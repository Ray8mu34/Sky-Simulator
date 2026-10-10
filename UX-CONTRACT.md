# 夜空工具交互契约

## Product context

中文天文教学与天空探索工具；主任务是在同一时刻、地点下切视角、比较科学读数与显示效果。视觉规范见 [DESIGN.md](DESIGN.md)。运行时样式为规范源，原生控件负责键盘语义与平台弹出行为，手机主要操作目标为44px。WCAG 2.2 AA是目标，不将静态审计解释为完整认证。

时间显示使用场景的 displayZone，农历独立使用UTC+8；地点与时区独立。不存在账户权限、收费、服务端同步或本轮新增外部副作用。

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| 可见性与地形显示 | 本次用户明确要求；`src/contracts.ts` | 当前需求 / 状态契约 | 2026-10-10 |
| 科学模型边界 | `docs/SCIENCE-MODEL.md`；`src/core/sky-appearance.ts` | 维护文档 / 唯一模型API | 2026-10-10 |
| 显示后端能力 | `src/platform/renderer-port.ts` | GraphicsStatus能力契约 | 2026-10-10 |
| 本地保存与分享 | `src/platform/scene-library.ts`；`src/ui/scene-controls.ts` | 现有数据与交互接口 | 2026-10-10 |
| 视觉与响应式 | `src/style.css`；本轮保持既有视觉的明确要求 | 运行时规范 / 当前需求 | 2026-10-10 |

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | 控件模块中的原生select | 状态值与对应模块 | native：接受平台弹出层；搜索使用现有结果列表 | 既有浏览器QA，本轮未新增select |
| Date | `src/ui/time-controls.ts` | core时间API与displayZone | typed：显式应用，整表草稿 | 既有时间与草稿QA，本轮不改 |
| Form | `src/ui/form-draft.ts`和各模块提交校验 | `src/state.ts`及core输入校验 | 显式应用；失败保留草稿 | 既有草稿QA；历史静态差异不以本文件豁免 |
| Scrollbar | `src/style.css`的既有滚动区域 | 运行时CSS | 面板及有界列表独立滚动 | 本轮不改滚动规范；全局基线缺口另记 |
| Toast | `controls.ts`中的message | 同一role=status区域 | 正常短反馈 / 持续错误 | 既有反馈；本轮状态说明使用同区局部文本 |
| CRUD | `scene-controls.ts` + sceneLibrary | 本地库单一格式与完整状态 | 显式保存 / 覆盖 / 删除 / 载入 | 既有场景库QA，本轮不改 |

新增能力不创建重复实现：肉眼模拟与污染编辑由 `appearance-controls.ts` 唯一拥有；地形复选框由 `controls.ts` 的图层定义、同步与change处理唯一拥有。

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| 模拟肉眼星空 | `#sky-observe-appearance` | 清旧模型数值 | 同一页面，3D切地表；2D保留已保存视角 | 已开启及当前生效说明 | 无新求解器；沿用主应用错误状态 | 按钮保留焦点 | 当前需求 / SkyAppearance |
| 完整星图 | `#sky-full-star-map` | 清旧模型数值 | 同页原理模式 | 污染未生效，设置保留 | 沿用主应用错误状态 | 按钮保留焦点 | 当前需求 |
| 编辑人工亮度 / 月光 | range、预设、月光checkbox | 清旧模型数值 | 同页即时更新 | 当前值、当前是否生效、模型星限 | 忽略非有限或越界range值 | 原控件 | 既有环境字段与唯一模型 |
| 地面透明 | 唯一 `input[data-layer=terrain]` | 无额外科学请求 | 同页移除或恢复地面遮挡 | checkbox与独立口径说明 | 2D或外部视图不接受该动作 | 原控件 | terrain boolean / GraphicsStatus |

## Observable state contract

- “模拟肉眼星空”在3D中只设 `viewMode=ground`、`presentation=observation`、`layers.atmosphere=true`。2D实际是当地总览，因此只设观察与大气，不改保存的viewMode。
- “完整星图”只设 `presentation=explanation`，保留污染、月光、大气和视角。它取消肉眼衰减，不声称包含未收录的所有天体。
- 以上动作不更改UTC、地点、显示时区、四相机、密度、选择或播放速率。
- 人工亮度与月光沿用 `environment-appearance` reason；模式动作使用既有view/presentation reason，地形使用layers reason。不创建新时钟、星历请求、缓存格式或状态字段。
- 星限、银河对比与底亮只显示主应用提供的SkyAppearance数值。改变时间/地点或显示口径后清除旧模型数值，等待共同的新结果。
- `terrain`原值true表示地面遮挡。唯一复选框checked表示“地面透明”，所以写入 `terrain=!checked`，同步同样反向；导入、预设、重置、API载入都走相同同步路径。
- 透明仅3D ground有效。2D禁用并明确不展示地平线下；外部视图隐藏该操作并保留原字段。`horizon`开关独立，不因透明而改变。
- 天体高度、当前地平上下、肉眼模型与升落事件都不因地面透明而重解释。

## Navigation, resilience and accessibility

非模态底部抽屉保留可辨天空及常驻播放/复位/搜索；不宣称focus trap或inert背景。新增details初始折叠，触发按钮为原生button；范围为原生range，命名预设作为非拖动替代。输入和按钮事件仍由控件容器隔离，不拖动天空。

选中对象与搜索草稿不因污染或透明动作清空。时间、地点和折射整表草稿沿用既有机制，不为此功能刷新。能力不可用用原生disabled及可见说明表达，不只靠灰色或hover。

## Verification

本轮限定只改两个UI模块、局部CSS与设计上下文；不改schema、科学/渲染/主时钟，不build或部署，不启动浏览器或大测试。先执行typecheck、premium静态审计与官方DESIGN lint；原始输出保存在 `_local-archive/sky-visibility-20261010`。静态审计中的既有页面缺口如不属于此改动则如实保留，不扩范围修复或改契约掩盖。后续由root统一验证真实3D/2D与窄屏入口及状态保持。
