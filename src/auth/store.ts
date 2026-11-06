import { randomUUID } from 'node:crypto';
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { ProviderError } from '../errors.js';

export const KEY = credentialKey('chatgpt-subscription', 'session');
export type Method = 'siwc' | 'codex';
export type CredentialStore = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>;
export interface TokenSet { access: string; refresh: string; id?: string; scopes: string[]; expiresAt: number; receivedAt: number; earliestRefreshAt?: number }
export interface Registration { clientId: string; subject?: string; issuer?: string; email?: string; accountId?: string }
export interface Connection {
  schemaVersion: 2; method: Method; hostId: string; generation: number;
  state: 'disconnected' | 'identity_only' | 'connected' | 'reauth_required';
  registration?: Registration;
  tokens?: TokenSet;
  checkpoint?: { tokens: TokenSet; nonce?: string };
  attempt?: string;
}
function migration(p: Record<string, any>): Record<string, any> {
  return p.schemaVersion === 1 ? { ...p, schemaVersion: 2, method: 'siwc' } : p;
}
export function readConnection(record: CredentialRecord | undefined): Connection | undefined {
  if (!record) return undefined;
  const raw = record.kind === 'grant' ? migration(record.payload as Record<string, any>) : undefined;
  const p = raw as Connection | undefined;
  const r = p?.registration;
  const registrationOk = !r || (
    typeof r.clientId === 'string' && r.clientId !== '' && r.clientId !== 'dynamic_agent_client'
    && (r.subject === undefined || (typeof r.subject === 'string' && r.subject !== '' && r.issuer === 'https://auth.openai.com'))
    && (r.email === undefined || typeof r.email === 'string')
    && (r.accountId === undefined || /^[\x21-\x7e]{1,200}$/.test(r.accountId))
  );
  const stateOk = !p || !['connected', 'identity_only'].includes(p.state) || (Boolean(p.tokens) && Boolean(r?.subject));
  if (!p || p.schemaVersion !== 2 || !['siwc', 'codex'].includes(p.method)
    || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.hostId) || !Number.isSafeInteger(p.generation) || p.generation < 0
    || !['disconnected', 'identity_only', 'connected', 'reauth_required'].includes(p.state)
    || !registrationOk || !stateOk || (p.method === 'codex' && p.state === 'identity_only')) throw new ProviderError('STORAGE_INVALID');
  for (const t of [p.tokens, p.checkpoint?.tokens]) if (t && (typeof t.access !== 'string' || !t.access || typeof t.refresh !== 'string' || !t.refresh
    || !Array.isArray(t.scopes) || t.scopes.some(s => typeof s !== 'string') || !Number.isFinite(t.expiresAt) || !Number.isFinite(t.receivedAt)
    || (t.id !== undefined && typeof t.id !== 'string') || (t.earliestRefreshAt !== undefined && !Number.isFinite(t.earliestRefreshAt)))) throw new ProviderError('STORAGE_INVALID');
  return structuredClone(p);
}
export class Store {
  constructor(readonly credentials: CredentialStore) {}
  async read(): Promise<Connection | undefined> { return readConnection(await this.credentials.readRecord(KEY)); }
  async update(fn: (c: Connection) => Promise<void> | void): Promise<Connection> {
    const record = await this.credentials.modifyRecord(KEY, async current => {
      const c = readConnection(current) ?? { schemaVersion: 2, method: 'siwc' as const, hostId: `urn:uuid:${randomUUID()}`, generation: 0, state: 'disconnected' as const };
      await fn(c);
      // The host's credential contract rejects undefined even in optional object fields.
      const payload = JSON.parse(JSON.stringify(c)) as Connection;
      readConnection({ kind: 'grant', payload });
      return { kind: 'grant', payload };
    });
    const c = readConnection(record);
    if (!c) throw new ProviderError('STORAGE_INVALID');
    return c;
  }
}
