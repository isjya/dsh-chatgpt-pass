// Start one isolated Harness Web instance from the installed plugin, capture the
// launch URL from its stdout in memory (the credential-bearing line is never
// persisted to the terminal or the log), drive the settings UI headlessly, then
// stop the instance.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostCommand } from './host-command.mjs';
import { runUiCheck, redact } from './ui-check-lib.mjs';

const target = process.argv[2];
if (!['source', 'desktop'].includes(target)) throw new Error('Use source or desktop');
const port = process.argv[3] ?? (target === 'source' ? '3197' : '3202');
const outBase = resolve(process.argv[4] ?? `.validation/ui-${target}`);
await mkdir(resolve(outBase, '..'), { recursive: true });
const log = createWriteStream(`${outBase}.log`);

const { command, args, env, cwd } = hostCommand(target, ['--no-open', '--port', port]);
const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
// Only the `dsh web:` readiness line carries the launch token; an earlier
// listening line may advertise the same origin without one.
const urlPattern = new RegExp(`dsh web: (https?://127\\.0\\.0\\.1:${port}/\\S*token=\\S+)`);
const found = new Promise((ok, bad) => {
  let buffer = '';
  let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; bad(new Error('Launch URL did not appear in time')); } }, 180_000);
  const onData = data => {
    const text = String(data);
    log.write(redact(text));
    process.stdout.write(redact(text));
    buffer += text;
    const match = buffer.match(urlPattern);
    if (match && !done) { done = true; clearTimeout(timer); ok(match[1]); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', code => { if (!done) { done = true; clearTimeout(timer); bad(new Error(`Host exited early with code ${code}`)); } });
  child.once('error', error => { if (!done) { done = true; clearTimeout(timer); bad(error); } });
});

let report;
try {
  const url = await found;
  report = { target, port, driverNode: process.version, homePurpose: 'isolated installed-package UI check', ...(await runUiCheck(url, outBase)) };
} finally {
  child.kill();
  log.end();
}
console.log(JSON.stringify({ ...report, log: `${outBase}.log`, url: 'redacted' }));
if (report?.stage !== 'rendered') process.exitCode = 1;
