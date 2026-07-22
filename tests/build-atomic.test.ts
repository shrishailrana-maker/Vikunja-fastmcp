import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('atomic build recovery', () => {
  it('restores dist-old before a failed compile when dist is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-atomic-build-'));
    try {
      fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
      fs.copyFileSync(
        path.join(process.cwd(), 'scripts', 'build-atomic.js'),
        path.join(root, 'scripts', 'build-atomic.js'),
      );
      fs.mkdirSync(path.join(root, 'dist-old'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist-old', 'index.js'), 'known-good');
      const fakeTsc = path.join(root, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
      fs.mkdirSync(path.dirname(fakeTsc), { recursive: true });
      fs.writeFileSync(fakeTsc, 'process.exit(1);');

      const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-atomic.js')], {
        cwd: root,
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(fs.readFileSync(path.join(root, 'dist', 'index.js'), 'utf8')).toBe('known-good');
      expect(fs.existsSync(path.join(root, 'dist-old'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
