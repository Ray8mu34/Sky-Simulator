import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const paths=['tmp/chinese-lines.txt','tmp/chinese-names.txt','tmp/boundaries.txt','assets/source/stellarium244/po/stellarium-skycultures/zh_CN.po'];
const [lines,names,boundaries,po]=await Promise.all(paths.map(p=>readFile(p,'utf8')));
const translations=new Map([...po.matchAll(/msgid "([^"\n]+)"\r?\nmsgstr "([^"\n]+)"/g)].map(m=>[m[1],m[2]]));
const labels=new Map([...names.matchAll(/^(\d+)\s+"[^"]*"\s+_\("([^"]+)"\)/gm)].map(m=>[m[1],{english:m[2],name:translations.get(m[2])||m[2]}]));
const stars=JSON.parse(await readFile('assets/runtime/star-meta.json','utf8'));
const hips=new Map(stars.filter(s=>s[2]).map(s=>[s[2],s]));
const raw=await readFile('assets/source/hyg/hyg/CURRENT/hygdata_v41.csv','utf8');
function csv(line){return [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map(m=>m[1].replace(/^"|"$/g,'').replaceAll('""','"'));}
const [header,...records]=raw.trim().split(/\r?\n/),fields=csv(header);
for(const line of records){const row=csv(line),hip=Number(row[fields.indexOf('hip')]);if(hip&&!hips.has(hip))hips.set(hip,[`hip:${hip}`,null,hip,Number(row[fields.indexOf('ra')]),Number(row[fields.indexOf('dec')])]);}
let missing=0;const missingPairs=[];
const figures=lines.trim().split(/\r?\n/).filter(l=>/^\d/.test(l)).map(line=>{
  const [id,count,...ids]=line.trim().split(/\s+/); const pairs=[];
  for(let i=0;i<Number(count)*2;i+=2){const a=hips.get(Number(ids[i])),b=hips.get(Number(ids[i+1]));if(a&&b)pairs.push([[a[3],a[4]],[b[3],b[4]]]);else {missing++;missingPairs.push({figure:id,hip:[Number(ids[i]),Number(ids[i+1])]});}}
  return {id,...labels.get(id),pairs};
});
const tokens=boundaries.trim().split(/\s+/), arcs=[];let i=0;
while(i<tokens.length){const n=Number(tokens[i++]);if(!Number.isInteger(n)||n<2)throw Error('Invalid boundary');const points=[];for(let j=0;j<n;j++)points.push([Number(tokens[i++]),Number(tokens[i++])]);const k=Number(tokens[i++]);arcs.push({points,regions:tokens.slice(i,i+k)});i+=k;}
await writeFile('assets/runtime/chinese-sky.json',JSON.stringify(figures)+'\n');
await writeFile('assets/runtime/iau-boundaries.json',JSON.stringify(arcs)+'\n');
await writeFile('assets/licenses/SKY-CULTURE-SOURCES.json',JSON.stringify({source:'Stellarium v24.4',url:'https://github.com/Stellarium/stellarium/tree/v24.4',license:'CC-BY-SA-4.0',credit:'Karrie Berglund (Digitalis Education Solutions); Sun Shuwei; Stellarium contributors and Chinese translators; HYG 4.1 David Nash / Astronexus',modifications:'Chinese line endpoints matched to full HYG4.1 HIP catalogue at fixed J2000; boundary J2000 RA(hours)/Dec(degrees) preserved; Chinese PO translations. Six upstream figures have zero line segments and are not drawn.',figures:figures.length,drawnFigures:figures.filter(f=>f.pairs.length).length,missingSegments:missing,missingPairs,boundaryArcs:arcs.length,files:[...paths.map((path,index)=>({path,sha256:createHash('sha256').update([lines,names,boundaries,po][index]).digest('hex')})),{path:'assets/source/hyg/hyg/CURRENT/hygdata_v41.csv',sha256:createHash('sha256').update(raw).digest('hex')}]},null,2));
console.log({figures:figures.length,missingSegments:missing,boundaryArcs:arcs.length});
