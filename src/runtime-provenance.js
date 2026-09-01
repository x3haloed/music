import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runtimeProvenance(habitat, mode) {
  const releaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(readFileSync(resolve(releaseRoot, 'package.json'), 'utf8'));
  const commit = git(releaseRoot, ['rev-parse', 'HEAD'], null);
  const status = git(releaseRoot, ['status', '--porcelain', '--untracked-files=all'], '');
  return {
    kind: 'runtime.started',
    mode,
    habitat: resolve(habitat),
    release: {
      root: releaseRoot,
      version: pkg.version,
      commit: commit?.trim() || null,
      workingTreeClean: status === '',
      workingTreeStateSha256: createHash('sha256').update(status ?? 'not-a-git-checkout').digest('hex'),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      pid: process.pid,
    },
  };
}

function git(root, args, fallback) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return fallback;
  }
}
