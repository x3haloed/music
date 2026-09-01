import { z } from 'zod';
import Ajv from 'ajv';
import { canonical } from './canonical.js';
import { IdentifierSchema, JsonValueSchema } from './schema.js';

export const ToolArtifactSchema = z.object({
  format: z.literal('music-v2-tool-1'),
  manifest: z.object({
    id: IdentifierSchema,
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    inputSchema: JsonValueSchema,
    outputSchema: JsonValueSchema,
    effects: z.array(IdentifierSchema).max(32),
  }),
  source: z.string().min(1).max(512 * 1024),
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export async function executeTool(toolValue, input, context) {
  const tool = ToolArtifactSchema.parse(toolValue);
  JsonValueSchema.parse(input);
  validateContract(tool.manifest.inputSchema, input, `${tool.manifest.id} input`);
  const granted = new Set(context.grants.filter(grant => grant.active).map(grant => grant.capability));
  for (const effect of tool.manifest.effects) {
    if (!granted.has(effect)) throw new Error(`effect is not granted: ${effect}`);
  }
  const run = new AsyncFunction('input', 'context', `'use strict';\n${tool.source}`);
  const output = await run(structuredClone(input), Object.freeze({
    habitat: context.habitat,
    emitObservation: context.emitObservation,
  }));
  JsonValueSchema.parse(output);
  validateContract(tool.manifest.outputSchema, output, `${tool.manifest.id} output`);
  canonical(output);
  return output;
}

export function starterTools() {
  return [
    artifact('read_file', 'Read file', 'Read exact UTF-8 text from a local file. If the file is larger than maxBytes, the contact fails rather than truncating.',
      objectSchema({ path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1 } }, ['path']),
      objectSchema({ path: { type: 'string' }, bytes: { type: 'integer', minimum: 0 }, text: { type: 'string' } }, ['path', 'bytes', 'text']),
      ['local.read'], `
const { readFile, stat } = await import('node:fs/promises');
const { resolve } = await import('node:path');
const path = resolve(context.habitat, input.path);
const limit = Number.isInteger(input.maxBytes) ? input.maxBytes : 2097152;
const info = await stat(path);
if (info.size > limit) throw new Error('file exceeds maxBytes');
return { path, bytes: info.size, text: await readFile(path, 'utf8') };
`),
    artifact('write_file', 'Write file', 'Write exact UTF-8 text to a local file, creating parent directories.',
      objectSchema({ path: { type: 'string' }, text: { type: 'string' } }, ['path', 'text']),
      objectSchema({ path: { type: 'string' }, bytes: { type: 'integer', minimum: 0 }, written: { const: true } }, ['path', 'bytes', 'written']),
      ['local.write'], `
const { mkdir, writeFile } = await import('node:fs/promises');
const { dirname, resolve } = await import('node:path');
const path = resolve(context.habitat, input.path);
await mkdir(dirname(path), { recursive: true });
await writeFile(path, input.text, { encoding: 'utf8' });
return { path, bytes: Buffer.byteLength(input.text), written: true };
`),
    artifact('shell', 'Run shell command', 'Run an unrestricted zsh command and retain stdout, stderr, and exit status.',
      objectSchema({ command: { type: 'string' }, cwd: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1 } }, ['command']),
      objectSchema({ status: { type: ['integer', 'null'] }, signal: { type: ['string', 'null'] }, stdout: { type: 'string' }, stderr: { type: 'string' }, truncated: { type: 'boolean' } }, ['status', 'signal', 'stdout', 'stderr', 'truncated']),
      ['local.execute'], `
const { spawn } = await import('node:child_process');
const { resolve } = await import('node:path');
const cwd = resolve(context.habitat, input.cwd || '.');
const limit = Number.isInteger(input.maxBytes) ? input.maxBytes : 2097152;
const result = await new Promise((resolveResult, reject) => {
  const child = spawn('/bin/zsh', ['-lc', input.command], { cwd, env: process.env });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  const collect = target => chunk => {
    bytes += chunk.length;
    if (bytes > limit) child.kill('SIGKILL');
    else target.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.on('error', reject);
  child.on('close', (code, signal) => resolveResult({
    status: code,
    signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    truncated: bytes > limit,
  }));
});
return result;
`),
    artifact('web_fetch', 'Fetch web resource', 'Fetch an HTTP(S) resource and retain status, headers, and bounded text.',
      objectSchema({ url: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1 } }, ['url']),
      objectSchema({ url: { type: 'string' }, status: { type: 'integer' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, text: { type: 'string' } }, ['url', 'status', 'headers', 'text']),
      ['network.fetch'], `
const url = new URL(input.url);
if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only HTTP(S) URLs are supported');
const response = await fetch(url, { redirect: 'follow' });
const limit = Number.isInteger(input.maxBytes) ? input.maxBytes : 2097152;
const bytes = new Uint8Array(await response.arrayBuffer());
if (bytes.length > limit) throw new Error('response exceeds maxBytes');
return {
  url: response.url,
  status: response.status,
  headers: Object.fromEntries([...response.headers].sort(([a], [b]) => a.localeCompare(b))),
  text: new TextDecoder().decode(bytes),
};
`),
    artifact('send_message', 'Send message', 'Place a message in the entity outbox for delivery by an external adapter.',
      objectSchema({ to: { type: 'string' }, content: { type: 'string' }, channel: { type: 'string' } }, ['to', 'content']),
      objectSchema({ queued: { const: true }, observationId: { type: 'string' } }, ['queued', 'observationId']),
      ['message.send'], `
const observation = await context.emitObservation({
  kind: 'message.outbound',
  recipient: input.to,
  channel: input.channel || 'outbox',
  content: input.content,
});
return { queued: true, observationId: observation.id };
`),
  ];
}

function artifact(id, title, description, inputSchema, outputSchema, effects, source) {
  return ToolArtifactSchema.parse({
    format: 'music-v2-tool-1',
    manifest: { id, title, description, inputSchema, outputSchema, effects },
    source: source.trim(),
  });
}

export function validateContract(schema, value, label = 'value') {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`${label} violates its JSON schema: ${ajv.errorsText(validate.errors)}`);
  }
}

function objectSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}
