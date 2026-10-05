# Stellarium v24.4 skyculture data and Chinese names

Western/Modern line figures: Stellarium's team.
Chinese name mappings: Karrie Berglund of Digitalis Education Solutions (based on Hong Kong Space Museum star maps); Sun Shuwei (based primarily on Yi Shitong's Chinese and Western Contrast Star Chart and Catalogue 1950.0); Stellarium's team.
Chinese factual object labels cross-checked with matching v24.4 zh_CN localization: Stellarium's Chinese (China) translation team, including Fluorine Zhu, StarryNight268, Yang Zhou, Hongming Chu, Celestial Phineas, Yang Xiansheng, Cat Astro, Cardinot, Allen Zhong, Silas Wong, Freemanli and Sun Shuwei, as credited in the pinned upstream PO header.

All selected skyculture sources are fixed to **Stellarium v24.4**, commit **ab961cbde42eec8121be0df6ff48292f8d492b54**:
- https://github.com/Stellarium/stellarium/tree/ab961cbde42eec8121be0df6ff48292f8d492b54/skycultures/modern
- https://github.com/Stellarium/stellarium/tree/ab961cbde42eec8121be0df6ff48292f8d492b54/skycultures/chinese
- https://github.com/Stellarium/stellarium/blob/ab961cbde42eec8121be0df6ff48292f8d492b54/po/stellarium-skycultures/zh_CN.po

The selected `modern/info.ini` and `chinese/info.ini` explicitly state **CC BY-SA 4.0 International Public License**. The data adaptations retain that license. The Modern family also separately names the Free Art License for illustrations; no illustrations are included here.

Our adaptations are offered under CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/ (full license included). Application code licensing is separate. All data is provided as-is without warranties.

Changes: extract only the complete 88 Modern (Western) HIP line figures, flatten their 676 segments, compute normalized label anchors, and resolve 692 unique endpoints to the HYG star catalog. The selected naming data uses confirmed confidence-1 HIP mappings from the same release's Chinese `star_names.fab`; each factual Chinese object label is checked against the complete individual-star entry in that release's zh_CN table. Fuzzy/untranslated entries and uncertain confidence-2 mappings are skipped. No arbitrary group-to-star name assignment or Roman-name inference is used. Object names, not translated explanatory prose, are included. Every label's HIP, source line and translation key is retained in the evidence files. Lines are one cultural drawing convention, not IAU boundaries or the only official connection pattern.

The newer stellarium-skycultures snapshot was downloaded as a development reference, but it is not the selected line or naming source and is not distributed. Its description does not specify a version for CC BY-SA, which is why the explicitly versioned v24.4 data was selected. No Stellarium rendering engine, program code, full PO file, star-chart images, illustrations or IAU boundaries are included in these runtime assets.
