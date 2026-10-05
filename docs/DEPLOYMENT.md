# sky.zjuaaa.cn 部署与维护

2026-10-05已上线：<https://sky.zjuaaa.cn/>。运行的是v0.1.0原冻结Web包，build ID `2966df95ea4fbc32`，入口模块SHA256 `ea9a85063d60ea6c8cc01bd8b3d915f63957a2e8acb81a5e633cb753889bef26`。部署与文档更新不改变该发行包。

## 独立项目边界

|内容|位置或规则|
|---|---|
|静态发行目录|`/srv/apps/sky-simulator/releases/2966df95ea4fbc32/`|
|当前入口|`/srv/apps/sky-simulator/current`，指向上述目录的相对符号链接|
|Nginx配置|`/etc/nginx/sites-available/sky-simulator`，同名sites-enabled链接|
|源码配置副本|仓库 `deploy/nginx/sky-simulator.conf`|
|ACME验证根|`/srv/data/sky-simulator/acme/`|
|部署记录|`/srv/data/sky-simulator/deployments/20261005/`|
|TLS证书|`/etc/letsencrypt/live/sky.zjuaaa.cn/`，禁止公开私钥|
|日志|`/var/log/nginx/sky-simulator-access.log`、`sky-simulator-error.log`|

本项目由已有Nginx直接提供静态文件，不启动Node、PM2、数据库或新监听端口，也没有在服务器安装Codex或开发依赖。部署包含预压缩gzip副本，实际目录约6.9 MiB。

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

## 本次上线检查

- DNS指向目标服务器，HTTP301、HTTPS200、证书验证、正确JS/manifest MIME和gzip响应通过。
- 实际公网入口模块字节SHA与冻结包一致，Chrome WebGL2四视图实际绘制，时间保持一致。
- HTTPS缓存显示就绪，关闭页面、浏览器断网、打开新页面返回200且来自Service Worker，离线仍能切换视图；没有页面脚本错误。
- 首轮截图拍在视图淡入期间；补充截图等待过渡idle后再保存。两次检查均保留本地记录，不作为性能或完整科学矩阵。
- 官网和lab部署前后200；flower部署前已502、部署后仍502，未把它作为本项目故障处理。

该检查补齐真实公网HTTPS与桌面浏览器离线重开证据。它不代表操作系统PWA安装、实体手机、Safari、Firefox间歇问题或30分钟持续测试通过。
