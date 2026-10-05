# Compact lunar civil calendar

Generator: lunar-typescript1.8.6 by6tail, MIT, exact Git commit a376ec2b8fd1b3069e24c92801bab8707fccd49d. https://github.com/6tail/lunar-typescript
The exact npm source package and upstream MIT license are hash-locked. The generator runs only at build time; no lunar-typescript code or dependency is imported by the browser. The compact table covers Gregorian1901-01-01 through2100-12-31 in UTC+08:00, including the first day's lunar1900 month and an exclusive terminal sentinel in2101.

HKO independent audit checked73,049 civil days. The fixed generator disagrees with the fixed HKO table on30 days,2057-09-28 through2057-10-27. The generator convention is retained, and every difference is recorded. All dates in2057,2089,2097 are marked uncertain because HKO explicitly warns the corresponding new moons may fall on an adjacent civil date. HKO raw and derived comparison rows remain QA sources only, outside the runtime releases. See HKO-QA-NOTICE.md for their separate conditions. No claim is made that a computed future civil lunar date is a measured new-moon instant, or that the HKO warnings affect the independent lunar phase/ephemeris model.

The included LUNAR-TYPESCRIPT-MIT.txt preserves the complete generator license notice.
