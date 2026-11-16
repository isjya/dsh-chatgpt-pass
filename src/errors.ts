import { HarnessError, ProviderRequestId, type LlmFailure } from '@deepseek-ai/dsh-llm';

const messages: Record<string, string> = {
  AUTH_REQUIRED: '请先使用 ChatGPT 登录。', SHARING_DISABLED: '身份已确认，但尚未启用订阅共享。请重新授权。',
  CONNECTION_CHANGED: '连接已改变，请重新发起请求。', AUTH_INVALID: '官方身份验证未通过，请重新登录。',
  CONNECTION_RESET: '连接已手动重置，本次请求已停止；聊天记录已保留，请手动继续。',
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
  PROTOCOL: '响应数据未通过校验，本次生成未完成。', STREAM_INTERRUPTED: '响应提前断开，本次生成未完成。',
  UPSTREAM_ERROR: '上游服务返回了错误，本次生成未完成，请稍后重试。',
  HTTP_ERROR: '上游服务拒绝或未能完成本次请求，请根据状态码检查服务。',
  UNSUPPORTED_INPUT: '此版本仅支持文本，请移除附件或使用宿主明确提示的文本投影。',
  MODEL_UNAVAILABLE: '所选模型不在当前账号目录中，请刷新模型并重新选择。',
  REPLAY_INVALID: '会话回放数据无效或版本不受支持，无法安全续聊；原会话已保留。',
  REPLAY_IDENTITY_MISMATCH: '当前登录身份与会话历史不一致，请切回原连接身份，或在新会话中补充文字上下文；原会话已保留。',
  NETWORK: '暂时无法连接官方服务，请稍后重试。', HTTP_401: '官方服务未接受当前身份，请检查共享授权。',
  TIMEOUT: '官方服务响应超时，本次生成未完成，请稍后重试。',
  HTTP_400: '官方服务拒绝了请求参数，请检查所选模型与输入内容。',
  HTTP_408: '上游服务等待请求超时，本次生成未完成，请稍后重试。',
  HTTP_413: '请求内容过大，请缩短上下文或减少工具输出。',
  HTTP_422: '上游服务无法处理本次请求，请检查模型与输入内容。',
  HTTP_429: '上游服务限制了请求频率或用量，请稍后重试。',
  HTTP_500: '上游服务内部错误，本次生成未完成，请稍后重试。',
  HTTP_502: '上游网关暂时不可用，本次生成未完成，请稍后重试。',
  HTTP_504: '上游网关等待响应超时，本次生成未完成，请稍后重试。',
  context_length_exceeded: '上下文超出模型限制，请压缩上下文或新建会话。',
  rate_limit_exceeded: '上游服务限制了请求频率或用量，请稍后重试。',
  server_error: '上游服务内部错误，本次生成未完成，请稍后重试。',
  usage_limit_reached: '此账号的订阅用量已达当前时间窗口上限，请稍后重试；不要重复发送同一请求。',
  invalid_request_error: '官方服务拒绝了本次请求，请检查输入或稍后重试。',
  HTTP_403: '官方服务限制了此操作，请检查账号、区域和共享权限。', HTTP_503: '官方服务暂时不可用，请稍后重试。',
};
const reasons = {
  'stream.usage': '用量计数无效', 'stream.limit': '响应超过处理上限',
  'stream.event': '响应事件的顺序或字段不一致', 'stream.item': '输出项目不受支持或不一致',
  'stream.text': '文本内容与已接收内容不一致', 'stream.tool': '工具名称、参数或调用标识无效',
  'stream.reasoning': '推理摘要与已接收内容不一致', 'stream.completion': '结束事件与已接收输出不一致',
  'timeout.headers': '等待响应头超时', 'timeout.stream': '等待后续响应超时',
  'stream.eof': '响应连接意外关闭', 'stream.json': '响应事件不是有效 JSON', 'stream.transport': '读取响应时网络连接中断',
} as const;
export type FailureReason = keyof typeof reasons;
// Provider codes are outside DSH's built-in LlmError constructor taxonomy.
// A HarnessError carrying LlmFailure also works on the earlier supported hosts.
export class ProviderError extends HarnessError {
  readonly failure: LlmFailure;
  readonly diagnostic: { code: string; status?: number; requestId?: string; param?: string; reason?: FailureReason; retryCount?: number };
  constructor(code: string, status?: number, requestId?: string, param?: string, reason?: FailureReason, retryCount = 0) {
    const safeCode = Object.hasOwn(messages, code) ? code : 'PROTOCOL';
    const safeId = requestId && /^req_[A-Za-z0-9_-]{1,120}$/.test(requestId) ? requestId : undefined;
    const safeReason = reason && Object.hasOwn(reasons, reason) ? reason : undefined;
    const retries = Number.isSafeInteger(retryCount) && retryCount > 0 && retryCount <= 3 ? retryCount : 0;
    super(messages[safeCode]! + (safeReason ? `（${reasons[safeReason]}；诊断：${safeReason}）` : '') + (retries ? `（已自动重试 ${retries} 次）` : ''), safeCode);
    if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599)) throw new Error('ProviderError status must be an integer from 100 through 599');
    this.name = 'ProviderError';
    this.failure = Object.freeze({ message: this.message, code: safeCode, ...(status === undefined ? {} : { status }), ...(safeId ? { requestId: ProviderRequestId(safeId) } : {}) });
    this.diagnostic = { code: safeCode, ...(status === undefined ? {} : { status }), ...(safeId ? { requestId: safeId } : {}), ...(param && /^[a-zA-Z0-9_.\[\]-]{1,100}$/.test(param) ? { param } : {}), ...(safeReason ? { reason: safeReason } : {}), ...(retries ? { retryCount: retries } : {}) };
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
  const code = [e.code, e.type].find(c => typeof c === 'string' && Object.hasOwn(messages, c));
  const httpCode = status === undefined ? 'UPSTREAM_ERROR' : Object.hasOwn(messages, `HTTP_${status}`) ? `HTTP_${status}` : 'HTTP_ERROR';
  return new ProviderError(code ?? httpCode, status, requestId, e.param);
}
