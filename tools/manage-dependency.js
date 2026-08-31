import { sourceBody, validateToolModule } from '../src/tool-module.js';

export function initialDependencyTool() {
  return validateToolModule({
    id: 'manage_dependency',
    version: 1,
    parent: null,
    description: 'Install, remove, or list packages in the resident dependency habitat with normal npm lifecycle scripts and unrestricted process/network authority. Newly learned tools can resolve packages from context.environment.dependencyRoot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['install', 'remove', 'list'] },
        name: { type: 'string', minLength: 1, maxLength: 214 },
        spec: { type: 'string', minLength: 1, maxLength: 2_048 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    source: sourceBody(manageDependency),
  });
}

async function manageDependency(input) {
  if (!input || typeof input !== 'object') throw new Error('manage_dependency input must be an object');
  const dependencyRoot = context.environment?.dependencyRoot;
  if (typeof dependencyRoot !== 'string' || !dependencyRoot.trim()) {
    throw new Error('dependency management needs a configured dependencyRoot');
  }
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const root = resolve(dependencyRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const manifestPath = join(root, 'package.json');
  try {
    await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(manifestPath, `${JSON.stringify({ name: 'music-resident-dependencies', version: '0.0.0', private: true }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  if (input.action === 'list') {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    return { kind: 'dependency-list', root, dependencies: manifest.dependencies ?? {} };
  }
  if (!['install', 'remove'].includes(input.action)) throw new Error(`unknown dependency action: ${String(input.action)}`);
  if (typeof input.name !== 'string' || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(input.name)) {
    throw new Error(`${input.action} needs a valid package name`);
  }
  const args = input.action === 'install'
    ? ['install', '--save-exact', '--no-audit', '--no-fund', input.spec ?? input.name]
    : ['uninstall', '--no-audit', '--no-fund', input.name];
  const result = await new Promise((resolveResult, reject) => {
    execFile('npm', args, { cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr}`.trim();
        reject(error);
      } else resolveResult({ stdout, stderr });
    });
  });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (input.action === 'install' && typeof manifest.dependencies?.[input.name] !== 'string') {
    throw new Error(`npm completed without retaining the requested package name: ${input.name}`);
  }
  return {
    kind: 'dependency-change', action: input.action, name: input.name, root,
    retainedSpec: manifest.dependencies?.[input.name] ?? null,
    stdout: result.stdout.slice(-16_384), stderr: result.stderr.slice(-16_384),
  };
}
