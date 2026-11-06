import { LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm';

const messages: Record<string, string> = {
  AUTH_REQUIRED: '请先使用 ChatGPT 登录。', SHARING_DISABLED: '身份已确认，但尚未启用订阅共享。请重新授权。',
  CONNECTION_CHANGED: '连接已改变，请重新发起请求。', AUTH_INVALID: '官方身份验证未通过，请重新登录。',
  AUTH_TEMPORARY: '暂时无法验证官方身份，请稍后重试。', AUTH_CANCELLED: '登录已取消或超时。',
  AUTH_BUSY: '登录正在进行。', AUTH_PROTOCOL: '官方授权响应不完整，请重新登录。',
  STORAGE_INVALID: '连接数据损坏或版本不受支持；原数据已保留。',
  subscription_sharing_user_not_eligible: '当前账号或工作区不具备订阅共享资格。',
  subscription_sharing_usage_limit_exceeded: '此应用当前可用的订阅额度已达上限，请查看 ChatGPT 用量设置。',
  subscription_sharing_usage_unavailable: '暂时无法核验订阅用量，请稍后重试。',
  subscription_sharing_user_unavailable: '暂时无法确认账号信息，请稍后重试。',
  subscription_sharing_unsupported_capability: '订阅接口不支持本次输入、工具或配置。',
  subscription_sharing_route_not_supported: '订阅接口不支持此请求路径，请检查插件版本。',
  subscription_sharing_invalid_user: '订阅身份未被接受，请检查连接或重新授权。',
  chatpass_v2_scope_not_authorized: '当前授权不允许此操作，请检查共享权限。',
  chatpass_v2_invalid_authorization_context: '当前注册与授权不匹配，请重新授权。',
  PROTOCOL: '响应协议不受支持或不完整，请检查插件版本。', STREAM_INTERRUPTED: '响应提前断开，本次生成未完成。',
  UNSUPPORTED_INPUT: '此版本仅支持文本，请移除附件或使用宿主明确提示的文本投影。',
  MODEL_UNAVAILABLE: '所选模型不在当前账号目录中，请刷新模型并重新选择。',
  REPLAY_INVALID: '会话回放不兼容或已损坏，请新建会话；原会话已保留。',
  NETWORK: '暂时无法连接官方服务，请稍后重试。', HTTP_401: '官方服务未接受当前身份，请检查共享授权。',
  TIMEOUT: '官方服务响应超时，本次生成未完成，请稍后重试。',
  HTTP_400: '官方服务拒绝了请求参数，请检查所选模型与输入内容。',
  usage_limit_reached: '此账号的订阅用量已达当前时间窗口上限，请稍后重试；不要重复发送同一请求。',
  invalid_request_error: '官方服务拒绝了本次请求，请检查输入或稍后重试。',
  HTTP_403: '官方服务限制了此操作，请检查账号、区域和共享权限。', HTTP_503: '官方服务暂时不可用，请稍后重试。',
};
export class ProviderError extends LlmError {
  readonly diagnostic: { code: string; status?: number; requestId?: string; param?: string };
  constructor(code: string, status?: number, requestId?: string, param?: string) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'PROTOCOL';
    const safeId = requestId && /^req_[A-Za-z0-9_-]{1,120}$/.test(requestId) ? requestId : undefined;
    super(messages[safeCode]!, safeCode, { status, requestId: safeId ? ProviderRequestId(safeId) : undefined });
    this.diagnostic = { code: safeCode, ...(status === undefined ? {} : { status }), ...(safeId ? { requestId: safeId } : {}), ...(param && /^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(param) ? { param } : {}) };
  }
}
export function safeError(error: unknown): ProviderError {
  return error instanceof ProviderError ? error : new ProviderError('NETWORK');
}
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('PROTOCOL');
  return value as Record<string, any>;
}
export function wireError(value: unknown, status?: number, requestId?: string): ProviderError {
  const body = value && typeof value === 'object' ? value as Record<string, any> : {};
  const e = body.error && typeof body.error === 'object' ? body.error : body;
  const code = typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : undefined;
  return new ProviderError(code && Object.hasOwn(messages, code) ? code : `HTTP_${status}`, status, requestId, e.param);
}
