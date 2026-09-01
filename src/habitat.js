import { createHash } from 'node:crypto';
import {
  constants, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { MusicKernel } from './kernel.js';
import { acquireResidentLease, releaseResidentLease } from './resident-lease.js';

export const HABITAT_FORMAT = 'music-v2-habitat-1';
const MARKER = 'habitat.json';

export function createHabitat(rootArgument) {
  let root = resolve(rootArgument);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`habitat root is not empty: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  root = realpathSync(root);
  for (const path of ['home', 'state', 'mailbox/inbound', 'mailbox/outbound/pending', 'dependencies', 'governance']) {
    mkdirSync(join(root, path), { recursive: true, mode: 0o700 });
  }
  writeExclusiveJson(join(root, MARKER), {
    format: HABITAT_FORMAT,
    createdAt: new Date().toISOString(),
  });
  return readHabitat(root);
}

export function readHabitat(rootArgument) {
  const root = realpathSync(resolve(rootArgument));
  const marker = JSON.parse(readFileSync(join(root, MARKER), 'utf8'));
  if (marker?.format !== HABITAT_FORMAT || typeof marker.createdAt !== 'string') {
    throw new Error(`invalid Music v2 habitat marker: ${join(root, MARKER)}`);
  }
  const paths = habitatPaths(root);
  for (const directory of [paths.home, paths.state, paths.inbox, paths.outbox, paths.dependencies, paths.governance]) {
    if (!statSync(directory).isDirectory()) throw new Error(`Music habitat path is not a directory: ${directory}`);
  }
  return paths;
}

export function snapshotHabitat(rootArgument, backupRootArgument) {
  if (!backupRootArgument) throw new Error('snapshot needs an explicit backup root outside the habitat');
  const habitat = readHabitat(rootArgument);
  const backupRoot = canonicalProspective(backupRootArgument);
  if (inside(habitat.root, backupRoot) || inside(backupRoot, habitat.root)) {
    throw new Error('snapshot backup root and habitat must not contain one another');
  }
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const targetParent = join(backupRoot, basename(habitat.root));
  mkdirSync(targetParent, { recursive: true, mode: 0o700 });
  const target = join(targetParent, safeTimestamp());
  const kernel = new MusicKernel(habitat.root);
  const residentLease = acquireResidentLease(habitat.root, 'snapshot');
  let lock;
  try {
    lock = kernel.ledger.acquire();
    cpSync(habitat.root, target, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: source => source !== kernel.ledger.lockPath && source !== residentLease.path,
    });
    const files = inventory(target);
    writeExclusiveJson(join(target, 'snapshot.json'), {
      format: 'music-v2-habitat-snapshot-1',
      source: habitat.root,
      createdAt: new Date().toISOString(),
      files,
    });
    return { habitat: habitat.root, snapshot: target, files: files.length };
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      unlinkSync(kernel.ledger.lockPath);
    }
    releaseResidentLease(residentLease);
  }
}

function habitatPaths(root) {
  return {
    root,
    marker: join(root, MARKER),
    home: join(root, 'home'),
    state: join(root, 'state'),
    ledger: join(root, 'state', 'ledger.jsonl'),
    inbox: join(root, 'mailbox', 'inbound'),
    outbox: join(root, 'mailbox', 'outbound', 'pending'),
    dependencies: join(root, 'dependencies'),
    governance: join(root, 'governance'),
  };
}

function writeExclusiveJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function inventory(root) {
  const entries = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      if (name === 'snapshot.json') continue;
      const path = join(directory, name);
      const rel = relative(root, path);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(path);
        entries.push({ path: rel, kind: 'symlink', target, sha256: sha256(target) });
      } else if (metadata.isFile()) {
        const bytes = readFileSync(path);
        entries.push({ path: rel, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  visit(root);
  return entries;
}

function inside(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function canonicalProspective(pathArgument) {
  let cursor = resolve(pathArgument);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...missing);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(':', '-');
}
