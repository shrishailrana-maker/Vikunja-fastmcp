/**
 * Thin authenticated HTTP client for the Vikunja v2 REST API.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { Config, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_TRANSFER_TIMEOUT_MS } from './config.js';
import { VikunjaError, mapStatusToCode } from './errors.js';

export class VikunjaApiClient {
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  public getConfig(): Config {
    return this.config;
  }

  async request<T>(
    method: string,
    path: string,
    options: {
      body?: any;
      headers?: Record<string, string>;
      isMultipart?: boolean;
      isStreamResponse?: boolean;
    } = {},
  ): Promise<T> {
    const url = `${this.config.vikunjaUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.vikunjaToken}`,
      ...options.headers,
    };

    let body: any;
    if (options.body !== undefined) {
      if (options.isMultipart) {
        // Caller supplies multipart body + Content-Type (with boundary).
        // Do not force application/json.
        body = options.body;
      } else {
        headers['Content-Type'] ??= 'application/json';
        body = JSON.stringify(options.body);
      }
    }

    const timeoutMs =
      options.isStreamResponse || options.isMultipart
        ? (this.config.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS)
        : (this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

    // Streamed bodies are consumed by the caller after this method returns, so
    // the transfer timeout must bound inactivity (time to headers, then gaps
    // between chunks) rather than total duration; a healthy large download may
    // legitimately outlive the transfer window. Ordinary requests keep the
    // fixed total cap.
    const controller = options.isStreamResponse ? new AbortController() : undefined;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const restartInactivityTimer = () => {
      if (!controller) return;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => controller.abort(), timeoutMs);
      inactivityTimer.unref?.();
    };
    const stopInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
    };

    try {
      restartInactivityTimer();
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller ? controller.signal : AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        let detail = `HTTP error ${response.status}: ${response.statusText}`;
        let fieldErrors: { location: string; message: string }[] = [];

        try {
          const text = await response.text();
          const errorBody = JSON.parse(text);
          if (errorBody && typeof errorBody === 'object') {
            detail = errorBody.detail || errorBody.title || errorBody.message || detail;
            if (Array.isArray(errorBody.errors)) {
              fieldErrors = errorBody.errors.map((fe: any) => ({
                location: Array.isArray(fe.location)
                  ? fe.location.map(String).join('.')
                  : String(fe.location ?? ''),
                message: String(fe.message ?? ''),
              }));
            }
          }
        } catch {
          // If response is not JSON, we keep the default status text
        }

        const subscriptionSchemaFailure = fieldErrors.some(
          (fieldError) =>
            fieldError.location === 'subscription.entity' &&
            /expected integer/i.test(fieldError.message),
        );
        if (subscriptionSchemaFailure) {
          throw new VikunjaError({
            status: 502,
            code: 'VIKUNJA_SUBSCRIPTION_SCHEMA_BUG',
            method,
            path,
            message:
              'Vikunja returned an invalid subscription.entity value while validating this task response. ' +
              'The write may not have been applied. Track the server fix at ' +
              'https://github.com/go-vikunja/vikunja/issues/3316.',
            fieldErrors,
          });
        }

        throw new VikunjaError({
          status: response.status,
          code: mapStatusToCode(response.status),
          method,
          path,
          message: detail,
          fieldErrors,
        });
      }

      if (options.isStreamResponse) {
        restartInactivityTimer();
        return wrapStreamedBody(
          response,
          restartInactivityTimer,
          stopInactivityTimer,
          method,
          path,
          timeoutMs,
        ) as unknown as T;
      }

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      if (!text) {
        return {} as T;
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new VikunjaError({
          status: 502,
          code: 'INVALID_JSON_RESPONSE',
          method,
          path,
          message: 'Server returned a non-JSON success body that could not be parsed.',
          fieldErrors: [],
        });
      }
    } catch (err: any) {
      stopInactivityTimer();
      if (err instanceof VikunjaError) {
        throw err;
      }
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new VikunjaError({
          status: 504,
          code: 'REQUEST_TIMEOUT',
          method,
          path,
          message: `Vikunja request timed out after ${timeoutMs} ms.`,
          fieldErrors: [],
        });
      }
      // Map general network error
      throw new VikunjaError({
        status: err.status || 500,
        code: err.status ? mapStatusToCode(err.status) : 'NETWORK_ERROR',
        method,
        path,
        message: err.message || 'Network request failed',
        fieldErrors: [],
      });
    }
  }
}

// Refresh the inactivity timer on every chunk the caller reads, stop it when
// the stream ends (or the caller exits early), and surface an abort as the
// standard REQUEST_TIMEOUT error instead of a raw AbortError.
function wrapStreamedBody(
  response: Response,
  restartTimer: () => void,
  stopTimer: () => void,
  method: string,
  path: string,
  timeoutMs: number,
): Response {
  const original = response.body as any;
  if (!original || typeof original[Symbol.asyncIterator] !== 'function') {
    // Non-iterable bodies (mocks, buffered fallbacks) are consumed in one call;
    // the fixed timer would only misfire later, so stop it here.
    stopTimer();
    return response;
  }
  const wrapped = (async function* () {
    try {
      for await (const chunk of original) {
        restartTimer();
        yield chunk;
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new VikunjaError({
          status: 504,
          code: 'REQUEST_TIMEOUT',
          method,
          path,
          message: `Vikunja stream stalled for more than ${timeoutMs} ms.`,
          fieldErrors: [],
        });
      }
      throw err;
    } finally {
      stopTimer();
    }
  })();
  Object.defineProperty(response, 'body', { value: wrapped, configurable: true });
  return response;
}
