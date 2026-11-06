// Open an explicitly supplied loopback host and save a redacted settings report.
import { resolve } from 'node:path';
import { runUiCheck } from './ui-check-lib.mjs';
const url = process.argv[2];
if (!url) throw new Error('Pass the isolated Harness loopback URL.');
const parsed = new URL(url);
if (!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)) throw new Error('Only a local Harness URL is supported.');
const report = await runUiCheck(url, resolve(process.argv[3] ?? '.validation/ui-check'));
console.log(JSON.stringify(report));
if (report.stage !== 'rendered') process.exitCode = 1;
