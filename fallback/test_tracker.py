import json
import os
import tempfile
import unittest
from types import SimpleNamespace

from fallback import tracker


class FakeClient:
    def __init__(self, responses=None, download_root=None):
        self.responses = responses or {}
        self.calls = []
        self.config = SimpleNamespace(
            vikunja_web_url="https://vikunja.example.com/",
            attachment_download_root=download_root or tempfile.gettempdir(),
        )

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        response = self.responses.get((method, path))
        if response is None:
            raise AssertionError(f"Unexpected request: {method} {path}")
        return response


class TrackerFallbackTests(unittest.TestCase):
    def test_envelope_escapes_fences_without_changing_parsed_data(self):
        rendered = tracker.render_envelope(
            "Task details.", {"ok": True, "data": {"description": "```json\n{}\n```"}}, None
        )
        payload = rendered.split("```json\n", 1)[1].rsplit("\n```", 1)[0]
        self.assertEqual(json.loads(payload)["data"]["description"], "```json\n{}\n```")
        self.assertEqual(rendered.count("```"), 2)

    def test_task_normalization_includes_creator(self):
        task = tracker.normalize_task(
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
        _, result = tracker.cmd_tasks_apply_label(
            client, {"task_selector": 10, "label_title": "BUG"}
        )
        self.assertEqual(result["action"], "unchanged")
        self.assertEqual(len(client.calls), 1)

    def test_bulk_update_accepts_extra_writable_fields(self):
        client = FakeClient({("PUT", "/tasks/bulk"): {"tasks": []}})
        tracker.cmd_bulk_update(
            client, {"task_ids": [10], "fields_extra": {"percent_done": 0.5}}
        )
        body = client.calls[0][2]["body"]
        self.assertEqual(body["fields"], ["percent_done"])
        self.assertEqual(body["values"], {"percent_done": 0.5})

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
            _, result = tracker.cmd_export_project(
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


if __name__ == "__main__":
    unittest.main()
