import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialFilePatchTool() {
  return validateToolModule({
    id: 'file_patch',
    version: 1,
    parent: null,
    description: 'Apply an exact textual replacement to any file visible to the Music process.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        expectedOccurrences: { type: 'integer', minimum: 1 },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    source: sourceBody(filePatch),
  });
}

async function filePatch(input) {
  const { readFile, writeFile, rename, stat, unlink } = await import('node:fs/promises');
  const { randomUUID, createHash } = await import('node:crypto');
  if (!input || typeof input !== 'object') throw new Error('file_patch input must be an object');
  if (typeof input.path !== 'string' || !input.path) throw new Error('file_patch needs a path');
  if (typeof input.oldText !== 'string' || typeof input.newText !== 'string') throw new Error('file_patch needs oldText and newText');
  if (input.oldText.length === 0) throw new Error('file_patch oldText must be nonempty');
  const before = await readFile(input.path, 'utf8');
  const occurrences = before.split(input.oldText).length - 1;
  const expected = input.expectedOccurrences ?? 1;
  if (!Number.isInteger(expected) || expected < 1) throw new Error('expectedOccurrences must be a positive integer');
  if (occurrences !== expected) throw new Error(`file_patch expected ${expected} occurrence(s), found ${occurrences}`);
  const after = before.split(input.oldText).join(input.newText);
  const metadata = await stat(input.path);
  const temporary = `${input.path}.music-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, after, { mode: metadata.mode });
    await rename(temporary, input.path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  return { kind: 'file_patch', path: input.path, occurrences, before: sha256(before), after: sha256(after) };
}
