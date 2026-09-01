#!/usr/bin/env node
import { installRelease } from '../src/install.js';

const destination = process.argv[2];
if (!destination) throw new Error('usage: music-install /new/absolute/release-directory');
process.stdout.write(`${JSON.stringify(installRelease(destination), null, 2)}\n`);
