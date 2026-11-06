// Headless browser helpers for the ChatGPT subscription settings section.
// The caller supplies a loopback URL; any launch token in it stays in memory and
// is redacted from reports. The probe never types credentials and never sends an
// inference request.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const edge = process.env.DSH_BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = Number(process.env.DSH_BROWSER_PORT ?? 9223);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function endpoint(path, init) {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}${path}`, init); if (r.ok) return await r.json(); } catch {}
    await sleep(200);
  }
  throw new Error(`DevTools endpoint did not answer: ${path}`);
}

/** Strip any launch-token query values from text before it leaves this process. */
export function redact(value) {
  return String(value).replace(/([?&](?:token|code|state|id_token_hint)=)[^\s&"'<>]+/g, '$1[redacted]');
}

/**
 * Open one loopback page in headless Edge and run `fn` with CDP send/evaluate
 * helpers. Console errors are collected and returned alongside the callback value.
 */
export async function withPage(url, fn) {
  const profile = await mkdtemp(join(tmpdir(), 'dsh-ui-check-'));
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let ws;
  try {
    await endpoint('/json/version');
    const target = await endpoint(`/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', bad, { once: true }); });
    let seq = 0; const pending = new Map(); const consoleErrors = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { const { ok, bad } = pending.get(message.id); pending.delete(message.id); message.error ? bad(new Error(message.error.message)) : ok(message.result); return; }
      if (message.method === 'Runtime.exceptionThrown') consoleErrors.push(redact(String(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text)).slice(0, 400));
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') consoleErrors.push(redact(message.params.args.map(a => String(a.value ?? a.description ?? '')).join(' ')).slice(0, 400));
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') consoleErrors.push(redact(String(message.params.entry.text)).slice(0, 400));
    });
    const send = (method, params = {}) => new Promise((ok, bad) => {
      const id = ++seq; pending.set(id, { ok, bad }); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(redact(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
      return result.result.value;
    };
    const screenshot = async (path, clip) => {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, Buffer.from(shot.data, 'base64'));
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    const value = await fn({ send, evaluate, screenshot, sleep, consoleErrors });
    return { value, consoleErrors };
  } finally {
    try { ws?.close(); } catch {}
    child.kill();
  }
}

const pageProbe = `(async () => {
  const trace = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (find, ms = 45000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = find(); if (v) return v; await sleep(200); } return undefined; };
  const triggerByPopup = () => document.querySelector('button[aria-haspopup="dialog"]');
  const triggerByName = () => [...document.querySelectorAll('button')].find(b => /^(打开侧边栏|Open sidebar)$/i.test(b.getAttribute('aria-label') ?? ''));
  const triggerSettings = () => [...document.querySelectorAll('button')].find(b => /^(设置|Settings)$/i.test(b.getAttribute('aria-label') ?? ''));
  const dialogNav = () => document.querySelector('[role="dialog"] nav button');
  const visibleDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(d => d.getClientRects().length > 0 && d.innerText.trim());
  const menuItem = () => [...document.querySelectorAll('[role="menuitem"],[role="menu"] button')].find(i => /^(设置|Settings)/.test(i.innerText.trim()));
  const menuButtons = () => [...document.querySelectorAll('button[aria-haspopup="menu"]')];
  // The isolated window starts narrow/collapsed; open the session rail first when present.
  await waitFor(() => document.querySelector('button[aria-haspopup="menu"]'), 60000);
  await sleep(500);
  // A first-run preview notice owns the viewport until dismissed; it is not the settings panel.
  for (let step = 0; step < 4; step++) {
    const gate = visibleDialog();
    if (!gate || gate.querySelector('nav button')) break;
    const next = [...gate.querySelectorAll('button')].find(b => /^(继续|开始使用|我知道了|Next|Continue)$/i.test(b.innerText.trim()));
    if (!next) break;
    trace.push({ onboarding: gate.innerText.trim().slice(0, 12) });
    next.click(); await sleep(700);
  }
  const opener = triggerByName(); if (opener && !triggerByPopup()) { opener.click(); await sleep(700); }
  // Older shells keep Settings behind a menu row rather than an inline trigger, so
  // probe the menu rows first and only fall back to dialog-popup triggers.
  if (!dialogNav()) {
    for (const button of menuButtons()) {
      button.click(); await sleep(600);
      const item = menuItem();
      trace.push({ menu: button.getAttribute('aria-label') ?? button.innerText.trim().slice(0, 10), item: item?.innerText.trim().slice(0, 20) ?? null });
      if (item) { item.click(); await sleep(800); trace.push({ afterMenuClick: !!dialogNav() }); break; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await sleep(300);
    }
  }
  if (!dialogNav()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', ctrlKey: true, altKey: true, bubbles: true })); await sleep(700); }
  // Only look for a trigger when no settings dialog is open yet: clicking an
  // unrelated aria-haspopup="dialog" button would tear the panel down again.
  if (!dialogNav()) { const trigger = triggerByPopup() ?? triggerSettings(); if (trigger) { trigger.click(); await sleep(400); } }
  const nav = await waitFor(() => [...document.querySelectorAll('[role="dialog"] nav button')].find(b => b.innerText.includes('ChatGPT 订阅')), 20000);
  if (!nav) { const buttons = [...document.querySelectorAll('button')].map(b => ({ label: b.getAttribute('aria-label'), popup: b.getAttribute('aria-haspopup'), text: b.innerText.trim().slice(0, 40) })); return { stage: dialogNav() ? 'nav' : 'trigger', trace, title: document.title, buttons: buttons.slice(0, 40), dialog: document.querySelector('[role="dialog"]')?.innerText.slice(0, 1500) ?? '', text: document.body.innerText.slice(0, 1500) }; }
  nav.click();
  const content = await waitFor(() => [...document.querySelectorAll('[role="dialog"] h2')].find(h => h.innerText.trim() === 'ChatGPT 订阅'));
  const dialog = content?.closest('[role="dialog"]');
  const status = await waitFor(() => { const s = dialog?.querySelector('[role="status"]')?.innerText ?? ''; return s && !/读取/.test(s) ? s : undefined; }, 15000);
  // The section loads usage automatically once connected; record whether that happened
  // before any manual refresh click.
  const autoUsage = status && /已连接/.test(status)
    ? await waitFor(() => { const text = dialog?.innerText ?? ''; return dialog?.querySelector('[role="meter"]') ? text : undefined; }, 8000)
    : undefined;
  // When already connected, click the section's refresh control and capture the model list.
  let models = '', usage = '';
  if (status && /已连接/.test(status)) {
    const modelDetails = dialog?.querySelector('.cgp-models'); if (modelDetails) modelDetails.open = true;
    const refresh = [...(dialog?.querySelectorAll('button') ?? [])].find(b => b.innerText.trim() === '刷新模型');
    if (refresh) { refresh.click(); models = await waitFor(() => dialog?.querySelector('.cgp-model-list')?.innerText, 20000) ?? ''; await sleep(1200); }
    const usageButton = dialog?.querySelector('button[aria-label="刷新用量"]');
    if (usageButton) { await waitFor(() => !usageButton.disabled, 5000); usageButton.click(); await sleep(200); await waitFor(() => !usageButton.disabled, 20000); usage = await waitFor(() => { const text = dialog?.innerText ?? ''; return /剩余|额度已达上限|暂时无法获取余量/.test(text) ? text : undefined; }, 20000) ?? ''; }
    if (modelDetails) modelDetails.open = false;
    await sleep(200);
  }
  return { stage: content ? 'rendered' : 'section-missing', trace, status, autoUsage: Boolean(autoUsage), models: models.slice(0, 800), usage: usage.slice(0, 800), nav: nav.innerText, dialog: dialog?.innerText.slice(0, 4000) ?? '', buttons: [...(dialog?.querySelectorAll('button') ?? [])].map(b => b.innerText.trim()).filter(Boolean), text: content ? undefined : document.body.innerText.slice(0, 2000) };
})()`;

export async function runUiCheck(url, outBase) {
  const { value, consoleErrors } = await withPage(url, async ({ evaluate, screenshot }) => {
    const result = await evaluate(pageProbe);
    await screenshot(`${outBase}.png`);
    const clip = await evaluate(`(() => { const n = document.querySelector('.chatgpt-subscription'); if (!n) return null; const r = n.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
    if (clip) await screenshot(`${outBase}-section.png`, clip);
    return result;
  });
  const report = { at: new Date().toISOString(), ...value, consoleErrors, screenshot: `${outBase}.png` };
  await mkdir(resolve(outBase, '..'), { recursive: true });
  await writeFile(`${outBase}.json`, JSON.stringify(report, null, 2) + '\n');
  return report;
}
