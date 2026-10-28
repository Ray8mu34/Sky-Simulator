# sky.zjuaaa.cn 部署与维护

网站：<https://sky.zjuaaa.cn/>。2026-10-28最新发布设备时间地点与原生日历，当前v0.3.0 Web构建ID为 `b4aca969debfe48f`，入口模块 `index-ClVFzZmN.js`，SHA256 `3be2a1aa0a8e1175da9d58995b59d419fd49e71290b07061dd1d6c1f93b8c7f6`。第八批已交付10等HYG星表与星图深度控制；其他扩展继续按独立功能推进。历史发行附件保留，服务器保留上一构建 `1c8b866cfcd567cc` 供回滚。

## 2026-10-28：设备时间地点与原生日历

源码提交 [`5db42c3`](https://github.com/Ray8mu34/Sky-Simulator/commit/5db42c3265b6979af301d5946eb46e20a4324316) 已推送，[GitHub构建检查](https://github.com/Ray8mu34/Sky-Simulator/actions/runs/40643473184)成功。平台/状态130项、本地Chrome/Edge设备与选择器流程、9组扩展时间场景、7组草稿以及离线回退检查通过，范围见[功能验证记录](DEVICE-CONTEXT-20261028.md)。

运行包SHA256为 `400151fbfca6042a8699deb1b1c5456744e3c4433f4a763fcb69e51cae89380c`。上传校验、独立release、旧hash资源兼容和gzip生成后原子切换current，保留上一完整版本；全局及全部站点Nginx配置SHA一致，没有重启其他服务。

公网Chrome验证入口模块SHA与本地一致，四视角与UTC配对正常、离线资源就绪、课程草稿经刷新和离线重开恢复，Service Worker返回200且构建ID一致，没有页面脚本错误。证据位于 `_local-archive/deployment-device-20261028/browser/report.json`。版本号继续为0.3.0，以build ID识别本次网站更新，历史GitHub发行附件保持原样。

另在公网HTTPS普通入口使用浏览器模拟授权坐标，确认自动读取设备时间与Asia/Shanghai时区、更新观测地点，以及日历/时间控件应用2028-02-29 20:30:45后得到正确UTC。没有读取真实用户坐标；证据为同目录 `public-device.json`，无页面脚本错误。

## 2026-10-28：精简前端文案

源码提交 [`64bd1cf`](https://github.com/Ray8mu34/Sky-Simulator/commit/64bd1cf49bf5b32dc7ce763d86cbe60b6c685fc1) 已推送main，[GitHub类型检查与构建](https://github.com/Ray8mu34/Sky-Simulator/actions/runs/40641420175)成功。本地123项状态/平台测试、Chrome桌面与320/390px触屏模拟、参考密度、二维回退、离线单文件均通过；发布前补充Edge同一前端流程，结果通过。核查范围与静态审计误报见 [文案核查记录](UI-COPY-REVIEW-20261028.md)。

部署包仅包含网站运行文件及署名，SHA256为 `8cb8dbd568642346574a3b113997382e17b249e2ae5f72d12c05006a818a9b1a`。服务器校验后建立独立release，兼容保留旧hash资源、生成gzip副本，再原子切换current。上一完整release保留；全局及所有站点Nginx配置SHA前后一致，没有重启其他服务。

公网Chrome实际下载入口模块SHA与本地和服务器一致，四视角与UTC保持配对，WebGL2运行、离线资源就绪。课程标题与未录入讲解经刷新保留；关闭页面并断网重开后返回Service Worker的200、构建ID一致，课程草稿继续恢复。无页面脚本错误，验证浏览器已关闭。本地证据：`_local-archive/deployment-20261028/browser/report.json`，Edge检查位于同目录 `edge/`。

此次为网站更新，版本号仍为0.3.0，以构建ID区分更新；没有覆盖既有GitHub Release附件。旧页面完整下载新版本后仍遵循“先保存场景、关闭全部本应用页面再重新打开”的更新流程。

## 独立项目边界

|内容|位置或规则|
|---|---|
|静态发行目录|`/srv/apps/sky-simulator/releases/b4aca969debfe48f/`|
|当前入口|`/srv/apps/sky-simulator/current`，指向上述目录的相对符号链接|
|Nginx配置|`/etc/nginx/sites-available/sky-simulator`，同名sites-enabled链接|
|源码配置副本|仓库 `deploy/nginx/sky-simulator.conf`|
|ACME验证根|`/srv/data/sky-simulator/acme/`|
|部署记录|`/srv/data/sky-simulator/deployments/20261028-device/`；历史记录保留在同级目录|
|TLS证书|`/etc/letsencrypt/live/sky.zjuaaa.cn/`，禁止公开私钥|
|日志|`/var/log/nginx/sky-simulator-access.log`、`sky-simulator-error.log`|

本项目由已有Nginx直接提供静态文件，不启动Node、PM2、数据库或新监听端口，也没有在服务器安装Codex或开发依赖。部署包含预压缩gzip副本，并保留旧hash资源以兼容尚未刷新的页面。

已有官网、flower与astronomy-lab的目录、证书、PM2及Nginx站点分别维护。不要执行 `pm2 restart all`、覆盖全局Nginx配置或把其他站点目录用作本项目根目录。本次部署前后全局Nginx及三份旧站点配置SHA256一致，既有PM2 PID一致。

## HTTP、缓存和证书

HTTP保留本项目 `/.well-known/acme-challenge/` 路由，其他请求301到HTTPS。HTTPS使用独立证书、TLS1.2/1.3，资源启用gzip预压缩；带hash的assets长缓存，HTML、Service Worker及manifest重新验证，缺失文件返回404。

证书签发后的到期时间为2027-01-03 04:30:30 UTC，后续以实际证书为准。使用现有 `certbot.timer` 自动检查续期；本证书为webroot验证，成功后运行 `nginx -t && systemctl reload nginx`。这次已确认签发成功、续期配置和timer启用，没有将其他证书改成Sky证书。

日志由现有 `/etc/logrotate.d/nginx` 的 `*.log` 规则处理，每日轮转、保留14份并压缩。

## 更新和回滚

先在开发机/CI生成并验证新Web包，上传压缩包和SHA256，不在这台共享服务器安装构建依赖。SSH凭据只保存在本地运维环境，不写进本仓库。

在服务器为每个新build创建独立 `releases/<buildId>/`，核对上传包哈希，解压并为JS/CSS/HTML/JSON等生成 `.gz` 副本，保留未压缩原文件。确认文件可由www-data读取后，通过临时符号链接原子替换 `current`；不要覆盖正在提供服务的旧发行目录。回滚同样只把current指回保留版本。

更新时将旧版本带hash的assets合并保留在新目录，且同名文件必须字节一致，避免仍打开旧HTML的客户端请求旧资源失败；不要覆盖同名hash文件。离线缓存仍由应用自己完成版本校验及等待激活。至少保留前一个完整release供回滚。

只有改动Nginx配置时才需要先 `sudo nginx -t`，成功后 `sudo systemctl reload nginx`；静态版本切换无需重启其他项目进程。初次部署若撤销，只解除本项目sites-enabled链接，再测试并reload，不能回滚整套共享配置。

## 2026-10-05初次上线检查

- DNS指向目标服务器，HTTP301、HTTPS200、证书验证、正确JS/manifest MIME和gzip响应通过。
- 实际公网入口模块字节SHA与冻结包一致，Chrome WebGL2四视图实际绘制，时间保持一致。
- HTTPS缓存显示就绪，关闭页面、浏览器断网、打开新页面返回200且来自Service Worker，离线仍能切换视图；没有页面脚本错误。
- 首轮截图拍在视图淡入期间；补充截图等待过渡idle后再保存。两次检查均保留本地记录，不作为性能或完整科学矩阵。
- 官网和lab部署前后200；flower部署前已502、部署后仍502，未把它作为本项目故障处理。

该检查补齐真实公网HTTPS与桌面浏览器离线重开证据。它不代表操作系统PWA安装、实体手机、Safari、Firefox间歇问题或30分钟持续测试通过。

## 2026-10-10功能更新检查

新Web包在开发机完成类型检查、构建、55项定向CPU测试和实际浏览器功能检查后，通过SSH上传；包SHA256为 `a20a517845f324b2504da56207b2f516cddf323960b632d47650c85ba0dd7f31`。服务器校验后切换current符号链接，保留上一完整版本及其hash资源；新目录含兼容资源和gzip约14 MiB。

公网Chrome验证入口模块SHA与本地构建一致，四视图正常、UTC保持一致，离线就绪后关闭页面、断网重开返回Service Worker的200与同一build ID。Nginx配置前后hash一致，未重启既有服务。官网与lab保持200；flower在更新前已502，更新后未改变。浏览器证据和静态审计原始结果保存在本地 `_local-archive/sky-visibility-20261010/`，没有上传开发中间材料到站点。

## 2026-10-21：第一至第七批功能部署

生产构建与便携版构建成功，447项自动化测试全部通过。目录扩展、探索工具、课程与设备浏览器检查通过，覆盖WebGL、适用的Canvas回退及便携版离线运行。第八批只包含规划文档，未实施。

部署包SHA256为 `cb563c5f77405966294718f5fa9c54dc42f50fc47a8df7e5e8b17b59ab3d3381`。服务器核对哈希后建立独立release，保留旧hash资源并生成gzip副本，原子切换current；保留完整上一版本。全局及所有站点Nginx配置哈希一致，没有重启其他服务。

公网Chrome确认入口模块SHA256与本地一致，四视图绘制及UTC一致、无页面脚本错误。离线资源就绪后关闭页面并断网重开，Service Worker返回200且构建ID一致。证据位于本地 `_local-archive/deployment-20261021/browser/report.json`。这次检查不代表实体移动设备、完整兼容性矩阵或长时间性能测试通过。

## 2026-10-25：v0.2.0教学资料与版本更新

Web及便携版构建、465项自动化测试、Chrome/Edge与窄屏/便携版教学资料流程、实际旧版缓存升级均通过。最终Web构建另完成30分钟Chrome加速时间与四视角持续运行，共31个检查点，无脚本或控制台错误；预热后同视角纹理/几何计数没有增长。完整范围见[本轮验证](USABILITY-20261025.md)。

部署包SHA256为 `28ea9c1d5f9d9ea6e877366abe2b4ca5a1bb92c6bca145eb4fdf708d21d43acc`。服务器校验后预置独立release、保留旧hash资产及gzip副本，等待最终持续测试通过才原子切换current。旧release `d2eae3b97390d5a0`完整保留；全局及所有站点Nginx配置hash一致，无服务重启。

公网Chrome确认v0.2.0及实际入口模块SHA256与本地包一致。四视图绘制和UTC一致，离线资源就绪，关闭页面后断网重开由Service Worker返回200。通过实际控件建立的测试课程及未录入讲解，在公网刷新和离线重开后均正确恢复。原始报告为 `_local-archive/deployment-20261025/browser/report.json`，无页面错误，测试浏览器已关闭。

## 2026-10-25：v0.3.0扩展星表

增加99,150颗HYG恒星，合计108,071颗。类型检查、Web与便携构建通过；Chrome155、Edge156及390px浏览器窄屏完成10等显示、暗星搜索/详情/定位、相机视场和肉眼模式复原。单次关键流程约5秒，无页面脚本错误；便携HTML直接打开确认完整目录。记录在 `qa/extended-stars/report.json`，本轮未重复长测或实体移动设备检查。

功能提交 `b7f1a51` 已推送，GitHub构建检查 [40167804741](https://github.com/Ray8mu34/Sky-Simulator/actions/runs/40167804741) 成功。部署包SHA256为 `ba7c6b526e06593a803388b26843665655d9f840677a09429e88bda32ff33dd1`。服务器核对后原子切换current，旧release和旧hash资源保留，Nginx全局及站点配置hash未改变，无服务重启。

公网HTTPS首页返回v0.3.0和构建 `7813a8cd8a083076`；从开发机实际下载入口JS返回200，SHA256与本地构建及服务器文件三方一致。公网浏览器复核脚本的资源等待发生30秒超时，本次不声称公网浏览器流程通过；浏览器功能结果来自上述本机构建检查。部署与下载原始材料保存在 `_local-archive/deployment-v030/`。
