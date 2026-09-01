import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync,
  realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, digest } from './canonical.js';
import { createHabitat } from './habitat.js';
import { MusicKernel } from './kernel.js';

const PORTABLE_TOOLS = new Set(['discord_api', 'discord_send', 'discord_read']);
const SUBSTITUTED_TOOLS = new Set([
  'message', 'file_patch', 'manage_dependency', 'read_file', 'write_file', 'search_files', 'shell', 'web_fetch',
]);

export async function planV1Succession(snapshotArgument, v1ReleaseArgument) {
  const snapshot = realpathSync(resolve(snapshotArgument));
  const v1Release = realpathSync(resolve(v1ReleaseArgument));
  const manifest = verifySnapshot(snapshot);
  const releaseCommit = git(v1Release, ['rev-parse', 'HEAD']).trim();
  if (git(v1Release, ['status', '--porcelain', '--untracked-files=all']).length > 0) {
    throw new Error(`v1 release is not clean: ${v1Release}`);
  }
  const [{ MusicKernel: V1Kernel }, { readHabitat: readV1Habitat }, { serializeCarrier }, { toolModuleDigest }] = await Promise.all([
    import(pathToFileURL(join(v1Release, 'src', 'kernel.js'))),
    import(pathToFileURL(join(v1Release, 'src', 'habitat.js'))),
    import(pathToFileURL(join(v1Release, 'src', 'carrier.js'))),
    import(pathToFileURL(join(v1Release, 'src', 'tool-module.js'))),
  ]);
  const habitat = readV1Habitat(snapshot);
  const kernel = new V1Kernel(habitat.ledger);
  const events = kernel.events();
  const state = kernel.state();
  verifyQuiescent(state, snapshot);
  const runtimeCommit = state.runtime?.release?.commit;
  if (runtimeCommit !== releaseCommit) {
    throw new Error(`v1 snapshot runtime commit ${runtimeCommit ?? 'missing'} does not match release ${releaseCommit}`);
  }
  const sourceFormat = events[0]?.format;
  if (sourceFormat !== 'music-event-12') throw new Error(`v1 source must be music-event-12, received ${sourceFormat ?? 'empty ledger'}`);
  if (events.at(-1)?.hash !== state.head) throw new Error('v1 reconstructed head does not match final event');
  const ledgerBytes = readFileSync(habitat.ledger);
  const completedByTool = completedInvocations(state);
  const activeTools = [...state.tools.values()];
  const portable = [];
  const substituted = [];
  const retainedOnly = [];
  for (const tool of activeTools.sort((a, b) => a.id.localeCompare(b.id))) {
    const sourceDigest = toolModuleDigest(tool);
    const completed = completedByTool.get(`${tool.id}:${sourceDigest}`) ?? 0;
    if (PORTABLE_TOOLS.has(tool.id)) {
      if (completed < 1) throw new Error(`portable v1 tool lacks lived successful execution: ${tool.id}@${sourceDigest}`);
      portable.push({
        tool: {
          format: 'music-v2-tool-1',
          manifest: {
            id: tool.id,
            title: title(tool.id),
            description: tool.description,
            inputSchema: structuredClone(tool.inputSchema),
            // V1 retained arbitrary JSON outputs without an output contract.
            // Preserve that exact boundary honestly rather than inventing one.
            outputSchema: {},
            effects: ['discord.access'],
          },
          source: tool.source,
        },
        provenance: {
          kind: 'music-v1-exercised-tool',
          sourceFormat,
          sourceHead: state.head,
          sourceDigest,
          sourceVersion: tool.version,
          sourceParent: tool.parent,
          completedInvocations: completed,
        },
      });
    } else if (SUBSTITUTED_TOOLS.has(tool.id)) {
      substituted.push({ id: tool.id, sourceDigest, sourceVersion: tool.version, completedInvocations: completed, successor: successorToolId(tool.id) });
    } else {
      retainedOnly.push({
        id: tool.id, sourceDigest, sourceVersion: tool.version, completedInvocations: completed,
        reason: 'The mechanism is specific to v1 cognitive geometry or lacks a native v2 causal role; its exact history remains in the lineage archive.',
      });
    }
  }
  const carrier = serializeCarrier(state.carrier);
  const frontier = [...state.developmentalProposals.values()].map(developmentSummary);
  const statuses = countBy(frontier, value => value.status);
  const recentDeltas = events.filter(event => event.type === 'delta_admitted').slice(-64).map(event => structuredClone(event.payload.delta));
  const succession = {
    format: 'music-v1-to-v2-succession-1',
    subjectId: state.subject.id,
    sourceFormat,
    sourceHead: state.head,
    sourceLedgerSha256: sha256(ledgerBytes),
    sourceSnapshotManifestSha256: sha256(readFileSync(join(snapshot, 'snapshot.json'))),
    sourcePositionRoot: state.position.root,
    sourceEventCount: events.length,
    sourceRelease: { commit: releaseCommit, version: state.runtime.release.version },
    sourceSnapshot: { createdAt: manifest.createdAt, files: manifest.files.length },
    sourceArchive: 'state/lineage/v1-snapshot',
    succeededAt: manifest.createdAt,
  };
  const planBody = {
    format: 'music-v1-to-v2-plan-1',
    succession,
    subject: { id: state.subject.id, name: state.subject.name, bornAt: state.subject.bornAt },
    successor: {
      position: {
        stakes: {
          legacyActiveTrajectory: structuredClone(state.currentTrajectory),
          legacyDevelopmentFrontier: frontier.filter(value => ['authored', 'exercised', 'deferred'].includes(value.status)),
          legacyStanding: {
            position: structuredClone(state.position),
            proposalStatuses: statuses,
            note: 'These are exact predecessor standings, not native v2 admissions or floors.',
          },
        },
        memory: {
          legacyCarriers: carrier,
          legacyInferencePolicy: carrier.find(value => value.id === 'inference_policy') ?? null,
          legacyHistoricalResources: historicalResources(state),
          legacyRepresentationChange: {
            from: 'Music v1 Sounding/carrier/trajectory actor',
            to: 'Music v2 wager/consequence developmental recurrence',
            meaning: 'Identity and exact ancestry continue; cognitive representation and native authority do not pretend to be unchanged.',
          },
        },
        authority: defaultInferenceAuthority(),
        floors: [],
        activeOpening: openingFromV1(state.position.activeOpening),
      },
      tools: portable,
      observations: [successionObservation(succession, state), ...recentDeltas.map(deltaObservation)],
    },
    report: {
      portableTools: portable.map(value => ({ id: value.tool.manifest.id, ...value.provenance })),
      substitutedTools: substituted,
      retainedOnlyTools: retainedOnly,
      carrierComponents: carrier.map(value => ({ id: value.id, generation: value.state.generation })),
      activeTrajectory: state.currentTrajectory === null ? null : {
        electionId: state.currentTrajectory.electionId,
        objective: state.currentTrajectory.trajectory.objective,
      },
      activeOpening: structuredClone(state.position.activeOpening),
      development: { total: frontier.length, statuses, carriedActive: frontier.filter(value => ['authored', 'exercised', 'deferred'].includes(value.status)).length },
      recentWorldDeltas: recentDeltas.length,
      exclusions: [
        'V1 inference transcripts remain in the exact archive and are not converted into v2 cognitive receipts.',
        'V1 completed-floor tokens remain historical trajectory evidence and receive no native v2 constitutional authority.',
        'V1 carrier and trajectory organs remain retained history; v2 does not activate them as ordinary tools.',
        'V1 resource totals remain historical facts and do not become v2 resource counters.',
      ],
    },
  };
  return { ...planBody, planDigest: digest(planBody) };
}

export function buildV1Successor(plan, snapshotArgument, targetArgument) {
  const { planDigest, ...body } = plan ?? {};
  if (plan?.format !== 'music-v1-to-v2-plan-1' || planDigest !== digest(body)) {
    throw new Error('invalid or changed v1 succession plan');
  }
  const snapshot = realpathSync(resolve(snapshotArgument));
  const target = resolve(targetArgument);
  const habitat = createHabitat(target);
  copyDirectoryContents(join(snapshot, 'home'), habitat.home);
  copyDirectoryContents(join(snapshot, 'dependencies'), habitat.dependencies);
  const lineage = join(habitat.state, 'lineage', 'v1-snapshot');
  mkdirSync(lineage, { recursive: true, mode: 0o700 });
  for (const name of ['state', 'mailbox', 'config']) cpSync(join(snapshot, name), join(lineage, name), { recursive: true, mode: constants.COPYFILE_FICLONE });
  for (const name of ['habitat.json', 'snapshot.json']) cpSync(join(snapshot, name), join(lineage, name), { mode: constants.COPYFILE_FICLONE });
  writeFileSync(join(lineage, 'succession-plan.json'), `${canonical(plan)}\n`, { flag: 'wx', mode: 0o600 });
  let sequence = 0;
  const kernel = new MusicKernel(habitat.root, {
    clock: () => new Date(plan.succession.succeededAt),
    id: () => `succession-${String(sequence++).padStart(4, '0')}-${plan.planDigest.slice(0, 24)}`,
  });
  const state = kernel.initializeSuccessor({
    subject: plan.subject,
    succession: plan.succession,
    position: plan.successor.position,
    tools: plan.successor.tools,
    observations: plan.successor.observations,
  });
  return { habitat, state, planDigest: plan.planDigest, ledgerHead: state.head };
}

function verifyQuiescent(state, snapshot) {
  const failures = [];
  if (state.activeInferenceId !== null) failures.push(`active inference ${state.activeInferenceId}`);
  if (state.openSoundingId !== null) failures.push(`open Sounding ${state.openSoundingId}`);
  if (state.activeEncounter !== null && state.activeEncounter !== undefined) failures.push('active encounter');
  if ((state.pendingDeltas?.length ?? 0) > 0) failures.push(`${state.pendingDeltas.length} pending Deltas`);
  if ((state.activeToolInvocations?.size ?? state.activeToolInvocations?.length ?? 0) > 0) failures.push('active tool invocations');
  if (state.stagedCarrierTransition) failures.push('staged carrier transition');
  if (state.stagedWakeTransition) failures.push('staged wake transition');
  if (state.stagedDevelopmentalTransaction) failures.push('staged developmental transaction');
  if ((state.stagedRevisions?.size ?? state.stagedRevisions?.length ?? 0) > 0) failures.push('staged revisions');
  const pendingMailbox = mailboxPending(snapshot);
  if (pendingMailbox.length > 0) failures.push(`pending mailbox files: ${pendingMailbox.join(', ')}`);
  if (failures.length > 0) throw new Error(`v1 snapshot is not quiescent: ${failures.join('; ')}`);
}

function verifySnapshot(snapshot) {
  const manifestPath = join(snapshot, 'snapshot.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.format !== 'music-habitat-snapshot-1' || !Array.isArray(manifest.files)) throw new Error('invalid v1 snapshot manifest');
  const actual = inventory(snapshot);
  if (canonical(actual) !== canonical(manifest.files)) throw new Error('v1 snapshot inventory does not match snapshot.json');
  return manifest;
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

function completedInvocations(state) {
  const counts = new Map();
  for (const invocation of state.invocations) {
    if (invocation.status !== 'completed') continue;
    const key = `${invocation.tool.id}:${invocation.tool.digest}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function developmentSummary(value) {
  const tool = value.revision?.tool;
  const component = value.transition?.component;
  return {
    id: value.proposalId,
    kind: value.kind,
    status: value.status,
    authoredAt: value.authoredAt,
    target: tool ? { kind: 'tool', id: tool.id, version: tool.version } : component ? { kind: 'carrier', id: component.id, generation: component.state?.generation ?? null } : null,
    interpretation: value.revision?.interpretation ?? value.transition?.interpretation ?? null,
    evidence: structuredClone(value.revision?.evidence ?? value.transition?.evidence ?? []),
    trials: value.trials?.length ?? 0,
  };
}

function historicalResources(state) {
  return {
    inferenceCheckpoints: count(state.inferenceCheckpointCount),
    invocations: state.invocations.length,
    completedInvocations: state.invocations.filter(value => value.status === 'completed').length,
    failedInvocations: state.invocations.filter(value => value.status === 'failed').length,
    completedInferences: count(state.completedInferences),
    failedInferences: count(state.failedInferences),
    soundings: count(state.soundings),
  };
}

function openingFromV1(opening) {
  if (!opening) return { kind: 'continue', notBefore: null, focus: 'Encounter the exact predecessor standing after representational succession.' };
  return {
    kind: 'continue',
    notBefore: opening.notBefore,
    focus: opening.content?.reason ?? 'Continue the exact predecessor-authored opening.',
  };
}

function successionObservation(succession, state) {
  return {
    id: `v1-succession-${succession.sourceHead.slice(0, 24)}`,
    kind: 'lineage.succeeded',
    observedAt: succession.succeededAt,
    succession: structuredClone(succession),
    predecessor: {
      activeTrajectoryElectionId: state.currentTrajectory?.electionId ?? null,
      activeOpeningId: state.position.activeOpening?.id ?? null,
      carrierRoot: state.position.carrierRoot,
    },
    meaning: 'The same subject now continues through Music v2. This event proves ancestry and representational change; it does not declare predecessor judgments infallible or native v2 authority.',
  };
}

function deltaObservation(delta) {
  return {
    id: `v1-delta-${digest(delta).slice(0, 24)}`,
    kind: 'legacy.delta',
    observedAt: delta.at,
    source: { format: 'music-v1-delta', id: delta.id, stream: delta.stream, authority: delta.authority },
    delta: structuredClone(delta),
  };
}

function defaultInferenceAuthority() {
  return { inference: {
    model: 'z-ai/glm-5.3-flash', reasoningEffort: 'low', providerOrder: ['z-ai', 'deepinfra', 'baseten'],
    budgets: { orientation: 15_000, challenge: 15_000, election: 15_000, assimilation: 15_000, disposition: 15_000 },
    timeoutMs: 120_000,
  } };
}

function mailboxPending(snapshot) {
  const mailbox = join(snapshot, 'mailbox');
  const pending = [];
  for (const name of readdirSync(mailbox)) {
    const path = join(mailbox, name);
    if (statSync(path).isFile()) pending.push(relative(snapshot, path));
    if (name === 'outbound' && statSync(path).isDirectory()) {
      for (const child of readdirSync(path)) {
        const childPath = join(path, child);
        if (statSync(childPath).isFile()) pending.push(relative(snapshot, childPath));
        if (child === 'pending' && statSync(childPath).isDirectory()) {
          for (const file of readdirSync(childPath)) pending.push(relative(snapshot, join(childPath, file)));
        }
      }
    }
  }
  return pending.sort();
}

function copyDirectoryContents(source, target) {
  for (const name of readdirSync(source)) cpSync(join(source, name), join(target, name), { recursive: true, mode: constants.COPYFILE_FICLONE });
}

function countBy(values, key) {
  const result = {};
  for (const value of values) result[key(value)] = (result[key(value)] ?? 0) + 1;
  return result;
}

function successorToolId(id) { return id === 'message' ? 'send_message' : id === 'manage_dependency' ? 'manage_dependency' : id; }
function title(id) { return id.split('_').map(value => value[0].toUpperCase() + value.slice(1)).join(' '); }
function count(value) { return typeof value === 'number' ? value : value?.size ?? value?.length ?? 0; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function git(root, args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); }
