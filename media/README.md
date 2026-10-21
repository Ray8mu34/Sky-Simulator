# 项目宣传资料

- `Sky-Simulator-Overview.pdf`：5页中文项目介绍，使用真实应用截图。
- `Sky-Simulator-Client-Review-Report.pdf`：28页A4纵向详细功能与甲方审查报告，报告日期2026年10月5日，产品版本v0.1.0公开预览版；含功能操作、21个教学预设索引、交付运行说明、验证边界及审查清单。原5页简介继续保留。
- `screenshots/`：6张1920×1080 PNG及场景来源说明。
- `capture-screenshots.mjs`：截图生成脚本；`../scripts/build-promo.mjs`：PDF生成脚本，使用本机Chrome和微软雅黑字体。
- `../scripts/build-client-report.py`：详细报告生成脚本，使用ReportLab及本机宋体、黑体；通过Codex工作区依赖提供的Python运行。报告仅整理已有功能和证据，不修改应用构建，不新增科学或性能验收结论。

截图和PDF中的第三方星表、星座资料与天文贴图遵循 `../assets/licenses/` 的许可和署名，不能因自有代码采用MIT而忽略这些条款。素材来自HYG、Stellarium及NASA相关公开产品；具体数据版本与转换在 `../assets/assets-manifest.json` 中记录。宣传图使用真实应用画面，没有生成或替换星图内容。

PDF排版使用本项目原创文字和样式。分发含CC BY-SA星表/星座改编展示内容时，遵守所附CC BY-SA 4.0及其署名要求。机构名称仅用于来源归属，不表示机构认可本项目。
