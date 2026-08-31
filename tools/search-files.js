import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialSearchFilesTool() {
  return validateToolModule({
    id: 'search_files',
    version: 1,
    parent: null,
    description: 'Search UTF-8 file contents with ripgrep, or discover file paths containing a substring. Relative paths resolve from the Music process working directory; absolute paths are accepted. Results are bounded.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        target: { type: 'string', enum: ['content', 'files'] },
        path: { type: 'string', minLength: 1 },
        fileGlob: { type: 'string', minLength: 1, maxLength: 1_024 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    source: sourceBody(searchFiles),
  });
}

async function searchFiles(input) {
  if (!input || typeof input !== 'object') throw new Error('search_files input must be an object');
  if (typeof input.pattern !== 'string') throw new Error('search_files needs a pattern');
  const { execFile } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const target = input.target ?? 'content';
  const root = resolve(process.cwd(), input.path ?? '.');
  const limit = input.limit ?? 50;
  const run = args => new Promise((resolveResult, reject) => {
    execFile('rg', args, { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && error.code !== 1) {
        error.message = `${error.message}\n${stderr}`.trim();
        reject(error);
      } else resolveResult(stdout);
    });
  });
  if (target === 'files') {
    const stdout = await run(['--files', root]);
    const available = stdout.split('\n').filter(Boolean).filter(path => path.includes(input.pattern));
    const matches = available.slice(0, limit);
    return {
      ok: true, kind: 'file-search', target, cwd: process.cwd(), path: input.path ?? '.', resolvedPath: root,
      matches, count: matches.length, truncated: available.length > limit,
    };
  }
  if (target !== 'content') throw new Error(`unknown search target: ${String(target)}`);
  const args = ['--line-number', '--column', '--no-heading', '--color', 'never'];
  if (input.fileGlob) args.push('--glob', input.fileGlob);
  args.push(input.pattern, root);
  const stdout = await run(args);
  const available = stdout.split('\n').filter(Boolean);
  const matches = available.slice(0, limit);
  return {
    ok: true, kind: 'file-search', target, cwd: process.cwd(), path: input.path ?? '.', resolvedPath: root,
    matches, count: matches.length, truncated: available.length > limit,
  };
}
