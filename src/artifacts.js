import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class ArtifactStore {
  constructor(root) {
    this.root = root;
  }

  put(bytes) {
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const id = createHash('sha256').update(content).digest('hex');
    const path = this.path(id);
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
    return id;
  }

  has(id) {
    return existsSync(this.path(id));
  }

  read(id) {
    const content = readFileSync(this.path(id));
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== id) throw new Error(`artifact digest mismatch: ${id}`);
    return content;
  }

  path(id) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid artifact digest');
    return join(this.root, id);
  }
}
