# 发布

本项目按 Harness bundle 分发，推荐 GitHub Release 中的预构建 tarball。源码仓库不提交 `lib/`，普通用户安装 Release 包即可，无需授予安装时构建权限。

## 生成安装包

1. 修改 `package.json` 中的版本。不要覆盖已经发布的同版本资产。
2. 执行 `pnpm install --frozen-lockfile --ignore-scripts`。
3. 执行 `pnpm check`、`pnpm check:repository`、`pnpm pack:release`。
4. 在支持的宿主上以全新隔离目录安装 tarball，检查加载、订阅页和卸载。需要真实账号的检查单独记录，未执行项不得标记通过。

打包使用 `package.json.files` 白名单，只包含构建入口、bundle patch、许可与安装文档。`artifacts/` 中生成 `.tgz`、同名 `.sha256`、`files.json`。包内不含源码工作目录、登录数据、测试记录或生命周期安装脚本。

## GitHub Release

推送与版本一致的 `vX.Y.Z` tag 后，release workflow 会检查、构建并建立草稿 Release，附加 tarball、SHA256 与文件清单。维护者审查草稿后发布。CI 不进行 npm 发布，也不运行真实账号探针。

Release 说明应写清兼容 Harness 版本、两条连接路径、实验性限制与本次实际检查范围。用户应下载明确命名的 `.tgz` 资产，不使用 GitHub 自动生成的源码归档。

仓库设置 `dsh-plugin` topic 便于发现。`package.json` 保留 bundle、客户端声明、版本兼容范围、repository、homepage、图标、本地化标题和关键词。推荐安装源是 Release tarball；若加入只接受 Git / npm 来源的第三方索引，应先验证对应来源可直接安装，不能把源码仓库误标为预构建分发。

## 规范参考

- [Harness 源码中的插件打包说明](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)
- [插件索引格式与发现方式](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/guide/plugin-market.md)

直接 Git 安装需要 `prepare` 与用户明确允许构建；本项目不把它作为预构建包的替代。需要直接 Git 安装时，应单独实现并验证自包含构建，而不是把开发构建产物加入主分支。
