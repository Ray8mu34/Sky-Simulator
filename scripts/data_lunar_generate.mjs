/** Fixed local MIT generator, build time only; never import this in src. */
import { createRequire } from 'node:module';
import { writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
const require=createRequire(import.meta.url);
const { LunarYear, Solar }=require('../assets/source/lunar-typescript/package/dist/index.cjs');
const records=[];
for(let year=1900;year<=2101;year++) {
  for(const month of LunarYear.fromYear(year).getMonthsInYear()) {
    const solar=Solar.fromJulianDay(month.getFirstJulianDay());
    const iso=`${solar.getYear()}-${String(solar.getMonth()).padStart(2,'0')}-${String(solar.getDay()).padStart(2,'0')}`;
    records.push({civilDate:iso,civilDay:Date.UTC(solar.getYear(),solar.getMonth()-1,solar.getDay())/86400000,
      year:month.getYear(),month:Math.abs(month.getMonth()),isLeapMonth:month.isLeap(),monthLengthDays:month.getDayCount()});
  }
}
records.sort((a,b)=>a.civilDay-b.civilDay);
for(let i=1;i<records.length;i++) {
  if(records[i].civilDay-records[i-1].civilDay!==records[i-1].monthLengthDays) throw Error('Noncontiguous generator months');
}
const target=resolve('assets/source/lunar-typescript/generated-months.json');
writeFileSync(target+'.tmp',JSON.stringify({generator:'lunar-typescript@1.8.6',months:records})+'\n');
renameSync(target+'.tmp',target);
console.log(`${records.length} contiguous lunar months generated from exact local 1.8.6 package.`);
