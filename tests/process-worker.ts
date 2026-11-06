import { Context } from '@deepseek-ai/cordis';
import LocalCredentials from '@deepseek-ai/dsh-credentials-local';
import { Store } from '../src/auth/store.js';
import { SessionManager } from '../src/auth/session.js';
import { OAuth } from '../src/auth/oauth.js';
import { buildRequest } from '../src/llm/request.js';
import { readFile } from 'node:fs/promises';

const mode = process.argv[2];
if (mode === 'replay') {
  const data = JSON.parse(await readFile(process.argv[3]!, 'utf8'));
  const request = buildRequest(data.options, data.identity);
  process.stdout.write(JSON.stringify(request));
} else {
  const ctx = new Context();
  try {
    await ctx.plugin(LocalCredentials, { path: process.argv[3], watch: false });
    const oauth = new OAuth(async (url, init) => {
      if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/token', jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' });
      return fetch(process.argv[4]!, init);
    });
    const session = new SessionManager(new Store(ctx.credentials), oauth);
    await session.access(); process.stdout.write('REFRESH_OK'); session.dispose();
  } finally { await ctx.fiber.dispose(); }
}
