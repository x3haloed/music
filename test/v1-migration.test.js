import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { digest } from '../src/canonical.js';
import { MusicKernel } from '../src/kernel.js';
import { buildV1Successor } from '../src/v1-migration.js';

test('one frozen succession plan builds the same v2 genesis twice and rejects changed meaning', t => {
  const root = mkdtempSync(join(tmpdir(), 'music-v1-successor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = join(root, 'snapshot');
  for (const path of ['home', 'dependencies', 'state/lineage', 'mailbox/accepted', 'config']) mkdirSync(join(snapshot, path), { recursive: true });
  writeFileSync(join(snapshot, 'home', 'continuity.txt'), 'same resident\n');
  writeFileSync(join(snapshot, 'state', 'events.jsonl'), '{"retained":"v1"}\n');
  writeFileSync(join(snapshot, 'habitat.json'), '{"format":"music-habitat-1"}\n');
  writeFileSync(join(snapshot, 'snapshot.json'), '{"format":"music-habitat-snapshot-1","files":[]}\n');
  const hash = value => value.repeat(64);
  const body = {
    format: 'music-v1-to-v2-plan-1',
    succession: {
      format: 'music-v1-to-v2-succession-1', subjectId: 'resident', sourceFormat: 'music-event-12',
      sourceHead: hash('a'), sourceLedgerSha256: hash('b'), sourceSnapshotManifestSha256: hash('c'),
      sourcePositionRoot: hash('d'), sourceEventCount: 10, sourceArchive: 'state/lineage/v1-snapshot',
      succeededAt: '2026-09-01T17:31:55.553Z',
    },
    subject: { id: 'resident', name: null, bornAt: '2026-08-31T06:16:49.630Z' },
    successor: {
      position: {
        stakes: { inherited: true }, memory: { continuity: 'exact' }, floors: [],
        authority: { inference: { model: 'z-ai/glm-5.3-flash', reasoningEffort: 'low', providerOrder: ['z-ai'], budgets: {
          orientation: 15_000, challenge: 15_000, election: 15_000, assimilation: 15_000, disposition: 15_000,
        }, timeoutMs: 120_000 } },
        activeOpening: { kind: 'continue', notBefore: null, focus: 'Continue.' },
      },
      tools: [],
      observations: [{ id: 'succession', kind: 'lineage.succeeded', observedAt: '2026-09-01T17:31:55.553Z' }],
    },
    report: { exact: true },
  };
  const plan = { ...body, planDigest: digest(body) };
  const first = buildV1Successor(plan, snapshot, join(root, 'first'));
  const second = buildV1Successor(plan, snapshot, join(root, 'second'));
  assert.equal(first.ledgerHead, second.ledgerHead);
  assert.equal(first.state.position.id, second.state.position.id);
  assert.equal(first.state.subject.id, 'resident');
  assert.equal(new MusicKernel(first.habitat.root).state().succession.sourceHead, hash('a'));
  const changed = structuredClone(plan);
  changed.successor.position.memory.continuity = 'rewritten';
  assert.throws(() => buildV1Successor(changed, snapshot, join(root, 'changed')), /changed v1 succession plan/);
});
