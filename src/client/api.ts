import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionView } from '../auth/session.js';
import type { UsageView } from '../llm/usage.js';

export interface Api {
  view(): Promise<RemoteResult<SessionView>>;
  login(): Promise<RemoteResult<{ url: string }>>;
  loginCodex(): Promise<RemoteResult<{ url: string }>>;
  consent(): Promise<RemoteResult<{ url: string }>>;
  cancel(): Promise<RemoteResult<void>>;
  models(): Promise<RemoteResult<{ id: string; name: string }[]>>;
  usage(): Promise<RemoteResult<UsageView | null>>;
  logout(): Promise<RemoteResult<{ remoteRevoked: boolean }>>;
}

export async function value<T>(request: Promise<RemoteResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
