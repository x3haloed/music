import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function serviceDefinition({ label, release, run, spec, node = process.execPath, logsRoot = join(homedir(), '.local/share/music/logs') }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/.test(label)) throw new Error('service label must be 3..128 letters, digits, dots, or hyphens');
  for (const [name, value] of Object.entries({ release, run, spec, node, logsRoot })) {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  const cli = resolve(release, 'src/cli.js');
  if (!existsSync(cli)) throw new Error(`sealed Music CLI is missing: ${cli}`);
  if (!existsSync(spec)) throw new Error(`sealed resident spec is missing: ${spec}`);
  return {
    label,
    cli,
    run: resolve(run),
    spec: resolve(spec),
    node: resolve(node),
    logsRoot: resolve(logsRoot),
    stdout: resolve(logsRoot, `${label}.stdout.log`),
    stderr: resolve(logsRoot, `${label}.stderr.log`),
  };
}

export function renderLaunchAgent(definition) {
  const value = definition?.cli ? definition : serviceDefinition(definition);
  const args = [value.node, value.cli, 'resident', value.run, value.spec];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(value.label)}</string>
  <key>ProgramArguments</key>
  <array>${args.map(item => `\n    <string>${xml(item)}</string>`).join('')}\n  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(value.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(value.stderr)}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent(definition, {
  agentsRoot = join(homedir(), 'Library/LaunchAgents'),
  execute = execFileSync,
  uid = process.getuid?.(),
} = {}) {
  if (process.platform !== 'darwin') throw new Error('Music LaunchAgent installation requires macOS');
  if (!Number.isInteger(uid)) throw new Error('could not determine the macOS user id');
  const value = serviceDefinition(definition);
  const plist = resolve(agentsRoot, `${value.label}.plist`);
  if (existsSync(plist)) throw new Error(`LaunchAgent already exists: ${plist}`);
  mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
  mkdirSync(value.logsRoot, { recursive: true, mode: 0o700 });
  writeFileSync(plist, renderLaunchAgent(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    execute('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'pipe' });
    execute('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${value.label}`], { stdio: 'pipe' });
  } catch (error) {
    const disabled = `${plist}.disabled-${Date.now()}`;
    renameSync(plist, disabled);
    throw new Error(`LaunchAgent failed to start; definition preserved at ${disabled}`, { cause: error });
  }
  return { format: 'music-v4-launch-agent-1', label: value.label, plist, run: value.run, releaseCli: value.cli };
}

export function stopLaunchAgent(label, { agentsRoot = join(homedir(), 'Library/LaunchAgents'), execute = execFileSync, uid = process.getuid?.() } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/.test(label)) throw new Error('invalid service label');
  const plist = resolve(agentsRoot, `${label}.plist`);
  if (!existsSync(plist)) throw new Error(`LaunchAgent does not exist: ${plist}`);
  execute('/bin/launchctl', ['bootout', `gui/${uid}`, plist], { stdio: 'pipe' });
  return { stopped: true, label, plist };
}

export function archiveLaunchAgent(label, options = {}) {
  const stopped = stopLaunchAgent(label, options);
  const archived = `${stopped.plist}.disabled-${Date.now()}`;
  renameSync(stopped.plist, archived);
  return { ...stopped, archived };
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
