import { beforeAll, it, expect } from 'vitest';
import { build } from 'esbuild';
import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../src/auth/store.js';
import { connected, expire, collect, scripted, events, message } from './helpers.js';
import { translate } from '../src/llm/stream.js';
import { toolMap, PROVIDER } from '../src/llm/request.js';
import { BlockAssembler, createAssistantMessage } from '@deepseek-ai/dsh-llm';

beforeAll(async () => { await mkdir('.validation', { recursive: true }); await build({ entryPoints: ['tests/process-worker.ts'], outfile: '.validation/process-worker.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external' }); });
function child(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['.validation/process-worker.mjs', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; proc.stdout.on('data', b => { output += b; }); proc.stderr.on('data', b => { error += b; });
    proc.once('error', reject); proc.once('exit', code => code === 0 ? resolve(output) : reject(new Error(`Worker exit ${code}: ${error}`)));
  });
}
it('AUTH-07 two actual processes share host atomic record lock and rotate once', async () => {
  const dir = await mkdtemp(resolve('.validation/process-')); const path = resolve(dir, '.credentials.yaml'); const ctx = new Context();
  const f = await connected(); await expire(f.store);
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const b of req) body += b;
    expect(new URLSearchParams(body).get('refresh_token')).toContain('_refresh_0'); calls++;
    await new Promise(r => setTimeout(r, 80));
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ access_token: 'synthetic_new_access', refresh_token: 'synthetic_new_refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct' }));
  });
  try {
    await ctx.plugin(LocalCredentials, { path, watch: false }); await new Store(ctx.credentials).update(c => { Object.assign(c, (f.memory.record as any).payload); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address() as any;
    const output = await Promise.all([child(['refresh', path, `http://127.0.0.1:${address.port}`]), child(['refresh', path, `http://127.0.0.1:${address.port}`])]);
    expect(output).toEqual(['REFRESH_OK', 'REFRESH_OK']); expect(calls).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await ctx.fiber.dispose(); }
});
it('LLM-10 actual fresh process reconstructs persisted phase and encrypted reasoning without upstream response ID', async () => {
  const out = [{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'synthetic_opaque' }, message('persisted')];
  const assembler = new BlockAssembler(); for (const c of await collect(translate(events(scripted(out)), 'fixture-model', 'identity', toolMap(), AbortSignal.timeout(5000)))) assembler.push(c);
  const m = createAssistantMessage({ content: assembler.blocks(), source: { provider: PROVIDER, model: 'fixture-model', replayState: assembler.replayState } });
  const dir = await mkdtemp(resolve('.validation/replay-')); const path = resolve(dir, 'session.json');
  await writeFile(path, JSON.stringify({ identity: 'identity', options: { provider: PROVIDER, model: 'fixture-model', messages: [m, { role: 'user', content: [{ type: 'text', text: 'continue' }] }] } }));
  const request = JSON.parse(await child(['replay', path]));
  expect(request.input[0]).toMatchObject({ type: 'reasoning', encrypted_content: 'synthetic_opaque' }); expect(request.input[1].phase).toBe('final_answer'); expect(request.previous_response_id).toBeUndefined();
});
