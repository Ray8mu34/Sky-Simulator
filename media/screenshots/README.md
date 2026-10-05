# 应用宣传截图

六张 1920×1080 PNG 均直接截取真实冻结版应用：build `2966df95ea4fbc32`，模块 `index-DrZppIQ6.js`（SHA256 `ea9a85063d60ea6c8cc01bd8b3d915f63957a2e8acb81a5e633cb753889bef26`）。没有后期合成、调亮或伪造界面；地表与地平天球保留完整侧栏，其余通过原生按钮收起侧栏。浏览器和 context 在拍摄后全部关闭。

| 文件 | 场景与口径 |
| --- | --- |
| [overview-ground.png](overview-ground.png) | 地表北天总览；杭州，2026-09-14 22:00（UTC+8）。原理模式，展示北极星、中文星名、星座连线与低矮示意地景；保留操作 UI。 |
| [overview-earth.png](overview-earth.png) | 太空视图，同一时刻；静态地球日景、云层、薄大气及背光区域城市夜灯。原生收起侧栏，采用既有 V02 相机配置。 |
| [overview-celestial.png](overview-celestial.png) | 天球视图，同一时刻；星座、银河、黄道与天赤道在有限方向球壳上的关系。采用既有 V03 相机配置；这是几何方向示意。 |
| [overview-horizon.png](overview-horizon.png) | 地平天球，同一时刻；地平参考锁定，显示当地水平面、子午方向与天赤道；保留操作 UI。 |
| [feature-moon.png](feature-moon.png) | 杭州，2026-03-25 21:00:16（UTC+8），站心月面照亮约 46.6%，月球几何高度约 48.9°。**主月盘为应用内 20× 教学放大，非真实角径**；右下科学放大镜共享同一快照、真实姿态与太阳照明。此图使用原理模式并关闭大气、地景。 |
| [feature-milky-way.png](feature-milky-way.png) | 银河教学 G01：杭州，2026-08-14 22:00（UTC+8），观察模式、低人工光污染。为突出真实银河层而关闭星名和连线；银河对比度属于定性视觉模型。 |

地球、云层、月面和分离银河素材来自项目已归档的 NASA 静态资源；恒星目录和星座数据沿用当前应用资源。具体素材来源与许可见[素材说明](../../docs/ASSETS.md)，截图不代表实时云图、实拍天空或绝对光度测量。

[capture-manifest.json](capture-manifest.json) 保存实际场景 JSON、UTC、截图 SHA256 和版本身份，可用于复现。拍摄脚本为 [`../capture-screenshots.mjs`](../capture-screenshots.mjs)，只加载既有场景/分享 JSON 并操作原生控件，不修改产品代码。原有 QA 证据全部保留；此次没有新增验收矩阵或运行性能测试。
