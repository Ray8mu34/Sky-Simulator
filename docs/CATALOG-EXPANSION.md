# 行星与Messier目录增量

## 可用入口

- 搜索“金星 / Venus / 启明星”“木星 / Jupiter”，选择后查看坐标、星等、角直径、照亮比例和本日升落；“定位”适用于四个三维视图。
- 搜索“M31 / M 31 / Messier31 / NGC 224 / 仙女座星系”。M1至M110全部可选择、定位、导出场景和分享。
- “五大行星”和“深空目录”分别控制两类图层。旧schema-1场景省略这两个字段时默认开启，新导出会保留显式开关。
- M1、M31、M42详情的“观测图像”可展开查看，Web与离线HTML均携带本地图像。
- 三维中的行星为星点，深空为分类目录符号；二维回退也支持新对象的显示与选择。

## 数据与构建

`assets/runtime/messier.json` 是已经生成的运行目录，常规构建不联网。
重新生成使用 `node scripts/build-messier.mjs`，输入为下载至 `tmp/opengnc.csv` 和 `tmp/opengnc-addendum.csv` 的OpenNGC CSV。
来源和哈希保存在 `assets/licenses/MESSIER-SOURCES.json`；图像见 `MESSIER-IMAGES.md`。署名自动进入Web credits和便携HTML。

## 验证

- 对象测试19项、科学测试193项、状态测试34项、数据测试20项通过。
- `node scripts/qa-catalog-expansion.mjs`：Chrome真实浏览器验证WebGL、强制Canvas2D、断网便携HTML的搜索与详情；五颗行星及M31的四视图定位；行星升落就绪；标准折射下原生点击行星；图层关闭/恢复；离线观测图像解码；390px手机布局无横向溢出。
- 浏览器结果与截图位于 `qa/catalog-expansion/`。
- 新行星升落测试验证五个目标的穿越方向、事件地平与彼此不同的时刻，属于内部一致性检查，不代替独立高精度星历认证。
