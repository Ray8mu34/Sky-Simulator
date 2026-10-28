---
version: alpha
name: 三维全景夜空
description: 让天空占据主画面，用紧凑深色教学面板比较同一时刻与地点的天象。
colors:
  primary: "#839dab"
  background: "#020407"
  text: "#e7e5dc"
  control: "#121d26"
  border: "#2d3b45"
  secondary: "#97a3ac"
  focus: "#a8bcc7"
  selected: "#273943"
  caution: "#c6b38d"
  error: "#e4a498"
typography:
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "13px"
  reference:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "11px"
  touch:
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14px"
rounded:
  control: "3px"
  panel: "5px"
spacing:
  panel-padding: "10px"
  control-gap: "4px"
components:
  button:
    backgroundColor: "#121d26"
    textColor: "#e7e5dc"
    rounded: "3px"
  panel:
    rounded: "5px"
---

# 三维全景夜空设计上下文

## Overview

这是面向中文天文教学与自主探索的工具界面，沿用用户已接受的紧凑深色面板。物理参照是夜间观测仪器：天空是主体，设置和坐标读数是安静的辅助。不能把这一功能增量变成营销首页或重新设计仪表盘。

主要使用场景是桌面演示与手机临时查看。特色是同一科学时刻、地点下的四种视角，以及始终可以辨认的暂停状态与几何/视高度读数。表达力集中在真实天空，界面不增加装饰渐变、大卡片、品牌动画或新字体下载。语言为简体中文；当前没有日本市场或日文界面要求。

本文件采用“既有运行时为规范源”的映射方式。`src/style.css` 的声明拥有颜色、尺寸和断点；这里记录其接受值与意图，不生成第二套主题。此次仅增加局部布局类，没有更改全局色彩、字体、面板宽度或密度。

## Colors

黑色 `background` 留给天空，`control` 与透明深色面板区分交互表面。`text` 用于主标签；`secondary` 用于说明和坐标标题。`border` 区分控件边界，`focus` 保留键盘焦点。`selected` 表示按下或当前模式；`caution` 表示科学/能力边界，`error` 表示需要修正的输入。状态必须带文字，不能只用颜色。

面板现有背景为 `rgb(11 18 25 / 94%)`，不用新增不透明整屏遮罩。当前只提供深色主题；不声称已完成高对比度或所有辅助技术验证。

## Typography

保留 Segoe UI 与 Microsoft YaHei 本机字族，标题、正文和读数共用这一字族，以重量、字号和数字等宽特性区分角色。面板标题使用 600，普通标签与说明保持既有层级；坐标、时间和模型数值使用 `font-variant-numeric: tabular-nums`，不换成装饰字体。参考密度 11px、教学密度 13px、触控密度 14px 是现有产品约定。

## Layout

桌面左侧面板：教学 248px，参考 186px；内部 `.panel-scroll` 为单一设置滚动区。窄屏 `max-width: 640px` 或触控短横屏 `pointer: coarse and max-height: 600px` 使用底部非模态抽屉，手机主要操作保持 44px。紧凑时钟、播放、复位、视角和搜索常驻；透明的控件容器不阻挡天空。

星空显示入口置于视角设置之后、搜索之前，作为独立的原生 `details`，初始折叠。摘要显示当前“肉眼星空 / 完整星图 / 未开启”，打开后先显示“模拟肉眼星空 / 完整星图”，随后是星图深度、光污染强度和月光设置。星图深度沿用现有范围输入与数值输出，提供“显示至10等”按钮；默认6.5等保持原观感。地面透明仍属于显示图层，只保留一个地形复选框。

## Elevation & Depth

通过深浅表面、细边框和分隔线组织层级，不增加新阴影。操作与天文概念的简短帮助默认折叠。手机抽屉仍让天空露出，不因新增功能扩大整屏遮挡。

## Shapes

控件 3px、面板 5px 圆角保留现状。模式按钮为矩形按钮，预设沿用三列按钮；不引入胶囊、图标卡片或另一种复选框样式。

## Components

| 文档角色 | 运行时源 / 消费者 |
|---|---|
| 背景、文本与字族 | `src/style.css` 的 `:root` |
| 控件底色、边框、3px圆角 | `button, select, input` 与共享 hover / focus-visible / aria-pressed 样式 |
| 面板密度与尺寸 | `--panel-width`, `--panel-pad`, `--control-font`, `--control-height` |
| 触控目标与底部抽屉 | 同文件的手机/短横屏 media query |
| 模式、范围、预设 | `src/ui/appearance-controls.ts`，原生 button / range / details |
| 地面透明 | `src/ui/controls.ts` 唯一 `data-layer="terrain"` 复选框，局部 `.layer-toggle-wide` |
| 版本与离线 | `src/ui/offline-controls.ts` 展示 `platform/offline` 的唯一状态；版本号来自构建时的 `package.json` |
| 课程与地景保存 | `src/ui/course-equipment-controls.ts` 的原生details、按钮及局部持久状态文字 |
| 补充说明 | `src/ui/info-tip.ts` 的共享信息按钮与 tooltip；`src/style.css` 的 `.info-tip-*` |

开启按钮、完整星图按钮和预设均复用现有 hover、键盘焦点与 `aria-pressed` 状态。禁用使用原生 `disabled`，并显示能力解释。范围输入保留原生键盘操作，显示当前值、0–1边界和定性含义；命名预设提供非拖动操作。

肉眼模拟开启时显示 SkyAppearance 提供的可见极限，更新时清空旧数值。银河对比度、底亮参数、性能数据和科学核查记录留在开发诊断中。产品文案用于命名操作、呈现结果和指导错误恢复；不向页面转发模型 notes 或验证声明。版本与离线区域显示当前版本及构建标识，帮助用户辨别缓存是否更新；完整标识收在详情中。

课程与地景的保存状态留在所属区块，明确区分“正在保存”“已保存在此设备”和失败。全站更新提示沿用唯一的非模态离线提示，不覆盖主操作、不抢夺焦点、不自动刷新教学页面。新增区域沿用同一字族、颜色和密度，不改变天空主导的布局。

视角短淡入沿用现有生命周期模块及动态 reduced-motion 处理；本次不增加动画。抽屉开闭不做尺寸动画。所有用户文本仍通过安全 DOM 属性或 `textContent` 展示。

## Do's and Don'ts

- 前端文案遵循项目 [AGENTS.md](AGENTS.md)：先删冗余说明，再以布局、分组和清楚的操作名称补足理解。默认不加口号、教学段落或每区帮助文案。
- 必要的格式、概念说明使用信息图标与按需 tooltip。复用现有深色控件底色、边框和3px圆角；提示在顶层显示，避开滚动容器裁切。桌面入口至少24px，窄屏沿用44px触控目标；键盘焦点、悬停和点击均可打开，Escape关闭并保留焦点。
- 表单标签、单位、有效状态、错误恢复及科学口径保留。删除和覆盖本地场景使用就地后果提示与明确确认按钮，初始焦点放在取消；不可把后果藏进 tooltip。
- 用简短、直接的成品文案。删除自我辩护、开发阶段、验收进度和重复免责声明；必要的科学含义写成按需查看的简短帮助。
- 正常状态保持安静，加载时说明正在做什么，失败时给出恢复方法。完整错误保留在控制台及开发接口。
- 保留天空主导、现有密度、低圆角和单一滚动面板。
- 开启肉眼模拟时明确改变地表/观察/大气设置；完整星图明确忽略可见性并保留污染参数。
- 地面透明只移除示意遮挡，不能暗示地平下天体真实可见或改变升落预报。
- 不把定性污染值叫作实测 SQM、Bortle、天气或个人肉眼极限。
- 不为一个功能新增第二份科学状态、地形开关、通知系统或全局样式重构。

设计上下文由现有实现扫描建立。此前没有根 DESIGN.md；本次没有改变已接受的视觉规范。浏览器、触控与最终构建验收由本轮统一验证完成，此文件不作为其通过证明。
