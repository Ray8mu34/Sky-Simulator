# 教学资料保存与版本更新验证（2026-10-25）

发行版本：v0.2.0。Web构建 `6d8747c4a64b157b`。本次不实施第八批扩展，也不改变科学计算精度口径。

## 已完成的验证

| 范围 | 实际结果 | 本地原始证据 |
|---|---|---|
| 类型、Web与便携构建 | 通过；便携HTML 5,253,180字节，构建预算通过 | `dist/build-report.json`、`dist-portable/build-report.json` |
| 自动化测试 | 465项通过，0失败、0跳过 | `_local-archive/usability-20261025/unit-tests.txt` |
| 课程/地景/版本流程 | Chrome桌面、390px窄屏、Edge桌面、断网便携版通过；额外存储拒绝恢复场景通过 | `qa/teaching-resilience/final-6d8747c4/report.json` |
| 真实更新生命周期 | A=`ea307ae7095fbf8a`、B=`44b6ac42a92a9dff`；检查失败、核心资源下载失败、下载暂停、等待提示、多页自然激活和离线重开通过 | `qa/version-update/evidence/report.json` |
| 已部署旧版升级 | 真实旧构建`d2eae3b97390d5a0`→本版；旧页面不被中断，全部关闭后离线打开新版并恢复相同保存场景 | `qa/installed-upgrade/report.json` |
| 存储配额失败恢复 | 注入QuotaExceededError后旧记录/修订号不变，编辑可导出，离页提示可取消；重试后修订号仅增加一次并可刷新恢复 | `qa/teaching-resilience/quota-final-6d8747c4/report.json` |
| 原课程/设备流程回归 | Web与便携版示例播放、退出恢复、设备视场、地景导入导出通过 | `qa/course-equipment/report.json` |
| 页面生命周期 | Chrome真实前进/后退缓存恢复及正常退出释放通过 | `qa/teaching-resilience/lifecycle-final/report.json` |
| 设计规范结构检查 | 官方DESIGN.md lint：0错误；6条运行时映射token的静态引用警告 | 本轮终端输出 |
| GitHub CI | 实现提交`f100f937a5464c3ac0de844911c8acbc5086cadc`安装固定依赖、类型检查与Web构建成功 | [Actions运行](https://github.com/Ray8mu34/Sky-Simulator/actions/runs/40163797653) |
| 公网部署 | HTTPS版本/入口哈希、四视图、课程草稿刷新恢复、Service Worker离线重开及草稿恢复全部通过 | `_local-archive/deployment-20261025/browser/report.json` |

课程流程通过真实文件控件上传、下载后读取文件、刷新与新页面测试；并未仅根据内部状态断言。覆盖未录入草稿、地景方位、附带课程地景的临时应用与退出恢复、旧课程JSON、损坏图片/包、null地景包拒绝、替换确认与取消、草稿备份、移除撤销、跨页写入冲突、禁止存储后恢复、读取前编辑保护。新版本场景验证包含当前保存场景在离线重开后仍存在。

## 持续运行

旧部署基线 `d2eae3b97390d5a0` 与最终构建 `6d8747c4a64b157b` 各自使用冻结包完成30分钟Chrome测试，实际时长分别为1,800,450 ms和1,800,440 ms，均通过31个检查点。原始记录分别位于 `qa/teaching-resilience/sustained-baseline/` 与 `qa/teaching-resilience/sustained-final-6d8747c4/`，各自测试浏览器、上下文和本地服务器均已关闭。

最终构建经过约298小时的加速模拟时间，四视角中状态、科学快照和绘制UT在每次暂停检查时一致；Worker最多2个，预热后为5张纹理/10个几何对象，同视角前后数量增量均为0。脚本与控制台错误为0。浏览器报告的JS堆在约30.44–54.26 MiB间波动，不能由此推导无限期无泄漏。

脚本每分钟切换视角、运行时钟并暂停核对同一UT、统计Worker/纹理/几何/JS堆及脚本错误。它不测GPU完成耗时或实际显存，未强制GC，也不代表所有观测场景或设备长期稳定。

## 静态审计的实际限制

`audit_project.py --mode strict` 返回exit 1，前后均为两项 `affordance.actionless-button`：四视角动态按钮和月相放大镜关闭按钮。审计器只识别标签内事件属性，无法识别本项目的委托事件/`addEventListener`绑定。源码分别具有实际处理器，桌面及窄屏浏览器已用原生按钮的点击、聚焦和Enter操作验证成功，属于已核实的误报。本轮没有为消除误报增加空事件处理器，也没有将审计结果写成“全部通过”。

原始审计：`_local-archive/usability-20261025/premium-before.json`、`premium-final.json`；按钮运行证据：`qa/teaching-resilience/native-controls/report.json`以及最终流程报告。静态审计不能代替键盘或完整无障碍验收。

## 可复现命令与平台边界

```powershell
pnpm build
pnpm build:portable
node --import tsx --test tests/*.test.ts
pnpm qa:teaching
pnpm qa:version-update
pnpm qa:sustained
```

旧版升级复测使用 `node scripts/qa-installed-upgrade.mjs`，通过`SKY_QA_INSTALLED_OLD`、`SKY_QA_INSTALLED_NEW`指定已归档的真实Web包。脚本检查完整SHA256后使用原包，不重新构建或用测试标记冒充历史版本。

测试环境为Windows、Chrome 155.0.8059.85及Edge 156.0.4314.42。当前可调用的Playwright Firefox/WebKit运行时与原`.qa-browsers`目录缺失，未安装新运行时，不能据此声明Firefox旧问题已修复。macOS Safari、实体iOS/Android和系统PWA安装仍未验收。390px布局、Playwright离线与无头桌面运行只代表各自明确范围。

部分完整数据审计测试依赖本机保留的上游文件；本机全套测试成功不意味着干净GitHub checkout具备这些忽略文件。GitHub CI仍只执行固定依赖安装、类型检查与Web构建。
