import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialShellTool() {
  return validateToolModule({
    id: 'shell',
    version: 1,
    parent: null,
    description: 'Run an unrestricted foreground shell command with the Music process authority and environment. Returns separate bounded stdout and stderr, exit status, duration, and explicit timeout uncertainty. Relative working directories resolve from the process working directory.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 65_536 },
        workdir: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 100, maximum: 600_000 },
        maxOutputChars: { type: 'integer', minimum: 1_024, maximum: 200_000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
    source: sourceBody(shell),
  });
}

async function shell(input) {
  if (!input || typeof input !== 'object') throw new Error('shell input must be an object');
  if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('shell needs a command');
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const command = input.command;
  const cwd = resolve(process.cwd(), input.workdir ?? '.');
  const timeoutMs = input.timeoutMs ?? 120_000;
  const maxOutputChars = input.maxOutputChars ?? 20_000;
  const captureLimit = 200_000;
  const append = (current, chunk) => {
    const next = current + chunk.toString('utf8');
    return next.length > captureLimit ? next.slice(-captureLimit) : next;
  };
  const startedAt = Date.now();
  const child = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  let stdoutDropped = false;
  let stderrDropped = false;
  let timedOut = false;
  child.stdout.on('data', chunk => {
    const next = stdout + chunk.toString('utf8');
    if (next.length > captureLimit) stdoutDropped = true;
    stdout = append(stdout, chunk);
  });
  child.stderr.on('data', chunk => {
    const next = stderr + chunk.toString('utf8');
    if (next.length > captureLimit) stderrDropped = true;
    stderr = append(stderr, chunk);
  });
  const terminate = signal => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') stderr = append(stderr, `\nMusic could not send ${signal} to the command: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let forceTimer;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate('SIGTERM');
    forceTimer = setTimeout(() => terminate('SIGKILL'), 250);
    forceTimer.unref?.();
  }, timeoutMs);
  timeout.unref?.();
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
  }).finally(() => {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
  });
  const clip = value => value.length > maxOutputChars ? value.slice(-maxOutputChars) : value;
  return {
    ok: !timedOut && result.exitCode === 0,
    kind: 'shell-command',
    command,
    cwd,
    status: timedOut ? 'timeout' : 'exited',
    effect: timedOut ? 'possibly-partial' : 'completed',
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    stdout: clip(stdout),
    stderr: clip(stderr),
    stdoutTruncated: stdoutDropped || stdout.length > maxOutputChars,
    stderrTruncated: stderrDropped || stderr.length > maxOutputChars,
  };
}
