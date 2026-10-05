/** Load a Windows user-bound DPAPI credential without storing plaintext on disk. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let cached: { file: string; modified: number; size: number; token: string } | undefined;

export function loadProtectedToken(env: NodeJS.ProcessEnv): string | undefined {
  // An explicit empty file setting disables the default store (useful for isolated tests).
  const defaultFile = env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'vikunja-fastmcp', 'native-api-token.dpapi')
    : undefined;
  const file =
    env.VIKUNJA_API_TOKEN_FILE === undefined
      ? defaultFile && fs.existsSync(defaultFile)
        ? defaultFile
        : undefined
      : env.VIKUNJA_API_TOKEN_FILE.trim() || undefined;
  if (!file) return undefined;
  if (process.platform !== 'win32')
    throw new Error(
      'DPAPI token files require Windows; unset VIKUNJA_API_TOKEN_FILE or set it to an empty value.',
    );
  let executablesMissing = false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid protected token file.');
    if (cached?.file === file && cached.modified === stat.mtimeMs && cached.size === stat.size)
      return cached.token;
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference="Stop"; $value=Get-Content -Raw -LiteralPath $env:VFM_CREDENTIAL_FILE; $secure=ConvertTo-SecureString $value; try { [Console]::Write([Net.NetworkCredential]::new("",$secure).Password) } finally { $secure.Dispose() }',
    ];
    const options = {
      env: { ...process.env, VFM_CREDENTIAL_FILE: file },
      encoding: 'utf8' as const,
      windowsHide: true,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    let decrypted: string;
    try {
      decrypted = execFileSync('pwsh', args, options);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        decrypted = execFileSync('powershell.exe', args, options);
      } catch (fallbackError: any) {
        executablesMissing = fallbackError?.code === 'ENOENT';
        throw fallbackError;
      }
    }
    const token = decrypted.trim();
    if (!token) throw new Error('Empty protected token.');
    cached = { file, modified: stat.mtimeMs, size: stat.size, token };
    return token;
  } catch (error: any) {
    // Never propagate child output or decrypted bytes into configuration errors.
    if (executablesMissing)
      throw new Error(
        'PowerShell is required to read VIKUNJA_API_TOKEN_FILE; install PowerShell 7 or use VIKUNJA_API_TOKEN.',
      );
    if (error?.code === 'ETIMEDOUT')
      throw new Error('Timed out reading the protected Vikunja token file.');
    throw new Error(
      'Unable to decrypt the protected Vikunja token. Use the Windows account that saved it, or update VIKUNJA_API_TOKEN_FILE.',
    );
  }
}
