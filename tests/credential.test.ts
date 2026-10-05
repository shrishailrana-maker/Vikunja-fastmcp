import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadProtectedToken } from '../src/credential.js';
import { loadConfig } from '../src/config.js';

const windowsTest = process.platform === 'win32' ? it : it.skip;

describe('protected Windows token store', () => {
  windowsTest('decrypts a DPAPI file and gives it priority over the old environment token', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfm-dpapi-test-'));
    const file = path.join(root, 'token.dpapi');
    const token = 'neutral-dpapi-test-value';
    try {
      const encrypted = execFileSync(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'ConvertTo-SecureString $env:VFM_TEST_SECRET -AsPlainText -Force | ConvertFrom-SecureString',
        ],
        { encoding: 'utf8', windowsHide: true, env: { ...process.env, VFM_TEST_SECRET: token } },
      ).trim();
      fs.writeFileSync(file, encrypted);
      expect(encrypted).not.toContain(token);
      expect(loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: file })).toBe(token);
      expect(
        loadConfig({
          VIKUNJA_URL: 'https://vikunja.example.com',
          VIKUNJA_API_TOKEN: 'old-neutral-value',
          VIKUNJA_API_TOKEN_FILE: file,
        }).vikunjaToken,
      ).toBe(token);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  windowsTest('does not expose invalid credential-file contents through errors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfm-dpapi-invalid-'));
    const file = path.join(root, 'token.dpapi');
    try {
      fs.writeFileSync(file, 'neutral-value-that-must-not-be-printed');
      expect(() => loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: file })).toThrow(
        'Unable to decrypt the protected Vikunja token.',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets an explicit empty file setting disable automatic store lookup', () => {
    expect(
      loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: '', LOCALAPPDATA: 'unused' }),
    ).toBeUndefined();
  });
});
