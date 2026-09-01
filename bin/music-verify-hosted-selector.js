#!/usr/bin/env node
import { resolve } from 'node:path';
import { runHostedSelectorVerification } from '../src/hosted-selector-verification.js';

const root = process.argv[2];
if (!root) throw new Error('usage: music-verify-hosted-selector /new/absolute/output-directory');
const report = await runHostedSelectorVerification(resolve(root));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
