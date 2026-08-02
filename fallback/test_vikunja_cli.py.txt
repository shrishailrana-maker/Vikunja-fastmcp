import json
import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


module_path = Path(__file__).with_name("vikunja-cli.py")
spec = importlib.util.spec_from_file_location("vikunja_cli", module_path)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load fallback CLI from {module_path}")
vikunja_cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vikunja_cli)


class FakeClient:
    def __init__(self, responses=None, download_root=None):
        self.responses = responses or {}
        self.calls = []
        self.config = SimpleNamespace(
            vikunja_web_url="https://vikunja.example.com/",
            attachment_download_root=download_root or tempfile.gettempdir(),
            attachment_source_roots=[download_root or tempfile.gettempdir()],
            max_attachment_bytes=100 * 1024 * 1024,
        )

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        response = self.responses.get((method, path))
        if response is None:
            raise AssertionError(f"Unexpected request: {method} {path}")
        if isinstance(response, BaseException):
            raise response
        return response


class TrackerFallbackTests(unittest.TestCase):
    def test_multipart_filename_cannot_inject_headers(self):
        value = vikunja_cli.sanitize_multipart_filename(
            '..\\evidence"\r\nX-Injected: yes.csv'
        )
        self.assertNotIn("\r", value)
        self.assertNotIn("\n", value)
        self.assertNotIn('"', value)
        self.assertNotIn("\\", value)

    def test_source_file_must_be_inside_an_allowed_root(self):
        with tempfile.TemporaryDirectory() as allowed, tempfile.TemporaryDirectory() as outside:
            allowed_file = Path(allowed, "run.log")
            outside_file = Path(outside, "secret.log")
            allowed_file.write_text("ok", encoding="utf-8")
            outside_file.write_text("no", encoding="utf-8")
            self.assertEqual(
                vikunja_cli.resolve_safe_source_path([allowed], str(allowed_file)),
                os.path.realpath(allowed_file),
            )
            with self.assertRaises(vikunja_cli.VikunjaError) as raised:
                vikunja_cli.resolve_safe_source_path([allowed], str(outside_file))
            self.assertEqual(raised.exception.code, "SOURCE_PATH_FORBIDDEN")

    def test_download_path_rejects_existing_symlink(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            target = Path(outside, "outside.bin")
            target.write_bytes(b"secret")
            link = Path(root, "link.bin")
            try:
                link.symlink_to(target)
            except OSError as error:
                self.skipTest(f"symlinks unavailable: {error}")
            with self.assertRaises(vikunja_cli.VikunjaError):
                vikunja_cli.resolve_safe_path(root, str(link))

    def test_envelope_escapes_fences_without_changing_parsed_data(self):
        rendered = vikunja_cli.render_envelope(
            "Task details.", {"ok": True, "data": {"description": "```json\n{}\n```"}}, None
        )
        payload = rendered.split("```json\n", 1)[1].rsplit("\n```", 1)[0]
        self.assertEqual(json.loads(payload)["data"]["description"], "```json\n{}\n```")
        self.assertEqual(rendered.count("```"), 2)

    def test_task_normalization_includes_creator(self):
        task = vikunja_cli.normalize_task(
            {
                "id": 10,
                "index": 4,
                "title": "Example",
                "created_by": {"id": 7, "username": "example-tester"},
            },
            {"id": 2, "title": "Alpha"},
            "https://vikunja.example.com/",
        )
        self.assertEqual(task["creator"], {"id": 7, "username": "example-tester"})

    def test_apply_label_is_idempotent_when_label_is_already_present(self):
        client = FakeClient(
            {
                ("GET", "/tasks/10"): {
                    "id": 10,
                    "index": 4,
                    "title": "Example",
                    "project_id": 2,
                    "project": {"title": "Alpha"},
                    "labels": [{"id": 3, "title": "bug"}],
                }
            }
        )
        _, result = vikunja_cli.cmd_tasks_apply_label(
            client, {"task_selector": 10, "label_title": "BUG"}
        )
        self.assertEqual(result["action"], "unchanged")
        self.assertEqual(len(client.calls), 1)

    def test_bulk_update_accepts_extra_writable_fields(self):
        client = FakeClient({("PUT", "/tasks/bulk"): {"tasks": []}})
        vikunja_cli.cmd_bulk_update(
            client, {"task_ids": [10], "fields_extra": {"percent_done": 0.5}}
        )
        body = client.calls[0][2]["body"]
        self.assertEqual(body["fields"], ["percent_done"])
        self.assertEqual(body["values"], {"percent_done": 0.5})

    def test_task_patch_does_not_retry_via_obsolete_full_update(self):
        error = vikunja_cli.VikunjaError(
            status=422,
            code="VALIDATION_ERROR",
            method="PATCH",
            path="/tasks/10",
            message="Invalid task update",
            field_errors=[
                {
                    "location": "body.subscription.entity",
                    "message": "Expected integer",
                }
            ],
        )
        client = FakeClient({("PATCH", "/tasks/10"): error})

        with self.assertRaises(vikunja_cli.VikunjaError) as raised:
            vikunja_cli.patch_task_fields(
                client,
                10,
                [{"op": "replace", "path": "/title", "value": "After"}],
            )

        self.assertIs(raised.exception, error)
        self.assertEqual([call[:2] for call in client.calls], [("PATCH", "/tasks/10")])

    def test_project_export_can_include_creator_and_comments(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeClient(
                {
                    ("GET", "/projects/2"): {"id": 2, "title": "Alpha"},
                    ("GET", "/projects/2/tasks?page=1&per_page=100"): {
                        "items": [
                            {
                                "id": 10,
                                "index": 4,
                                "title": "Example",
                                "created_by": {"id": 7, "username": "example-tester"},
                            }
                        ],
                        "page": 1,
                        "per_page": 100,
                        "total": 1,
                        "total_pages": 1,
                    },
                    ("GET", "/tasks/10/comments?page=1&per_page=100"): {
                        "items": [
                            {
                                "id": 50,
                                "comment": "<p><strong>Verified</strong></p>",
                                "author": {"id": 9, "username": "example-developer"},
                            }
                        ],
                        "page": 1,
                        "per_page": 100,
                        "total": 1,
                        "total_pages": 1,
                    },
                },
                root,
            )
            _, result = vikunja_cli.cmd_export_project(
                client,
                {
                    "project_id": 2,
                    "format": "json",
                    "destination_path": "alpha.json",
                    "include_comments": True,
                },
            )
            with open(result["path"], encoding="utf-8") as exported_file:
                exported = json.load(exported_file)
            self.assertEqual(
                exported["tasks"][0]["creator"], {"id": 7, "username": "example-tester"}
            )
            self.assertEqual(exported["tasks"][0]["comments"][0]["comment"], "**Verified**")

    def test_csv_export_neutralizes_spreadsheet_formulas_and_uses_private_file(self):
        with tempfile.TemporaryDirectory() as root:
            client = FakeClient(
                {
                    ("GET", "/projects/2"): {"id": 2, "title": "Alpha"},
                    ("GET", "/projects/2/tasks?page=1&per_page=100"): {
                        "items": [{"id": 10, "index": 4, "title": "=cmd|' /C calc'!A0"}],
                        "page": 1,
                        "per_page": 100,
                        "total": 1,
                        "total_pages": 1,
                    },
                },
                root,
            )
            _, result = vikunja_cli.cmd_export_project(
                client,
                {"project_id": 2, "format": "csv", "destination_path": "alpha.csv"},
            )
            with open(result["path"], newline="", encoding="utf-8") as exported_file:
                rows = list(__import__("csv").reader(exported_file))
            self.assertTrue(rows[1][3].startswith("'="))
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(os.stat(result["path"]).st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
