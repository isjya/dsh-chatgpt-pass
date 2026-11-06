import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const inject = ['llm', 'credentials', 'authorization', 'chatgptProvider', 'clientModules', 'typertGateway'];
export async function apply(ctx) {
  let stage = 'provider';
  try {
    assert(ctx.llm.listProviders().some(p => p.id === 'chatgpt-subscription'));
    assert(ctx.authorization.list().some(f => String(f.key) === 'chatgpt-subscription/session'));
    const view = await ctx.get('chatgptProvider').view();
    assert.equal(view.state, 'disconnected');
    assert(!JSON.stringify(view).includes('token'));
    stage = 'client-graph'; let entry;
    const find = value => { if (!value || typeof value !== 'object') return; if (value.id === 'dsh-chatgpt-provider' && value.url) entry = value; else for (const v of Object.values(value)) find(v); };
    find(ctx.clientModules.graph()); assert(entry);
    stage = 'client-asset'; const asset = await ctx.clientModules.fetchBundle(new Request(new URL(entry.url, 'http://127.0.0.1')));
    assert.equal(asset.status, 200); const body = await asset.text(); assert(body.includes('使用 ChatGPT 登录'));
    const peer = { id: 'chatgpt-validation', ctx, principal: { kind: 'owner' }, signal: new AbortController().signal, interactions: 'none', dispose: async () => {} };
    stage = 'gateway'; const remote = await ctx.typertGateway.invoke({ namespace: 'chatgptProvider', method: 'view', args: {}, peer });
    assert.equal(remote.state, 'disconnected');
    // Isolated test home only: public logout creates stable registration metadata without tokens.
    stage = 'metadata-logout'; await ctx.get('chatgptProvider').logout();
    stage = 'metadata-read';
    const record = await ctx.credentials.readRecord('chatgpt-subscription/session');
    assert.equal(record.kind, 'grant'); assert(!record.payload.tokens);
    const hostHash = createHash('sha256').update(record.payload.hostId).digest('hex');
    console.log('DSH_CHATGPT_INSTALLED_READY ' + JSON.stringify({ node: process.version, provider: true, flow: true, clientAsset: true, gateway: true, hostHash, state: view.state, result: 'PASS' }));
    setTimeout(() => process.exit(0), 100);
  } catch (error) { console.error('DSH_CHATGPT_INSTALLED_READY FAIL ' + JSON.stringify({ stage, name: error?.name, code: error?.code, categories: ['JSON', 'scope', 'active', 'permission', 'denied', 'writable', 'exist', 'lock', 'property', 'configure'].filter(word => String(error?.message).toLowerCase().includes(word.toLowerCase())) })); process.exitCode = 1; setTimeout(() => process.exit(1), 100); }
}
