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

import { Config } from './config.js';
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

    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
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
        return response as unknown as T;
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
      if (err instanceof VikunjaError) {
        throw err;
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
