# 夜空工具交互契约

## Product context

中文天文教学与天空探索工具；主任务是在同一时刻、地点下切视角、比较科学读数与显示效果。视觉规范见 [DESIGN.md](DESIGN.md)。运行时样式为规范源，原生控件负责键盘语义与平台弹出行为，手机主要操作目标为44px。WCAG 2.2 AA是目标，不将静态审计解释为完整认证。

时间显示使用场景的 displayZone，农历独立使用UTC+8；地点预设与时区独立。普通入口和“此刻与当前位置”明确同时采用设备时间及设备时区，定位通过浏览器权限控制。不增加账户、收费或服务端位置存储。

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| 可见性与地形显示 | 本次用户明确要求；`src/contracts.ts` | 当前需求 / 状态契约 | 2026-10-10 |
| 科学模型边界 | `docs/SCIENCE-MODEL.md`；`src/core/sky-appearance.ts` | 维护文档 / 唯一模型API | 2026-10-10 |
| 显示后端能力 | `src/platform/renderer-port.ts` | GraphicsStatus能力契约 | 2026-10-10 |
| 本地保存与分享 | `src/platform/scene-library.ts`；`src/ui/scene-controls.ts` | 现有数据与交互接口 | 2026-10-10 |
| 视觉与响应式 | `src/style.css`；本轮保持既有视觉的明确要求 | 运行时规范 / 当前需求 | 2026-10-10 |
| 版本识别与安全更新 | 用户确认缓存问题及持续完善授权；`src/platform/offline.ts` | 当前需求 / 离线生命周期 | 2026-10-25 |
| 课程与地景恢复 | 用户持续完善授权；`docs/COURSES-EQUIPMENT.md` | 当前需求 / 本地教学资料 | 2026-10-25 |

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | 控件模块中的原生select | 状态值与对应模块 | native：接受平台弹出层；搜索使用现有结果列表 | 既有浏览器QA，本轮未新增select |
| Date | `src/ui/time-controls.ts` | core时间API与displayZone | native date/time；天文纪年typed；显式应用，整表草稿 | `qa-device-context.mjs`及时间/草稿QA |
| Form | `src/ui/form-draft.ts`和各模块提交校验 | `src/state.ts`及core输入校验 | 显式应用；失败保留草稿 | 既有草稿QA；历史静态差异不以本文件豁免 |
| Scrollbar | `src/style.css`的全局滚动条基线 | `:root`滚动条变量、标准属性与WebKit回退 | 面板及有界列表独立滚动 | 桌面与窄屏滚动检查 |
| Toast | `controls.ts`中的message | 同一role=status区域 | 正常短反馈 / 持续错误 | 既有反馈；本轮状态说明使用同区局部文本 |
| CRUD | `scene-controls.ts` + sceneLibrary | 本地库单一格式与完整状态 | 显式保存 / 覆盖 / 删除 / 载入 | 既有场景库QA，本轮不改 |
| Offline update | `platform/offline.ts` + `ui/offline-controls.ts` | 当前页面、active和waiting构建身份 | 检查 / 下载 / 待重开；不强制激活 | 版本更新浏览器测试 |
| Teaching persistence | `ui/course-equipment-controls.ts` + platform教学存储 | 单份当前草稿及独立地景，版本化本地记录 | 自动保存 / 导出 / 冲突恢复 | 存储单测与刷新、跨页浏览器测试 |
| Supplementary help | `ui/info-tip.ts` | AGENTS.md的文案原则 | 非交互tooltip，鼠标/键盘/触屏 | `scripts/qa-ui-copy.mjs` |
| Device context | `platform/device-context.ts` + `ui/controls.ts` | 设备Date/Intl与浏览器Geolocation | 单次定位；显式重试；拒绝时保留地点 | platform-device-context单测及qa-device-context浏览器验证 |

新增能力不创建重复实现：肉眼模拟与污染编辑由 `appearance-controls.ts` 唯一拥有；地形复选框由 `controls.ts` 的图层定义、同步与change处理唯一拥有。

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| 模拟肉眼星空 | `#sky-observe-appearance` | 清旧模型数值 | 同一页面，3D切地表；2D保留已保存视角 | 已开启及当前生效说明 | 无新求解器；沿用主应用错误状态 | 按钮保留焦点 | 当前需求 / SkyAppearance |
| 完整星图 | `#sky-full-star-map` | 清旧模型数值 | 同页原理模式 | 污染未生效，设置保留 | 沿用主应用错误状态 | 按钮保留焦点 | 当前需求 |
| 星图深度 | range或“显示至10等” | 清旧模型数值 | 同页完整星图 | 当前星等与完整星图状态 | 忽略非有限或超出6.5–10的输入 | 原控件 | 既有暗空极限字段 / HYG星表 |
| 编辑光污染 / 月光 | range、预设、月光checkbox | 清旧模型数值 | 同页即时更新 | 当前值、开启状态、可见极限 | 忽略非有限或越界range值 | 原控件 | 既有环境字段与唯一模型 |
| 地面透明 | 唯一 `input[data-layer=terrain]` | 无额外科学请求 | 同页移除或恢复地面遮挡 | checkbox与独立口径说明 | 2D或外部视图不接受该动作 | 原控件 | terrain boolean / GraphicsStatus |

## Observable state contract

- “模拟肉眼星空”在3D中设 `viewMode=ground`、`presentation=observation`、`layers.atmosphere=true`，并将 `environment.darkSkyLimitingMagnitude` 恢复为6.5，避免扩展星图深度影响肉眼模型。2D实际是当地总览，因此设观察、大气和6.5等基准，不改保存的viewMode。
- “完整星图”只设 `presentation=explanation`，保留污染、月光、大气和视角。它取消肉眼衰减，不声称包含未收录的所有天体。
- 星图深度复用 `environment.darkSkyLimitingMagnitude`；范围输入以0.5等步长设置6.5–10等，按钮设10等，同时切换完整星图，使用既有presentation reason。HYG扩展用于寻星与构图，说明其不构成完备深空测光星表。
- 以上动作不更改UTC、地点、显示时区、四相机、密度、选择或播放速率。
- 人工亮度与月光沿用 `environment-appearance` reason；模式动作使用既有view/presentation reason，地形使用layers reason。不创建新时钟、星历请求、缓存格式或状态字段。
- 可见极限只显示主应用提供的SkyAppearance数值，完整星图模式隐藏此数值。改变时间/地点或显示方式后清除旧数值，等待共同的新结果。
- `terrain`原值true表示地面遮挡。唯一复选框checked表示“地面透明”，所以写入 `terrain=!checked`，同步同样反向；导入、预设、重置、API载入都走相同同步路径。
- 透明仅3D ground有效。2D禁用并明确不展示地平线下；外部视图隐藏该操作并保留原字段。`horizon`开关独立，不因透明而改变。
- 天体高度、当前地平上下、肉眼模型与升落事件都不因地面透明而重解释。

## Navigation, resilience and accessibility

非模态底部抽屉保留可辨天空及常驻播放/复位/搜索；不宣称focus trap或inert背景。新增details初始折叠，触发按钮为原生button；范围为原生range，命名预设作为非拖动替代。输入和按钮事件仍由控件容器隔离，不拖动天空。

选中对象与搜索草稿不因污染或透明动作清空。时间、地点和折射整表草稿沿用既有机制，不为此功能刷新。能力不可用用原生disabled及可见说明表达，不只靠灰色或hover。

## Verification

### 设备信息与日期选择（2026-10-28）

- 普通入口以设备当前时间、设备IANA时区（不可用时退回设备UTC偏移）初始化，1倍速且暂停，随后请求一次设备定位。教学预设工厂仍保持可重现的固定数据；含`#scene=`的分享入口不触发设备读取来覆盖场景。
- “此刻与当前位置”立即使用设备当前时间/时区，再请求单次位置；成功后再次取当前时刻并应用经纬度。“实时”使用设备时钟和时区，1倍速连续播放，但不请求定位或改地点。
- 使用浏览器位置授权，不调用IP定位或反向地理编码，不后台追踪，不自动持久化位置。用户主动保存、导出或分享场景仍按既有场景协议包含经纬度。
- 定位拒绝、超时、不支持均展示可恢复提示并保留原地点；时间仍可独立使用。未返回有效海拔时显式按0 m计算，不沿用杭州的20 m。精度来自设备报告，不作为实测保证。
- 手动编辑时间/地点草稿、切换预设、导入场景、改变时区或播放状态会使待返回定位失效；旧请求、已超时请求和卸载后的回调均不能覆盖较新操作。定位全程20秒上限，浏览器求解15秒上限。
- 公元1至4000年使用原生date，时刻使用原生time（含秒）；选择只改草稿，“应用时间”才转为UTC并暂停。浏览器/OS拥有弹层外观和语言。打开选择器即冻结整表草稿，播放更新不能覆盖未提交选择。
- “时区 / 纪年”中的天文纪年输入支持−2000至4000及0年；载入公元前场景自动启用。切回日历前必须提供有效正年份，不能静默清空公元前输入。IANA仍限1900–2100民用输入，其他年代用固定偏移；夏令时重叠/缺失校验沿用core。

### 精简文案与后果提示（2026-10-28）

- 补充说明统一通过 info 图标按需打开，不增加每区常驻教学文案；继续保留表单名称、单位、读数、能力限制和恢复提示。
- Tooltip 使用原生 button、可访问名称和 aria-describedby；悬停可移入提示，聚焦或触屏点击可打开，Escape只关闭提示并保留焦点。顶层定位随面板滚动更新，入口滚出可视区域或所属区块关闭后收起。
- 删除/覆盖本地场景前显示具体名称、影响和不可恢复后果，默认聚焦取消。确认后才修改存储；取消、Escape、修改选择或收起区块均不修改存储。覆盖使用请求确认时捕获的状态，避免运行中的时钟改变待保存内容。
- 确认操作与课程草稿替换沿用就地确认方式，不新增全站弹窗或通知系统。
- 本轮证据：`scripts/qa-ui-copy.mjs` 和 `docs/UI-COPY-REVIEW-20261028.md`。

### 课程与版本更新补充（2026-10-25）

- 版本区域明确当前页面运行的版本；检查成功不等同新版已完成下载或激活。只有完整下载后显示待重开提示。所有页面关闭前继续运行当前版本，保存入口帮助用户先保留场景。
- 课程标题、步骤和编辑草稿自动保存到此设备；刷新恢复编辑内容，但不自动开始课程播放。地景及方位/启用状态独立保存，课程临时使用的地景不得覆盖独立地景。
- 保存成功以存储事务完成为准；浏览器禁止存储、配额不足、损坏记录和跨页面冲突必须明确显示，保留当前可导出的内容，不静默覆盖他页的新记录。恢复和导入的迟到结果不得覆盖用户较新的操作。
- 课程包只保存一份可选地景，继续接受旧课程JSON。格式、大小和图像解码通过后才替换当前课程；失败保留原内容。退出课程恢复进入前的场景及地景。
- 本地保存不等同云端备份，便携文件和不同域名可能使用不同存储空间；导出课程/地景包作为迁移与备份方式。

前端文案以用户操作为准：控件名称、观测结果、简短帮助和可恢复的错误。开发诊断、科学验证进度、算法版本、模型原始notes不进入产品界面。详细科学与性能数据继续由skyApp开发接口提供；显示方式统一称为“肉眼星空 / 完整星图”。

文案修改需要执行typecheck、相关状态与平台测试、正式构建，并在浏览器检查桌面、窄屏、二维回退和离线入口。搜索清空按钮保留焦点；中文输入法组合期间不提前选择天体。错误保留输入，提示修正方法；导入错误不显示内部字段或异常堆栈。
