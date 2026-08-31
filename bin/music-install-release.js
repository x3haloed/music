#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const [installationsArgument, sourceArgument] = process.argv.slice(2);

try {
  const source = resolve(sourceArgument ?? process.cwd());
  const installations = resolve(installationsArgument ?? join(homedir(), '.local', 'share', 'music', 'installations'));
  const status = git(source, ['status', '--porcelain', '--untracked-files=all']);
  if (status.length > 0) throw new Error('source repository must be clean before installing a release');
  const commit = git(source, ['rev-parse', 'HEAD']).trim();
  const upstream = git(source, ['rev-parse', '@{upstream}']).trim();
  if (commit !== upstream) throw new Error(`source HEAD ${commit} is not the pushed upstream ${upstream}`);
  const remote = git(source, ['remote', 'get-url', 'origin']).trim();
  const releases = join(installations, 'releases');
  const release = join(releases, commit);
  mkdirSync(releases, { recursive: true, mode: 0o700 });
  if (!existsSync(release)) install(source, remote, commit, release);
  verifyRelease(release, commit);
  activate(installations, release);
  process.stdout.write(`${JSON.stringify({ ok: true, installations, release, current: join(installations, 'current'), commit }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`music-install-release: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function install(source, remote, commit, release) {
  const temporary = join(dirname(release), `.install-${commit}-${randomUUID()}`);
  try {
    run('git', ['clone', '--no-hardlinks', '--no-checkout', source, temporary]);
    git(temporary, ['remote', 'set-url', 'origin', remote]);
    git(temporary, ['checkout', '--detach', commit]);
    run('npm', ['ci'], temporary);
    run('npm', ['run', 'check'], temporary);
    run(process.execPath, ['bin/music-doctor.js', 'check', temporary], temporary);
    renameSync(temporary, release);
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function verifyRelease(release, commit) {
  if (git(release, ['rev-parse', 'HEAD']).trim() !== commit) throw new Error(`installed release does not match ${commit}: ${release}`);
  if (git(release, ['status', '--porcelain', '--untracked-files=all']).length > 0) throw new Error(`installed release is dirty: ${release}`);
  run(process.execPath, ['bin/music-doctor.js', 'check', release], release);
}

function activate(installations, release) {
  const current = join(installations, 'current');
  if (existsSync(current) && !lstatSync(current).isSymbolicLink()) throw new Error(`installation current path is not a symlink: ${current}`);
  const temporary = join(installations, `.current-${randomUUID()}`);
  symlinkSync(relative(installations, release), temporary);
  renameSync(temporary, current);
  if (resolve(installations, readlinkSync(current)) !== release) throw new Error('installation current symlink did not activate the requested release');
}

function git(root, args) {
  return run('git', ['-C', root, ...args]);
}

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
}
