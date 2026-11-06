// Verify that the connected Codex models reach the real chat model picker.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostCommand } from './host-command.mjs';
import { withPage } from './ui-check-lib.mjs';

const port = process.argv[2] ?? '3203';
const out = resolve(process.argv[3] ?? '.validation/model-picker.json');
const { command, args, env, cwd } = hostCommand('desktop', ['--no-open', '--port', port]);
const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((ok, bad) => {
  let buffer = ''; const timer = setTimeout(() => bad(new Error('Launch URL did not appear in time')), 180000);
  const onData = d => { buffer += String(d); const m = buffer.match(new RegExp(`dsh web: (https?://127\\.0\\.0\\.1:${port}/\\S*token=\\S+)`)); if (m) { clearTimeout(timer); ok(m[1]); } };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.once('exit', code => bad(new Error(`Host exited early with code ${code}`)));
});
let report;
try {
  const { value, consoleErrors } = await withPage(url, async ({ evaluate, screenshot }) => {
    const result = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitFor = async (find, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = find(); if (v) return v; await sleep(200); } return undefined; };
      await waitFor(() => /GPT-|ChatGPT 订阅/.test(document.body?.innerText ?? ''), 30000);
      const button = await waitFor(() => [...document.querySelectorAll('button')].find(b => /请选择模型|Select model|GPT-|模型/i.test((b.getAttribute('aria-label') ?? '') + ' ' + b.innerText)), 60000);
      if (!button) return { stage: 'button', text: document.body.innerText.slice(0, 600) };
      button.click();
      const menu = await waitFor(() => document.querySelector('[role="menu"]'), 20000);
      await sleep(800);
      const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])].map(i => i.innerText.trim()).filter(Boolean);
      return { stage: menu ? 'menu' : 'no-menu', items: items.slice(0, 30), text: (menu?.innerText ?? '').slice(0, 1200) };
    })()`);
    await screenshot(`${out.replace(/\.json$/, '')}.png`);
    return result;
  });
  report = { at: new Date().toISOString(), ...value, consoleErrors, realAccount: 'NOT RUN' };
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { child.kill(); }
if (report?.stage !== 'menu' || !/gpt-6-astra|gpt-5\.6-sol|ChatGPT 订阅/i.test(report?.text ?? '')) process.exitCode = 1;
