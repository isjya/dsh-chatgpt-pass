// Scoped styles travel with the client bundle and inherit the host's theme tokens.
export const styles = `
.chatgpt-subscription{--cgp-text:var(--dsw-alias-label-primary,#202124);--cgp-muted:var(--dsw-alias-label-secondary,#73757c);--cgp-border:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--cgp-surface:var(--dsw-alias-bg-layer-2,Canvas);--cgp-soft:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07));--cgp-accent:light-dark(#168368,#61d9b2);--cgp-warning:light-dark(#966000,#efbd66);--cgp-danger:light-dark(#bb3636,#ff9696);container-type:inline-size;box-sizing:border-box;width:100%;max-width:760px;margin:0 auto;padding:8px 0 24px;color:var(--cgp-text);font-family:inherit;font-size:14px;line-height:1.5}
.chatgpt-subscription *{box-sizing:border-box}
.chatgpt-subscription h2,.chatgpt-subscription h3,.chatgpt-subscription p{margin:0}
.chatgpt-subscription h2{font-size:24px;font-weight:650;line-height:1.35;letter-spacing:-.5px}
.chatgpt-subscription h3{font-size:14px;font-weight:600}
.chatgpt-subscription .cgp-subtitle{margin-top:6px;color:var(--cgp-muted);font-size:13px}
.chatgpt-subscription .cgp-muted{color:var(--cgp-muted)}
.chatgpt-subscription .cgp-card{border:1px solid var(--cgp-border);border-radius:var(--dsw-radius-md,12px);background:var(--cgp-surface)}
.chatgpt-subscription .cgp-account{margin-top:20px;overflow:hidden}
.chatgpt-subscription .cgp-account-main{display:flex;align-items:center;gap:12px;padding:16px}
.chatgpt-subscription .cgp-account-actions{display:flex;align-items:center;gap:12px;flex:none}
.chatgpt-subscription .cgp-avatar{display:grid;place-items:center;width:40px;height:40px;flex:none;border:1px solid var(--cgp-border);border-radius:12px;background:var(--cgp-soft)}
.chatgpt-subscription .cgp-identity{flex:1;min-width:0}
.chatgpt-subscription .cgp-email{font-weight:600;overflow-wrap:anywhere}
.chatgpt-subscription .cgp-path{margin-top:3px;font-size:12px;color:var(--cgp-muted)}
.chatgpt-subscription .cgp-status{display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--cgp-muted);font-size:12px;white-space:nowrap}
.chatgpt-subscription .cgp-status[data-connected=true]{color:var(--cgp-accent)}
.chatgpt-subscription .cgp-dot{width:6px;height:6px;background:currentColor;border-radius:50%;flex:none}
.chatgpt-subscription button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;margin:0;padding:7px 12px;border:1px solid var(--cgp-border);border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--cgp-text);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:background .15s}
.chatgpt-subscription button:hover:not(:disabled){background:var(--cgp-soft)}
.chatgpt-subscription button:disabled{opacity:.45;cursor:default}
.chatgpt-subscription :is(button,a,summary):focus-visible{outline:2px solid var(--cgp-accent);outline-offset:3px}
.chatgpt-subscription .cgp-quiet{border-color:transparent;color:var(--cgp-muted);padding:5px 8px}
.chatgpt-subscription .cgp-primary{background:var(--dsw-alias-button-primary-fill,var(--cgp-text));color:var(--dsw-alias-label-primary-foreground,Canvas);border-color:transparent}
.chatgpt-subscription .cgp-primary:hover:not(:disabled){opacity:.85;background:var(--dsw-alias-button-primary-fill,var(--cgp-text))}
.chatgpt-subscription .cgp-section{margin-top:20px}
.chatgpt-subscription .cgp-sidebar-option{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;padding:12px 0;border-block:1px solid var(--cgp-border);cursor:pointer}
.chatgpt-subscription .cgp-sidebar-option strong{display:block;font-size:13px;font-weight:500}
.chatgpt-subscription .cgp-sidebar-option span>span{display:block;margin-top:2px;font-size:12px;color:var(--cgp-muted)}
.chatgpt-subscription .cgp-sidebar-option input{width:16px;height:16px;flex:none;margin:0;accent-color:var(--cgp-accent);cursor:pointer}
.chatgpt-subscription .cgp-sidebar-option input:focus-visible{outline:2px solid var(--cgp-accent);outline-offset:3px}
.chatgpt-subscription .cgp-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.chatgpt-subscription .cgp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:12px}
.chatgpt-subscription .cgp-login{display:flex;flex-direction:column;gap:14px;padding:16px}
.chatgpt-subscription .cgp-login-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.chatgpt-subscription .cgp-login-heading strong{font-size:16px;font-weight:600}
.chatgpt-subscription .cgp-tag{font-size:10px;line-height:18px;padding:1px 6px;border:1px solid var(--cgp-border);border-radius:5px;color:var(--cgp-muted)}
.chatgpt-subscription .cgp-login p{font-size:12px;color:var(--cgp-muted);margin-top:4px}
.chatgpt-subscription .cgp-login button{margin-top:auto;width:100%}
.chatgpt-subscription .cgp-switch{margin-top:6px}
.chatgpt-subscription summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}
.chatgpt-subscription summary::-webkit-details-marker{display:none}
.chatgpt-subscription .cgp-chevron{margin-left:auto;transition:transform .15s}
.chatgpt-subscription details[open]>summary .cgp-chevron{transform:rotate(180deg)}
.chatgpt-subscription .cgp-switch>summary{color:var(--cgp-muted);font-size:12px;min-height:28px}
.chatgpt-subscription .cgp-switch[open]>summary{margin-bottom:10px}
.chatgpt-subscription .cgp-usage-panel{padding:16px;display:flex;flex-direction:column;gap:20px}
.chatgpt-subscription .cgp-usage-label{font-size:13px;font-weight:600;line-height:20px}
.chatgpt-subscription .cgp-usage-meta{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:3px;color:var(--cgp-muted);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.chatgpt-subscription .cgp-remaining{white-space:nowrap}
.chatgpt-subscription .cgp-meter{height:6px;overflow:hidden;margin-top:7px;border-radius:99px;background:color-mix(in srgb,var(--cgp-text) 10%,transparent);color:var(--cgp-text)}
.chatgpt-subscription .cgp-meter[data-tone=warning]{color:var(--cgp-warning)}
.chatgpt-subscription .cgp-meter[data-tone=empty]{color:var(--cgp-danger)}
.chatgpt-subscription .cgp-meter-fill{height:100%;background:currentColor}
.chatgpt-subscription .cgp-reset{color:var(--cgp-muted)}
.chatgpt-subscription .cgp-updated{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:10px;color:var(--cgp-muted);font-size:11px}
.chatgpt-subscription .cgp-empty{padding:26px 18px;text-align:center;font-size:13px;color:var(--cgp-muted)}
.chatgpt-subscription .cgp-feedback{margin-top:14px;padding:12px 14px;border-radius:8px;background:var(--cgp-soft);font-size:12px;overflow-wrap:anywhere}
.chatgpt-subscription [role=alert]{color:var(--cgp-danger)}
.chatgpt-subscription .cgp-waiting{display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.chatgpt-subscription a{color:inherit;text-decoration:none}
.chatgpt-subscription a:hover{text-decoration:underline}
.chatgpt-subscription .cgp-models{margin-top:20px;overflow:hidden}
.chatgpt-subscription .cgp-models>summary{padding:16px;font-size:13px;font-weight:500}
.chatgpt-subscription .cgp-count{color:var(--cgp-muted);font-size:11px;font-weight:400}
.chatgpt-subscription .cgp-model-body{padding:0 16px 16px;border-top:1px solid var(--cgp-border)}
.chatgpt-subscription .cgp-model-toolbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:10px 0;font-size:11px;color:var(--cgp-muted)}
.chatgpt-subscription .cgp-model-list{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.chatgpt-subscription .cgp-model-list li{padding:5px 9px;border-radius:6px;background:var(--cgp-soft);font-size:12px;overflow-wrap:anywhere;max-width:100%}
.chatgpt-subscription .cgp-footer{display:flex;justify-content:flex-end;margin-top:18px;font-size:12px;color:var(--cgp-muted)}
@container (max-width:460px){.chatgpt-subscription .cgp-account-actions{flex-direction:column;align-items:flex-end;gap:0}.chatgpt-subscription .cgp-account-actions button{min-height:26px;padding:2px 0}.chatgpt-subscription .cgp-account-main{gap:10px}}
@container (max-width:360px){.chatgpt-subscription .cgp-avatar{width:32px;height:32px;border-radius:10px}.chatgpt-subscription .cgp-model-toolbar{align-items:flex-start;flex-direction:column}}
@media(prefers-reduced-motion:reduce){.chatgpt-subscription *{transition:none!important}}
`;

export const sidebarStyles = `
.cgp-sidebar{--cgp-text:var(--dsw-alias-label-primary,CanvasText);--cgp-muted:var(--dsw-alias-label-secondary,GrayText);--cgp-border:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--cgp-warning:light-dark(#966000,#efbd66);--cgp-danger:light-dark(#bb3636,#ff9696);box-sizing:border-box;flex:1;min-width:0;margin:4px 8px 8px;color:var(--cgp-text);font:inherit;font-size:12px;line-height:18px}
.cgp-sidebar *{box-sizing:border-box}
.cgp-sidebar .cgp-quota-trigger{display:block;width:100%;padding:10px 12px;border:1px solid var(--cgp-border);border-radius:10px;background:transparent;color:var(--cgp-text);font:inherit;text-align:left;cursor:pointer}
.cgp-sidebar .cgp-quota-trigger:hover,.cgp-sidebar .cgp-quota-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}
.cgp-sidebar :is(button,a):focus-visible{outline:2px solid var(--cgp-text);outline-offset:3px}
.cgp-sidebar .cgp-quota-line{display:flex;align-items:center;justify-content:space-between;gap:8px;line-height:20px}
.cgp-sidebar .cgp-quota-line strong{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.cgp-sidebar .cgp-quota-period{color:var(--cgp-muted);font-size:11px}
.cgp-sidebar .cgp-quota-track{display:block;height:3px;margin-top:7px;overflow:hidden;border-radius:9px;background:color-mix(in srgb,var(--cgp-text) 10%,transparent);color:var(--cgp-text)}
.cgp-sidebar .cgp-quota-track>span{display:block;height:100%;background:currentColor}
.cgp-sidebar .cgp-quota-track[data-tone=warning],.cgp-sidebar .cgp-quota-trigger[data-stale=true] strong{color:var(--cgp-warning)}
.cgp-sidebar .cgp-quota-track[data-tone=empty]{color:var(--cgp-danger)}
.cgp-sidebar .cgp-quota-status{display:block;margin-top:3px;color:var(--cgp-muted);font-size:11px;line-height:16px}
.cgp-sidebar .cgp-quota-popover{position:fixed;inset:auto;width:304px;max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);overflow:auto;margin:0;padding:16px;border:1px solid var(--cgp-border);border-radius:16px;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--cgp-text);box-shadow:0 8px 32px rgba(0,0,0,.15);font:inherit}
.cgp-sidebar .cgp-quota-popover h3{margin:0;padding-bottom:12px;border-bottom:1px solid var(--cgp-border);font-size:14px;font-weight:600;line-height:22px}
.cgp-sidebar .cgp-quota-popover dl{display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0}
.cgp-sidebar .cgp-quota-detail{display:grid;grid-template-columns:1fr auto;align-items:baseline;gap:3px 12px;font-size:13px;line-height:20px}
.cgp-sidebar .cgp-quota-detail dd{margin:0;white-space:nowrap;font-variant-numeric:tabular-nums}
.cgp-sidebar .cgp-quota-detail time{grid-column:1/-1;color:var(--cgp-muted);font-size:11px;line-height:16px}
.cgp-sidebar .cgp-quota-updated{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;color:var(--cgp-muted);font-size:11px}
.cgp-sidebar .cgp-quota-updated button{padding:3px 6px;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.cgp-sidebar .cgp-quota-updated button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}
.cgp-sidebar .cgp-quota-updated button:disabled{opacity:.45;cursor:default}
.cgp-sidebar .cgp-quota-manage{display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:12px;padding:12px 0 0;border:0;border-top:1px solid var(--cgp-border);background:transparent;color:inherit;font:inherit;text-align:left;font-size:13px;line-height:22px;cursor:pointer}
.cgp-sidebar .cgp-quota-manage:hover{text-decoration:underline}
.cgp-sidebar .cgp-quota-manage span{color:var(--cgp-muted)}
.cgp-sidebar .cgp-quota-warning,.cgp-sidebar [data-stale=true]{color:var(--cgp-warning)}
.cgp-sidebar .cgp-quota-warning{margin:0 0 10px;font-size:11px}
.cgp-sidebar .cgp-quota-empty{margin:16px 0;color:var(--cgp-muted);font-size:12px;line-height:20px}
`;
