import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialReadFileTool() {
  return validateToolModule({
    id: 'read_file',
    version: 1,
    parent: null,
    description: 'Read a UTF-8 text file with line numbers and bounded pagination. Relative paths resolve from the Music process working directory; absolute paths are accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 1_000 },
        maxChars: { type: 'integer', minimum: 1_024, maximum: 262_144 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    source: sourceBody(readFile),
  });
}

async function readFile(input) {
  if (!input || typeof input !== 'object') throw new Error('read_file input must be an object');
  if (typeof input.path !== 'string' || !input.path) throw new Error('read_file needs a path');
  const { readFile: read, stat } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const file = resolve(process.cwd(), input.path);
  const metadata = await stat(file);
  if (!metadata.isFile()) return { ok: false, kind: 'file-read', path: input.path, resolvedPath: file, error: 'Path is not a regular file.' };
  const bytes = await read(file);
  if (bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) {
    return {
      ok: false, kind: 'file-read', path: input.path, resolvedPath: file, bytes: bytes.length,
      error: 'This appears to be a binary file; read_file only projects UTF-8 text.',
    };
  }
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  const offset = input.offset ?? 1;
  const limit = input.limit ?? 500;
  const maxChars = input.maxChars ?? 131_072;
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = selected.map((line, index) => `${offset + index}: ${line}`).join('\n');
  const content = numbered.length > maxChars ? numbered.slice(0, maxChars) : numbered;
  return {
    ok: true,
    kind: 'file-read',
    path: input.path,
    resolvedPath: file,
    cwd: process.cwd(),
    bytes: bytes.length,
    modifiedAt: metadata.mtime.toISOString(),
    offset,
    limit,
    returnedLines: selected.length,
    totalLines: lines.length,
    hasMore: offset - 1 + selected.length < lines.length,
    truncatedByCharacters: content.length < numbered.length,
    content,
  };
}
