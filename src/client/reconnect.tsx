import { useEffect, useId, useRef } from 'react';

/** Confirm interruption of this plugin's requests using a focus-trapped native dialog. */
export function ReconnectDialog({ count, onCancel, onConfirm }: { count: number; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const title = useId(), description = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); };
  }, []);
  return <dialog ref={dialog} className="cgp-reconnect-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h3 id={title}>重新连接 ChatGPT？</h3>
    <p id={description}>将中止本插件当前 {count} 个请求，可能影响其他聊天。登录、聊天历史和已完成的工具结果会保留。</p>
    <p>重连后不会自动重新发送任务，请在需要时手动继续。</p>
    <div className="cgp-dialog-actions"><button ref={cancel} onClick={onCancel}>取消</button><button className="cgp-primary" onClick={onConfirm}>中止请求并重连</button></div>
  </dialog>;
}

/** Switching authorization routes replaces the current connection. */
export function QuotaConnectionDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const title = useId(), description = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); };
  }, []);
  return <dialog ref={dialog} className="cgp-reconnect-dialog" aria-labelledby={title} aria-describedby={description}
    onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h3 id={title}>启用订阅余量查询？</h3>
    <p id={description}>Plus / Pro / Business 均可尝试使用订阅余量连接。需要重新授权，将替换当前官方连接，并中止其进行中的请求。</p>
    <p>历史记录保留，切换后请新建会话。此连接为实验性，模型与余量以账号实际授权为准。</p>
    <div className="cgp-dialog-actions"><button ref={cancel} onClick={onCancel}>取消</button><button className="cgp-primary" onClick={onConfirm}>切换连接并重新授权</button></div>
  </dialog>;
}
