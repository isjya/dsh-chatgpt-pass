// Verify the main-window sidebar and Host-backed preference in a fresh profile.
// Metadata is synthetic; no authorization, credential seeding or inference is performed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostCommand } from './host-command.mjs';
import { pageProbe, withPage } from './ui-check-lib.mjs';

const target = process.argv[2] ?? 'desktop';
const taskHome = resolve(`.validation/sidebar-${target}-${Date.now()}`), profile = 'sidebar-quota';
await mkdir(taskHome, { recursive: true });
process.env.DSH_CHATGPT_HOME = taskHome;
process.env.DSH_CHATGPT_PROFILE = profile;
process.env.npm_config_minimum_release_age = '0';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const output = resolve('.validation/sidebar-host'); await mkdir(output, { recursive: true });
const mock = resolve(taskHome, 'synthetic-metadata.mjs'), patch = resolve(taskHome, 'synthetic.patch.yml');
await writeFile(mock, `export const inject=['chatgptProvider'];
export function apply(ctx) {
 const service=ctx.get('chatgptProvider');
 service.view=async()=>({state:'connected',sharing:true,signingIn:false,method:'codex',account:'s***@example.com'});
 service.models=async()=>[{id:'synthetic-model',name:'Demo model'}];
 service.usage=async()=>({limitReached:false,observedAt:Date.now(),windows:[{id:'5h',label:'5 小时窗口',usedPercent:16,resetAt:Date.now()+7200000},{id:'weekly',label:'每周窗口',usedPercent:42,resetAt:Date.now()+86400000*5}]});
}
`);
await writeFile(patch, `- insert:\n    - id: sidebar-synthetic-metadata\n      name: ${mock.replaceAll('\\', '/')}\n`);
function command(extra) { return hostCommand(target, extra); }
function run(extra) {
  const { command: executable, args, env, cwd } = command(extra);
  return new Promise((ok, bad) => {
    const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
    child.once('error', bad); child.once('exit', code => code === 0 ? ok() : bad(new Error(`Isolated CLI failed (${code}): ${text.slice(-1200)}`)));
  });
}
async function start(port) {
  const { command: executable, args, env, cwd } = command(['--patch', patch, '--no-open', '--port', String(port)]);
  const child = spawn(executable, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((ok, bad) => {
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); bad(new Error('Isolated Host startup timed out')); }, 120000);
    const onData = chunk => {
      buffer += chunk;
      const match = buffer.match(new RegExp('dsh web: (http://127\\.0\\.0\\.1:' + port + '/\\S*token=\\S+)'));
      if (match) { clearTimeout(timer); ok(match[1]); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('error', error => { clearTimeout(timer); bad(error); });
    child.once('exit', code => { clearTimeout(timer); bad(new Error(`Isolated Host exited (${code})`)); });
  });
  return { url, stop: () => new Promise(ok => { if (child.exitCode !== null) return ok(); child.once('exit', ok); child.kill(); }) };
}

console.log('Preparing a new isolated profile');
await run(['--from-default-profile', 'web', '--dump-config']);
await run(['plugin', 'add', resolve(`artifacts/dsh-chatgpt-pass-${version}.tgz`)]);
const checks = [];
for (const [index, port] of [3204, 3205].entries()) {
  const host = await start(port);
  try {
    const report = await withPage(host.url, async ({ evaluate, send, sleep, screenshot }) => {
      const waitFor = async expression => {
        for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await sleep(100); }
        throw new Error('Main sidebar check timed out: ' + expression);
      };
      const page = await evaluate(pageProbe); assert.equal(page.stage, 'rendered');
      await waitFor(`!!document.querySelector('.cgp-sidebar-option input:not(:disabled)')`);
      assert.equal(await evaluate(`document.querySelector('.cgp-sidebar-option input').checked`), index === 1);
      if (index === 0) await evaluate(`document.querySelector('.cgp-sidebar-option input').click()`);
      await waitFor(`document.querySelectorAll('.cgp-sidebar [role=meter]').length===2`);
      assert.equal(await evaluate(`!!document.querySelector('.cgp-sidebar').closest('[role=dialog]')`), false);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await waitFor(`![...document.querySelectorAll('[role=dialog]')].some(n=>n.getClientRects().length&&n.querySelector('.chatgpt-subscription'))`);
      const geometry = await evaluate(`(()=>{const r=document.querySelector('.cgp-sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottomGap:innerHeight-r.bottom,viewport:{width:innerWidth,height:innerHeight}};})()`);
      assert(geometry.x < 100 && geometry.width >= 150 && geometry.width < 400);
      assert(geometry.height <= 150 && geometry.bottomGap >= 25 && geometry.bottomGap <= 140);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('.cgp-sidebar [role=meter]')].map(n=>Number(n.getAttribute('aria-valuenow')))`), [84, 58]);
      await screenshot(resolve(output, `main-sidebar-${index}.png`));
      return { stage: index === 0 ? 'main sidebar above account entry' : 'preference restored on another port after Host restart', geometry };
    });
    assert.deepEqual(report.consoleErrors, []); checks.push(report.value);
  } finally { await host.stop(); }
}
await run(['plugin', 'remove', 'dsh-chatgpt-pass']);
const result = { target, version, kind: 'isolated real Host with synthetic metadata', checks, removal: 'PASS', realAccount: 'NOT RUN' };
await writeFile(resolve(output, 'report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
