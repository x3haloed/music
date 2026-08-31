import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MusicKernel } from '../src/kernel.js';
import { initialTools } from '../src/seeds.js';

test('the starter filesystem tools discover, create, read, search, and revise real files', async () => {
  const { kernel, root } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  const target = join(root, 'resident', 'notes.txt');

  const written = await kernel.invokeTool(inferenceId, sounding.id, 'write_file', {
    path: target,
    content: 'first line\nneedle line\nthird line\n',
  });
  assert.equal(written.ok, true);
  assert.equal(written.overwritten, false);
  assert.equal(readFileSync(target, 'utf8'), 'first line\nneedle line\nthird line\n');

  const refused = await kernel.invokeTool(inferenceId, sounding.id, 'write_file', {
    path: target,
    content: 'unrequested replacement',
  });
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(target, 'utf8'), 'first line\nneedle line\nthird line\n');

  const read = await kernel.invokeTool(inferenceId, sounding.id, 'read_file', {
    path: target,
    offset: 2,
    limit: 1,
  });
  assert.equal(read.ok, true);
  assert.equal(read.totalLines, 4);
  assert.equal(read.hasMore, true);
  assert.equal(read.content, '2: needle line');

  const contentSearch = await kernel.invokeTool(inferenceId, sounding.id, 'search_files', {
    pattern: 'needle',
    path: join(root, 'resident'),
  });
  assert.equal(contentSearch.ok, true);
  assert.equal(contentSearch.count, 1);
  assert.match(contentSearch.matches[0], /notes\.txt:2:1:needle line/);

  const pathSearch = await kernel.invokeTool(inferenceId, sounding.id, 'search_files', {
    pattern: 'notes',
    target: 'files',
    path: join(root, 'resident'),
  });
  assert.equal(pathSearch.ok, true);
  assert.deepEqual(pathSearch.matches, [target]);

  const patched = await kernel.invokeTool(inferenceId, sounding.id, 'file_patch', {
    path: target,
    oldText: 'needle line',
    newText: 'learned line',
  });
  assert.equal(patched.kind, 'file_patch');
  assert.match(readFileSync(target, 'utf8'), /learned line/);

  complete(kernel, inferenceId);
  const restarted = new MusicKernel(kernel.ledgerPath);
  for (const id of ['read_file', 'write_file', 'search_files', 'file_patch']) {
    assert.ok(restarted.state().tools.has(id), `${id} survives reconstruction`);
  }
  assert.equal(restarted.audit().failedInvocations, 0);
});

test('the starter shell executes with real process authority and makes timeout uncertainty explicit', async () => {
  const { kernel, root } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  const target = join(root, 'from-shell.txt');
  const command = `printf 'created by shell' > ${JSON.stringify(target)}; printf 'visible out'; printf 'visible err' >&2`;

  const executed = await kernel.invokeTool(inferenceId, sounding.id, 'shell', { command, workdir: root });
  assert.equal(executed.ok, true);
  assert.equal(executed.status, 'exited');
  assert.equal(executed.effect, 'completed');
  assert.equal(executed.exitCode, 0);
  assert.equal(executed.stdout, 'visible out');
  assert.equal(executed.stderr, 'visible err');
  assert.equal(readFileSync(target, 'utf8'), 'created by shell');

  const timedOut = await kernel.invokeTool(inferenceId, sounding.id, 'shell', {
    command: 'sleep 1',
    workdir: root,
    timeoutMs: 100,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.effect, 'possibly-partial');
  assert.equal(kernel.audit().failedInvocations, 0, 'a reported uncertain effect is a completed invocation, not a false failure');
});

test('the starter web tool crosses a real HTTP boundary with bounded retained output', async t => {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.writeHead(201, { 'content-type': 'text/plain; charset=utf-8', 'x-music-method': request.method });
    response.end(`${body}|${'x'.repeat(2_048)}`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const { kernel } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);

  const fetched = await kernel.invokeTool(inferenceId, sounding.id, 'web_fetch', {
    url: `http://127.0.0.1:${address.port}/contact`,
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'resident request',
    maxBytes: 1_024,
  });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.status, 201);
  assert.equal(fetched.headers['x-music-method'], 'POST');
  assert.match(fetched.body, /^resident request\|x+/);
  assert.equal(fetched.bytes, 1_024);
  assert.equal(fetched.truncated, true);

  const retained = kernel.events().findLast(event => event.type === 'tool_invocation_completed');
  assert.equal(retained.payload.output.url, fetched.url);
  assert.equal(retained.payload.output.status, 201);
  assert.equal(retained.payload.output.body, fetched.body);
});

test('starter observation failures retain exact invocation failure boundaries', async () => {
  const { kernel, root } = harness();
  const sounding = kernel.openSounding();
  const inferenceId = begin(kernel, sounding.id);
  await assert.rejects(
    () => kernel.invokeTool(inferenceId, sounding.id, 'read_file', { path: join(root, 'absent.txt') }),
    /ENOENT/,
  );
  assert.equal(kernel.audit().failedInvocations, 1);
  assert.deepEqual(
    kernel.events().filter(event => event.type.startsWith('tool_invocation_')).map(event => event.type),
    ['tool_invocation_started', 'tool_invocation_failed'],
  );
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'music-starter-tools-'));
  let identity = 0;
  const kernel = new MusicKernel(join(root, 'events.jsonl'), { id: () => `starter-id-${++identity}` });
  kernel.initialize('Test Subject', initialTools());
  return { root, kernel };
}

function begin(kernel, soundingId) {
  return kernel.beginInference(soundingId, { provider: 'fixture', model: 'fixture' }, { role: 'user', content: 'Fixture.' });
}

function complete(kernel, inferenceId) {
  kernel.completeInference(inferenceId, {
    responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }],
    text: 'Done.', finishReason: 'stop', usage: {}, steps: [], requests: [],
  });
}
