/**
 * Structured error type, HTTP status→code mapping, and secret redaction.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

export interface FieldError {
  location: string;
  message: string;
}

export interface ErrorDetails {
  status: number;
  code: string;
  method: string;
  path: string;
  message: string;
  fieldErrors: FieldError[];
}

export class VikunjaError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly method: string;
  public readonly path: string;
  public readonly fieldErrors: FieldError[];

  constructor(details: ErrorDetails) {
    super(redactSecrets(details.message));
    this.name = 'VikunjaError';
    this.status = details.status;
    this.code = details.code;
    this.method = details.method;
    this.path = details.path;
    this.fieldErrors = details.fieldErrors.map((fieldError) => ({
      location: normalizeFieldLocation(fieldError.location),
      message: String(fieldError.message ?? ''),
    }));

    // Set prototype explicitly for custom error class in TS/ES5
    Object.setPrototypeOf(this, VikunjaError.prototype);
  }
}

function normalizeFieldLocation(location: unknown): string {
  if (Array.isArray(location)) return location.map(String).join('.');
  if (location === null || location === undefined) return '';
  return String(location);
}

export function redactSecrets(text: string, tokenToRedact?: string): string {
  if (!text) return text;
  let redacted = text;

  const token = tokenToRedact || process.env.VIKUNJA_API_TOKEN;
  if (token) {
    const escapedToken = token.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    redacted = redacted.replace(new RegExp(escapedToken, 'g'), '[REDACTED_TOKEN]');
  }

  // Redact token pattern: tk_<alphanumeric>
  redacted = redacted.replace(/tk_[a-zA-Z0-9]{30,}/g, '[REDACTED_TOKEN]');

  // Redact Bearer tokens in headers or general text
  redacted = redacted.replace(
    /(Authorization:\s*Bearer\s+)[a-zA-Z0-9_\-\.]+/gi,
    '$1[REDACTED_TOKEN]',
  );
  redacted = redacted.replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1[REDACTED_TOKEN]');

  return redacted;
}

export function mapStatusToCode(status: number): string {
  switch (status) {
    case 400:
    case 422:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'PERMISSION_DENIED';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'ATTACHMENT_TOO_LARGE';
    default:
      return status >= 500 || status === 0 ? 'INTERNAL_SERVER_ERROR' : `HTTP_${status}`;
  }
}

export function toErrorEnvelope(
  error: any,
  currentToken?: string,
): { ok: false; error: ErrorDetails } {
  let details: ErrorDetails;

  if (error instanceof VikunjaError) {
    details = {
      status: error.status,
      code: error.code,
      method: error.method,
      path: error.path,
      message: error.message,
      fieldErrors: error.fieldErrors,
    };
  } else {
    // Prefer explicit status/code when present (e.g. markdown validation markers).
    const status = typeof error?.status === 'number' ? error.status : 500;
    const code =
      typeof error?.code === 'string' && error.code ? error.code : mapStatusToCode(status);
    details = {
      status,
      code,
      method: error?.method || 'UNKNOWN',
      path: error?.path || 'UNKNOWN',
      message: error?.message || 'An unexpected error occurred',
      fieldErrors: [],
    };
  }

  // Redact details
  details.message = redactSecrets(details.message, currentToken);
  details.path = redactSecrets(details.path, currentToken);
  details.fieldErrors = details.fieldErrors.map((fe) => ({
    location: redactSecrets(fe.location, currentToken),
    message: redactSecrets(fe.message, currentToken),
  }));

  return {
    ok: false,
    error: details,
  };
}
