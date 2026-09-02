#!/usr/bin/env node
import { archiveLaunchAgent, installLaunchAgent, stopLaunchAgent } from '../src/service.js';

const [command, ...args] = process.argv.slice(2);
if (command === 'install') {
  const [label, release, run, spec] = args;
  if (![label, release, run, spec].every(Boolean)) throw new Error('usage: music-service install LABEL RELEASE RUN SPEC');
  process.stdout.write(`${JSON.stringify(installLaunchAgent({ label, release, run, spec }), null, 2)}\n`);
} else if (command === 'stop') {
  if (!args[0]) throw new Error('usage: music-service stop LABEL');
  process.stdout.write(`${JSON.stringify(stopLaunchAgent(args[0]), null, 2)}\n`);
} else if (command === 'archive') {
  if (!args[0]) throw new Error('usage: music-service archive LABEL');
  process.stdout.write(`${JSON.stringify(archiveLaunchAgent(args[0]), null, 2)}\n`);
} else {
  throw new Error('usage: music-service install LABEL RELEASE RUN SPEC | stop LABEL | archive LABEL');
}
