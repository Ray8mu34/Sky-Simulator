// Rebuild from downloaded OpenNGC CSVs; no network access during ordinary builds.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files = ['tmp/opengnc.csv', 'tmp/opengnc-addendum.csv'];
const sources = await Promise.all(files.map(path => readFile(path, 'utf8')));
const rows = sources.flatMap(text => {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const fields = header.split(';');
  return lines.map(line => Object.fromEntries(line.split(';').map((value, index) => [fields[index], value])));
});
const names = { 1:'蟹状星云', 6:'蝴蝶星团', 7:'托勒密星团', 8:'礁湖星云', 11:'野鸭星团', 13:'武仙座球状星团', 16:'鹰状星云', 17:'天鹅星云', 20:'三裂星云', 24:'人马座恒星云', 27:'哑铃星云', 31:'仙女座星系', 33:'三角座星系', 40:'温尼克4双星', 42:'猎户座大星云', 43:'德梅兰星云', 44:'蜂巢星团', 45:'昴星团', 51:'涡状星系', 57:'环状星云', 63:'向日葵星系', 64:'黑眼星系', 73:'宝瓶座四星星群', 76:'小哑铃星云', 81:'波德星系', 82:'雪茄星系', 83:'南风车星系', 97:'猫头鹰星云', 101:'风车星系', 102:'纺锤星系', 104:'草帽星系' };
const sexagesimal = value => { const [a,b,c] = value.replace(/^[+-]/, '').split(':').map(Number); return (a+b/60+c/3600)*(value.startsWith('-')?-1:1); };
const numeric = value => value?.trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const selected = rows.filter(row => row.M && row.Type !== 'Dup');
const m102 = rows.find(row => row.Name === 'NGC5866');
if (!m102) throw new Error('Missing NGC5866');
selected.push({ ...m102, M:'102' });
const objects = selected.map(row => {
  const number = Number(row.M);
  return { number, catalogName: row.Name.replace(/^(NGC|IC)0*(\d+)/, '$1 $2'), type: row.Type,
    raHours: sexagesimal(row.RA), decDeg: sexagesimal(row.Dec), magnitude: numeric(row['V-Mag']),
    majorArcmin: numeric(row.MajAx), minorArcmin: numeric(row.MinAx), positionAngleDeg: numeric(row.PosAng),
    nameZh: names[number] ?? '', aliases: (row['Common names'] ?? '').split(',').filter(Boolean),
    note: number === 102 ? 'M102采用常见的NGC 5866对应；历史身份存在争议。' : number === 40 ? 'M40是双星，保留其Messier历史编号。' : number === 73 ? 'M73是视线方向上的星群，不是物理星团。' : '',
  };
}).sort((a,b)=>a.number-b.number);
if (objects.length !== 110 || objects.some((object,index)=>object.number!==index+1)) throw new Error('Messier coverage must be exactly 1..110');
await writeFile('assets/runtime/messier.json', JSON.stringify(objects, null, 2)+'\n');
await writeFile('assets/licenses/MESSIER-SOURCES.json', JSON.stringify({
  source:'OpenNGC', author:'Mattia Verga and contributors', url:'https://github.com/mattiaverga/OpenNGC',
  license:'CC-BY-SA-4.0', licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',
  retrieved:'2026-10-21', modifications:'Messier subset; M102 = NGC5866 (disputed identification); decimal J2000 coordinates; Chinese names; preserve null V magnitudes and angular sizes.',
  files:files.map((path,index)=>({path,sha256:createHash('sha256').update(sources[index]).digest('hex')})),
  upstreamAcknowledgments:'NASA/IPAC Extragalactic Database (NED); HyperLEDA; SIMBAD (CDS, Strasbourg); HEASARC; Harold Corwin NGC/IC positions and notes.',
},null,2)+'\n');
console.log(`Generated ${objects.length} Messier records`);
