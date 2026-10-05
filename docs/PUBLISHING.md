# 构建与发布

仓库：<https://github.com/Ray8mu34/Sky-Simulator>。v0.1.0 以 **GitHub prerelease / 公开预览版** 发布，CI不自动部署网站。2026-10-05已按用户授权独立部署至 <https://sky.zjuaaa.cn/>，见[部署与维护](DEPLOYMENT.md)。

## 构建输入

使用 Node.js 24.14.0 和 package.json 声明的 pnpm 11.0.9：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm build:portable
```

构建读取 `src/`、`assets/runtime/`、资产清单与许可证、入口和构建脚本。仓库已包含经过处理的运行素材；普通构建无需 `assets/source/`、历史 QA、浏览器运行时、Python 或上游原始图像。

- `dist/`：完整 Web 包，包含相对路径入口、Service Worker、manifest、运行资源和 `credits/`。
- `dist-portable/三维全景夜空.html`：经典脚本单文件，CSS、数据、图像和两个 Worker 脚本均内嵌；不依赖 Service Worker。
- 两处 `build-report.json`：字节数、SHA256、素材署名和构建预算；其状态只说明构建完成，不等于浏览器验收。

## 最小 CI

[ci.yml](../.github/workflows/ci.yml) 在 Windows runner 上设置固定 Node/pnpm，执行 `pnpm install --frozen-lockfile` 和 `pnpm build`，后者包含类型检查。Actions 固定到已核对的提交，不下载 Playwright 浏览器、不跑 GPU/设备矩阵、不发布包或部署 Pages。

当前锁文件没有私有 registry、Git 或本地路径依赖；直接依赖的固定版本与 tarball 已检查可从公共 npm registry 获取。首次 GitHub CI 的安装与构建结果仍以实际 workflow 运行记录为准，不能由本机检查预先声明通过。[setup-node](https://github.com/actions/setup-node) 与 [pnpm/action-setup](https://github.com/pnpm/action-setup) 的运行职责分开。

## Release 文件

发布维护者应固定提交与 `v0.1.0` tag，并使用 [发布说明](RELEASE-NOTES-v0.1.0.md) 创建 prerelease。附件至少包含便携 HTML、完整 Web 包压缩文件及对应 SHA256 清单；不要只上传 Web 的 `index.html`。项目介绍 PDF 与真实应用截图保留在 `media/`，供 README 展示。

上传前核对包的实际哈希、文件大小和署名资料，确认压缩包只包含计划发布的文件。不把本机路径、私有参考材料、原始大图、浏览器缓存、node_modules 或历史调试日志加入发布附件。源码仓库保留构建所需运行素材、固定锁文件、许可证及必要科学测试夹具。

现有预览版与历史失败记录不能被新的构建结果混称；Release 说明应保留 Firefox 未确认、真实移动设备/Safari 未验和长测暂缓等限制。CI 成功也不是这些项目通过的证据。

## 静态部署与更新

部署时上传完整 Web 包到同一个路径，保留相对资源和 `credits/`，通过 HTTPS 访问。子路径支持来自相对入口与独立 Service Worker scope，不需要自定义 API。真实部署域上的 PWA 安装、离线冷启动与系统兼容性仍应单独验证；本仓库的 CI 不完成这些步骤。

应用等待新版完整缓存后提示用户保存场景、关闭同应用所有页面再重新打开，不强制激活或刷新教学中的页面。本地场景数据独立于版本资源缓存；重要场景仍建议导出 JSON 备份。

便携版直接用桌面浏览器打开，不要把 `dist/index.html` 当作单文件。移动系统可能限制本地 HTML 执行，不能由桌面文件验收推导实体移动端可用。

## 许可

自有代码为根 [MIT LICENSE](../LICENSE)。第三方素材与依赖采用各自原许可证，见 [资产清单](../assets/assets-manifest.json) 与 [assets/licenses](../assets/licenses/)。Web 的 `credits/` 和便携 HTML 内嵌署名应随发行保留；宣传截图/PDF 同样保留相应素材来源，不暗示提供者背书。
