// Render the shipped settings component with synthetic accounts; no authorization
// or model request leaves the local fixture server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { withPage } from './ui-check-lib.mjs';

const root = process.cwd();
const hostRoot = process.env.DSH_CHATGPT_SOURCE_ROOT;
if (!hostRoot) throw new Error('Set DSH_CHATGPT_SOURCE_ROOT to a Harness checkout with React DOM 18.3.1 installed.');
const store = resolve(hostRoot, 'node_modules/.pnpm');
const reactDom = (await readdir(store)).find(n => n.startsWith('react-dom@18.3.1_'));
if (!reactDom) throw new Error('The verified host React DOM 18.3.1 dependency is required.');
const output = resolve('.validation/settings-redesign');
await mkdir(output, { recursive: true });
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Settings } from './src/client/index.tsx';
import { ClientState } from './src/client/state.ts';
import { SidebarQuota } from './src/client/sidebar.tsx';
import { SidebarPreference } from './src/client/preferences.ts';
const root = createRoot(document.getElementById('root'));
const sidebarRoot = createRoot(document.getElementById('quota'));
let client, wide=true;
let preferenceState={status:'loading',value:undefined,writable:false}, preferenceFailure=false;
const preferenceListeners=new Set();
const publishPreference=enabled=>{preferenceState={status:'ready',value:{showSidebarQuota:enabled},writable:true};for(const listener of preferenceListeners)listener();};
const form={getSnapshot:()=>preferenceState,subscribe:listener=>{preferenceListeners.add(listener);return()=>preferenceListeners.delete(listener);},set:async(field,value)=>{if(preferenceFailure)return false;const response=await fetch('/preferences',{method:'POST',body:JSON.stringify(value)});publishPreference(await response.json());return true;}};
void fetch('/preferences').then(r=>r.json()).then(publishPreference);
window.setPreferenceFailure=value=>{preferenceFailure=value;};
const connected = {state:'connected', sharing:true, signingIn:false, method:'codex', account:'s***@example.com'};
const quota = {limitReached:false, observedAt:Date.now(), windows:[{id:'5h',label:'5 小时窗口',usedPercent:16,resetAt:Date.now()+7200000},{id:'weekly',label:'每周窗口',usedPercent:42,resetAt:Date.now()+86400000*6}]};
let session, usage, failUsage=false, failModels=false, failView=false, usageFailures=0, sequence=0;
window.calls=[];
window.requests={models:0,usage:0};window.opened=[];window.desktop=false;
const ok = value => Promise.resolve({ok:true,value});
const api = {
view:()=>failView ? Promise.reject(new Error('synthetic state read')) : ok({...session}),
models:()=>{window.requests.models++;return failModels ? Promise.reject(new Error('synthetic')) : ok(['GPT-6.1-Sol','GPT-6.1 Terra','GPT-6-Astra','GPT-6-Sol','GPT-6-Luna','GPT-5.6-Sol','GPT-5.6-Terra','GPT-5.6-Luna'].map((name,i)=>({id:'synthetic-model-'+i,name})));},
usage:()=>{window.requests.usage++;return failUsage || usageFailures-->0 ? Promise.reject(new Error('synthetic')) : ok(usage);},
login:()=>{window.calls.push('siwc');session.signingIn=true;return ok({url:'https://auth.openai.com/oauth/authorize'});},
loginCodex:()=>{window.calls.push('codex');session.signingIn=true;return ok({url:'https://auth.openai.com/oauth/authorize'});},
consent:()=>{window.calls.push('consent');session.signingIn=true;return ok({url:'https://auth.openai.com/oauth/authorize'});},
cancel:()=>{window.calls.push('cancel');session.signingIn=false;return ok();},
logout:()=>{window.calls.push('logout');session={state:'disconnected',sharing:false,signingIn:false,method:'siwc'};return ok({remoteRevoked:true});}
};
window.open=url=>{window.opened.push(url);return window.desktop ? null : {closed:false,opener:null,location:{replace(url){window.authorizedUrl=url;}},close(){this.closed=true;}};};
window.setFailures=(u,m)=>{failUsage=u;failModels=m;};
window.setViewFailure=v=>{failView=v;};
window.finishLogin=()=>{session={...connected};};
window.showSettings=show=>root.render(show ? <Settings client={client} key={sequence}/> : null);
window.sidebarWide=value=>{wide=value;sidebarRoot.render(<SidebarQuota client={client} wide={wide} key={sequence}/>);};
window.refreshState=()=>client.refreshView();
window.disconnect=()=>{session={state:'disconnected',sharing:false,signingIn:false,method:'siwc'};return client.refreshView();};
window.scenario=name=>{
 session={...connected};usage=structuredClone(quota);failUsage=false;failModels=false;failView=false;usageFailures=0;window.requests={models:0,usage:0};window.opened=[];window.desktop=false;
 if(name==='disconnected')session={state:'disconnected',sharing:false,signingIn:false,method:'siwc'};
 if(name==='identity')session={...session,state:'identity_only',sharing:false,method:'siwc'};
 if(name==='siwc')session.method='siwc';
 if(name==='reauth')session={...session,state:'reauth_required',sharing:false};
 if(name==='unavailable')failUsage=true;
 if(name==='transient')usageFailures=1;
 if(name==='settling')session.signingIn=true;
 if(name==='empty')usage={...usage,windows:[]};
 if(name==='limits'){usage.windows[0].usedPercent=100;usage.windows[1].usedPercent=0;usage.limitReached=true;}
 if(name==='single')usage.windows=usage.windows.slice(0,1);
 client?.dispose();client=new ClientState(api,new SidebarPreference(form));sequence++;
 root.render(<Settings key={sequence} client={client}/>);
 sidebarRoot.render(<SidebarQuota key={sequence} client={client} wide={wide}/>);
};
window.scenario('connected');
`;
const bundle = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, alias: { react: resolve(root, 'node_modules/react'), 'react-dom/client': resolve(store, reactDom, 'node_modules/react-dom/client.js') } });
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>订阅设置 · 界面验证</title><style>
body{margin:0;padding:36px;background:#18181b;font-family:'Segoe UI','Microsoft YaHei',sans-serif;color:#f3f3f5;color-scheme:dark}
.shell{max-width:800px;min-height:760px;margin:auto;background:#2b2b2e;border-radius:20px;overflow:hidden;--dsw-alias-bg-layer-2:#2b2b2e;--dsw-alias-label-primary:#f3f3f5;--dsw-alias-label-secondary:#aaaab1;--dsw-alias-border-l2:#ffffff1f;--dsw-alias-interactive-bg-hover:#ffffff0a;--dsw-alias-button-primary-fill:#ededf0;--dsw-alias-label-primary-foreground:#222225}
.top{display:flex;justify-content:space-between;padding:22px 24px;font-size:20px}.top small{font-size:12px;color:#aaaab1}.body{display:grid;grid-template-columns:188px minmax(0,1fr)}nav{padding:12px}nav>div{padding:12px;margin-bottom:4px;font-size:14px}nav .selected{background:#ffffff10;border-radius:10px}main{padding:12px 24px 24px;min-width:0}
body.light{color-scheme:light;background:#ededf0;color:#222225}body.light .shell{background:#fff;--dsw-alias-bg-layer-2:#fff;--dsw-alias-label-primary:#222225;--dsw-alias-label-secondary:#686871;--dsw-alias-border-l2:#00000020;--dsw-alias-interactive-bg-hover:#00000007;--dsw-alias-button-primary-fill:#222225;--dsw-alias-label-primary-foreground:#fff}body.light nav .selected{background:#00000009}
@media(max-width:600px){body{padding:8px}.body{display:block}nav{display:none}main{padding:12px 16px}.top{padding:16px}}
</style><div class="shell"><div class="top">设置<small>打开配置文件　 ×</small></div><div class="body"><nav><div>通用设置</div><div>模型</div><div>内置插件</div><div>Agent 预设</div><div class="selected">ChatGPT 订阅</div><aside id="quota" style="display:flex;padding:0;width:100%;margin-top:180px"></aside></nav><main id="root"></main></div></div><script src="/fixture.js"></script></html>`;
let savedPreference = false;
const server = createServer(async (req, res) => {
  if (req.url === '/preferences') {
    if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; savedPreference = JSON.parse(body) === true; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(savedPreference)); return;
  }
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'application/javascript' : 'text/html; charset=utf-8'); res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].contents : html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const checks = [];
try {
  const report = await withPage(`http://127.0.0.1:${server.address().port}`, async ({ evaluate, send, screenshot, sleep }) => {
    const waitFor = async expression => { for (let i=0;i<60;i++) { if(await evaluate(expression)) return; await sleep(100); } throw new Error(`UI condition failed: ${expression}`); };
    const scenario = async name => { await evaluate(`window.scenario(${JSON.stringify(name)})`); await waitFor(`!!document.querySelector('.cgp-account')`); await sleep(150); };
    const click = label => evaluate(`[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.innerText).trim()===${JSON.stringify(label)}).click()`);
    await waitFor(`document.querySelectorAll('[role="meter"]').length===2`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role="meter"]')].map(n=>Number(n.getAttribute('aria-valuenow')))`), [84,58]);
    assert.equal(await evaluate(`document.querySelector('.cgp-models').open`), false);
    assert.ok(await evaluate(`document.querySelector('.cgp-usage-panel').getBoundingClientRect().height<=170`));
    assert.equal(await evaluate(`document.querySelector('.cgp-meter-fill').style.width`),'84%');
    await screenshot(resolve(output,'connected-dark.png')); checks.push('connected: two compact quota bars, panel height <=170px, models collapsed');
    await evaluate(`document.querySelector('.cgp-models').open=true`);
    assert.equal(await evaluate(`document.querySelectorAll('.cgp-model-list li').length`),8);
    await evaluate(`window.setFailures(true,false)`); await click('刷新用量');
    await waitFor(`document.querySelector('[role="alert"]')?.innerText.includes('用量暂时无法更新')`);
    assert.equal(await evaluate(`document.querySelectorAll('[role="meter"]').length`),2); checks.push('refresh failure retains last observed quota');
    for(const name of ['unavailable','empty','siwc']) { await scenario(name); assert.equal(await evaluate(`document.querySelectorAll('[role="meter"]').length`),0); }
    checks.push('unavailable, empty and official connection never fabricate quota');
    await scenario('limits');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[role="meter"]')].map(n=>Number(n.getAttribute('aria-valuenow')))`),[0,100]);
    assert.equal(await evaluate(`document.querySelector('[role="alert"]').innerText.includes('上限')`),true); checks.push('zero/full quota and rate limit state');
    await scenario('single'); assert.equal(await evaluate(`document.querySelectorAll('[role="meter"]').length`),1);
    await scenario('disconnected');
    await screenshot(resolve(output,'disconnected-dark.png'));
    await click('使用 ChatGPT 登录'); await waitFor(`document.body.innerText.includes('请在浏览器中完成登录')`);
    assert.equal(await evaluate(`window.calls.at(-1)`),'siwc'); await click('取消登录');
    await scenario('disconnected'); await click('使用 Business 登录'); await waitFor(`window.calls.at(-1)==='codex'`); await click('取消登录');
    await scenario('disconnected'); await evaluate(`window.desktop=true`); await click('使用 Business 登录');
    await waitFor(`window.opened.some(u=>u.startsWith('https://auth.openai.com/'))`);
    assert.deepEqual(await evaluate(`window.opened`),['about:blank','https://auth.openai.com/oauth/authorize']);
    await click('取消登录'); checks.push('Desktop opens the official URL automatically when blank-window reservation is denied');
    await scenario('identity'); await click('启用订阅共享'); await waitFor(`window.calls.at(-1)==='consent'`); await click('取消登录');
    checks.push('both login routes, cancellation and subscription consent');
    await scenario('settling');
    assert.deepEqual(await evaluate(`window.requests`),{models:0,usage:0});
    await evaluate(`window.finishLogin()`);
    await waitFor(`document.querySelectorAll('[role="meter"]').length===2`);
    assert.deepEqual(await evaluate(`window.requests`),{models:1,usage:1});
    checks.push('model and quota requests start only after sign-in finishes, then load automatically');
    await scenario('transient');
    await waitFor(`document.querySelectorAll('[role="meter"]').length===2`);
    assert.equal(await evaluate(`window.requests.usage`),2);
    assert.equal(await evaluate(`!!document.querySelector('[role="alert"]')`),false);
    checks.push('initial quota read retries once and recovers without a manual refresh or stale alert');
    await scenario('transient'); await click('退出登录'); await sleep(1200);
    assert.equal(await evaluate(`window.requests.usage`),1);
    assert.equal(await evaluate(`document.querySelectorAll('[role="meter"]').length`),0);
    checks.push('signing out cancels a scheduled quota retry');
    await scenario('connected');
    await evaluate(`window.setViewFailure(true)`);
    await waitFor(`document.querySelector('[role="alert"]')?.innerText.includes('读取连接状态')`);
    await evaluate(`window.setViewFailure(false)`);
    await waitFor(`!document.querySelector('[role="alert"]')`);
    checks.push('connection-state polling clears its own error after recovery');
    await scenario('reauth'); assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(b=>b.innerText==='使用 Business 登录'&&!b.disabled)`),true);
    await scenario('connected'); await click('退出登录'); await waitFor(`document.body.innerText.includes('连接你的 ChatGPT 账号')`);
    assert.equal(await evaluate(`document.querySelectorAll('[role="meter"]').length`),0); checks.push('reauthentication and logout clear connected data');
    await scenario('connected');
    await evaluate(`document.body.classList.add('light')`); await screenshot(resolve(output,'connected-light.png'));
    for(const name of ['connected','disconnected']) {
      await scenario(name); await send('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:false});
      assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);
      assert.equal(await evaluate(`[...document.querySelectorAll('.cgp-card')].filter(n=>n.getClientRects().length).every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`),true);
      await screenshot(resolve(output,`${name}-narrow.png`));
    }
    checks.push('dark/light themes and 390px layouts without horizontal clipping');
    await send('Emulation.setDeviceMetricsOverride',{width:1200,height:1000,deviceScaleFactor:1,mobile:false});
    await scenario('connected');
    assert.equal(await evaluate(`!!document.querySelector('.cgp-sidebar')`),false);
    await evaluate(`window.setPreferenceFailure(true);document.querySelector('input[type=checkbox]').click()`);
    await waitFor(`document.querySelector('[role=alert]')?.innerText.includes('显示设置未保存')`);
    assert.equal(await evaluate(`!!document.querySelector('.cgp-sidebar')`),false);
    await evaluate(`window.setPreferenceFailure(false)`);
    await evaluate(`document.querySelector('input[type=checkbox]').click()`);
    await waitFor(`document.querySelectorAll('.cgp-sidebar [role=meter]').length===2`);
    assert.equal(await evaluate(`window.requests.usage`),1);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.cgp-sidebar [role=meter]')].map(n=>Number(n.getAttribute('aria-valuenow')))`),[84,58]);
    assert.ok(await evaluate(`document.querySelector('.cgp-sidebar').getBoundingClientRect().height<=150`));
    await screenshot(resolve(output,'sidebar-light.png'));
    await evaluate(`document.body.classList.remove('light')`); await screenshot(resolve(output,'sidebar-dark.png'));
    checks.push('opt-in sidebar card shares quota reads, is at most 150px high, and supports both themes');
    await send('Page.reload');
    await waitFor(`document.querySelector('input[type=checkbox]')?.checked && document.querySelectorAll('.cgp-sidebar [role=meter]').length===2`);
    assert.deepEqual(await evaluate(`Object.entries(localStorage)`),[]);
    await evaluate(`window.showSettings(false)`);
    assert.equal(await evaluate(`document.querySelectorAll('.cgp-sidebar [role=meter]').length`),2);
    await click('刷新侧边栏余量'); await waitFor(`window.requests.usage===2`);
    await evaluate(`window.setFailures(true,false)`); await click('刷新侧边栏余量');
    await waitFor(`document.querySelector('.cgp-sidebar-note')?.innerText.includes('更新失败')`);
    assert.equal(await evaluate(`document.querySelectorAll('.cgp-sidebar [role=meter]').length`),2);
    await evaluate(`window.setFailures(false,false)`); await click('刷新侧边栏余量');
    await waitFor(`!document.querySelector('.cgp-sidebar-note')?.innerText.includes('更新失败')`);
    checks.push('display preference survives reload; sidebar keeps working with settings closed and marks stale data');
    await evaluate(`window.sidebarWide(false)`); await sleep(100);
    assert.equal(await evaluate(`!!document.querySelector('.cgp-sidebar')`),false);
    const requestsBefore = await evaluate(`window.requests.usage`); await sleep(2200);
    assert.equal(await evaluate(`window.requests.usage`),requestsBefore);
    await evaluate(`window.sidebarWide(true)`); await waitFor(`document.querySelectorAll('.cgp-sidebar [role=meter]').length===2`);
    await evaluate(`window.disconnect()`);
    await waitFor(`document.querySelector('.cgp-sidebar')?.innerText.includes('连接 ChatGPT')`);
    assert.equal(await evaluate(`document.querySelectorAll('.cgp-sidebar [role=meter]').length`),0);
    for(const name of ['siwc','unavailable','empty','reauth']) {
      await scenario(name); await sleep(name==='unavailable'?1200:100);
      assert.equal(await evaluate(`document.querySelectorAll('.cgp-sidebar [role=meter]').length`),0);
    }
    await evaluate(`document.querySelector('input[type=checkbox]').click()`); await sleep(100);
    assert.equal(await evaluate(`!!document.querySelector('.cgp-sidebar')`),false);
    checks.push('collapse and disable remove the card; sign-out and unavailable connections never retain old quota');
    return { checks, screenshots: ['connected-dark.png','disconnected-dark.png','connected-light.png','connected-narrow.png','disconnected-narrow.png','sidebar-light.png','sidebar-dark.png'] };
  });
  assert.deepEqual(report.consoleErrors,[]);
  await writeFile(resolve(output,'report.json'),JSON.stringify({at:new Date().toISOString(),kind:'synthetic component browser check',...report},null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally { await new Promise(r=>server.close(r)); }
