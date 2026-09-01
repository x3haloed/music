import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeTool, starterTools } from '../src/tools.js';

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'music-v2-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const outbox = join(root, 'mailbox', 'outbound', 'pending');
  const dependencies = join(root, 'dependencies');
  mkdirSync(home, { recursive: true });
  const observations = [];
  const invoke = (id, input, capability) => executeTool(
    starterTools().find(tool => tool.manifest.id === id),
    input,
    {
      habitat: root,
      invocationId: 'fixture-invocation',
      wagerId: 'fixture-wager',
      environment: { home, outbox, dependencies },
      grants: capability ? [{ capability, active: true }] : [],
      emitObservation: value => {
        const observation = { ...value, id: `observation-${observations.length + 1}` };
        observations.push(observation);
        return observation;
      },
    },
  );
  return { root, home, outbox, dependencies, observations, invoke };
}

test('resident file tools retain pagination, refusal, exact patching, and bounded search behavior', async t => {
  const { home, invoke } = harness(t);
  const written = await invoke('write_file', { path: 'notes/example.txt', content: 'alpha\nbeta\ngamma\n' }, 'local.write');
  assert.equal(written.ok, true);
  assert.equal(existsSync(join(home, 'notes', 'example.txt')), true);
  const refused = await invoke('write_file', { path: 'notes/example.txt', content: 'replace' }, 'local.write');
  assert.equal(refused.ok, false);

  const page = await invoke('read_file', { path: 'notes/example.txt', offset: 2, limit: 1 }, 'local.read');
  assert.equal(page.content, '2: beta');
  assert.equal(page.hasMore, true);

  await assert.rejects(
    () => invoke('file_patch', { path: 'notes/example.txt', oldText: 'missing', newText: 'x' }, 'local.write'),
    /expected 1 occurrence\(s\), found 0/,
  );
  const patched = await invoke('file_patch', { path: 'notes/example.txt', oldText: 'beta', newText: 'delta' }, 'local.write');
  assert.notEqual(patched.before, patched.after);
  assert.match(readFileSync(join(home, 'notes', 'example.txt'), 'utf8'), /delta/);

  const searched = await invoke('search_files', { pattern: 'delta', path: 'notes' }, 'local.read');
  assert.equal(searched.ok, true);
  assert.equal(searched.count, 1);
});

test('shell retains separate bounded output and explicit timeout uncertainty', async t => {
  const { invoke } = harness(t);
  const result = await invoke('shell', { command: "printf 'out'; printf 'err' >&2" }, 'local.execute');
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  const timeout = await invoke('shell', { command: 'sleep 2', timeoutMs: 100 }, 'local.execute');
  assert.equal(timeout.status, 'timeout');
  assert.equal(timeout.effect, 'possibly-partial');
});

test('web fetch streams a bounded body and retains request/response facts', async t => {
  const { invoke } = harness(t);
  const server = createServer((request, response) => {
    response.writeHead(201, { 'content-type': 'text/plain', 'x-music-method': request.method });
    response.end(`resident request|${'x'.repeat(2_000)}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const result = await invoke('web_fetch', {
    url: `http://127.0.0.1:${port}/contact`, method: 'POST', body: 'hello', maxBytes: 1_024,
  }, 'network.fetch');
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-music-method'], 'POST');
  assert.equal(result.bytes, 1_024);
  assert.equal(result.truncated, true);
});

test('message creates a durable envelope before retaining its outbound observation', async t => {
  const { outbox, observations, invoke } = harness(t);
  const result = await invoke('send_message', {
    action: 'ask', recipient: 'Chad', question: 'What arrived?', replyToObservationId: 'inbound-1',
  }, 'message.send');
  const files = process.getBuiltinModule('node:fs').readdirSync(outbox);
  assert.equal(files.length, 1);
  const envelope = JSON.parse(readFileSync(join(outbox, files[0]), 'utf8'));
  assert.equal(envelope.content, 'What arrived?');
  assert.equal(envelope.wagerId, 'fixture-wager');
  assert.equal(result.observationId, observations[0].id);
  assert.equal(observations[0].replyToObservationId, 'inbound-1');
});

test('dependency tool initializes and reports the resident-local dependency habitat without network contact', async t => {
  const { dependencies, invoke } = harness(t);
  const result = await invoke('manage_dependency', { action: 'list' }, 'dependency.manage');
  assert.deepEqual(result.dependencies, {});
  assert.equal(existsSync(join(dependencies, 'package.json')), true);
});
