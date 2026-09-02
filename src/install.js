import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseFiles = [
  'src', 'bin', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'DESIGN.md', 'HATCH.md', 'READINESS.md',
];

export function installRelease(destinationValue, { clock = () => new Date(), dependencyInstaller = installDependencies, releaseVerifier = verifyRelease } = {}) {
  const destination = resolve(destinationValue);
  if (existsSync(destination)) throw new Error(`release destination already exists: ${destination}`);
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
  if (existsSync(partial)) throw new Error(`release partial already exists: ${partial}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  mkdirSync(partial, { mode: 0o700 });
  try {
    for (const path of releaseFiles) cpSync(resolve(sourceRoot, path), resolve(partial, path), { recursive: true, errorOnExist: true });
    dependencyInstaller(partial);
    const doctor = releaseVerifier(partial);
    if (!doctor.ready) throw new Error('installed release failed its doctor check');
    const pkg = JSON.parse(readFileSync(resolve(partial, 'package.json'), 'utf8'));
    const manifest = {
      format: 'music-v4-installed-release-1',
      version: pkg.version,
      installedAt: clock().toISOString(),
      implementationSha256: doctor.runtime.implementationSha256,
      dependencyLockSha256: doctor.runtime.dependencyLockSha256,
      node: doctor.node,
    };
    writeFileSync(resolve(partial, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(partial, destination);
    return { destination, manifest, doctor };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

function installDependencies(root) {
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, stdio: 'pipe' });
}

function verifyRelease(root) {
  return JSON.parse(execFileSync(process.execPath, ['bin/music-doctor.js'], { cwd: root, encoding: 'utf8' }));
}
