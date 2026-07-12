#!/usr/bin/env python3
"""
vikunja-cli.py - Emergency Python fallback CLI for the Vikunja FastMCP v2 server.

Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp

Copyright (c) 2026 Shrishail Rana
Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
SPDX-License-Identifier: MIT

When the MCP server (Node/TypeScript) is unavailable, this single-file Python 3
CLI provides the primary tracker operations directly against the Vikunja v2
REST API while preserving the critical identity rules, guardrails, and JSON
output shape. The MCP remains the authoritative implementation.

Usage:
    python vikunja-cli.py <tool> <action> [--param value ...]

Environment:
    VIKUNJA_URL                    (required) Vikunja server URL
    VIKUNJA_API_TOKEN              (required) API bearer token
    VIKUNJA_WEB_URL                (optional) Override web UI URL
    VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT (optional) Sandbox dir for downloads
    VIKUNJA_MAX_ATTACHMENT_BYTES   (optional) Max single-file size (default 100 MiB)
    VIKUNJA_TEMPLATE_FILE          (optional) Path to templates.json
    VIKUNJA_REQUEST_TIMEOUT_SECONDS (optional) HTTP timeout (default 30 seconds)
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
from urllib.parse import urlencode, quote as url_quote

import requests

# ─── Constants ────────────────────────────────────────────────────────────────

DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024  # 100 MiB
MAX_AGENT_PAGE_SIZE = 100

VALID_RELATION_KINDS = [
    "subtask", "parenttask", "related", "duplicateof", "duplicates",
    "blocking", "blocked", "precedes", "follows", "copiedfrom", "copiedto",
]

WRITABLE_TASK_FIELDS = [
    "bucket_id", "cover_image_attachment_id", "description", "done",
    "due_date", "end_date", "hex_color", "is_favorite", "percent_done",
    "priority", "project_id", "reminders", "repeat_after", "repeat_mode",
    "start_date", "title",
]

MIME_BY_EXT = {
    ".txt": "text/plain", ".log": "text/plain", ".md": "text/markdown",
    ".json": "application/json", ".csv": "text/csv", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".pdf": "application/pdf", ".zip": "application/zip",
    ".gz": "application/gzip", ".html": "text/html", ".xml": "application/xml",
}

UNSUPPORTED_OPERATIONS = [
    {
        "operation": "vikunja_filters:list",
        "reason": "The Vikunja v2 API has no collection GET /filters route.",
    },
]

OPERATIONAL_NOTES = [
    "Task list defaults to open tasks only (done=false). Pass --all-states for open+closed, or --done for closed-only.",
    "create_if_absent is best-effort (not a distributed lock).",
    "Team add-member returns userId (Vikunja user id).",
    "Bulk create/delete are bounded (1-100) and non-atomic.",
    "Templates are machine-local JSON, not Vikunja server entities.",
    "CSV imports, exports, and downloads obey the configured attachment size/path sandbox.",
    "User-data export authentication is server-specific.",
    "Task label operations require the caller to have the corresponding label and project permissions.",
]


# ─── Errors ───────────────────────────────────────────────────────────────────

class VikunjaError(Exception):
    """Structured error matching the TypeScript VikunjaError."""

    def __init__(self, *, status: int, code: str, method: str, path: str,
                 message: str, field_errors: Optional[List[Dict[str, str]]] = None):
        super().__init__(redact_secrets(message))
        self.status = status
        self.code = code
        self.method = method
        self.path = path
        self.field_errors = [
            {"location": _norm_field_loc(fe.get("location", "")),
             "message": str(fe.get("message", ""))}
            for fe in (field_errors or [])
        ]


def _norm_field_loc(loc: Any) -> str:
    if isinstance(loc, list):
        return ".".join(str(x) for x in loc)
    if loc is None:
        return ""
    return str(loc)


def redact_secrets(text: str, token_to_redact: Optional[str] = None) -> str:
    if not text:
        return text
    redacted = text
    token = token_to_redact or os.environ.get("VIKUNJA_API_TOKEN", "")
    if token:
        redacted = redacted.replace(token, "[REDACTED_TOKEN]")
    # tk_ pattern
    redacted = re.sub(r"tk_[a-zA-Z0-9]{30,}", "[REDACTED_TOKEN]", redacted)
    # Bearer tokens
    redacted = re.sub(
        r"(Authorization:\s*Bearer\s+)[a-zA-Z0-9_\-\.]+",
        r"\1[REDACTED_TOKEN]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(
        r"(Bearer\s+)[a-zA-Z0-9_\-\.]+",
        r"\1[REDACTED_TOKEN]", redacted, flags=re.IGNORECASE)
    return redacted


def map_status_to_code(status: int) -> str:
    mapping = {
        400: "VALIDATION_ERROR", 422: "VALIDATION_ERROR",
        401: "UNAUTHORIZED", 403: "PERMISSION_DENIED",
        404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED",
        409: "CONFLICT", 413: "ATTACHMENT_TOO_LARGE",
    }
    if status in mapping:
        return mapping[status]
    return "INTERNAL_SERVER_ERROR" if (status >= 500 or status == 0) else f"HTTP_{status}"


def to_error_envelope(error: Any, current_token: Optional[str] = None) -> Dict:
    if isinstance(error, VikunjaError):
        details = {
            "status": error.status, "code": error.code,
            "method": error.method, "path": error.path,
            "message": str(error), "fieldErrors": error.field_errors,
        }
    else:
        status = getattr(error, "status", 500)
        code = getattr(error, "code", None) or map_status_to_code(status)
        details = {
            "status": status, "code": code,
            "method": getattr(error, "method", "UNKNOWN"),
            "path": getattr(error, "path", "UNKNOWN"),
            "message": str(error) or "An unexpected error occurred",
            "fieldErrors": [],
        }
    details["message"] = redact_secrets(details["message"], current_token)
    details["path"] = redact_secrets(details["path"], current_token)
    details["fieldErrors"] = [
        {"location": redact_secrets(fe["location"], current_token),
         "message": redact_secrets(fe["message"], current_token)}
        for fe in details["fieldErrors"]
    ]
    return {"ok": False, "error": details}


# ─── Config ───────────────────────────────────────────────────────────────────

class Config:
    def __init__(self):
        raw_url = os.environ.get("VIKUNJA_URL", "")
        token = os.environ.get("VIKUNJA_API_TOKEN", "")
        raw_web_url = os.environ.get("VIKUNJA_WEB_URL", "")

        if not raw_url:
            raise VikunjaError(status=500, code="CONFIG_ERROR", method="INIT",
                               path="env", message="VIKUNJA_URL environment variable is not set.")
        if not token:
            raise VikunjaError(status=500, code="CONFIG_ERROR", method="INIT",
                               path="env", message="VIKUNJA_API_TOKEN environment variable is not set.")

        api_url, web_url = self._normalize_url(raw_url)
        self.vikunja_url = api_url
        self.vikunja_token = token

        if raw_web_url:
            self.vikunja_web_url = raw_web_url.rstrip("/") + "/"
        else:
            self.vikunja_web_url = web_url

        dl_root = os.environ.get("VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT", "").strip()
        if dl_root:
            self.attachment_download_root = os.path.abspath(dl_root)
        else:
            self.attachment_download_root = os.path.join(
                tempfile.gettempdir(), "vikunja-fastmcp", "attachments")

        raw_max = os.environ.get("VIKUNJA_MAX_ATTACHMENT_BYTES", "")
        try:
            val = int(raw_max)
            self.max_attachment_bytes = val if val > 0 else DEFAULT_MAX_ATTACHMENT_BYTES
        except (ValueError, TypeError):
            self.max_attachment_bytes = DEFAULT_MAX_ATTACHMENT_BYTES

        try:
            timeout = float(os.environ.get("VIKUNJA_REQUEST_TIMEOUT_SECONDS", "30"))
            self.request_timeout_seconds = timeout if timeout > 0 else 30.0
        except (ValueError, TypeError):
            self.request_timeout_seconds = 30.0

    @staticmethod
    def _normalize_url(url_str: str) -> Tuple[str, str]:
        if not url_str:
            raise VikunjaError(status=500, code="CONFIG_ERROR", method="INIT",
                               path="env", message="VIKUNJA_URL is required but not set.")
        if "/api/v1" in url_str:
            raise VikunjaError(status=500, code="CONFIG_ERROR", method="INIT",
                               path="env",
                               message="Vikunja FastMCP V2 does not support v1 API routes (/api/v1).")
        from urllib.parse import urlparse
        parsed = urlparse(url_str)
        if not parsed.scheme or not parsed.netloc:
            raise VikunjaError(status=500, code="CONFIG_ERROR", method="INIT",
                               path="env", message=f"Invalid VIKUNJA_URL: {url_str}")

        origin = f"{parsed.scheme}://{parsed.netloc}"
        pathname = parsed.path.rstrip("/")

        if pathname.endswith("/api/v2"):
            return origin + pathname, origin + "/"
        elif "/api/v2" in pathname:
            raise VikunjaError(
                status=500, code="CONFIG_ERROR", method="INIT", path="env",
                message=f'Invalid VIKUNJA_URL path "{pathname}": use the server root or a base ending in "/api/v2".')
        else:
            return origin + pathname + "/api/v2", origin + pathname + "/"


# ─── HTTP Client ──────────────────────────────────────────────────────────────

class VikunjaApiClient:
    def __init__(self, config: Config):
        self.config = config
        self._session = requests.Session()
        self._session.headers["Authorization"] = f"Bearer {config.vikunja_token}"

    def request(self, method: str, path: str, *,
                body: Any = None, headers: Optional[Dict[str, str]] = None,
                is_multipart: bool = False, is_stream: bool = False) -> Any:
        url = f"{self.config.vikunja_url}{path}"
        req_headers = dict(headers or {})

        kwargs: Dict[str, Any] = {
            "headers": req_headers,
            "stream": is_stream,
            "timeout": self.config.request_timeout_seconds,
        }

        if body is not None:
            if is_multipart:
                kwargs["data"] = body
            else:
                req_headers.setdefault("Content-Type", "application/json")
                if isinstance(body, (dict, list)):
                    kwargs["data"] = json.dumps(body)
                else:
                    kwargs["data"] = body

        try:
            resp = self._session.request(method, url, **kwargs)
        except requests.RequestException as exc:
            raise VikunjaError(status=500, code="NETWORK_ERROR", method=method,
                               path=path, message=str(exc) or "Network request failed")

        if not resp.ok:
            detail = f"HTTP error {resp.status_code}: {resp.reason}"
            field_errors: List[Dict[str, str]] = []
            try:
                error_body = resp.json()
                if isinstance(error_body, dict):
                    detail = (error_body.get("detail")
                              or error_body.get("title")
                              or error_body.get("message")
                              or detail)
                    if isinstance(error_body.get("errors"), list):
                        for fe in error_body["errors"]:
                            loc = fe.get("location", "")
                            if isinstance(loc, list):
                                loc = ".".join(str(x) for x in loc)
                            field_errors.append({
                                "location": str(loc or ""),
                                "message": str(fe.get("message", "")),
                            })
            except (ValueError, KeyError):
                pass
            raise VikunjaError(
                status=resp.status_code, code=map_status_to_code(resp.status_code),
                method=method, path=path, message=detail, field_errors=field_errors)

        if is_stream:
            return resp

        if resp.status_code == 204 or not resp.text:
            return {}

        try:
            return resp.json()
        except ValueError:
            raise VikunjaError(
                status=502, code="INVALID_JSON_RESPONSE", method=method, path=path,
                message="Server returned a non-JSON success body that could not be parsed.")


# ─── Format / Pagination Helpers ──────────────────────────────────────────────

def normalize_zero_date(val: Any) -> Any:
    if isinstance(val, str):
        if val.startswith("0001-01-01") or val == "":
            return None
    return val


def normalize_dates_and_nulls(obj: Any) -> Any:
    if obj is None:
        return None
    if isinstance(obj, list):
        return [normalize_dates_and_nulls(item) for item in obj]
    if isinstance(obj, dict):
        result = {}
        for k, v in obj.items():
            v = normalize_zero_date(v)
            if v is not None and isinstance(v, (dict, list)):
                v = normalize_dates_and_nulls(v)
            result[k] = v
        return result
    return obj


def to_item_array(res: Any) -> list:
    if isinstance(res, list):
        return res
    if isinstance(res, dict) and isinstance(res.get("items"), list):
        return res["items"]
    return []


def normalize_pagination(raw: Any) -> Dict[str, Any]:
    if isinstance(raw, list):
        total = len(raw)
        return {"page": 1, "perPage": total or 25, "total": total,
                "totalPages": 1, "hasMore": False, "nextPage": None}
    page = int(raw.get("page", 1) or 1)
    per_page = int(raw.get("per_page", raw.get("perPage", 25)) or 25)
    total = int(raw.get("total", 0) or 0)
    total_pages = int(raw.get("total_pages", raw.get("totalPages", 0)) or 0)
    if not total_pages and per_page > 0 and total > 0:
        total_pages = -(-total // per_page)  # ceil division
    has_more = page < total_pages
    return {"page": page, "perPage": per_page, "total": total,
            "totalPages": total_pages, "hasMore": has_more,
            "nextPage": page + 1 if has_more else None}


def fetch_all_collection_items(client: VikunjaApiClient, base_path: str,
                                per_page: int = 100, max_pages: int = 50) -> list:
    items: list = []
    page = 1
    last_total = 0
    seen_pages: set = set()
    seen_batch_sigs: set = set()
    seen_ids: set = set()
    sep = "&" if "?" in base_path else "?"

    while page <= max_pages:
        raw = client.request("GET", f"{base_path}{sep}page={page}&per_page={per_page}")
        if isinstance(raw, list):
            return raw
        batch = to_item_array(raw)
        pagination = normalize_pagination(raw)
        batch_sig = json.dumps([
            (item.get("id") if isinstance(item, dict) and "id" in item else item)
            for item in batch
        ])
        if pagination["page"] in seen_pages or batch_sig in seen_batch_sigs:
            raise VikunjaError(
                status=502, code="COLLECTION_PAGE_REPEATED", method="GET",
                path=base_path,
                message=f'The server repeated collection page {pagination["page"]} for "{base_path}".')
        seen_pages.add(pagination["page"])
        seen_batch_sigs.add(batch_sig)
        for item in batch:
            item_id = item.get("id") if isinstance(item, dict) else None
            if item_id is not None:
                if item_id in seen_ids:
                    continue
                seen_ids.add(item_id)
            items.append(item)
        last_total = pagination["total"]
        if not pagination["hasMore"] or len(batch) == 0:
            break
        page += 1

    if last_total and len(items) < last_total:
        raise VikunjaError(
            status=502, code="COLLECTION_TRUNCATED", method="GET", path=base_path,
            message=f'Fetched {len(items)} of {last_total} items from "{base_path}" before page cap.')
    return items


def render_envelope(summary: str, envelope: Dict, indent: Optional[int]) -> str:
    """Render a summary followed by exactly one fenced JSON envelope.

    Escapes any literal triple-backtick in the serialized JSON so task/comment
    content cannot break out of the ```json fence (mirrors stringifyEnvelope in
    src/format.ts; json.loads restores the backticks from the \\u0060 escapes).
    """
    body = json.dumps(envelope, indent=indent).replace("```", "\\u0060\\u0060\\u0060")
    return f"{summary}\n\n```json\n{body}\n```"


# ─── Markdown ↔ HTML ──────────────────────────────────────────────────────────

_HTML_ENTITIES = {
    "amp": "&", "apos": "'", "gt": ">", "hellip": "…", "lt": "<",
    "mdash": "—", "middot": "·", "ndash": "–", "nbsp": " ", "quot": '"', "sol": "/",
}


def _decode_entities(text: str) -> str:
    if not text:
        return ""

    def _repl(m):
        body = m.group(1)
        if body.startswith("#"):
            is_hex = body[1:2].lower() == "x"
            try:
                cp = int(body[2:] if is_hex else body[1:], 16 if is_hex else 10)
            except ValueError:
                return m.group(0)
            if 0 <= cp <= 0x10FFFF and not (0xD800 <= cp <= 0xDFFF):
                return chr(cp)
            return m.group(0)
        return _HTML_ENTITIES.get(body.lower(), m.group(0))

    return re.sub(r"&(#(?:x[0-9a-fA-F]+|\d+)|[a-z][a-z0-9]+);", _repl, text, flags=re.IGNORECASE)


def _escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _validate_url_scheme(url_str: str) -> str:
    if url_str.lower().startswith("mailto:"):
        return url_str
    if url_str.startswith("/") or url_str.startswith("./") or url_str.startswith("../"):
        return url_str
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url_str)
        if parsed.scheme in ("http", "https"):
            return url_str
    except Exception:
        pass
    raise VikunjaError(status=400, code="UNSAFE_MARKDOWN", method="MARKDOWN",
                       path="description", message=f"Unsafe link scheme or malformed URL: {url_str}")


def markdown_to_html(md: str) -> str:
    if not md:
        return ""
    lines = md.replace("\r\n", "\n").split("\n")
    blocks: list = []
    block_type = None
    block_lines: list = []

    def _parse_inline(text: str) -> str:
        escaped = _escape_html(text)
        # Extract inline code
        inline_codes: list = []

        def _code_repl(m):
            idx = len(inline_codes)
            inline_codes.append(f"<code>{m.group(1)}</code>")
            return f"@@INLINECODE_{idx}@@"

        escaped = re.sub(r"`([^`]+)`", _code_repl, escaped)
        # Bold
        escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
        escaped = re.sub(r"__([^_]+)__", r"<strong>\1</strong>", escaped)
        # Italic
        escaped = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", escaped)
        escaped = re.sub(r"_([^_]+)_", r"<em>\1</em>", escaped)
        # Links
        link_error = None

        def _link_repl(m):
            nonlocal link_error
            label, url = m.group(1), m.group(2)
            try:
                decoded_url = _decode_entities(url)
                safe_url = _validate_url_scheme(decoded_url)
                attr_safe = (safe_url.replace("&", "&amp;").replace('"', "&quot;")
                             .replace("<", "&lt;").replace(">", "&gt;"))
                return f'<a href="{attr_safe}">{label}</a>'
            except Exception as e:
                link_error = e
                return m.group(0)

        escaped = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _link_repl, escaped)
        if link_error:
            raise link_error
        # Restore inline code
        for i, code in enumerate(inline_codes):
            escaped = escaped.replace(f"@@INLINECODE_{i}@@", code)
        return escaped

    def _flush():
        nonlocal block_type, block_lines
        if not block_lines:
            return
        if block_type == "code":
            code_content = _escape_html("\n".join(block_lines))
            blocks.append(f"<pre><code>{code_content}</code></pre>")
        elif block_type == "ul":
            items = "\n".join(f"<li>{_parse_inline(line)}</li>" for line in block_lines)
            blocks.append(f"<ul>\n{items}\n</ul>")
        elif block_type == "ol":
            items = "\n".join(f"<li>{_parse_inline(line)}</li>" for line in block_lines)
            blocks.append(f"<ol>\n{items}\n</ol>")
        elif block_type == "p":
            p_content = "\n".join(_parse_inline(line) for line in block_lines)
            blocks.append(f"<p>{p_content}</p>")
        block_lines = []
        block_type = None

    for line in lines:
        trimmed = line.strip()
        if trimmed.startswith("```"):
            if block_type == "code":
                _flush()
            else:
                _flush()
                block_type = "code"
            continue
        if block_type == "code":
            block_lines.append(line)
            continue
        # Headings
        hm = re.match(r"^(#{1,3})\s+(.*)$", line)
        if hm:
            _flush()
            level = len(hm.group(1))
            content = _parse_inline(hm.group(2))
            blocks.append(f"<h{level}>{content}</h{level}>")
            continue
        # Lists
        ul_m = re.match(r"^[*\-]\s+(.*)$", line)
        ol_m = re.match(r"^\d+\.\s+(.*)$", line)
        if ul_m:
            if block_type != "ul":
                _flush()
                block_type = "ul"
            block_lines.append(ul_m.group(1))
        elif ol_m:
            if block_type != "ol":
                _flush()
                block_type = "ol"
            block_lines.append(ol_m.group(1))
        elif trimmed == "":
            _flush()
        else:
            if block_type not in ("p", None):
                _flush()
            if block_type is None:
                block_type = "p"
            block_lines.append(line)

    _flush()
    return "\n".join(blocks)


def html_to_markdown(html: str) -> str:
    if not html:
        return ""
    md = html.replace("\r\n", "\n")
    md = re.sub(r"<(script|style)\b[^>]*>[\s\S]*?</\1>", "", md, flags=re.IGNORECASE)
    # Extract pre blocks
    pre_blocks: list = []

    def _pre_repl(m):
        idx = len(pre_blocks)
        code = m.group(1).strip()
        pre_blocks.append(f"\n```\n{_decode_entities(code)}\n```\n")
        return f"__PRE_BLOCK_{idx}__"

    md = re.sub(r"<pre><code>([\s\S]*?)</code></pre>", _pre_repl, md)
    md = re.sub(r"<pre>([\s\S]*?)</pre>", _pre_repl, md)
    # Inline code
    inline_codes: list = []

    def _code_repl(m):
        idx = len(inline_codes)
        inline_codes.append(f"`{_decode_entities(m.group(1))}`")
        return f"__CODE_{idx}__"

    md = re.sub(r"<code>(.*?)</code>", _code_repl, md)
    # Headings
    md = re.sub(r"<h1>(.*?)</h1>", r"\n# \1\n", md, flags=re.IGNORECASE)
    md = re.sub(r"<h2>(.*?)</h2>", r"\n## \1\n", md, flags=re.IGNORECASE)
    md = re.sub(r"<h3>(.*?)</h3>", r"\n### \1\n", md, flags=re.IGNORECASE)
    # UL
    def _ul_repl(m):
        inner = m.group(1)
        items = re.findall(r"<li>([\s\S]*?)</li>", inner, re.IGNORECASE)
        return "\n" + "\n".join(f"* {item.strip()}" for item in items) + "\n"

    md = re.sub(r"<ul>([\s\S]*?)</ul>", _ul_repl, md, flags=re.IGNORECASE)
    # OL
    def _ol_repl(m):
        inner = m.group(1)
        items = re.findall(r"<li>([\s\S]*?)</li>", inner, re.IGNORECASE)
        return "\n" + "\n".join(f"{i+1}. {item.strip()}" for i, item in enumerate(items)) + "\n"

    md = re.sub(r"<ol>([\s\S]*?)</ol>", _ol_repl, md, flags=re.IGNORECASE)
    # Bold / Italic
    md = re.sub(r"<strong>(.*?)</strong>", r"**\1**", md, flags=re.IGNORECASE)
    md = re.sub(r"<b>(.*?)</b>", r"**\1**", md, flags=re.IGNORECASE)
    md = re.sub(r"<em>(.*?)</em>", r"*\1*", md, flags=re.IGNORECASE)
    md = re.sub(r"<i>(.*?)</i>", r"*\1*", md, flags=re.IGNORECASE)
    # Links
    def _link_repl(m):
        href = _decode_entities(m.group(1) or m.group(2) or "")
        label = m.group(3)
        try:
            return f"[{label}]({_validate_url_scheme(href)})"
        except Exception:
            return label

    md = re.sub(r'<a\s+[^>]*href=(?:"([^"]*)"|\'([^\']*)\')[^>]*>([\s\S]*?)</a>',
                _link_repl, md, flags=re.IGNORECASE)
    # Paragraphs & breaks
    md = re.sub(r"<p>(.*?)</p>", r"\n\1\n", md, flags=re.IGNORECASE)
    md = re.sub(r"<br\s*/?>", "\n", md, flags=re.IGNORECASE)
    # Strip remaining tags
    md = re.sub(r"<[^>]+>", "", md)
    # Restore
    for i, block in enumerate(pre_blocks):
        md = md.replace(f"__PRE_BLOCK_{i}__", block)
    for i, code in enumerate(inline_codes):
        md = md.replace(f"__CODE_{i}__", code)
    md = _decode_entities(md.strip())
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md


# ─── Identity Cache ──────────────────────────────────────────────────────────

class IdentityCache:
    def __init__(self, ttl: float = 45.0):
        self._project_cache: Dict[str, Tuple[Dict, float]] = {}
        self._label_cache: Dict[str, Tuple[int, float]] = {}
        self._ttl = ttl

    def get_project(self, title: str) -> Optional[Dict]:
        key = title.lower()
        entry = self._project_cache.get(key)
        if entry and entry[1] > time.time():
            return entry[0]
        self._project_cache.pop(key, None)
        return None

    def set_project(self, title: str, ref: Dict):
        self._project_cache[title.lower()] = (
            {"id": ref["id"], "title": ref["title"]}, time.time() + self._ttl)

    def get_label(self, title: str) -> Optional[int]:
        key = title.lower()
        entry = self._label_cache.get(key)
        if entry and entry[1] > time.time():
            return entry[0]
        self._label_cache.pop(key, None)
        return None

    def set_label(self, title: str, label_id: int):
        self._label_cache[title.lower()] = (label_id, time.time() + self._ttl)

    def clear(self):
        self._project_cache.clear()
        self._label_cache.clear()


_cache = IdentityCache()

# ─── Idempotency Cache ───────────────────────────────────────────────────────

class IdempotencyCache:
    def __init__(self, ttl: float = 300.0, max_size: int = 1000):
        self._cache = {}
        self._ttl = ttl
        self._max_size = max_size

    def get(self, key: str):
        if not key:
            return None
        entry = self._cache.get(key)
        if entry:
            import time
            if time.time() - entry[1] < self._ttl:
                return entry[0]
            del self._cache[key]
        return None

    def set(self, key: str, result: Any):
        if not key:
            return
        import time
        self._cache[key] = (result, time.time())
        if len(self._cache) > self._max_size:
            oldest_k = min(self._cache, key=lambda k: self._cache[k][1])
            del self._cache[oldest_k]


_idempotency = IdempotencyCache()


# ─── Identity Resolution ─────────────────────────────────────────────────────

def resolve_project(client: VikunjaApiClient,
                    selector: Dict[str, Any]) -> Dict[str, Any]:
    sel_id = selector.get("id")
    sel_title = selector.get("title")

    if sel_id is not None:
        if sel_id <= 0:
            raise VikunjaError(status=400, code="INVALID_PROJECT_ID", method="GET",
                               path=f"/projects/{sel_id}",
                               message=f"Invalid project ID: {sel_id}")
        try:
            project = client.request("GET", f"/projects/{sel_id}")
        except VikunjaError as e:
            if e.status == 404:
                raise VikunjaError(status=404, code="PROJECT_NOT_FOUND", method="GET",
                                   path=f"/projects/{sel_id}",
                                   message=f"Project not found for ID: {sel_id}")
            raise
        if sel_title is not None and project["title"].lower() != sel_title.lower():
            raise VikunjaError(
                status=400, code="PROJECT_SELECTOR_MISMATCH", method="GET",
                path=f"/projects/{sel_id}",
                message=f'Project ID {sel_id} is "{project["title"]}", not "{sel_title}".')
        return {"id": project["id"], "title": project["title"]}

    if sel_title is not None:
        cached = _cache.get_project(sel_title)
        if cached:
            return cached
        projects = fetch_all_collection_items(client, "/projects")
        exact = [p for p in projects if p["title"].lower() == sel_title.lower()]
        if len(exact) == 0:
            raise VikunjaError(status=404, code="PROJECT_NOT_FOUND", method="GET",
                               path="/projects",
                               message=f'Project not found for title: "{sel_title}"')
        if len(exact) > 1:
            candidates = [{"id": p["id"], "title": p["title"]} for p in exact]
            raise VikunjaError(
                status=409, code="PROJECT_TITLE_AMBIGUOUS", method="GET",
                path="/projects",
                message=f'Multiple projects match exact title: "{sel_title}". Candidates: {json.dumps(candidates)}')
        ref = {"id": exact[0]["id"], "title": exact[0]["title"]}
        _cache.set_project(sel_title, ref)
        return ref

    raise VikunjaError(status=400, code="PROJECT_SELECTOR_REQUIRED", method="GET",
                       path="/projects",
                       message="Either project numeric ID or project title must be provided.")


def resolve_task(client: VikunjaApiClient, task_selector: Union[str, int],
                 project_selector: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    sel_str = str(task_selector).strip()
    is_digits = re.match(r"^\d+$", sel_str)

    def _task_labels(t: dict) -> list:
        raw_labels = t.get("labels")
        if isinstance(raw_labels, list):
            return [{"id": l["id"], "title": l.get("title", "")} for l in raw_labels]
        return []

    if is_digits and not sel_str.startswith("#"):
        global_id = int(sel_str)
        if global_id <= 0:
            raise VikunjaError(status=400, code="INVALID_TASK_SELECTOR", method="GET",
                               path="/tasks", message=f'Invalid task selector: "{task_selector}".')
        try:
            task = client.request("GET", f"/tasks/{global_id}")
        except VikunjaError as e:
            if e.status == 404:
                raise VikunjaError(status=404, code="TASK_NOT_FOUND", method="GET",
                                   path=f"/tasks/{global_id}",
                                   message=f"Task not found for global ID: {global_id}")
            raise
        if project_selector:
            expected_proj = resolve_project(client, project_selector)
            if expected_proj["id"] != task.get("project_id"):
                raise VikunjaError(
                    status=400, code="PROJECT_MISMATCH", method="GET",
                    path=f"/tasks/{global_id}",
                    message=(f"Task #{task.get('index')} (ID {global_id}) belongs to project ID "
                             f"{task.get('project_id')}, not the specified project "
                             f"'{expected_proj['title']}' (ID {expected_proj['id']})"))
            project = expected_proj
        elif task.get("project", {}).get("title"):
            project = {"id": task["project_id"], "title": task["project"]["title"]}
        else:
            project = resolve_project(client, {"id": task["project_id"]})
        return {
            "id": task["id"], "index": task.get("index", 0),
            "identifier": task.get("identifier"), "project": project,
            "title": task.get("title", ""), "labels": _task_labels(task),
        }

    # Portal / short-identifier parsing
    index = None
    if sel_str.startswith("#"):
        if len(sel_str) < 2:
            raise VikunjaError(
                status=400, code="INVALID_TASK_SELECTOR", method="GET", path="/tasks",
                message=f'Invalid task selector: "{task_selector}". Use #index with a positive portal number.')
        try:
            index = int(sel_str[1:])
        except ValueError:
            index = None
    elif "-" in sel_str:
        parts = sel_str.split("-")
        last_part = parts[-1]
        if re.match(r"^\d+$", last_part):
            index = int(last_part)

    if index is None or index <= 0:
        raise VikunjaError(
            status=400, code="INVALID_TASK_SELECTOR", method="GET", path="/tasks",
            message=(f'Invalid task selector: "{task_selector}". Use a numeric global ID, '
                     f"or a project-scoped #index or short-identifier (e.g. PRJ-123)."))

    if not project_selector:
        raise VikunjaError(
            status=400, code="PROJECT_CONTEXT_REQUIRED", method="GET", path="/tasks",
            message=f'Project title or ID context is required to resolve project-scoped task reference: "{task_selector}"')

    project = resolve_project(client, project_selector)
    filter_val = url_quote(f"index = {index}")
    lookup_path = f"/projects/{project['id']}/tasks?filter={filter_val}&per_page=2"
    try:
        response = client.request("GET", lookup_path)
    except VikunjaError as e:
        if e.status == 404:
            raise VikunjaError(
                status=404, code="TASK_NOT_FOUND", method="GET", path=lookup_path,
                message=f"Task #{index} not found in project '{project['title']}' (ID {project['id']})")
        raise

    matches = [t for t in to_item_array(response) if t.get("index") == index]
    if len(matches) == 0:
        raise VikunjaError(
            status=404, code="TASK_NOT_FOUND", method="GET", path=lookup_path,
            message=f"Task #{index} not found in project '{project['title']}' (ID {project['id']})")
    if len(matches) > 1:
        raise VikunjaError(
            status=409, code="TASK_INDEX_AMBIGUOUS", method="GET", path=lookup_path,
            message=f"Multiple tasks matched #{index} in project '{project['title']}' (ID {project['id']}).")

    task = matches[0]
    if "-" in sel_str and task.get("identifier") and task["identifier"].lower() != sel_str.lower():
        raise VikunjaError(
            status=400, code="IDENTIFIER_MISMATCH", method="GET", path=lookup_path,
            message=f'Task identifier "{task["identifier"]}" does not match specified selector "{sel_str}"')

    return {
        "id": task["id"], "index": task.get("index", 0),
        "identifier": task.get("identifier"), "project": {"id": task.get("project_id", project["id"]), "title": project["title"]},
        "title": task.get("title", ""), "labels": _task_labels(task),
    }


def resolve_user(client: VikunjaApiClient, user_selector: Union[str, int]) -> int:
    sel = str(user_selector).strip()
    if re.match(r"^\d+$", sel):
        uid = int(sel)
        if uid <= 0:
            raise VikunjaError(status=400, code="INVALID_USER_SELECTOR", method="GET",
                               path="/users", message=f'Invalid user id: "{user_selector}"')
        return uid
    items = fetch_all_collection_items(client, f"/users?q={url_quote(sel)}")
    exact = [u for u in items if u.get("username", "").lower() == sel.lower()]
    if not exact:
        raise VikunjaError(status=404, code="USER_NOT_FOUND", method="GET",
                           path="/users", message=f'User not found for username: "{user_selector}"')
    return exact[0]["id"]


def resolve_label(client: VikunjaApiClient, label_selector: Union[str, int]) -> int:
    sel = str(label_selector).strip()
    if re.match(r"^\d+$", sel):
        lid = int(sel)
        if lid <= 0:
            raise VikunjaError(status=400, code="INVALID_LABEL_SELECTOR", method="GET",
                               path="/labels", message=f'Invalid label id: "{label_selector}"')
        return lid
    cached = _cache.get_label(sel)
    if cached is not None:
        return cached
    items = fetch_all_collection_items(client, "/labels")
    exact = [l for l in items if l.get("title", "").lower() == sel.lower()]
    if len(exact) == 0:
        raise VikunjaError(status=404, code="LABEL_NOT_FOUND", method="GET",
                           path="/labels", message=f'Label not found: "{label_selector}"')
    if len(exact) > 1:
        candidates = [{"id": l["id"], "title": l["title"]} for l in exact]
        raise VikunjaError(
            status=409, code="LABEL_TITLE_AMBIGUOUS", method="GET", path="/labels",
            message=f'Multiple labels match title "{label_selector}". Use a numeric label ID. Candidates: {json.dumps(candidates)}')
    _cache.set_label(sel, exact[0]["id"])
    return exact[0]["id"]


def resolve_or_create_label(client: VikunjaApiClient,
                            label_selector: Union[str, int],
                            create_if_missing: bool = True) -> int:
    sel = str(label_selector).strip()
    if re.match(r"^\d+$", sel):
        return resolve_label(client, sel)
    try:
        return resolve_label(client, sel)
    except VikunjaError as e:
        if e.code != "LABEL_NOT_FOUND":
            raise
        if not create_if_missing:
            raise
    created = client.request("POST", "/labels", body={"title": sel})
    _cache.set_label(sel, created["id"])
    return created["id"]


# ─── Task helpers ─────────────────────────────────────────────────────────────

def normalize_task(task: dict, project_ref: dict, web_url: str) -> dict:
    n = normalize_dates_and_nulls(task)
    labels = [{"id": l["id"], "title": l["title"]} for l in (n.get("labels") or [])]
    assignees = [{"id": a["id"], "username": a.get("username", "")}
                 for a in (n.get("assignees") or [])]
    return {
        "id": n["id"], "index": n.get("index", 0),
        "identifier": n.get("identifier"),
        "project": {"id": project_ref["id"], "title": project_ref["title"]},
        "title": n.get("title", ""),
        "description": html_to_markdown(n.get("description", "")) or None,
        "done": bool(n.get("done")),
        "priority": n.get("priority", 0) or 0,
        "dueDate": n.get("due_date") or n.get("dueDate") or None,
        "creator": ({"id": n["created_by"].get("id"),
                     "username": n["created_by"].get("username", "")}
                    if isinstance(n.get("created_by"), dict) else None),
        "labels": labels, "assignees": assignees,
        "taskUrl": f"{web_url}tasks/{n['id']}",
        "projectUrl": f"{web_url}projects/{project_ref['id']}",
        "updated": n.get("updated") or n.get("updatedAt") or None,
    }


def normalize_task_list_item(task: dict, project_ref: dict, web_url: str) -> dict:
    full = normalize_task(task, project_ref, web_url)
    return {k: full[k] for k in
            ("id", "index", "identifier", "project", "title", "done",
             "priority", "creator", "labels", "taskUrl", "projectUrl")}


def _write_echo(action: str, task_ref: dict) -> dict:
    return {
        "action": action,
        "target": {
            "id": task_ref["id"], "index": task_ref.get("index", 0),
            "identifier": task_ref.get("identifier"),
            "project": task_ref["project"], "title": task_ref.get("title", ""),
        },
    }


def _is_filter_safe_title(title: str) -> bool:
    return not bool(re.search(r"[()[\]{}'\"`\\=&|<>]", title))


def _escape_filter_string(val: str) -> str:
    return f"'{val.replace(chr(39), chr(39)+chr(39))}'"


def _build_filter_string(*, done=None, all_states=False, priority=None,
                          label=None, filter_str=None) -> str:
    parts = []
    if done is not None:
        parts.append(f"done = {'true' if done else 'false'}")
    elif not all_states:
        parts.append("done = false")
    if priority is not None:
        parts.append(f"priority = {priority}")
    if label is not None:
        if isinstance(label, int):
            parts.append(f"labels = {label}")
        else:
            parts.append(f"labels = {_escape_filter_string(label)}")
    if filter_str:
        parts.append(f"({filter_str})")
    return " && ".join(parts)


def _build_writable_snapshot(current: dict, changes: dict) -> dict:
    snapshot = {}
    for field in WRITABLE_TASK_FIELDS:
        if field in current:
            snapshot[field] = current[field]
    snapshot.update(changes)
    return snapshot


def _is_subscription_validation_defect(error: VikunjaError) -> bool:
    return (error.status == 422 and
            any(fe.get("location") == "body.subscription.entity"
                and "expected integer" in (fe.get("message", "")).lower()
                for fe in error.field_errors))


def patch_task_fields(client: VikunjaApiClient, task_id: int,
                      current_task: dict, patch_ops: list, changes: dict) -> dict:
    try:
        return client.request("PATCH", f"/tasks/{task_id}", body=patch_ops,
                              headers={"Content-Type": "application/json-patch+json"})
    except VikunjaError as e:
        if not _is_subscription_validation_defect(e):
            raise
        return client.request("PUT", f"/tasks/{task_id}",
                              body=_build_writable_snapshot(current_task, changes))


# ─── Attachment helpers ───────────────────────────────────────────────────────

def infer_mime_type(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    return MIME_BY_EXT.get(ext, "application/octet-stream")


def resolve_safe_path(root: str, target: str) -> str:
    abs_root = os.path.abspath(root)
    abs_target = os.path.abspath(target) if os.path.isabs(target) else os.path.abspath(
        os.path.join(root, target))
    root_with_sep = abs_root if abs_root.endswith(os.sep) else abs_root + os.sep
    if abs_target != abs_root and not abs_target.startswith(root_with_sep):
        raise VikunjaError(
            status=403, code="FORBIDDEN", method="GET", path="/attachments",
            message=f'Access denied. Target path "{target}" lies outside the allowed download directory "{root}".')
    return abs_target


def _upload_buffer_to_task(client: VikunjaApiClient, task_id: int,
                            filename: str, mime_type: str, file_bytes: bytes) -> dict:
    boundary = f"----VikunjaMcpBoundary{os.urandom(16).hex()}"
    safe_fn = os.path.basename(filename).replace('"', '\\"')
    safe_mime = mime_type if re.match(
        r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+\-]*$",
        mime_type) else "application/octet-stream"

    header = (f"--{boundary}\r\n"
              f'Content-Disposition: form-data; name="files"; filename="{safe_fn}"\r\n'
              f"Content-Type: {safe_mime}\r\n\r\n").encode()
    footer = f"\r\n--{boundary}--\r\n".encode()
    body = header + file_bytes + footer

    path_url = f"/tasks/{task_id}/attachments"
    upload_res = client.request("POST", path_url, body=body,
                                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                                is_multipart=True)
    success_list = upload_res.get("success", []) if isinstance(upload_res, dict) else []
    if not success_list:
        error_list = upload_res.get("errors", []) if isinstance(upload_res, dict) else []
        first_err = error_list[0].get("error", "Unknown upload error") if error_list else "Unknown upload error"
        raise VikunjaError(status=500, code="UPLOAD_FAILED", method="POST", path=path_url,
                           message=f"Attachment upload failed: {first_err}")
    att = success_list[0]
    return {
        "id": att["id"],
        "fileName": att.get("file", {}).get("name", filename),
        "mime": att.get("file", {}).get("mime", mime_type),
        "fileSize": att.get("file", {}).get("size", len(file_bytes)),
        "created": att.get("created"),
    }


# ─── Tool Implementations ────────────────────────────────────────────────────
# Each function returns (summary_str, data_dict) on success or raises VikunjaError.


# --- self_check / vikunja_auth ---

def cmd_self_check(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    config = client.config
    diag: Dict[str, Any] = {
        "vikunjaUrl": config.vikunja_url,
        "tokenPresent": bool(config.vikunja_token),
        "connectionStatus": "offline",
        "authenticationState": "unknown",
        "apiContractVersion": "v2",
        "attachmentDownloadRoot": config.attachment_download_root,
        "attachmentDownloadRootWritable": False,
        "unsupportedOperations": UNSUPPORTED_OPERATIONS,
        "operationalNotes": OPERATIONAL_NOTES,
    }
    # Check download root writable
    try:
        os.makedirs(config.attachment_download_root, exist_ok=True)
        test_file = os.path.join(config.attachment_download_root, f".self-check-{int(time.time())}")
        with open(test_file, "w") as f:
            f.write("test")
        os.unlink(test_file)
        diag["attachmentDownloadRootWritable"] = True
    except Exception:
        pass
    # Check server
    try:
        user = client.request("GET", "/user")
        diag["currentUser"] = {"id": user["id"], "username": user.get("username", "")}
        diag["authenticationState"] = "authenticated"
        diag["connectionStatus"] = "online"
        projects = fetch_all_collection_items(client, "/projects")
        diag["projects"] = [
            {"id": p["id"], "title": p["title"], "archived": bool(p.get("is_archived"))}
            for p in projects
        ]
    except VikunjaError as e:
        diag["authenticationState"] = "unauthenticated" if e.status == 401 else "unknown"
        diag["connectionStatus"] = "offline" if e.code == "NETWORK_ERROR" else "online"
        diag["connectionError"] = str(e)
    ok = (diag.get("attachmentDownloadRootWritable") and
          diag.get("connectionStatus") == "online" and
          diag.get("authenticationState") == "authenticated")
    return "Self-check completed.", {"ok": bool(ok), "diagnostics": diag}


def cmd_auth_status(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    user = client.request("GET", "/user")
    return "Authenticated.", normalize_dates_and_nulls(user)


# --- vikunja_projects ---

def cmd_projects_list(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    items = fetch_all_collection_items(client, "/projects")
    projects = [{"id": p["id"], "title": p["title"], "archived": bool(p.get("is_archived")),
                 "identifier": p.get("identifier", "")} for p in items]
    return f"Found {len(projects)} projects.", projects


def cmd_projects_get(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    sel = _parse_project_selector(args)
    ref = resolve_project(client, sel)
    project = client.request("GET", f"/projects/{ref['id']}")
    return f"Project: {project.get('title', '')}", normalize_dates_and_nulls(project)


# --- vikunja_tasks ---

def cmd_tasks_create(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    proj_sel = _require_project_selector(args)
    fields = _parse_task_fields(args)
    if not fields.get("title"):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/tasks", message="fields.title is required for task creation.")
    project = resolve_project(client, proj_sel)
    web_url = client.config.vikunja_web_url
    body: dict = {"title": fields["title"]}
    if "description" in fields:
        body["description"] = markdown_to_html(fields["description"])
    if "done" in fields:
        body["done"] = fields["done"]
    if "priority" in fields:
        body["priority"] = fields["priority"]
    if "dueDate" in fields:
        body["due_date"] = fields["dueDate"]
    body.update(_extra_writable_fields(args))

    idem_key = args.get("idempotency_key", "")
    project_key = proj_sel.get("id") or (proj_sel.get("title", "").lower())
    cache_key = f"task-create:{project_key}:{idem_key}" if idem_key else ""
    if cache_key:
        cached = _idempotency.get(cache_key)
        if cached:
            return "Task created (idempotent replay).", cached

    raw = client.request("POST", f"/projects/{project['id']}/tasks", body=body)
    task = normalize_task(raw, project, web_url)
    echo = _write_echo("created", task)
    attachments = args.get("attachments") or args.get("file_paths") or []
    if attachments:
        echo = _attach_files_to_echo(client, echo, attachments)
    if cache_key:
        _idempotency.set(cache_key, echo)
    return f"Created task \"{task['title']}\".", echo


def cmd_tasks_create_if_absent(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    proj_sel = _require_project_selector(args)
    fields = _parse_task_fields(args)
    if not fields.get("title"):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/tasks", message="fields.title is required.")
    project = resolve_project(client, proj_sel)
    web_url = client.config.vikunja_web_url
    title = fields["title"].strip()

    idem_key = args.get("idempotency_key", "")
    project_key = proj_sel.get("id") or (proj_sel.get("title", "").lower())
    cache_key = f"task-create-absent:{project_key}:{idem_key}" if idem_key else ""
    if cache_key:
        cached = _idempotency.get(cache_key)
        if cached:
            if cached.get("action") == "exists":
                return f"Task \"{cached['target']['title']}\" already exists.", cached
            return "Task created (idempotent replay).", cached

    # Search for existing
    exact_match = None
    if _is_filter_safe_title(title):
        f = f"title = {_escape_filter_string(title)}"
        path = f"/projects/{project['id']}/tasks?filter={url_quote(f)}&per_page=5"
        search_res = client.request("GET", path)
        items = to_item_array(search_res)
        exact_match = next(
            (t for t in items if t.get("title", "").strip().lower() == title.lower()), None)
    else:
        page, scanned, total = 1, 0, float("inf")
        while page <= 50 and scanned < total:
            path = f"/projects/{project['id']}/tasks?q={url_quote(title)}&page={page}&per_page=100"
            search_res = client.request("GET", path)
            items = to_item_array(search_res)
            pag = normalize_pagination(search_res)
            total = pag["total"] or len(items)
            scanned += len(items)
            exact_match = next(
                (t for t in items if t.get("title", "").strip().lower() == title.lower()), None)
            if exact_match:
                break
            if not pag["hasMore"] or not items:
                break
            page += 1
        if not exact_match and scanned < total:
            raise VikunjaError(
                status=409, code="EXACT_TITLE_SEARCH_INCOMPLETE", method="GET",
                path=f"/projects/{project['id']}/tasks",
                message=f'Could not prove absence of title "{title}" after scanning {scanned} of {int(total)} candidates.')

    if exact_match:
        task = normalize_task(exact_match, project, web_url)
        echo = _write_echo("exists", task)
        if cache_key:
            _idempotency.set(cache_key, echo)
        return f"Task \"{task['title']}\" already exists.", echo
    else:
        summary, echo = cmd_tasks_create(client, args)
        if cache_key:
            _idempotency.set(cache_key, echo)
        return summary, echo


def cmd_tasks_get(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    comment_limit = int(args.get("comment_limit", 5))
    task_ref = resolve_task(client, task_sel, proj_sel)
    web_url = client.config.vikunja_web_url
    composed_calls = []

    raw_task = client.request("GET", f"/tasks/{task_ref['id']}?expand=comments")
    task = normalize_task(raw_task, task_ref["project"], web_url)
    composed_calls.append(f"GET /tasks/{task['id']}?expand=comments")

    comments = []
    if comment_limit > 0:
        raw_comments = raw_task.get("comments")
        if not isinstance(raw_comments, list):
            composed_calls.append(f"GET /tasks/{task['id']}/comments")
            raw_comments = client.request("GET", f"/tasks/{task['id']}/comments")
        comments = normalize_dates_and_nulls(to_item_array(raw_comments))
        comments = [
            {"id": c.get("id"), "comment": html_to_markdown(c.get("comment", "")),
             "author": {"id": c.get("author", {}).get("id"),
                        "username": c.get("author", {}).get("username", "")},
             "created": c.get("created")}
            for c in comments
        ]
        comments.sort(key=lambda c: str(c.get("created") or ""), reverse=True)
        comments = comments[:comment_limit]

    composed_calls.append(f"GET /tasks/{task['id']}/attachments")
    raw_att = client.request("GET", f"/tasks/{task['id']}/attachments")
    attachments = [
        {"id": a["id"],
         "fileName": a.get("file", {}).get("name") or a.get("file_name", "unknown"),
         "mime": a.get("file", {}).get("mime") or a.get("mime", "application/octet-stream"),
         "fileSize": a.get("file", {}).get("size") or a.get("file_size", 0),
         "created": a.get("created")}
        for a in to_item_array(raw_att)
    ]
    return f"Task: {task['title']}", {
        "task": task, "comments": comments, "attachments": attachments,
        "composedCalls": composed_calls,
    }


def cmd_tasks_list(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    web_url = client.config.vikunja_web_url
    done = args.get("done")
    all_states = args.get("all_states", False)
    priority = args.get("priority")
    label = args.get("label")
    q = args.get("q", "")
    count_only = args.get("count_only", False)
    filter_str = args.get("filter", "")
    page = int(args.get("page", 1))
    per_page = int(args.get("per_page", 25))
    all_projects = args.get("all_projects", False)
    projects_arg = args.get("projects")
    proj_sel = _parse_project_selector(args)

    # Resolve label to ID if string
    resolved_label = label
    if label is not None and not isinstance(label, int):
        try:
            resolved_label = resolve_label(client, label)
        except VikunjaError:
            resolved_label = label

    scope_count = (1 if proj_sel else 0) + (1 if projects_arg else 0) + (1 if all_projects else 0)
    if scope_count > 1:
        raise VikunjaError(status=400, code="INVALID_SCOPE", method="GET", path="/tasks",
                           message='Specify exactly one of "project", "projects", or "allProjects".')
    if scope_count == 0:
        raise VikunjaError(status=400, code="SCOPE_REQUIRED", method="GET", path="/tasks",
                           message='List operation requires a scope: "project", "projects", or "allProjects".')

    projects_to_query: list = []
    if proj_sel:
        projects_to_query = [resolve_project(client, proj_sel)]
    elif projects_arg:
        if not projects_arg:
            raise VikunjaError(status=400, code="SCOPE_REQUIRED", method="GET", path="/tasks",
                               message='The explicit "projects" scope must contain at least one project.')
        resolved = [resolve_project(client, p) for p in projects_arg]
        seen = {}
        for p in resolved:
            seen[p["id"]] = p
        projects_to_query = list(seen.values())
    elif all_projects:
        all_projs = fetch_all_collection_items(client, "/projects")
        projects_to_query = [{"id": p["id"], "title": p["title"]} for p in all_projs]

    filter_s = _build_filter_string(
        done=done, all_states=all_states, priority=priority,
        label=resolved_label, filter_str=filter_str)

    results = []
    for proj in projects_to_query:
        qp = {"page": str(page),
               "per_page": str(1 if count_only else min(per_page, MAX_AGENT_PAGE_SIZE))}
        if q:
            qp["q"] = q
        if filter_s:
            qp["filter"] = filter_s
        qs = "&".join(f"{k}={url_quote(v)}" for k, v in qp.items())
        raw_res = client.request("GET", f"/projects/{proj['id']}/tasks?{qs}")
        pagination = normalize_pagination(raw_res)
        if count_only:
            results.append({"project": {"id": proj["id"], "title": proj["title"]},
                            "count": pagination["total"]})
        else:
            tasks = [normalize_task_list_item(t, proj, web_url) for t in to_item_array(raw_res)]
            results.append({"project": {"id": proj["id"], "title": proj["title"]},
                            "tasks": tasks, "pagination": pagination})

    if proj_sel and len(results) == 1:
        total = results[0].get("count", results[0].get("pagination", {}).get("total", 0))
        next_page = results[0].get("pagination", {}).get("nextPage")
        continuation = f" Next page: {next_page}." if next_page else ""
        return f"Listed tasks ({total} total).{continuation}", results[0]
    return f"Listed tasks across {len(results)} projects.", {"projects": results}


def cmd_tasks_update(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    fields = _parse_task_fields(args)
    expected_updated = args.get("expected_updated_at")

    task_ref = resolve_task(client, task_sel, proj_sel)
    web_url = client.config.vikunja_web_url
    current_raw = client.request("GET", f"/tasks/{task_ref['id']}")
    current_task = normalize_task(current_raw, task_ref["project"], web_url)

    if expected_updated:
        if (current_task.get("updated") or "") != expected_updated:
            raise VikunjaError(
                status=409, code="CONFLICT", method="PATCH", path=f"/tasks/{task_ref['id']}",
                message=(f'Task update conflict. Expected task state updated at "{expected_updated}", '
                         f'but current server state was updated at "{current_task.get("updated", "")}"'))

    body: dict = {}
    if "title" in fields and fields["title"] != current_task["title"]:
        body["title"] = fields["title"]
    if "description" in fields:
        html_desc = markdown_to_html(fields["description"])
        if html_desc != current_raw.get("description", ""):
            body["description"] = html_desc
    if "done" in fields and fields["done"] != current_task["done"]:
        body["done"] = fields["done"]
    if "priority" in fields and fields["priority"] != current_task["priority"]:
        body["priority"] = fields["priority"]
    if "dueDate" in fields:
        api_due = fields["dueDate"]
        if api_due != (current_raw.get("due_date") or None):
            body["due_date"] = api_due
    body.update(_extra_writable_fields(args))

    if body:
        patch_ops = [{"op": "replace", "path": f"/{field}", "value": value}
                     for field, value in body.items()]
        raw_updated = patch_task_fields(client, task_ref["id"], current_raw, patch_ops, body)
        task = normalize_task(raw_updated, task_ref["project"], web_url)
        if fields.get("done") is True and not current_task["done"]:
            action = "closed"
        elif fields.get("done") is False and current_task["done"]:
            action = "reopened"
        else:
            action = "updated"
        return f"Task {action}.", _write_echo(action, task)

    return "Task updated (no changes).", _write_echo("updated", current_task)


def cmd_tasks_delete(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    client.request("DELETE", f"/tasks/{task_ref['id']}")
    return f"Deleted task \"{task_ref['title']}\".", _write_echo("deleted", task_ref)


def cmd_tasks_close(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    args = dict(args)
    args["done"] = True
    return cmd_tasks_update(client, args)


def cmd_tasks_reopen(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    args = dict(args)
    args["done"] = False
    return cmd_tasks_update(client, args)


def cmd_tasks_close_with_evidence(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    evidence = args.get("evidence_comment", "")
    if not evidence:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/tasks", message="evidenceComment is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    composed = []

    # 1. Post evidence comment
    composed.append(f"POST /tasks/{task_ref['id']}/comments")
    html_comment = markdown_to_html(evidence)
    raw_comment = client.request("POST", f"/tasks/{task_ref['id']}/comments",
                                 body={"comment": html_comment})
    comment = {
        "id": raw_comment.get("id"),
        "comment": html_to_markdown(raw_comment.get("comment", "")),
        "author": {"id": raw_comment.get("author", {}).get("id"),
                   "username": raw_comment.get("author", {}).get("username", "unknown")},
        "created": raw_comment.get("created"),
    }

    # 2. Close task
    composed.append(f"PATCH /tasks/{task_ref['id']}")
    close_args = dict(args)
    close_args["done"] = True
    close_args["task_selector"] = task_ref["id"]
    _, task_echo = cmd_tasks_update(client, close_args)

    return "Task closed with evidence.", {
        "comment": comment, "task": task_echo, "composedCalls": composed}


def cmd_tasks_assign(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    user_sel = args.get("user_selector")
    if not user_sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/tasks", message="userSelector is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    user_id = resolve_user(client, user_sel)
    client.request("POST", f"/tasks/{task_ref['id']}/assignees", body={"user_id": user_id})
    return "User assigned.", _write_echo("updated", task_ref)


def cmd_tasks_unassign(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    user_sel = args.get("user_selector")
    if not user_sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="DELETE",
                           path="/tasks", message="userSelector is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    user_id = resolve_user(client, user_sel)
    client.request("DELETE", f"/tasks/{task_ref['id']}/assignees/{user_id}")
    return "User unassigned.", _write_echo("updated", task_ref)


def cmd_tasks_list_assignees(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    res = client.request("GET", f"/tasks/{task_ref['id']}/assignees")
    assignees = [{"id": u.get("id"), "username": u.get("username", "")} for u in to_item_array(res)]
    return f"Found {len(assignees)} assignees.", assignees


def cmd_tasks_apply_label(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    label_title = args.get("label_title", "")
    if not label_title:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/tasks", message="labelTitle is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    
    existing_labels = task_ref.get("labels", [])
    if any(l.get("title", "").lower() == label_title.lower() for l in existing_labels):
        return "Label unchanged.", _write_echo("unchanged", task_ref)
        
    label_id = resolve_or_create_label(client, label_title)
    if any(l.get("id") == label_id for l in existing_labels):
        return "Label unchanged.", _write_echo("unchanged", task_ref)
        
    client.request("POST", f"/tasks/{task_ref['id']}/labels", body={"label_id": label_id})
    return "Label applied.", _write_echo("updated", task_ref)


def cmd_tasks_remove_label(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    label_title = args.get("label_title", "")
    if not label_title:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="DELETE",
                           path="/tasks", message="labelTitle is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    label_id = resolve_label(client, label_title)
    client.request("DELETE", f"/tasks/{task_ref['id']}/labels/{label_id}")
    return "Label removed.", _write_echo("updated", task_ref)


def cmd_tasks_list_labels(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    res = client.request("GET", f"/tasks/{task_ref['id']}/labels")
    labels = [{"id": l.get("id"), "title": l.get("title", "")} for l in to_item_array(res)]
    return f"Found {len(labels)} labels.", labels


def cmd_tasks_relate(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    other_sel = args.get("other_task_selector")
    kind = args.get("relation_kind", "")
    if not other_sel or not kind:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/tasks", message="otherTaskSelector and relationKind are required.")
    if kind not in VALID_RELATION_KINDS:
        raise VikunjaError(status=400, code="INVALID_RELATION_KIND", method="POST",
                           path=f"/tasks/{task_sel}/relations",
                           message=f'Invalid relation kind: "{kind}". Valid: {", ".join(VALID_RELATION_KINDS)}')
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    other_proj = proj_sel if not re.match(r"^\d+$", str(other_sel).strip()) else None
    other_ref = resolve_task(client, other_sel, other_proj)
    client.request("POST", f"/tasks/{task_ref['id']}/relations",
                   body={"other_task_id": other_ref["id"], "relation_kind": kind})
    return "Relation created.", _write_echo("updated", task_ref)


def cmd_tasks_unrelate(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    other_sel = args.get("other_task_selector")
    kind = args.get("relation_kind", "")
    if not other_sel or not kind:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="DELETE",
                           path="/tasks", message="otherTaskSelector and relationKind are required.")
    if kind not in VALID_RELATION_KINDS:
        raise VikunjaError(status=400, code="INVALID_RELATION_KIND", method="DELETE",
                           path=f"/tasks/{task_sel}/relations",
                           message=f'Invalid relation kind: "{kind}". Valid: {", ".join(VALID_RELATION_KINDS)}')
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    other_proj = proj_sel if not re.match(r"^\d+$", str(other_sel).strip()) else None
    other_ref = resolve_task(client, other_sel, other_proj)
    client.request("DELETE", f"/tasks/{task_ref['id']}/relations/{kind}/{other_ref['id']}")
    return "Relation removed.", _write_echo("updated", task_ref)


def cmd_tasks_list_relations(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    web_url = client.config.vikunja_web_url
    raw_task = client.request("GET", f"/tasks/{task_ref['id']}")
    related = raw_task.get("related_tasks") or {}
    relations = []
    project_cache = {task_ref["project"]["id"]: task_ref["project"]}
    for kind, task_list in related.items():
        if isinstance(task_list, list):
            for t in task_list:
                pid = t.get("project_id") or t.get("project", {}).get("id") or task_ref["project"]["id"]
                proj = project_cache.get(pid)
                if not proj:
                    if t.get("project", {}).get("title"):
                        proj = {"id": pid, "title": t["project"]["title"]}
                    else:
                        proj = resolve_project(client, {"id": pid})
                    project_cache[pid] = proj
                relations.append({"relationKind": kind,
                                  "task": normalize_task(t, proj, web_url)})
    return f"Found {len(relations)} relations.", relations



def decode_base64(base64_content: str, path_url: str) -> bytes:
    normalized = re.sub(r"\s+", "", base64_content)
    if not re.match(r"^[A-Za-z0-9+/]*={0,2}$", normalized):
        raise VikunjaError(status=400, code="INVALID_BASE64", method="POST",
                           path=path_url, message="Content is not valid base64 encoded data.")
    try:
        import base64 as b64_mod
        buf = b64_mod.b64decode(normalized)
    except Exception:
        raise VikunjaError(status=400, code="INVALID_BASE64", method="POST",
                           path=path_url, message="Content is not valid base64 encoded data.")
    
    reencoded = b64_mod.b64encode(buf).decode("ascii")
    if reencoded.rstrip("=") != normalized.rstrip("="):
        raise VikunjaError(status=400, code="INVALID_BASE64", method="POST",
                           path=path_url, message="Content is not valid base64 encoded data.")
    if len(buf) == 0:
        raise VikunjaError(status=400, code="INVALID_BASE64", method="POST",
                           path=path_url, message="Content is not valid base64 encoded data.")
    return buf


def _attach_files_to_echo(client: VikunjaApiClient, echo: dict, file_paths: list) -> dict:
    if not file_paths:
        return echo
    uploaded = []
    failed = []
    max_bytes = client.config.max_attachment_bytes
    for fp in file_paths:
        try:
            stat = os.stat(fp)
            if not os.path.isfile(fp):
                raise VikunjaError(status=400, code="INVALID_CONTENT", method="POST",
                                   path=f"/tasks/{echo['target']['id']}/attachments",
                                   message=f'Attachment path "{fp}" is not a regular file.')
            if stat.st_size > max_bytes:
                raise VikunjaError(
                    status=413, code="ATTACHMENT_TOO_LARGE", method="POST",
                    path=f"/tasks/{echo['target']['id']}/attachments",
                    message=f'Attachment "{fp}" is {stat.st_size} bytes, exceeding the {max_bytes}-byte limit.')
            with open(fp, "rb") as f:
                buf = f.read()
            fn = os.path.basename(fp)
            mt = mime_type = infer_mime_type(fn)
            uploaded.append(_upload_buffer_to_task(client, echo['target']['id'], fn, mt, buf))
        except Exception as e:
            failed.append({"file": fp, "error": redact_secrets(str(e), client.config.vikunja_token)})
    echo["attachments"] = uploaded
    if failed:
        echo["attachmentErrors"] = failed
    return echo


def cmd_tasks_attach(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    max_bytes = client.config.max_attachment_bytes

    # file paths mode
    file_paths = args.get("file_paths", [])
    b64 = args.get("base64_content", "")
    filename = args.get("filename", "")
    mime = args.get("mime_type", "")

    uploaded = []
    failed = []

    if file_paths:
        for fp in file_paths:
            try:
                stat = os.stat(fp)
                if not os.path.isfile(fp):
                    raise VikunjaError(status=400, code="INVALID_CONTENT", method="POST",
                                       path=f"/tasks/{task_ref['id']}/attachments",
                                       message=f'Attachment path "{fp}" is not a regular file.')
                if stat.st_size > max_bytes:
                    raise VikunjaError(
                        status=413, code="ATTACHMENT_TOO_LARGE", method="POST",
                        path=f"/tasks/{task_ref['id']}/attachments",
                        message=f'Attachment "{fp}" is {stat.st_size} bytes, exceeding the {max_bytes}-byte limit.')
                with open(fp, "rb") as f:
                    buf = f.read()
                fn = os.path.basename(fp)
                mt = mime or infer_mime_type(fn)
                uploaded.append(_upload_buffer_to_task(client, task_ref["id"], fn, mt, buf))
            except Exception as e:
                failed.append({"file": fp, "error": redact_secrets(str(e), client.config.vikunja_token)})
    elif b64:
        if not filename:
            raise VikunjaError(status=400, code="INVALID_FILENAME", method="POST",
                               path=f"/tasks/{task_ref['id']}/attachments",
                               message="filename is required when using base64Content.")
        try:
            path_url = f"/tasks/{task_ref['id']}/attachments"
            buf = decode_base64(b64, path_url)
        except VikunjaError:
            raise
        except Exception:
            raise VikunjaError(status=400, code="INVALID_BASE64", method="POST",
                               path=f"/tasks/{task_ref['id']}/attachments",
                               message="Content is not valid base64 encoded data.")
        if len(buf) > max_bytes:
            raise VikunjaError(status=413, code="ATTACHMENT_TOO_LARGE", method="POST",
                               path=f"/tasks/{task_ref['id']}/attachments",
                               message=f'Attachment "{filename}" is {len(buf)} bytes, exceeding limit.')
        mt = mime or infer_mime_type(filename)
        uploaded.append(_upload_buffer_to_task(client, task_ref["id"], filename, mt, buf))
    else:
        raise VikunjaError(status=400, code="INVALID_CONTENT", method="POST",
                           path="/attachments", message="Provide filePaths or base64Content+filename.")

    result = {"uploaded": uploaded}
    if failed:
        result["failed"] = failed
    return f"Attached {len(uploaded)} files.", result


def cmd_tasks_list_attachments(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    raw = client.request("GET", f"/tasks/{task_ref['id']}/attachments")
    atts = [
        {"id": a["id"],
         "fileName": a.get("file", {}).get("name") or a.get("file_name", "unknown"),
         "mime": a.get("file", {}).get("mime") or a.get("mime", "application/octet-stream"),
         "fileSize": a.get("file", {}).get("size") or a.get("file_size", 0),
         "created": a.get("created")}
        for a in to_item_array(raw)
    ]
    return f"Found {len(atts)} attachments.", atts


def cmd_tasks_download_attachment(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    att_id = args.get("attachment_id")
    if not att_id:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="GET",
                           path="/attachments", message="attachmentId is required.")
    att_id = int(att_id)
    proj_sel = _parse_project_selector(args)
    dest_path = args.get("destination_path", "")
    overwrite = args.get("overwrite", False)

    task_ref = resolve_task(client, task_sel, proj_sel)
    config = client.config
    dl_root = config.attachment_download_root
    max_bytes = config.max_attachment_bytes

    if dest_path and dest_path.strip():
        safe_dest = resolve_safe_path(dl_root, dest_path)
        file_name = os.path.basename(safe_dest)
    else:
        raw_atts = client.request("GET", f"/tasks/{task_ref['id']}/attachments")
        meta = next((a for a in to_item_array(raw_atts) if a.get("id") == att_id), None)
        file_name = (meta.get("file", {}).get("name") or meta.get("file_name", "")) if meta else ""
        if not file_name or file_name == "unknown":
            file_name = f"attachment-{att_id}"
        safe_dest = resolve_safe_path(
            dl_root, os.path.join(str(task_ref["id"]), str(att_id), file_name))

    if not overwrite and os.path.exists(safe_dest):
        raise VikunjaError(
            status=409, code="FILE_EXISTS", method="GET",
            path=f"/tasks/{task_ref['id']}/attachments/{att_id}",
            message=f'Refusing to overwrite existing file "{safe_dest}". Pass overwrite=true to replace it.')

    resp = client.request("GET", f"/tasks/{task_ref['id']}/attachments/{att_id}", is_stream=True)
    cl = resp.headers.get("Content-Length")
    if cl:
        advertised = int(cl)
        if advertised > max_bytes:
            raise VikunjaError(
                status=413, code="ATTACHMENT_TOO_LARGE", method="GET",
                path=f"/tasks/{task_ref['id']}/attachments/{att_id}",
                message=f"Attachment is {advertised} bytes, exceeding the {max_bytes}-byte download limit.")

    os.makedirs(os.path.dirname(safe_dest), exist_ok=True)
    h = hashlib.sha256()
    size = 0
    try:
        with open(safe_dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                size += len(chunk)
                if size > max_bytes:
                    raise VikunjaError(
                        status=413, code="ATTACHMENT_TOO_LARGE", method="GET",
                        path=f"/tasks/{task_ref['id']}/attachments/{att_id}",
                        message=f"Attachment is {size} bytes, exceeding limit.")
                h.update(chunk)
                f.write(chunk)
    except VikunjaError:
        try:
            os.unlink(safe_dest)
        except OSError:
            pass
        raise

    if cl and size != int(cl):
        os.unlink(safe_dest)
        raise VikunjaError(
            status=500, code="SIZE_MISMATCH", method="GET",
            path=f"/tasks/{task_ref['id']}/attachments/{att_id}",
            message=f"Downloaded size ({size}) does not match Content-Length ({cl}).")

    return "Attachment downloaded.", {
        "success": True, "path": safe_dest, "fileName": file_name,
        "mime": infer_mime_type(file_name), "size": size, "checksum": h.hexdigest(),
        "taskId": task_ref["id"], "attachmentId": att_id,
        "attachmentUrl": f"{config.vikunja_url}/tasks/{task_ref['id']}/attachments/{att_id}",
        "taskUrl": f"{config.vikunja_web_url}tasks/{task_ref['id']}",
    }


# --- vikunja_task_comments ---

def cmd_comments_create(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    comment_text = args.get("comment", "")
    if not comment_text:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/comments", message="comment is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    
    idem_key = args.get("idempotency_key", "")
    project_key = proj_sel.get("id") or (proj_sel.get("title", "").lower()) if proj_sel else "missing"
    cache_key = f"comment-create:{project_key}:{task_ref['id']}:{idem_key}" if idem_key else ""
    if cache_key:
        cached = _idempotency.get(cache_key)
        if cached:
            return "Comment created (idempotent replay).", cached

    html = markdown_to_html(comment_text)
    raw = client.request("POST", f"/tasks/{task_ref['id']}/comments", body={"comment": html})
    comment_data = {
        "id": raw.get("id"), "comment": html_to_markdown(raw.get("comment", "")),
        "author": {"id": raw.get("author", {}).get("id"),
                   "username": raw.get("author", {}).get("username", "unknown")},
        "created": raw.get("created"),
    }
    if cache_key:
        _idempotency.set(cache_key, comment_data)
    return "Comment created.", comment_data


def cmd_comments_list(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    raw = client.request("GET", f"/tasks/{task_ref['id']}/comments")
    comments = [
        {"id": c.get("id"), "comment": html_to_markdown(c.get("comment", "")),
         "author": {"id": c.get("author", {}).get("id"),
                    "username": c.get("author", {}).get("username", "unknown")},
         "created": c.get("created")}
        for c in to_item_array(raw)
    ]
    return f"Found {len(comments)} comments.", comments


def cmd_comments_get(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    cid = args.get("comment_id")
    if not cid:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="GET",
                           path="/comments", message="commentId is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    c = client.request("GET", f"/tasks/{task_ref['id']}/comments/{cid}")
    return "Comment fetched.", {
        "id": c.get("id"), "comment": html_to_markdown(c.get("comment", "")),
        "author": {"id": c.get("author", {}).get("id"),
                   "username": c.get("author", {}).get("username", "unknown")},
        "created": c.get("created"),
    }


def cmd_comments_update(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    cid = args.get("comment_id")
    comment_text = args.get("comment", "")
    if not cid or not comment_text:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="PATCH",
                           path="/comments", message="commentId and comment are required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    html = markdown_to_html(comment_text)
    c = client.request("PATCH", f"/tasks/{task_ref['id']}/comments/{cid}",
                       body={"comment": html},
                       headers={"Content-Type": "application/merge-patch+json"})
    return "Comment updated.", {
        "id": c.get("id"), "comment": html_to_markdown(c.get("comment", "")),
        "author": {"id": c.get("author", {}).get("id"),
                   "username": c.get("author", {}).get("username", "unknown")},
        "created": c.get("created"),
    }


def cmd_comments_delete(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    cid = args.get("comment_id")
    if not cid:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="DELETE",
                           path="/comments", message="commentId is required.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    client.request("DELETE", f"/tasks/{task_ref['id']}/comments/{cid}")
    return "Comment deleted.", {"ok": True, "commentId": int(cid)}


# --- vikunja_labels ---

def cmd_labels_list(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    items = fetch_all_collection_items(client, "/labels")
    labels = [{"id": l["id"], "title": l.get("title", ""), "description": l.get("description"),
               "hexColor": l.get("hex_color")} for l in items]
    return f"Found {len(labels)} labels.", labels


def cmd_labels_get(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    sel = args.get("label_selector")
    if not sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="GET",
                           path="/labels", message="labelSelector is required.")
    lid = resolve_label(client, sel)
    label = client.request("GET", f"/labels/{lid}")
    return f"Label: {label.get('title', '')}", normalize_dates_and_nulls(label)


def cmd_labels_create(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    title = args.get("title", "")
    if not title:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/labels", message="title is required.")
    body: dict = {"title": title}
    if args.get("description"):
        body["description"] = args["description"]
    if args.get("hex_color"):
        body["hex_color"] = args["hex_color"]
    label = client.request("POST", "/labels", body=body)
    return f"Created label \"{title}\".", normalize_dates_and_nulls(label)


def cmd_labels_update(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    sel = args.get("label_selector")
    if not sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="PATCH",
                           path="/labels", message="labelSelector is required.")
    lid = resolve_label(client, sel)
    body: dict = {}
    if args.get("title"):
        body["title"] = args["title"]
    if args.get("description") is not None:
        body["description"] = args["description"]
    if args.get("hex_color"):
        body["hex_color"] = args["hex_color"]
    label = client.request("PATCH", f"/labels/{lid}", body=body,
                           headers={"Content-Type": "application/merge-patch+json"})
    return "Label updated.", normalize_dates_and_nulls(label)


def cmd_labels_delete(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    sel = args.get("label_selector")
    if not sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="DELETE",
                           path="/labels", message="labelSelector is required.")
    lid = resolve_label(client, sel)
    client.request("DELETE", f"/labels/{lid}")
    return "Label deleted.", {"ok": True, "labelId": lid}


# --- vikunja_users ---

def cmd_users_current(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    user = client.request("GET", "/user")
    return "Current user.", normalize_dates_and_nulls(user)


def cmd_users_search(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    q = args.get("q", "")
    items = fetch_all_collection_items(client, f"/users?q={url_quote(q)}")
    users = [{"id": u["id"], "username": u.get("username", "")} for u in items]
    return f"Found {len(users)} users.", users


# --- vikunja_teams ---

def cmd_teams_list(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    items = fetch_all_collection_items(client, "/teams")
    teams = [{"id": t["id"], "name": t.get("name", ""), "created": t.get("created"),
              "updated": t.get("updated")} for t in items]
    return f"Found {len(teams)} teams.", teams


def cmd_teams_get(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    tid = _require_int(args, "team_id", "teamId")
    raw = client.request("GET", f"/teams/{tid}")
    members = [
        {"userId": m.get("id"), "username": m.get("username", ""),
         "admin": bool(m.get("admin")), "created": m.get("created")}
        for m in (raw.get("members") or [])
    ]
    return f"Team: {raw.get('name', '')}", {
        "id": raw["id"], "name": raw.get("name", ""),
        "created": raw.get("created"), "updated": raw.get("updated"),
        "members": members,
    }


def cmd_teams_create(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    name = args.get("name", "")
    if not name:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/teams", message="name is required.")
    team = client.request("POST", "/teams", body={"name": name})
    return f"Created team \"{name}\".", team


def cmd_teams_update(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    tid = _require_int(args, "team_id", "teamId")
    name = args.get("name", "")
    if not name:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="PATCH",
                           path=f"/teams/{tid}", message="name is required.")
    team = client.request("PATCH", f"/teams/{tid}", body={"name": name},
                          headers={"Content-Type": "application/merge-patch+json"})
    return "Team updated.", team


def cmd_teams_delete(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    tid = _require_int(args, "team_id", "teamId")
    client.request("DELETE", f"/teams/{tid}")
    return "Team deleted.", {"ok": True, "teamId": tid}


def cmd_teams_add_member(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    tid = _require_int(args, "team_id", "teamId")
    uoi = args.get("username_or_id", "")
    if not uoi:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path=f"/teams/{tid}/members", message="usernameOrId is required.")
    sel = str(uoi).strip()
    if re.match(r"^\d+$", sel):
        raise VikunjaError(
            status=400, code="USERNAME_REQUIRED", method="POST",
            path=f"/teams/{tid}/members",
            message=f'Adding a team member requires a username; the Vikunja v2 API has no lookup by numeric id (received "{sel}").')
    client.request("POST", f"/teams/{tid}/members", body={"username": sel})
    # Re-read for authoritative member data
    _, team_data = cmd_teams_get(client, args)
    found = next((m for m in team_data.get("members", [])
                  if str(m.get("username", "")).lower() == sel.lower()), None)
    if found:
        return "Member added.", found
    return "Member added (verify with get).", {"username": sel}


def cmd_teams_remove_member(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    tid = _require_int(args, "team_id", "teamId")
    uoi = args.get("username_or_id", "")
    if not uoi:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="DELETE",
                           path=f"/teams/{tid}/members", message="usernameOrId is required.")
    sel = str(uoi).strip()
    username = sel
    if re.match(r"^\d+$", sel):
        _, team_data = cmd_teams_get(client, args)
        member = next((m for m in team_data.get("members", []) if m.get("userId") == int(sel)), None)
        if not member:
            raise VikunjaError(status=404, code="MEMBER_NOT_FOUND", method="DELETE",
                               path=f"/teams/{tid}/members/{sel}",
                               message=f"No member with user id {sel} in team {tid}.")
        username = member["username"]
    client.request("DELETE", f"/teams/{tid}/members/{url_quote(username)}")
    return "Member removed.", {"ok": True, "username": username}


def cmd_teams_set_member_admin(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    tid = _require_int(args, "team_id", "teamId")
    uoi = args.get("username_or_id", "")
    admin_val = args.get("admin")
    if not uoi or admin_val is None:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path=f"/teams/{tid}/members", message="usernameOrId and admin are required.")
    _, team_data = cmd_teams_get(client, args)
    members = team_data.get("members", [])
    sel = str(uoi).strip()
    if re.match(r"^\d+$", sel):
        member = next((m for m in members if m.get("userId") == int(sel)), None)
    else:
        member = next((m for m in members if str(m.get("username", "")).lower() == sel.lower()), None)
    if not member:
        raise VikunjaError(status=404, code="MEMBER_NOT_FOUND", method="POST",
                           path=f"/teams/{tid}/members/{sel}/admin",
                           message=f'Member "{uoi}" is not in team {tid}.')
    if member.get("admin") == admin_val:
        return "Admin status unchanged.", member
    client.request("POST", f"/teams/{tid}/members/{url_quote(member['username'])}/admin")
    _, refreshed = cmd_teams_get(client, args)
    found = next((m for m in refreshed.get("members", [])
                  if str(m.get("username", "")).lower() == member["username"].lower()), None)
    return "Admin status toggled.", found or {**member, "admin": admin_val}


# --- vikunja_filters ---

def cmd_filters_create(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    title = args.get("title", "")
    fq = args.get("filter_query", "")
    if not title or not fq:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/filters", message="title and filterQuery are required.")
    body: dict = {"title": title, "filters": fq}
    if args.get("description") is not None:
        body["description"] = args["description"]
    if args.get("is_favorite") is not None:
        body["is_favorite"] = args["is_favorite"]
    f = client.request("POST", "/filters", body=body)
    return f"Created filter \"{title}\".", normalize_dates_and_nulls(f)


def cmd_filters_get(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    fid = _require_int(args, "filter_id", "filterId")
    f = client.request("GET", f"/filters/{fid}")
    return f"Filter: {f.get('title', '')}", normalize_dates_and_nulls(f)


def cmd_filters_update(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    fid = _require_int(args, "filter_id", "filterId")
    body: dict = {}
    if args.get("title"):
        body["title"] = args["title"]
    if args.get("filter_query") is not None:
        body["filters"] = args["filter_query"]
    if args.get("description") is not None:
        body["description"] = args["description"]
    if args.get("is_favorite") is not None:
        body["is_favorite"] = args["is_favorite"]
    f = client.request("PATCH", f"/filters/{fid}", body=body,
                       headers={"Content-Type": "application/merge-patch+json"})
    return "Filter updated.", normalize_dates_and_nulls(f)


def cmd_filters_delete(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    fid = _require_int(args, "filter_id", "filterId")
    client.request("DELETE", f"/filters/{fid}")
    return "Filter deleted.", {"ok": True, "filterId": fid}


# --- vikunja_task_bulk ---

def cmd_bulk_update(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_ids = args.get("task_ids", [])
    fields = _parse_task_fields(args)
    extra_fields = _extra_writable_fields(args)
    if not task_ids or (not fields and not extra_fields):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="PUT",
                           path="/tasks/bulk", message="Bulk update requires taskIds and at least one field.")
    api_fields = {}
    if "title" in fields:
        api_fields["title"] = fields["title"]
    if "description" in fields:
        api_fields["description"] = markdown_to_html(fields["description"])
    if "done" in fields:
        api_fields["done"] = fields["done"]
    if "priority" in fields:
        api_fields["priority"] = fields["priority"]
    if "dueDate" in fields:
        api_fields["due_date"] = fields["dueDate"]
    api_fields.update(extra_fields)
    resp = client.request("PUT", "/tasks/bulk", body={
        "task_ids": task_ids, "fields": list(api_fields.keys()), "values": api_fields})
    updated = []
    for t in (resp.get("tasks") or []) if isinstance(resp, dict) else []:
        dd = t.get("due_date")
        updated.append({
            "id": t["id"], "index": t.get("index"),
            "identifier": t.get("identifier") or f"#{t.get('index','')}",
            "projectId": t.get("project_id"),
            "title": t.get("title"), "done": bool(t.get("done")),
            "priority": t.get("priority", 0),
            "dueDate": None if not dd or str(dd).startswith("0001-01-01") else dd,
        })
    return f"Bulk updated {len(updated)} tasks.", {"requested": len(task_ids), "updated": updated}


def cmd_bulk_create(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    proj_sel = _require_project_selector(args)
    tasks = args.get("tasks", [])
    if not tasks or len(tasks) > 100:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="arguments", message="Bulk create requires 1-100 tasks, each with a title.")
    for t in tasks:
        if not t.get("title"):
            raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                               path="arguments", message="Each task requires a title.")
    created = []
    for t in tasks:
        task_args = dict(args)
        task_args.update(t)
        _, echo = cmd_tasks_create(client, task_args)
        created.append(echo)
    return f"Bulk created {len(created)} tasks.", created


def cmd_bulk_delete(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_ids = args.get("task_ids", [])
    confirm = args.get("confirm", False)
    if not task_ids or len(task_ids) > 100:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="arguments", message="Bulk delete requires 1-100 task IDs.")
    if not confirm:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="arguments", message="Bulk delete requires confirm=true.")
    deleted = []
    for tid in task_ids:
        task_args = {"task_selector": tid}
        _, echo = cmd_tasks_delete(client, task_args)
        deleted.append(echo)
    return f"Bulk deleted {len(deleted)} tasks.", deleted


# --- vikunja_task_reminders ---

def cmd_reminders_list(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    raw = client.request("GET", f"/tasks/{task_ref['id']}")
    reminders = [
        {"reminder": r.get("reminder"), "relativePeriod": r.get("relative_period"),
         "relativeTo": r.get("relative_to")}
        for r in (raw.get("reminders") or [])
    ]
    return f"Found {len(reminders)} reminders.", reminders


def cmd_reminders_add(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    reminder = args.get("reminder")
    rel_period = args.get("relative_period")
    rel_to = args.get("relative_to")
    if not reminder and rel_period is None:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="arguments", message="Provide an absolute reminder or relativePeriod.")
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    raw = client.request("GET", f"/tasks/{task_ref['id']}")
    reminders = list(raw.get("reminders") or [])
    new_r: dict = {}
    if reminder:
        new_r["reminder"] = reminder
    if rel_period is not None:
        new_r["relative_period"] = rel_period
    if rel_to:
        new_r["relative_to"] = rel_to
    reminders.append(new_r)
    patch_task_fields(client, task_ref["id"], raw,
                      [{"op": "replace", "path": "/reminders", "value": reminders}],
                      {"reminders": reminders})
    result = [
        {"reminder": r.get("reminder"), "relativePeriod": r.get("relative_period"),
         "relativeTo": r.get("relative_to")}
        for r in reminders
    ]
    return "Reminder added.", result


def cmd_reminders_remove(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    task_sel = _require_task_selector(args)
    idx = args.get("reminder_index")
    if idx is None:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="arguments", message="reminderIndex is required.")
    idx = int(idx)
    proj_sel = _parse_project_selector(args)
    task_ref = resolve_task(client, task_sel, proj_sel)
    raw = client.request("GET", f"/tasks/{task_ref['id']}")
    reminders = list(raw.get("reminders") or [])
    if idx < 0 or idx >= len(reminders):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="arguments", message="reminderIndex is out of range.")
    reminders = [r for i, r in enumerate(reminders) if i != idx]
    patch_task_fields(client, task_ref["id"], raw,
                      [{"op": "replace", "path": "/reminders", "value": reminders}],
                      {"reminders": reminders})
    result = [
        {"reminder": r.get("reminder"), "relativePeriod": r.get("relative_period"),
         "relativeTo": r.get("relative_to")}
        for r in reminders
    ]
    return "Reminder removed.", result


# --- vikunja_batch_import ---

def cmd_import_detect(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    fp = args.get("file_path", "")
    if not fp:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/migration/csv/detect", message="filePath is required.")
    data = _csv_request(client, "detect", fp)
    return "CSV detected.", data


def cmd_import_preview(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    fp = args.get("file_path", "")
    config_data = args.get("config")
    if not fp:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/migration/csv/preview", message="filePath is required.")
    data = _csv_request(client, "preview", fp, config_data)
    return "CSV preview.", data


def cmd_import_start(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    fp = args.get("file_path", "")
    config_data = args.get("config")
    if not fp:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/migration/csv/migrate", message="filePath is required.")
    data = _csv_request(client, "migrate", fp, config_data)
    return "CSV import started.", {"started": True, "message": data.get("message", "CSV import completed.")}


def cmd_import_status(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    val = client.request("GET", "/migration/csv/status")
    dd = lambda v: None if not v or str(v).startswith("0001-01-01") else str(v)
    return "Import status.", {
        "id": val.get("id"), "migratorName": val.get("migrator_name", "csv"),
        "startedAt": dd(val.get("started_at")), "finishedAt": dd(val.get("finished_at")),
    }


def _csv_request(client: VikunjaApiClient, action: str, file_path: str,
                  config_data=None) -> dict:
    if not os.path.isfile(file_path):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="filePath", message="CSV import file does not exist or cannot be read.")
    size = os.path.getsize(file_path)
    if size > client.config.max_attachment_bytes:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="filePath", message="CSV import file exceeds the configured size limit.")
    with open(file_path, "rb") as f:
        file_bytes = f.read()
    boundary = f"----VikunjaMcpBoundary{os.urandom(16).hex()}"
    parts = []
    if config_data is not None:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="config"\r\n\r\n{json.dumps(config_data)}\r\n'.encode())
    safe_name = os.path.basename(file_path).replace('"', '_').replace('\r', '_').replace('\n', '_')
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="import"; filename="{safe_name}"\r\nContent-Type: text/csv\r\n\r\n'.encode())
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)
    return client.request("POST", f"/migration/csv/{action}", body=body,
                          headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                          is_multipart=True)


# --- vikunja_export_project ---

def cmd_export_project(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    proj_sel = _require_project_selector(args)
    fmt = args.get("format", "json")
    dest = args.get("destination_path", "")
    include_comments = bool(args.get("include_comments"))

    project = resolve_project(client, proj_sel)
    raw_tasks = fetch_all_collection_items(client, f"/projects/{project['id']}/tasks")
    dd = lambda v: None if not v or str(v).startswith("0001-01-01") else str(v)
    tasks = [
        {"id": t["id"], "index": t.get("index"), "identifier": t.get("identifier"),
         "title": t.get("title", ""), "description": html_to_markdown(t.get("description", "")) if t.get("description") else "",
         "done": bool(t.get("done")), "priority": t.get("priority", 0),
         "dueDate": dd(t.get("due_date")),
         "creator": ({"id": t["created_by"].get("id"),
                      "username": t["created_by"].get("username", "")}
                     if isinstance(t.get("created_by"), dict) else None),
         "labels": [l.get("title", "") for l in (t.get("labels") or [])],
         "assignees": [u.get("username", "") for u in (t.get("assignees") or [])]}
        for t in raw_tasks
    ]
    if include_comments:
        for task in tasks:
            comments = fetch_all_collection_items(client, f"/tasks/{task['id']}/comments")
            task["comments"] = [
                {
                    "id": c.get("id"),
                    "comment": html_to_markdown(c.get("comment", "")),
                    "author": ({"id": c["author"].get("id"),
                                "username": c["author"].get("username", "")}
                               if isinstance(c.get("author"), dict) else None),
                    "created": dd(c.get("created")),
                    "updated": dd(c.get("updated")),
                }
                for c in comments
            ]
    file_name = dest or f"project-{project['id']}-tasks.{fmt}"
    destination = resolve_safe_path(client.config.attachment_download_root, file_name)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    if fmt == "json":
        with open(destination, "x", encoding="utf-8") as f:
            json.dump({"project": project, "tasks": tasks}, f, indent=2)
    else:
        header = ["id", "index", "identifier", "title", "description", "done",
                   "priority", "dueDate", "creatorId", "creatorUsername",
                   "labels", "assignees"]
        if include_comments:
            header.append("comments")
        with open(destination, "x", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(header)
            for t in tasks:
                row = {**t,
                       "creatorId": (t.get("creator") or {}).get("id", ""),
                       "creatorUsername": (t.get("creator") or {}).get("username", "")}
                if include_comments:
                    row["comments"] = json.dumps(t.get("comments", []))
                w.writerow([row.get(h) if not isinstance(row.get(h), list)
                            else ";".join(row[h]) for h in header])
    return "Project exported.", {"project": project, "format": fmt, "path": destination,
                                 "taskCount": len(tasks)}


# --- vikunja_request_user_export ---

def cmd_request_user_export(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    pw = args.get("password", "")
    val = client.request("POST", "/user/export/request", body={"password": pw})
    return "User export requested.", {"requested": True, "message": val.get("message", "User export requested.")}


# --- vikunja_download_user_export ---

def cmd_user_export_status(client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    val = client.request("GET", "/user/export")
    if not val:
        return "No export available.", {"available": False}
    return "Export available.", {"available": True, "id": val.get("id"),
                                 "size": val.get("size"),
                                 "created": val.get("created"),
                                 "expires": val.get("expires")}


def cmd_user_export_download(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    pw = args.get("password", "")
    dest = args.get("destination_path", "vikunja-user-export.zip")
    root = client.config.attachment_download_root
    destination = resolve_safe_path(root, dest)
    max_bytes = client.config.max_attachment_bytes

    resp = client.request("POST", "/user/export/download",
                          body={"password": pw}, is_stream=True)
    cl = resp.headers.get("Content-Length")
    if cl and int(cl) > max_bytes:
        raise VikunjaError(status=413, code="ATTACHMENT_TOO_LARGE", method="POST",
                           path="/user/export/download",
                           message=f"User export is {cl} bytes, exceeding the {max_bytes}-byte limit.")
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    size = 0
    with open(destination, "xb") as f:
        for chunk in resp.iter_content(chunk_size=8192):
            size += len(chunk)
            if size > max_bytes:
                raise VikunjaError(status=413, code="ATTACHMENT_TOO_LARGE", method="POST",
                                   path="/user/export/download",
                                   message=f"User export is {size} bytes, exceeding limit.")
            f.write(chunk)
    return "User export downloaded.", {"path": destination, "size": size}


# --- vikunja_templates ---

def _get_template_store() -> "TemplateStore":
    return TemplateStore()


class TemplateStore:
    def __init__(self):
        self.file_path = os.environ.get(
            "VIKUNJA_TEMPLATE_FILE",
            os.path.join(os.path.expanduser("~"), ".vikunja-fastmcp", "templates.json"))

    def _read(self) -> list:
        try:
            with open(self.file_path, "r") as f:
                val = json.load(f)
            return val if isinstance(val, list) else []
        except FileNotFoundError:
            return []

    def _write(self, templates: list):
        os.makedirs(os.path.dirname(self.file_path), exist_ok=True)
        tmp = f"{self.file_path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(templates, f, indent=2)
        os.replace(tmp, self.file_path)

    def create(self, name: str, fields: dict) -> dict:
        templates = self._read()
        if any(t["name"].lower() == name.lower() for t in templates):
            raise VikunjaError(status=409, code="TEMPLATE_ALREADY_EXISTS",
                               method="TEMPLATE_STORE", path="templates",
                               message=f'Template "{name}" already exists.')
        t = {"id": str(uuid.uuid4()), "name": name, "fields": fields}
        self._write([*templates, t])
        return t

    def list(self) -> list:
        return self._read()

    def get(self, id_or_name: str) -> dict:
        for t in self._read():
            if t["id"] == id_or_name or t["name"].lower() == id_or_name.lower():
                return t
        raise VikunjaError(status=404, code="TEMPLATE_NOT_FOUND",
                           method="TEMPLATE_STORE", path="templates",
                           message=f'Template "{id_or_name}" was not found.')

    def delete(self, id_or_name: str) -> dict:
        templates = self._read()
        remaining = [t for t in templates
                     if t["id"] != id_or_name and t["name"].lower() != id_or_name.lower()]
        if len(remaining) == len(templates):
            raise VikunjaError(status=404, code="TEMPLATE_NOT_FOUND",
                               method="TEMPLATE_STORE", path="templates",
                               message=f'Template "{id_or_name}" was not found.')
        self._write(remaining)
        return {"deleted": True, "template": id_or_name}


def cmd_templates_list(_client: VikunjaApiClient, _args) -> Tuple[str, Any]:
    templates = _get_template_store().list()
    return f"Found {len(templates)} templates.", templates


def cmd_templates_create(_client: VikunjaApiClient, args) -> Tuple[str, Any]:
    name = args.get("name", "")
    fields = _parse_task_fields(args)
    if not name or not fields.get("title"):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TEMPLATE_STORE",
                           path="templates", message="name and fields.title are required.")
    t = _get_template_store().create(name, fields)
    return f"Created template \"{name}\".", t


def cmd_templates_get(_client: VikunjaApiClient, args) -> Tuple[str, Any]:
    sel = args.get("template_selector", "")
    if not sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TEMPLATE_STORE",
                           path="templates", message="templateSelector is required.")
    t = _get_template_store().get(sel)
    return f"Template: {t['name']}", t


def cmd_templates_delete(_client: VikunjaApiClient, args) -> Tuple[str, Any]:
    sel = args.get("template_selector", "")
    if not sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TEMPLATE_STORE",
                           path="templates", message="templateSelector is required.")
    result = _get_template_store().delete(sel)
    return "Template deleted.", result


def cmd_templates_instantiate(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    sel = args.get("template_selector", "")
    proj_sel = _require_project_selector(args)
    variables = args.get("variables", {})
    if not sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TEMPLATE_STORE",
                           path="templates", message="templateSelector is required.")
    store = _get_template_store()
    template = store.get(sel)

    def _sub(val):
        if not val:
            return val
        return re.sub(r"\{\{([A-Za-z0-9_]+)\}\}",
                      lambda m: variables.get(m.group(1), m.group(0)), val)

    fields = dict(template["fields"])
    fields["title"] = _sub(fields.get("title", ""))
    if "description" in fields:
        fields["description"] = _sub(fields["description"])

    task_args = dict(args)
    task_args.update(fields)
    return cmd_tasks_create(client, task_args)


# --- vikunja_webhooks ---

def cmd_webhooks_events(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    scope = args.get("scope", "project")
    path = "/user/settings/webhooks/events" if scope == "user" else "/webhooks/events"
    events = client.request("GET", path)
    if not isinstance(events, list):
        events = []
    return f"Found {len(events)} webhook events.", events


def cmd_webhooks_list(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    proj_sel = _parse_project_selector(args)
    scope = args.get("scope")
    if proj_sel:
        project = resolve_project(client, proj_sel)
        base = f"/projects/{project['id']}/webhooks"
    elif scope == "user":
        base = "/user/settings/webhooks"
    else:
        base = "/user/settings/webhooks"
    items = fetch_all_collection_items(client, base)
    webhooks = [
        {"id": w["id"], "targetUrl": w.get("target_url"), "events": w.get("events", []),
         "projectId": w.get("project_id"), "userId": w.get("user_id")}
        for w in items
    ]
    return f"Found {len(webhooks)} webhooks.", webhooks


def cmd_webhooks_create(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    target_url = args.get("target_url", "")
    events = args.get("events", [])
    if not target_url or not events:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="POST",
                           path="/webhooks", message="targetUrl and events are required.")
    from urllib.parse import urlparse
    parsed = urlparse(target_url)
    if parsed.scheme not in ("http", "https"):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="targetUrl", message="Webhook target must use http or https.")
    proj_sel = _parse_project_selector(args)
    if proj_sel:
        project = resolve_project(client, proj_sel)
        base = f"/projects/{project['id']}/webhooks"
    else:
        base = "/user/settings/webhooks"
    body: dict = {"target_url": target_url, "events": events}
    for k, v in [("secret", args.get("secret")),
                 ("basic_auth_user", args.get("basic_auth_user")),
                 ("basic_auth_password", args.get("basic_auth_password"))]:
        if v:
            body[k] = v
    w = client.request("POST", base, body=body)
    return "Webhook created.", {
        "id": w.get("id"), "targetUrl": w.get("target_url"),
        "events": w.get("events", []),
        "projectId": w.get("project_id"), "userId": w.get("user_id"),
    }


def cmd_webhooks_update(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    wid = _require_int(args, "webhook_id", "webhookId")
    events = args.get("events", [])
    if not events:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="PUT",
                           path=f"/webhooks/{wid}", message="events are required.")
    proj_sel = _parse_project_selector(args)
    if proj_sel:
        project = resolve_project(client, proj_sel)
        base = f"/projects/{project['id']}/webhooks"
    else:
        base = "/user/settings/webhooks"
    w = client.request("PUT", f"{base}/{wid}", body={"events": events})
    return "Webhook updated.", {
        "id": w.get("id"), "targetUrl": w.get("target_url"),
        "events": w.get("events", []),
        "projectId": w.get("project_id"), "userId": w.get("user_id"),
    }


def cmd_webhooks_delete(client: VikunjaApiClient, args) -> Tuple[str, Any]:
    wid = _require_int(args, "webhook_id", "webhookId")
    proj_sel = _parse_project_selector(args)
    if proj_sel:
        project = resolve_project(client, proj_sel)
        base = f"/projects/{project['id']}/webhooks"
    else:
        base = "/user/settings/webhooks"
    client.request("DELETE", f"{base}/{wid}")
    return "Webhook deleted.", {"deleted": True, "webhookId": wid}


# ─── Argument Parsing Helpers ─────────────────────────────────────────────────

def _parse_project_selector(args: dict) -> Optional[Dict[str, Any]]:
    pid = args.get("project_id")
    ptitle = args.get("project_title")
    if pid is not None:
        sel: Dict[str, Any] = {"id": int(pid)}
        if ptitle:
            sel["title"] = ptitle
        return sel
    if ptitle:
        return {"title": ptitle}
    return None


def _require_project_selector(args: dict) -> Dict[str, Any]:
    sel = _parse_project_selector(args)
    if not sel:
        raise VikunjaError(status=400, code="PROJECT_SELECTOR_REQUIRED", method="POST",
                           path="/tasks", message="projectSelector (--project-id or --project-title) is required.")
    return sel


def _require_task_selector(args: dict) -> Union[str, int]:
    sel = args.get("task_selector")
    if not sel:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="GET",
                           path="/tasks", message="taskSelector is required.")
    return sel


def _require_int(args: dict, key: str, label: str) -> int:
    val = args.get(key)
    if val is None:
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="GET",
                           path="/", message=f"{label} is required.")
    return int(val)


def _parse_task_fields(args: dict) -> dict:
    fields: dict = {}
    if args.get("title"):
        fields["title"] = args["title"]
    if args.get("description") is not None:
        fields["description"] = args["description"]
    if args.get("done") is not None:
        fields["done"] = args["done"]
    if args.get("priority") is not None:
        fields["priority"] = int(args["priority"])
    if args.get("due_date") is not None:
        fields["dueDate"] = args["due_date"]
    return fields


def _extra_writable_fields(args: dict) -> dict:
    """Validate and return extra writable task fields supplied via --fields-json.

    Keys must be API field names in WRITABLE_TASK_FIELDS; values are sent as-is,
    letting callers set fields with no dedicated flag (start_date, percent_done,
    hex_color, repeat_after, is_favorite, project_id, reminders, etc.)."""
    extra = args.get("fields_extra")
    if not extra:
        return {}
    if not isinstance(extra, dict):
        raise VikunjaError(status=400, code="VALIDATION_ERROR", method="TOOLS_CALL",
                           path="fields", message="--fields-json must be a JSON object.")
    out: dict = {}
    for k, v in extra.items():
        if k not in WRITABLE_TASK_FIELDS:
            raise VikunjaError(
                status=400, code="VALIDATION_ERROR", method="TOOLS_CALL", path=f"fields.{k}",
                message=f'Field "{k}" is not writable. Allowed: {", ".join(WRITABLE_TASK_FIELDS)}')
        out[k] = v
    return out


# ─── Tool → Action Dispatch ──────────────────────────────────────────────────

TOOL_ACTIONS = {
    "self_check": {"": cmd_self_check},
    "vikunja_auth": {"status": cmd_auth_status, "self-check": cmd_self_check},
    "vikunja_projects": {"list": cmd_projects_list, "get": cmd_projects_get},
    "vikunja_tasks": {
        "create": cmd_tasks_create, "create_if_absent": cmd_tasks_create_if_absent,
        "get": cmd_tasks_get, "list": cmd_tasks_list,
        "update": cmd_tasks_update, "delete": cmd_tasks_delete,
        "close": cmd_tasks_close, "reopen": cmd_tasks_reopen,
        "close_with_evidence": cmd_tasks_close_with_evidence,
        "assign": cmd_tasks_assign, "unassign": cmd_tasks_unassign,
        "list-assignees": cmd_tasks_list_assignees,
        "apply-label": cmd_tasks_apply_label, "remove-label": cmd_tasks_remove_label,
        "list-labels": cmd_tasks_list_labels,
        "relate": cmd_tasks_relate, "unrelate": cmd_tasks_unrelate,
        "list-relations": cmd_tasks_list_relations,
        "attach": cmd_tasks_attach, "list-attachments": cmd_tasks_list_attachments,
        "download-attachment": cmd_tasks_download_attachment,
    },
    "vikunja_task_comments": {
        "create": cmd_comments_create, "list": cmd_comments_list,
        "get": cmd_comments_get, "update": cmd_comments_update,
        "delete": cmd_comments_delete,
    },
    "vikunja_labels": {
        "list": cmd_labels_list, "get": cmd_labels_get,
        "create": cmd_labels_create, "update": cmd_labels_update,
        "delete": cmd_labels_delete,
    },
    "vikunja_users": {"current": cmd_users_current, "search": cmd_users_search},
    "vikunja_teams": {
        "list": cmd_teams_list, "get": cmd_teams_get,
        "create": cmd_teams_create, "update": cmd_teams_update,
        "delete": cmd_teams_delete,
        "add-member": cmd_teams_add_member, "remove-member": cmd_teams_remove_member,
        "set-member-admin": cmd_teams_set_member_admin,
    },
    "vikunja_filters": {
        "create": cmd_filters_create, "get": cmd_filters_get,
        "update": cmd_filters_update, "delete": cmd_filters_delete,
    },
    "vikunja_task_bulk": {
        "update": cmd_bulk_update, "create": cmd_bulk_create,
        "delete": cmd_bulk_delete,
    },
    "vikunja_task_reminders": {
        "list": cmd_reminders_list, "add": cmd_reminders_add,
        "remove": cmd_reminders_remove,
    },
    "vikunja_batch_import": {
        "detect": cmd_import_detect, "preview": cmd_import_preview,
        "import": cmd_import_start, "status": cmd_import_status,
    },
    "vikunja_export_project": {"export": cmd_export_project},
    "vikunja_request_user_export": {"request": cmd_request_user_export},
    "vikunja_download_user_export": {
        "status": cmd_user_export_status, "download": cmd_user_export_download,
    },
    "vikunja_templates": {
        "list": cmd_templates_list, "create": cmd_templates_create,
        "get": cmd_templates_get, "delete": cmd_templates_delete,
        "instantiate": cmd_templates_instantiate,
    },
    "vikunja_webhooks": {
        "events": cmd_webhooks_events, "list": cmd_webhooks_list,
        "create": cmd_webhooks_create, "update": cmd_webhooks_update,
        "delete": cmd_webhooks_delete,
    },
}


# ─── CLI ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tracker",
        description="Vikunja FastMCP v2 - Python fallback CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=("Tools: " + ", ".join(sorted(TOOL_ACTIONS.keys())) +
                "\n\nExample:\n  python fallback/vikunja-cli.py vikunja_tasks list --project-title MyProject\n"
                "  python fallback/vikunja-cli.py vikunja_tasks create --project-id 1 --title 'Buy milk'"),
    )
    parser.add_argument("tool", help="Tool name (e.g. vikunja_tasks)")
    parser.add_argument("action", nargs="?", default="",
                        help="Action within the tool (e.g. list, create)")

    # Universal params
    parser.add_argument("--project-id", type=int, dest="project_id")
    parser.add_argument("--project-title", dest="project_title")
    parser.add_argument("--task-selector", "--task", dest="task_selector")
    parser.add_argument("--comment-limit", type=int, dest="comment_limit", default=5)

    # Task fields
    parser.add_argument("--title")
    parser.add_argument("--description")
    parser.add_argument("--done", type=_bool_arg, default=None)
    parser.add_argument("--priority", type=int)
    parser.add_argument("--due-date", dest="due_date")
    parser.add_argument("--idempotency-key", dest="idempotency_key")
    parser.add_argument("--expected-updated-at", dest="expected_updated_at")
    parser.add_argument("--fields-json", dest="fields_json",
                        help="JSON object of extra writable task fields by API name, e.g. "
                             "'{\"start_date\":\"2026-08-01T00:00:00Z\",\"percent_done\":0.5}'")

    # Task list
    parser.add_argument("--all-states", action="store_true", dest="all_states")
    parser.add_argument("--all-projects", action="store_true", dest="all_projects")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--per-page", type=int, dest="per_page", default=25)
    parser.add_argument("--label")
    parser.add_argument("-q", "--q", dest="q")
    parser.add_argument("--count-only", action="store_true", dest="count_only")
    parser.add_argument("--filter", dest="filter")

    # User / assignment
    parser.add_argument("--user-selector", "--user", dest="user_selector")
    parser.add_argument("--label-title", dest="label_title")

    # Relations
    parser.add_argument("--other-task-selector", dest="other_task_selector")
    parser.add_argument("--relation-kind", dest="relation_kind")

    # Attachments
    parser.add_argument("--file-paths", nargs="*", dest="file_paths")
    parser.add_argument("--filename")
    parser.add_argument("--mime-type", dest="mime_type")
    parser.add_argument("--base64-content", dest="base64_content")
    parser.add_argument("--attachment-id", type=int, dest="attachment_id")
    parser.add_argument("--destination-path", dest="destination_path")
    parser.add_argument("--overwrite", action="store_true")

    # Comments
    parser.add_argument("--comment")
    parser.add_argument("--comment-id", type=int, dest="comment_id")
    parser.add_argument("--evidence-comment", dest="evidence_comment")

    # Labels
    parser.add_argument("--label-selector", dest="label_selector")
    parser.add_argument("--hex-color", dest="hex_color")

    # Teams
    parser.add_argument("--team-id", type=int, dest="team_id")
    parser.add_argument("--name")
    parser.add_argument("--username-or-id", dest="username_or_id")
    parser.add_argument("--admin", type=_bool_arg, default=None)

    # Filters
    parser.add_argument("--filter-id", type=int, dest="filter_id")
    parser.add_argument("--filter-query", dest="filter_query")
    parser.add_argument("--is-favorite", type=_bool_arg, dest="is_favorite", default=None)

    # Bulk
    parser.add_argument("--task-ids", nargs="*", type=int, dest="task_ids")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--tasks-json", dest="tasks_json",
                        help="JSON array of task objects for bulk create")

    # Reminders
    parser.add_argument("--reminder")
    parser.add_argument("--relative-period", type=int, dest="relative_period")
    parser.add_argument("--relative-to", dest="relative_to")
    parser.add_argument("--reminder-index", type=int, dest="reminder_index")

    # Import
    parser.add_argument("--file-path", dest="file_path")
    parser.add_argument("--config-json", dest="config_json",
                        help="JSON object for CSV import config")

    # Export
    parser.add_argument("--format", dest="format", choices=["json", "csv"], default="json")
    parser.add_argument("--include-comments", action="store_true", dest="include_comments")

    # User export
    parser.add_argument("--password")

    # Templates
    parser.add_argument("--template-selector", dest="template_selector")
    parser.add_argument("--variables-json", dest="variables_json",
                        help="JSON object for template variables")

    # Webhooks
    parser.add_argument("--scope", choices=["project", "user"])
    parser.add_argument("--webhook-id", type=int, dest="webhook_id")
    parser.add_argument("--target-url", dest="target_url")
    parser.add_argument("--events", nargs="*")
    parser.add_argument("--secret")
    parser.add_argument("--basic-auth-user", dest="basic_auth_user")
    parser.add_argument("--basic-auth-password", dest="basic_auth_password")

    # JSON output control
    parser.add_argument("--compact", action="store_true",
                        help="Output compact JSON (no indentation)")

    return parser


def _bool_arg(val: str) -> bool:
    if val.lower() in ("true", "1", "yes"):
        return True
    if val.lower() in ("false", "0", "no"):
        return False
    raise argparse.ArgumentTypeError(f"Boolean expected, got: {val}")


def main():
    parser = build_parser()
    parsed = parser.parse_args()
    args = {k: v for k, v in vars(parsed).items() if v is not None}

    # Parse JSON args
    if args.get("tasks_json"):
        try:
            args["tasks"] = json.loads(args["tasks_json"])
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": {"message": "Invalid --tasks-json"}}), file=sys.stderr)
            sys.exit(1)
    if args.get("config_json"):
        try:
            args["config"] = json.loads(args["config_json"])
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": {"message": "Invalid --config-json"}}), file=sys.stderr)
            sys.exit(1)
    if args.get("variables_json"):
        try:
            args["variables"] = json.loads(args["variables_json"])
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": {"message": "Invalid --variables-json"}}), file=sys.stderr)
            sys.exit(1)
    if args.get("fields_json"):
        try:
            args["fields_extra"] = json.loads(args["fields_json"])
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": {"message": "Invalid --fields-json"}}), file=sys.stderr)
            sys.exit(1)

    tool = args.get("tool", "")
    action = args.get("action", "")
    compact = args.get("compact", False)
    indent = None if compact else 2

    if tool not in TOOL_ACTIONS:
        avail = ", ".join(sorted(TOOL_ACTIONS.keys()))
        print(json.dumps({"ok": False, "error": {
            "status": 400, "code": "UNKNOWN_TOOL", "method": "CLI",
            "path": tool, "message": f'Unknown tool: "{tool}". Available: {avail}',
            "fieldErrors": [],
        }}, indent=indent))
        sys.exit(1)

    tool_actions = TOOL_ACTIONS[tool]
    if action not in tool_actions:
        avail = ", ".join(sorted(k for k in tool_actions if k)) or "(none)"
        print(json.dumps({"ok": False, "error": {
            "status": 400, "code": "UNKNOWN_ACTION", "method": "CLI",
            "path": f"{tool}/{action}",
            "message": f'Unknown action: "{action}" for tool "{tool}". Available: {avail}',
            "fieldErrors": [],
        }}, indent=indent))
        sys.exit(1)

    try:
        config = Config()
        client = VikunjaApiClient(config)
    except VikunjaError as e:
        print(json.dumps(to_error_envelope(e, os.environ.get("VIKUNJA_API_TOKEN")),
                         indent=indent))
        sys.exit(1)

    handler = tool_actions[action]
    try:
        summary, data = handler(client, args)
        envelope = {"ok": True, "data": normalize_dates_and_nulls(data)}
        print(render_envelope(summary, envelope, indent))
    except VikunjaError as e:
        details = to_error_envelope(e, config.vikunja_token)
        summary = f"Error: {e.code} ({e.status})"
        print(render_envelope(summary, details, indent), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        details = to_error_envelope(e, os.environ.get("VIKUNJA_API_TOKEN"))
        print(render_envelope(f"Error: {e}", details, indent), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
