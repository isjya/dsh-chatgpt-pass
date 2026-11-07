# 安装与使用

## 支持范围

插件以 Harness 独立 bundle 分发，包名与 provider ID 分别为 `dsh-chatgpt-pass`、`chatgpt-subscription`。当前验证的宿主版本为 **0.2.1-rc.5** 和 **0.2.2-rc.1**；安装和启动时由 `engines.dsh` 检查兼容性。

插件不要求用户单独运行模型网关或配置 API key。宿主提供 Cordis、LLM、授权、凭据、Remote 和客户端服务。

## 推荐：安装 Release 预构建包

1. 打开本仓库 [Releases](https://github.com/isjya/dsh-chatgpt-pass/releases)，选择版本。
2. 下载 `dsh-chatgpt-pass-<版本>.tgz` 和同名 `.sha256` 文件。
3. 在 Harness 的 **插件 → 添加插件** 中选择本地 `.tgz`，完成安装后启用或重启。
4. 确认 **设置 → ChatGPT 订阅** 页面已出现。

Windows 可核对 SHA256，结果应与下载的校验文件一致：

```powershell
Get-FileHash -Algorithm SHA256 ./dsh-chatgpt-pass-<版本>.tgz
```

CLI 安装方式：

```sh
dsh plugin --profile <profile> add ./dsh-chatgpt-pass-<版本>.tgz
```

安装包已包含 `lib/`、bundle patch 和必要文档，没有安装时执行的生命周期脚本。不要把 GitHub 自动生成的 **Source code.zip / tar.gz** 当作插件安装包。

插件管理器支持下载链接时，可以直接粘贴 Release 中的 `.tgz` 地址；安装源保留默认 npm 官方源即可，不要将 GitHub 地址填入「自定义 npm 源」。本项目尚未发布到 npm，不能只输入包名来安装。

## 登录

打开 **设置 → ChatGPT 订阅**：

- **ChatGPT 登录**：推荐 Plus / Pro 账号，使用官方 SIWC 授权。
- **Business 登录**：推荐 Business / Team 账号，使用实验性 Codex 兼容路径。

只在 `auth.openai.com` 官方网页输入登录信息并授权。弹窗被拦截时使用设置页中的「继续授权」。登录可取消，超时后可重试。不要分享授权链接、回调、密码或令牌。

仅确认身份但未开启共享时，点击「启用订阅共享」。成功后在聊天模型选择器中选择实际模型。模型目录不代表真实推理资格已验证。

Business 路径借用 Codex 第一方 OAuth 客户端及 backend-api，并非 OpenAI 文档支持的第三方接入方式。它可能受工作区策略、条款和接口变更影响，不保证长期可用。

## 用量与模型

订阅页显示脱敏账号和连接状态。「切换连接方式」用于重新登录，「可用模型」用于查看和刷新目录。Codex 用量以双行进度条显示剩余额度；悬停重置倒计时可查看完整时间。

无数据时显示空状态，更新失败保留最近数据及其时间。数据以 ChatGPT 页面为准。当前没有已验证可用的账号级历史 Token 接口，因此未提供 7 / 30 天分析。刷新目录和用量不发送推理请求。

## 升级与卸载

通过同一入口安装新版本 `.tgz` 并重启 Harness。支持的凭据记录会保留；未知 schemaVersion 会停止写入，避免覆盖数据。

### 从旧包名迁移

本仓库 v0.2.14 及更早版本使用 `dsh-chatgpt-provider`，自 v0.2.15 起改为 `dsh-chatgpt-pass`。由于包名改变，需要先在插件管理器中移除旧包，再添加新包并重启。迁移时不要在订阅页点击「退出登录」。CLI 示例：

```sh
dsh plugin --profile <profile> remove dsh-chatgpt-provider
dsh plugin --profile <profile> add ./dsh-chatgpt-pass-<版本>.tgz
```

provider ID、凭据键和账号身份保持不变，已保存的模型选择与登录记录可继续使用。不要同时启用新旧两个包。

### 卸载

卸载前可在订阅页点击「退出登录」，再从插件管理器移除，或执行：

```sh
dsh plugin --profile <profile> remove dsh-chatgpt-pass
```

本地退出不一定代表远端授权已撤销，可在 [ChatGPT 设置](https://chatgpt.com/settings/usage) 管理远端连接。插件不会删除 Harness 会话或其他 provider 数据。

## 开发者安装

先按 [开发指南](DEVELOPMENT.md) 安装依赖并构建，再通过 `dsh plugin --profile <profile> add /path/to/dsh-chatgpt-pass` 链接本地目录。修改后需要重新构建。

直接 Git 安装源码需要 `prepare` 和用户的构建授权。本项目未设置 `prepare`，以 Release 预构建 `.tgz` 为推荐分发方式，不应将 Git 仓库 URL 直接作为安装入口。
