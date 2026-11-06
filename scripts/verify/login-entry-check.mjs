// Verify the real login entry without authenticating: click the ChatGPT login action
// in the installed plugin, observe the official authorize URL opened in the popup
// (parameter names only, never values), then cancel the pending attempt.
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostCommand } from './host-command.mjs';
import { withPage } from './ui-check-lib.mjs';

const target = process.argv[2];
if (!['source', 'desktop'].includes(target)) throw new Error('Use source or desktop');
const port = process.argv[3] ?? (target === 'source' ? '3197' : '3202');
const out = resolve(process.argv[4] ?? `.validation/login-entry-${target}.json`);
const method = process.argv[5] ?? 'siwc';
if (!['siwc', 'codex'].includes(method)) throw new Error('Use siwc or codex');
const buttonLabel = method === 'codex' ? '使用 Business 登录' : '使用 ChatGPT 登录';
const { command, args, env, cwd } = hostCommand(target, ['--no-open', '--port', port]);
const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((ok, bad) => {
  let buffer = ''; const timer = setTimeout(() => bad(new Error('Launch URL did not appear in time')), 180000);
  const onData = d => { buffer += String(d); const m = buffer.match(new RegExp(`dsh web: (https?://127\\.0\\.0\\.1:${port}/\\S*token=\\S+)`)); if (m) { clearTimeout(timer); ok(m[1]); } };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.once('exit', code => bad(new Error(`Host exited early with code ${code}`)));
});
let report;
try {
  const { value } = await withPage(url, async ({ evaluate, screenshot, sleep }) => {
    const open = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const waitFor = async (find, ms = 45000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = find(); if (v) return v; await sleep(200); } return undefined; };
      await waitFor(() => document.querySelector('button[aria-haspopup="menu"]'), 60000); await sleep(500);
      const opener = [...document.querySelectorAll('button')].find(b => /^(打开侧边栏|Open sidebar)$/i.test(b.getAttribute('aria-label') ?? ''));
      if (opener && !document.querySelector('button[aria-haspopup="dialog"]')) { opener.click(); await sleep(700); }
      const navOpen = () => document.querySelector('[role="dialog"] nav button');
      if (!navOpen()) {
        for (const button of [...document.querySelectorAll('button[aria-haspopup="menu"]')]) {
          button.click(); await sleep(600);
          const item = [...document.querySelectorAll('[role="menuitem"],[role="menu"] button')].find(i => /^(设置|Settings)/.test(i.innerText.trim()));
          if (item) { item.click(); await sleep(800); break; }
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); await sleep(300);
        }
      }
      const nav = await waitFor(() => [...document.querySelectorAll('[role="dialog"] nav button')].find(b => b.innerText.includes('ChatGPT 订阅')), 20000);
      if (!nav) return { stage: 'settings', dialog: document.querySelector('[role="dialog"]')?.innerText.slice(0, 600) ?? '' };
      nav.click();
      await waitFor(() => document.querySelector('.chatgpt-subscription'));
      const switcher = document.querySelector('.cgp-switch'); if (switcher) switcher.open = true;
      const button = await waitFor(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === ${JSON.stringify(buttonLabel)}), 20000);
      if (!button) return { stage: 'button', dialog: document.querySelector('[role="dialog"]')?.innerText.slice(0, 800) ?? '' };
      button.click();
      const status = await waitFor(() => { const s = [...document.querySelectorAll('[role="dialog"] [role="status"]')].map(n => n.innerText).join(' | '); return /等待授权|请在浏览器中完成登录/.test(s) ? s : undefined; }, 30000);
      const link = [...document.querySelectorAll('[role="dialog"] a')].find(a => a.href.includes('auth.openai.com'));
      return { stage: status ? 'waiting' : 'no-status', status: status ?? '', alert: document.querySelector('[role="dialog"] [role="alert"]')?.innerText.slice(0, 300) ?? '', hasOfficialLink: !!link, linkHref: link?.href ?? '' };
    })()`);
    // The popup target is inspected through the browser's own target list; only
    // structural facts are kept, never the PKCE/state values.
    let authorize;
    for (let i = 0; i < 150 && open.stage === 'waiting' && !authorize; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${Number(process.env.DSH_BROWSER_PORT ?? 9223)}/json/list`)).json();
      const hit = targets.find(t => typeof t.url === 'string' && t.url.startsWith('https://auth.openai.com/'));
      if (hit) { const u = new URL(hit.url); authorize = { origin: u.origin, pathname: u.pathname, parameters: [...u.searchParams.keys()].sort(), scopeValues: u.searchParams.get('scope')?.split(' ') ?? [] }; }
      await sleep(200);
    }
    // A synthetic click is not a user gesture, so the popup may be blocked; fall
    // back to the section's own official link. Only structural facts are kept.
    if (!authorize && open.linkHref) { const u = new URL(open.linkHref); authorize = { origin: u.origin, pathname: u.pathname, parameters: [...u.searchParams.keys()].sort(), scopeValues: u.searchParams.get('scope')?.split(' ') ?? [], source: 'section-link' }; }
    if (authorize && !authorize.source) authorize.source = 'popup-target';
    const cancelled = await evaluate(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const end = Date.now() + 20000;
      let button;
      while (Date.now() < end && !button) { button = [...document.querySelectorAll('[role="dialog"] button')].find(b => b.innerText.trim() === '取消登录'); if (!button) await sleep(200); }
      if (button) button.click();
      const end2 = Date.now() + 15000;
      while (Date.now() < end2) { const s = document.querySelector('[role="dialog"] [role="status"]')?.innerText ?? ''; if (s.includes('未连接')) return { cancelled: true, status: s }; await sleep(200); }
      return { cancelled: false, status: document.querySelector('[role="dialog"] [role="status"]')?.innerText ?? '' };
    })()`);
    await screenshot(`${out.replace(/\.json$/, '')}.png`);
    const { linkHref: _link, ...observable } = open;
    return { ...observable, ...authorize, ...cancelled };
  });
  report = { target, port, method, driverNode: process.version, at: new Date().toISOString(), ...value, realAccount: 'NOT RUN' };
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { child.kill(); }
const expectedPath = method === 'codex' ? '/oauth/authorize' : '/api/accounts/authorize';
if (!(report?.stage === 'waiting' && report?.cancelled && report?.origin === 'https://auth.openai.com' && report?.pathname === expectedPath)) process.exitCode = 1;
