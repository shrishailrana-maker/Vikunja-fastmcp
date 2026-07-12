/**
 * Atomic TypeScript build: compile into a temp dir, then swap dist.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const rootDir = process.cwd();
const distPath = path.join(rootDir, 'dist');
const tempDistPath = path.join(rootDir, 'dist-new');
const oldDistPath = path.join(rootDir, 'dist-old');

function cleanDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

try {
  console.log('Starting atomic build...');

  // Clean up any stale directories
  cleanDir(tempDistPath);
  cleanDir(oldDistPath);

  // Compile TS into dist-new
  console.log('Compiling TypeScript...');
  const tscPath = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tscPath, '-p', 'tsconfig.json', '--outDir', 'dist-new'], {
    stdio: 'inherit',
  });
  const entryPath = path.join(tempDistPath, 'index.js');
  if (!fs.existsSync(entryPath)) {
    throw new Error('Build verification failed: dist-new/index.js was not produced.');
  }
  fs.chmodSync(entryPath, 0o755);

  // Swap directories atomically
  console.log('Swapping build directories...');
  if (fs.existsSync(distPath)) {
    fs.renameSync(distPath, oldDistPath);
  }
  fs.renameSync(tempDistPath, distPath);

  // Clean up old dist
  cleanDir(oldDistPath);

  console.log('Atomic build completed successfully.');
  process.exit(0);
} catch (error) {
  console.error('Build failed. Restoring previous build...', error);
  // Clean up new failed build
  cleanDir(tempDistPath);
  // Restore old build if it was moved
  if (fs.existsSync(oldDistPath)) {
    if (fs.existsSync(distPath)) {
      cleanDir(distPath);
    }
    fs.renameSync(oldDistPath, distPath);
  }
  process.exit(1);
}
