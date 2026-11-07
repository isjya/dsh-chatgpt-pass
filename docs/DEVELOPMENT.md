# 开发与验证

## 环境

使用 Node.js ≥24.9 和 package.json 中固定的 pnpm 11.28.5。依赖版本以 `pnpm-lock.yaml` 为准；不维护第二份 npm / Yarn 锁文件。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm check:repository
pnpm pack:release
```

`pnpm check` 依次执行类型检查、构建与自动化测试。测试使用合成授权服务、真实宿主公开包和临时目录；不需要 ChatGPT 登录，也不执行真实推理。`pnpm test` 单独运行时要求已有最新 `lib/`。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/auth/` | OAuth、账号状态、凭据服务与刷新 |
| `src/llm/` | 模型目录、请求、流、回放和用量映射 |
| `src/client/` | 订阅设置页、主侧边栏余量卡片与共享读取状态 |
| `src/service.ts` | 提供给客户端的安全 Remote 方法 |
| `tests/` | 自动化协议、宿主与进程测试 |
| `scripts/` | 构建、打包与仓库检查 |
| `scripts/verify/` | 可选的本地 UI / 宿主集成验证 |
| `docs/` | 安装、架构、开发和发布文档 |

`lib/`、`artifacts/`、`.validation/`、`.local/` 和缓存目录都是本地生成内容，不提交到 Git。不要将登录环境、原始响应或会话日志作为测试夹具。

## 可选验证脚本

所有命令均从仓库根目录执行。浏览器检查默认使用 Windows 上的 Microsoft Edge；也可通过 `DSH_BROWSER_PATH` 指定兼容 Chromium 的浏览器，通过 `DSH_BROWSER_PORT` 指定调试端口。

- `pnpm verify:ui`：合成账号的设置组件浏览器检查；需要 `DSH_CHATGPT_SOURCE_ROOT` 指向安装了 React DOM 18.3.1 的 Harness 开发目录。
- `node scripts/verify/ui-session.mjs source <port> <输出前缀>`：启动隔离源码宿主并检查设置页；先设置 `DSH_CHATGPT_SOURCE_ROOT`。
- `node scripts/verify/ui-session.mjs desktop <port> <输出前缀>`：启动隔离 Desktop 宿主；先设置 `DSH_CHATGPT_DESKTOP_ROOT` 为 Desktop 安装目录。
- `node scripts/verify/lifecycle-check.mjs source|desktop`：在全新隔离目录验证安装、升级与卸载。
- `node scripts/verify/sidebar-host-check.mjs source|desktop`：在全新隔离宿主中使用合成元数据，验证主侧边栏的紧凑 5 小时入口、点击详情弹窗、关闭设置后仍显示，以及更换端口重启后保留开关；不登录真实账号。

`DSH_CHATGPT_HOME` 指定隔离的 DSH_HOME，默认 `.validation/<target>-home`；`DSH_CHATGPT_PROFILE` 指定测试 profile。真实账号只读状态与用量探针使用 `DSH_PROBE_HOME`。真实文本／工具探针会消耗订阅用量，须在明确决定执行后单独运行，不进入 CI。

不要用 `--from-default-profile` 覆盖现有 profile，也不要为测试删除整个 DSH_HOME。只使用该次验证创建的隔离目录。

## 提交前

运行 `pnpm check:repository` 检查 Git 待提交清单中的本地产物、敏感文件、机器路径和失效文档链接。检查脚本不会打印匹配到的秘密值。新增依赖和分发规则时，同时检查 tarball 内容与许可。
