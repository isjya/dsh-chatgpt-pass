// Real model-picker integration with the installed bundle, synthetic SIWC account,
// and an in-process fake transport. No external authorization or inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostCommand } from './host-command.mjs';
import { pageProbe, withPage } from './ui-check-lib.mjs';

const target = process.argv[2] ?? 'desktop';
const home = resolve(`.validation/reasoning-${target}-${Date.now()}`);
await mkdir(home, { recursive: true });
process.env.DSH_CHATGPT_HOME = home;
process.env.DSH_CHATGPT_PROFILE = 'reasoning-check';
process.env.npm_config_minimum_release_age = '0';
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const observation = resolve(home, 'request-observations.jsonl');
const fixture = resolve(home, 'synthetic.mjs'), patch = resolve(home, 'synthetic.patch.yml');
await writeFile(fixture, `
import {appendFile} from 'node:fs/promises';
export const inject=['chatgptProvider','llm'];
export function apply(ctx){
 const service=ctx.get('chatgptProvider'), adapter=service.adapter, session=service.session;
 const binding={generation:0,identity:'synthetic-siwc-identity'};
 session.view=async()=>({state:'connected',sharing:true,signingIn:false,method:'siwc',account:'s***@example.com'});
 session.profile=async()=>({method:'siwc'});
 session.binding=async()=>binding;
 session.access=async()=>({token:'synthetic-account-token',binding});
 let writes=Promise.resolve();
 adapter.transport=async(url,init)=>{
  if(String(url)==='https://api.openai.com/v1/models')return Response.json({models:[{slug:'gpt-6.1-sol',display_name:'Synthetic Sol',visibility:'list'}]});
  if(String(url)!=='https://api.openai.com/v1/responses')throw new Error('Unexpected synthetic endpoint');
  const request=JSON.parse(String(init.body));
  writes=writes.then(()=>appendFile(${JSON.stringify(observation)},JSON.stringify({effort:request.reasoning?.effort,endpoint:String(url),method:'siwc'})+'\\n'));await writes;
  const item={type:'message',id:'synthetic-message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic response complete',annotations:[]}]};
  const events=[{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,delta:'Synthetic response complete'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{status:'completed',output:[item],usage:{input_tokens:5,output_tokens:4,total_tokens:9}}}];
  return new Response(events.map(e=>'event: '+e.type+'\\ndata: '+JSON.stringify(e)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
 };
 adapter.invalidate();ctx.emit('llm/models-updated','chatgpt-subscription');
}
`);
await writeFile(patch, `- insert:\n    - id: synthetic-reasoning-check\n      name: ${fixture.replaceAll('\\', '/')}\n`);
function run(args) {
  const spec = hostCommand(target, args);
  return new Promise((ok, bad) => {
    const child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.once('error', bad); child.once('exit', code => code === 0 ? ok() : bad(new Error(`Isolated setup failed (${code})`)));
  });
}
await run(['--from-default-profile', 'web', '--dump-config']);
await run(['plugin', 'add', resolve(`artifacts/dsh-chatgpt-pass-${version}.tgz`)]);
const port = 3206;
const spec = hostCommand(target, ['--patch', patch, '--no-open', '--port', String(port)]);
const child = spawn(spec.command, spec.args, { env: spec.env, cwd: spec.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const url = await new Promise((ok, bad) => {
    let buffer = '';
    const timer = setTimeout(() => bad(new Error('Isolated Host startup timed out')), 120000);
    const onData = chunk => { buffer += chunk; const match = buffer.match(new RegExp('dsh web: (http://127\\.0\\.0\\.1:' + port + '/\\S*token=\\S+)')); if (match) { clearTimeout(timer); ok(match[1]); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('error', error => { clearTimeout(timer); bad(error); });
    child.once('exit', code => { clearTimeout(timer); bad(new Error(`Isolated Host exited (${code})`)); });
  });
  const report = await withPage(url, async ({ evaluate, send, sleep, screenshot, consoleErrors }) => {
    const waitFor = async expression => {
      for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate(expression)) return; await sleep(100); }
      await screenshot(resolve(home, 'failure.png'));
      throw new Error('Model picker condition timed out: ' + expression + ' ' + JSON.stringify({ consoleErrors, buttons: await evaluate(`[...document.querySelectorAll('button')].map(b=>({label:b.getAttribute('aria-label'),title:b.title,text:b.innerText.slice(0,70)})).slice(-25)`) }));
    };
    assert.equal((await evaluate(pageProbe)).stage, 'rendered');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor(`![...document.querySelectorAll('[role=dialog]')].some(d=>d.getClientRects().length&&d.querySelector('nav'))`);
    const picker = `[...document.querySelectorAll('button[aria-haspopup=menu]')].find(b=>/选择模型|Select model|Synthetic Sol/.test(b.title))`;
    await waitFor(`!!(${picker})`); await evaluate(`(${picker}).click()`);
    const model = `document.querySelector('[data-provider-id="chatgpt-subscription"][data-model-id="gpt-6.1-sol"]')?.closest('button')`;
    await waitFor(`!!(${model}) || !!document.querySelector('[role=menu] [role=menuitem]')`);
    if (!await evaluate(`!!(${model})`)) await evaluate(`document.querySelector('[role=menu] [role=menuitem]').click()`);
    await waitFor(`!!(${model})`); await evaluate(`(${model}).click()`);
    await waitFor(`!!(${picker})?.title.includes('Synthetic Sol') && (${picker}).getAttribute('aria-expanded')!=='true' && (${picker}).getAttribute('aria-busy')!=='true'`);
    await evaluate(`(${picker}).click()`);
    await waitFor(`document.querySelectorAll('[role=menu] [role=menuitem]').length>=2`);
    await evaluate(`document.querySelectorAll('[role=menu] [role=menuitem]')[1].click()`);
    await waitFor(`document.querySelectorAll('[role=menuitemradio]').length>=5`);
    const efforts = await evaluate(`[...document.querySelectorAll('[role=menuitemradio]')].map(b=>b.innerText.trim())`);
    assert(efforts.includes('High') && efforts.includes('Maximum') && !efforts.includes('None'));
    await screenshot(resolve(home, 'effort-menu.png'));
    await evaluate(`[...document.querySelectorAll('[role=menuitemradio]')].find(b=>b.innerText.trim()==='High').click()`);
    await waitFor(`!!(${picker})?.title.includes('High')`);
    await evaluate(`(document.querySelector('[contenteditable=true]')??document.querySelector('textarea')).focus()`);
    await send('Input.insertText', { text: 'Synthetic reasoning integration check.' });
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(`document.body.innerText.includes('Synthetic response complete')`);
    await send('Page.reload');
    await waitFor(`!!(${picker})?.title.includes('High')`);
    await screenshot(resolve(home, 'selected-high-after-reload.png'));
    return { efforts, selectionPersistsAfterReload: true };
  });
  assert.deepEqual(report.consoleErrors, []);
  const observations = (await readFile(observation, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(observations.some(request => request.effort === 'high' && request.endpoint === 'https://api.openai.com/v1/responses' && request.method === 'siwc'));
  const result = { target, version, kind: 'isolated installed bundle with synthetic official connection', ...report.value, requestEffort: 'high', realAccount: 'NOT RUN' };
  await writeFile(resolve(home, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (child.exitCode === null) await new Promise(ok => { child.once('exit', ok); child.kill(); });
}
await run(['plugin', 'remove', 'dsh-chatgpt-pass']);
