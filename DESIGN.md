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

肉眼星空入口置于视角设置之后、搜索之前，作为独立的原生 `details`，初始折叠。摘要直接显示“已开启 / 未生效”，打开后先显示“模拟肉眼星空 / 完整星图”，再显示参数与解释。地面透明仍属于显示图层，只保留一个地形复选框；长标签跨两列，不能挤入半列或产生水平溢出。

## Elevation & Depth

通过深浅表面、细边框和分隔线组织层级，不增加新阴影。科学口径、模型来源等长内容默认折叠。手机抽屉仍让天空露出，不因新增功能扩大整屏遮挡。

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

开启按钮、完整星图按钮和预设均复用现有 hover、键盘焦点与 `aria-pressed` 状态。禁用使用原生 `disabled`，并显示能力解释。范围输入保留原生键盘操作，显示当前值、0–1边界和定性含义；命名预设提供非拖动操作。

数值只来自共同的 SkyAppearance 模型。尚未取得新结果时显示“正在更新星空可见性…”，不保留上次条件下的数值。内容用“当前是否生效”回答用户问题，不用 profile、snapshot、schema 等实现术语。

视角短淡入沿用现有生命周期模块及动态 reduced-motion 处理；本次不增加动画。抽屉开闭不做尺寸动画。所有用户文本仍通过安全 DOM 属性或 `textContent` 展示。

## Do's and Don'ts

- 保留天空主导、现有密度、低圆角和单一滚动面板。
- 开启肉眼模拟时明确改变地表/观察/大气设置；完整星图明确忽略可见性并保留污染参数。
- 地面透明只移除示意遮挡，不能暗示地平下天体真实可见或改变升落预报。
- 不把定性污染值叫作实测 SQM、Bortle、天气或个人肉眼极限。
- 不为一个功能新增第二份科学状态、地形开关、通知系统或全局样式重构。

设计上下文由现有实现扫描建立。此前没有根 DESIGN.md；本次没有改变已接受的视觉规范。浏览器、触控与最终构建验收由本轮统一验证完成，此文件不作为其通过证明。
