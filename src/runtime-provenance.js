import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUSIC_EVENT_FORMAT } from './kernel.js';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createRuntimeProvenance(home, { sourceRoot = SOURCE_ROOT, mode = 'resident' } = {}) {
  if (!['resident', 'single-run'].includes(mode)) throw new Error(`invalid Music runtime mode: ${String(mode)}`);
  const root = realpathSync(sourceRoot);
  const residentHome = realpathSync(home);
  if (!statSync(residentHome).isDirectory()) throw new Error(`resident home is not a directory: ${residentHome}`);
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, ['status', '--porcelain', '--untracked-files=all']);
  const diff = git(root, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--']);
  return {
    format: 'music-runtime-1',
    eventFormat: MUSIC_EVENT_FORMAT,
    mode,
    release: {
      commit,
      version: packageJson.version,
      workingTreeClean: status.length === 0,
      workingTreeStateSha256: createHash('sha256').update(status).update('\0').update(diff).digest('hex'),
      root,
    },
    home: residentHome,
    process: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}
