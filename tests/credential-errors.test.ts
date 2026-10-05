import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execute = jest.fn<(...args: any[]) => string>();
jest.unstable_mockModule('node:child_process', () => ({ execFileSync: execute }));
const { loadProtectedToken } = await import('../src/credential.js');
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const decryptMessage =
  'Unable to decrypt the protected Vikunja token. Use the Windows account that saved it, or update VIKUNJA_API_TOKEN_FILE.';

afterEach(() => {
  execute.mockReset();
  Object.defineProperty(process, 'platform', originalPlatform);
});

function withFile(check: (file: string) => void) {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfm-credential-error-'));
  const file = path.join(root, 'token.dpapi');
  fs.writeFileSync(file, 'neutral-encrypted-fixture');
  try {
    check(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function childError(code: string) {
  return Object.assign(new Error('sensitive-child-output'), {
    code,
    stderr: 'sensitive-child-output',
  });
}

describe('secret-safe protected token errors', () => {
  it('uses identical arguments with Windows PowerShell when pwsh is missing', () => {
    execute
      .mockImplementationOnce(() => {
        throw childError('ENOENT');
      })
      .mockReturnValueOnce('neutral-fallback-token');
    withFile((file) => {
      expect(loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: file })).toBe('neutral-fallback-token');
      expect(execute.mock.calls.map((call) => call[0])).toEqual(['pwsh', 'powershell.exe']);
      expect(execute.mock.calls[1].slice(1)).toEqual(execute.mock.calls[0].slice(1));
    });
  });

  it('reports the fixed requirement when both PowerShell executables are missing', () => {
    execute.mockImplementation(() => {
      throw childError('ENOENT');
    });
    withFile((file) => {
      expect(() => loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: file })).toThrow(
        'PowerShell is required to read VIKUNJA_API_TOKEN_FILE; install PowerShell 7 or use VIKUNJA_API_TOKEN.',
      );
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  it('reports a fixed timeout without child output or fallback', () => {
    execute.mockImplementation(() => {
      throw childError('ETIMEDOUT');
    });
    withFile((file) => {
      expect(() => loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: file })).toThrow(
        'Timed out reading the protected Vikunja token file.',
      );
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the fixed decrypt-failure message without child output', () => {
    execute.mockImplementation(() => {
      throw childError('DECRYPT_FAILED');
    });
    withFile((file) => {
      expect(() => loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: file })).toThrow(decryptMessage);
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  it('does not misreport a missing credential file as missing PowerShell', () => {
    withFile((file) => {
      fs.unlinkSync(file);
      expect(() => loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: file })).toThrow(decryptMessage);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it('explains exactly how to disable DPAPI on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    expect(() => loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: 'neutral.dpapi' })).toThrow(
      'DPAPI token files require Windows; unset VIKUNJA_API_TOKEN_FILE or set it to an empty value.',
    );
    expect(loadProtectedToken({ VIKUNJA_API_TOKEN_FILE: '' })).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
