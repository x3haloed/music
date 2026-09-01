import { createHash } from 'node:crypto';
import {
  constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync,
  realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { serializeCarrier } from './carrier.js';
import { MusicKernel } from './kernel.js';
import { toolModuleDigest } from './tool-module.js';

export const MUSIC_HABITAT_FORMAT = 'music-habitat-1';
const MARKER = 'habitat.json';

export function createHabitat(rootArgument, { modelConfigPath } = {}) {
  let root = resolve(rootArgument);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`habitat root is not empty: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  root = realpathSync(root);
  for (const path of ['home', 'state', 'mailbox', 'dependencies', 'config']) {
    mkdirSync(join(root, path), { mode: 0o700 });
  }
  const marker = {
    format: MUSIC_HABITAT_FORMAT,
    createdAt: new Date().toISOString(),
  };
  writeExclusiveJson(join(root, MARKER), marker);
  const config = modelConfigPath
    ? JSON.parse(readFileSync(resolve(modelConfigPath), 'utf8'))
    : defaultModelConfig();
  writeExclusiveJson(join(root, 'config', 'model.json'), config);
  return habitatPaths(root);
}

export function readHabitat(rootArgument) {
  const root = realpathSync(resolve(rootArgument));
  const marker = JSON.parse(readFileSync(join(root, MARKER), 'utf8'));
  if (!marker || marker.format !== MUSIC_HABITAT_FORMAT || typeof marker.createdAt !== 'string') {
    throw new Error(`invalid Music habitat marker: ${join(root, MARKER)}`);
  }
  const paths = habitatPaths(root);
  for (const directory of [paths.home, paths.state, paths.mailbox, paths.dependencies, paths.config]) {
    if (!statSync(directory).isDirectory()) throw new Error(`Music habitat path is not a directory: ${directory}`);
  }
  if (!statSync(paths.modelConfig).isFile()) throw new Error(`Music habitat model config is not a file: ${paths.modelConfig}`);
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
  const kernel = new MusicKernel(habitat.ledger);
  const release = kernel.acquireWriter('habitat snapshot');
  try {
    cpSync(habitat.root, target, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: source => source !== `${habitat.ledger}.writer-lock`,
    });
    const files = inventory(target);
    writeExclusiveJson(join(target, 'snapshot.json'), {
      format: 'music-habitat-snapshot-1',
      source: habitat.root,
      createdAt: new Date().toISOString(),
      files,
    });
    return { habitat: habitat.root, snapshot: target, files: files.length };
  } catch (error) {
    throw new Error(`habitat snapshot failed at ${target}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    release();
  }
}

export async function offerSeedTool(rootArgument, toolId, { release = null } = {}) {
  const habitat = readHabitat(rootArgument);
  if (!existsSync(habitat.ledger)) throw new Error(`habitat has not been initialized: ${habitat.root}`);
  const kernel = new MusicKernel(habitat.ledger);
  const releaseWriter = kernel.acquireWriter('seed tool developmental offer');
  try {
    const seed = (await import('./seeds.js')).initialTools().find(tool => tool.id === toolId);
    if (!seed) throw new Error(`unknown seed tool: ${toolId}`);
    let retainedRelease = release;
    if (retainedRelease === null) {
      const { createRuntimeProvenance } = await import('./runtime-provenance.js');
      retainedRelease = createRuntimeProvenance(habitat.home, { mode: 'single-run' }).release;
    }
    const current = kernel.state().tools.get(seed.id);
    const offeredTool = {
      ...seed,
      version: current ? current.version + 1 : 1,
      parent: current ? toolModuleDigest(current) : null,
    };
    const offer = {
      format: 'music-developmental-offer-1',
      authority: 'release',
      release: {
        commit: retainedRelease.commit,
        version: retainedRelease.version,
        workingTreeClean: retainedRelease.workingTreeClean,
        workingTreeStateSha256: retainedRelease.workingTreeStateSha256,
      },
      tool: { id: offeredTool.id, digest: toolModuleDigest(offeredTool) },
    };
    const proposal = kernel.offerToolProposal({
      interpretation: `Release ${offer.release.commit} makes seed tool ${seed.id} available as inactive provisional machinery. The resident alone may inspect, trial, admit, deny, defer, contradict, or retire it.`,
      evidence: [
        `release:${offer.release.commit}`,
        `seed-tool:${seed.id}:${offer.tool.digest}`,
      ],
      tool: offeredTool,
    }, offer);
    kernel.admitDelta({
      authority: 'world',
      id: `developmental-offer-${proposal.proposalId}`,
      stream: 'release-development',
      at: proposal.authoredAt,
      payload: {
        format: 'music-developmental-offer-contact-1',
        proposalId: proposal.proposalId,
        tool: { id: proposal.revision.tool.id, version: proposal.revision.tool.version, digest: toolModuleDigest(proposal.revision.tool) },
        release: structuredClone(offer.release),
        active: false,
      },
    });
    return {
      habitat: habitat.root,
      proposalId: proposal.proposalId,
      tool: structuredClone(proposal.revision.tool),
      offer: structuredClone(offer),
      contactDeltaId: `developmental-offer-${proposal.proposalId}`,
      active: false,
    };
  } finally {
    releaseWriter();
  }
}

export function migrateHabitat(rootArgument) {
  const habitat = readHabitat(rootArgument);
  if (!existsSync(habitat.ledger)) throw new Error(`habitat has not been initialized: ${habitat.root}`);
  const kernel = new MusicKernel(habitat.ledger);
  const release = kernel.acquireWriter('legacy habitat migration');
  try {
    const events = kernel.events();
    const sourceFormat = events[0]?.format;
    if (!['music-event-10', 'music-event-11'].includes(sourceFormat)) {
      throw new Error(sourceFormat ? `habitat ledger ${sourceFormat} does not need legacy migration` : 'habitat ledger is empty');
    }
    const state = kernel.state();
    const sourceBytes = readFileSync(habitat.ledger);
    const lineageDirectory = join(habitat.state, 'lineage');
    mkdirSync(lineageDirectory, { recursive: true, mode: 0o700 });
    const archive = join(lineageDirectory, `events-${sourceFormat}-${safeTimestamp()}.jsonl`);
    const lineage = {
      format: 'music-legacy-lineage-1',
      sourceFormat,
      sourceHead: state.head,
      sourceSha256: sha256(sourceBytes),
      eventCount: events.length,
      archive: relative(habitat.root, archive),
      migratedAt: new Date().toISOString(),
    };
    renameSync(habitat.ledger, archive);
    try {
      kernel.initializeMigrated({
        subject: state.subject,
        tools: [...state.tools.values()],
        toolHistory: [...state.toolHistory.values()],
        carrier: serializeCarrier(state.carrier),
        lineage,
        checkpoint: legacyCheckpoint(state),
      });
    } catch (error) {
      if (existsSync(habitat.ledger)) unlinkSync(habitat.ledger);
      renameSync(archive, habitat.ledger);
      throw error;
    }
    return {
      habitat: habitat.root,
      ledger: habitat.ledger,
      archive,
      lineage,
      positionRoot: kernel.state().position.root,
    };
  } finally {
    release();
  }
}

function legacyCheckpoint(state) {
  return {
    format: 'music-legacy-checkpoint-1',
    deltaIds: [...state.deltaIds],
    pendingDeltas: structuredClone(state.pendingDeltas),
    consequences: [...state.consequences.entries()].map(([deltaId, consequence]) => ({
      deltaId, consequence: structuredClone(consequence),
    })),
    invocationHistory: [...state.invocationHistory.entries()].map(([invocationId, invocation]) => ({
      invocationId, invocation: structuredClone(invocation),
    })),
    invocations: structuredClone(state.invocations),
    contactedInvocationIds: [...state.contactedInvocationIds],
    consequenceSweepActive: state.consequenceSweepActive,
    consequenceSweepIds: [...state.consequenceSweepIds],
    nextWake: state.nextWake === null ? null : structuredClone(state.nextWake),
    runtimeFailure: state.runtimeFailure === undefined ? null : structuredClone(state.runtimeFailure),
  };
}

export function defaultModelConfig() {
  return {
    provider: 'openrouter',
    model: 'z-ai/glm-5.3-flash',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    appName: 'Music',
    modelSettings: { extraBody: { reasoning: { effort: 'minimal' } } },
    maxOutputTokens: 15_000,
    maxRetries: 0,
  };
}

function habitatPaths(root) {
  return {
    root,
    home: join(root, 'home'),
    state: join(root, 'state'),
    ledger: join(root, 'state', 'events.jsonl'),
    mailbox: join(root, 'mailbox'),
    dependencies: join(root, 'dependencies'),
    config: join(root, 'config'),
    modelConfig: join(root, 'config', 'model.json'),
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
