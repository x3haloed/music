import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialWriteFileTool() {
  return validateToolModule({
    id: 'write_file',
    version: 1,
    parent: null,
    description: 'Create a UTF-8 text file, including missing parent directories. Existing files are refused unless overwrite is explicitly true. Relative paths resolve from the Music process working directory; absolute paths are accepted.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string', maxLength: 1_048_576 },
        overwrite: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    source: sourceBody(writeFile),
  });
}

async function writeFile(input) {
  if (!input || typeof input !== 'object') throw new Error('write_file input must be an object');
  if (typeof input.path !== 'string' || !input.path) throw new Error('write_file needs a path');
  if (typeof input.content !== 'string') throw new Error('write_file needs string content');
  const { link, mkdir, open, rename, stat, unlink } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { createHash, randomUUID } = await import('node:crypto');
  const file = resolve(process.cwd(), input.path);
  await mkdir(dirname(file), { recursive: true });
  let existing = null;
  try { existing = await stat(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing && input.overwrite !== true) {
    return { ok: false, kind: 'file-write', path: input.path, resolvedPath: file, error: 'File already exists; set overwrite=true to replace it.' };
  }
  if (existing && !existing.isFile()) {
    return { ok: false, kind: 'file-write', path: input.path, resolvedPath: file, error: 'Existing path is not a regular file.' };
  }
  const data = Buffer.from(input.content, 'utf8');
  const temporary = `${file}.music-${process.pid}-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', existing?.mode ?? 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (existing) await rename(temporary, file);
    else {
      await link(temporary, file);
      await unlink(temporary);
    }
    const directory = await open(dirname(file), 'r').catch(() => null);
    if (directory) try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    kind: 'file-write',
    path: input.path,
    resolvedPath: file,
    cwd: process.cwd(),
    bytes: data.length,
    overwritten: Boolean(existing),
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}
