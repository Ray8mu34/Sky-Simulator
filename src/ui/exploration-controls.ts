import { infoTip } from './info-tip';
import type {SimulationState} from '../contracts';
import {catalog} from '../data/catalog';
import {altitudeCurve} from '../core/observation-tools';
import {eclipseDiscs,searchEclipse} from '../core/eclipse-tools';
import type {EclipseResult} from '../core/eclipse-tools';
import {formatCivil,localDayBounds,localCivilParts} from '../core/time';

export function mountExplorationControls(parent:HTMLElement,state:SimulationState,onChange:(reason:string)=>void){
  const root=document.createElement('details');root.className='control-section exploration-section';
  root.innerHTML=`<summary>观测曲线 / 日月食</summary><details class="altitude-tools"><summary>所选目标 · 本日高度</summary><p class="curve-title tiny-note"></p><svg class="altitude-chart" viewBox="0 0 220 130" role="img" aria-label="所选目标的本日几何高度曲线"></svg><p class="curve-summary tiny-note"></p><button type="button" data-explore="csv">导出曲线 CSV</button>${infoTip('sky-altitude-chart-help', '高度曲线图例', '曲线覆盖当地民用日，时间由左向右。虚线为地平线，暗底表示太阳低于−18°。')}</details><details class="eclipse-tools"><summary>日月食搜索与模拟</summary><div class="event-grid"><button type="button" data-explore="solar-local">下次当地日食</button><button type="button" data-explore="solar-global">下次全球日食</button><button type="button" data-explore="lunar">下次月食</button></div><p class="eclipse-status tiny-note" role="status"></p><div class="eclipse-contacts event-grid"></div><label>盘面模拟 <select class="eclipse-type"><option value="solar">日食 · 当地站心</option><option value="lunar">月食 · 地影</option></select></label><canvas class="eclipse-canvas" width="440" height="300" role="img" aria-label="当前时刻日月食盘面模拟"></canvas><p class="eclipse-caption tiny-note"></p><p class="tiny-note">全球事件不代表当前地点可见。</p>${infoTip('sky-eclipse-model-help', '日月食盘面说明', '盘面使用同一角比例；月食阴影采用球形地球近似，颜色仅作示意。')}</details>`;
  parent.append(root);
  const q=<T extends HTMLElement>(s:string)=>root.querySelector<T>(s)!;
  let curveKey='',curve:ReturnType<typeof altitudeCurve>=[],event:EclipseResult|null=null,eventContext='',busy=false,disposed=false;
  const context=()=>JSON.stringify([state.observer.latitudeDeg,state.observer.longitudeDegEast,state.observer.heightMeters,state.observer.displayZone]);
  const renderCurve=()=>{
    if(!q<HTMLDetailsElement>('.altitude-tools').open)return;
    const bounds=localDayBounds(state.time.utDaysJ2000,state.observer.displayZone);
    const key=JSON.stringify([state.selected,bounds.startUt,bounds.endUt,context()]);if(key===curveKey)return;curveKey=key;
    curve=altitudeCurve(catalog,state);const svg=q<SVGElement & HTMLElement>('.altitude-chart');svg.replaceChildren();
    const add=(tag:string,attrs:Record<string,string>,text?:string)=>{const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))el.setAttribute(k,v);if(text)el.textContent=text;svg.append(el);};
    q('.curve-title').textContent=state.selected?`${state.selected} · ${bounds.dateLocal}`:'先搜索并选择一个天体。';
    if(!curve.length){q('.curve-summary').textContent='请选择恒星、行星、日月或Messier目标。';return;}
    const x=(ut:number)=>25+190*(ut-bounds.startUt)/(bounds.endUt-bounds.startUt),y=(alt:number)=>110-(alt+90)*100/180;
    for(let i=0;i<curve.length-1;i++)if(curve[i]!.sunAltitude< -18)add('rect',{x:String(x(curve[i]!.ut)),y:'10',width:String(x(curve[i+1]!.ut)-x(curve[i]!.ut)+.3),height:'100',fill:'#05090d'});
    for(const alt of [-90,0,90]){add('line',{x1:'25',x2:'215',y1:String(y(alt)),y2:String(y(alt)),stroke:'#52616c','stroke-dasharray':alt===0?'3 3':'1 0'});add('text',{x:'0',y:String(y(alt)+3),fill:'#97a3ac','font-size':'9'},`${alt}°`);}
    add('polyline',{points:curve.map(p=>`${x(p.ut)},${y(p.altitude)}`).join(' '),fill:'none',stroke:'#a8bcc7','stroke-width':'1.5'});
    add('text',{x:'25',y:'125',fill:'#97a3ac','font-size':'9'},'日始');add('text',{x:'190',y:'125',fill:'#97a3ac','font-size':'9'},'次日始');
    for(const fraction of [.25,.5,.75]){const ut=bounds.startUt+(bounds.endUt-bounds.startUt)*fraction,civil=localCivilParts(ut,state.observer.displayZone);add('text',{x:String(x(ut)-10),y:'125',fill:'#97a3ac','font-size':'9'},`${String(civil.hour).padStart(2,'0')}:${String(civil.minute).padStart(2,'0')}`);}
    const highest=curve.reduce((a,b)=>a.altitude>b.altitude?a:b),dark=curve.filter(p=>p.altitude>=20&&p.sunAltitude<=-18);
    q('.curve-summary').textContent=`采样最高 ${highest.altitude.toFixed(1)}° · ${formatCivil(highest.ut,state.observer.displayZone)}${dark.length?`；深夜且高度≥20°的采样点 ${dark.length} 个`:'；本日无深夜且高度≥20°的采样点'}。`;
  };
  const drawEclipse=()=>{
    if(!q<HTMLDetailsElement>('.eclipse-tools').open)return;
    const type=q<HTMLSelectElement>('.eclipse-type').value as 'solar'|'lunar',d=eclipseDiscs(state,type);
    const canvas=q<HTMLCanvasElement>('.eclipse-canvas'),ctx=canvas.getContext('2d')!;ctx.clearRect(0,0,440,300);ctx.fillStyle='#020407';ctx.fillRect(0,0,440,300);
    const scale=110/Math.max(d.targetRadius,type==='lunar'?d.penumbraRadius:0),cx=220,cy=150;
    ctx.fillStyle=type==='solar'?'#f5d58e':'#d3d1c7';ctx.beginPath();ctx.arc(cx,cy,d.targetRadius*scale,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.beginPath();ctx.arc(cx,cy,d.targetRadius*scale,0,Math.PI*2);ctx.clip();
    if(type==='lunar'){ctx.fillStyle='rgba(50,35,30,.35)';ctx.beginPath();ctx.arc(cx-d.x*scale,cy-d.y*scale,d.penumbraRadius*scale,0,Math.PI*2);ctx.fill();}
    ctx.fillStyle=type==='solar'?'#020407':'#482b25';ctx.beginPath();ctx.arc(cx-d.x*scale,cy-d.y*scale,Math.max(0,d.occulterRadius)*scale,0,Math.PI*2);ctx.fill();ctx.restore();
    q('.eclipse-caption').textContent=`${formatCivil(state.time.utDaysJ2000,state.observer.displayZone)} · ${Math.hypot(d.x,d.y)<d.targetRadius+Math.max(d.occulterRadius,d.penumbraRadius)?'盘面相交':'当前无盘面相交'} · 当地几何高度 ${d.altitude.toFixed(1)}°${d.altitude<0?'（地平线下）':''} · 上北左东`;
  };
  const update=()=>{if(disposed||!root.open)return;try{renderCurve();drawEclipse();if(event&&eventContext!==context()){event=null;q('.eclipse-contacts').replaceChildren();q('.eclipse-status').textContent='地点或时区已改变，请重新搜索。';}}catch(error){q('.eclipse-status').textContent=error instanceof Error?error.message:String(error);}};
  const click=async(e:Event)=>{
    const button=(e.target as Element).closest<HTMLButtonElement>('button');if(!button)return;
    if(button.dataset.ut){const ut=Number(button.dataset.ut);if(state.observer.displayZone.kind==='iana'){const year=localCivilParts(ut,state.observer.displayZone).year;if(year<1900||year>2100){q('.eclipse-status').textContent='此事件超出IANA时区范围，请先改为固定UTC偏移。';return;}}state.time.utDaysJ2000=ut;state.time.running=false;state.time.mode='simulation';onChange('time-event');update();return;}
    const action=button.dataset.explore;if(!action)return;
    if(action==='csv'){renderCurve();if(!curve.length)return;const url=URL.createObjectURL(new Blob(['UTC,geometric_altitude_deg,sun_geometric_altitude_deg\n'+curve.map(p=>`${new Date((p.ut+2451545-2440587.5)*86400000).toISOString()},${p.altitude},${p.sunAltitude}`).join('\n')],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='altitude.csv';a.click();URL.revokeObjectURL(url);return;}
    if(busy)return;busy=true;q('.eclipse-status').textContent='正在搜索…';const captured=structuredClone(state),signature=context();
    await new Promise<void>(resolve=>setTimeout(resolve,0));
    try{
      const result=searchEclipse(captured,action==='lunar'?'lunar':'solar',action!=='solar-global');if(disposed)return;
      if(signature!==context()||captured.time.utDaysJ2000!==state.time.utDaysJ2000)throw Error('时间或地点已改变，请重新搜索。');
      event=result;eventContext=signature;q<HTMLSelectElement>('.eclipse-type').value=result.type;
      q('.eclipse-status').textContent=`${result.kind} · 食甚 ${formatCivil(result.peak,state.observer.displayZone)} · 遮蔽 ${(result.obscuration*100).toFixed(1)}%`;
      q('.eclipse-contacts').replaceChildren();for(const contact of result.contacts){const b=document.createElement('button');b.type='button';b.textContent=contact.label;b.title=formatCivil(contact.ut,state.observer.displayZone);b.dataset.ut=String(contact.ut);q('.eclipse-contacts').append(b);}
      if(result.latitude!==undefined&&result.longitude!==undefined){const b=document.createElement('button');b.type='button';b.textContent='前往食甚地点';b.onclick=()=>{state.observer.latitudeDeg=result.latitude!;state.observer.longitudeDegEast=result.longitude!;state.observer.name='日食食甚地点';state.time.utDaysJ2000=result.peak;state.time.running=false;onChange('observer');update();};q('.eclipse-contacts').append(b);}
      drawEclipse();
    }catch(error){if(!disposed)q('.eclipse-status').textContent=error instanceof Error?error.message:String(error);}finally{busy=false;}
  };
  root.addEventListener('click',click);root.addEventListener('toggle',update,true);root.addEventListener('change',update);
  return {update,dispose(){disposed=true;root.removeEventListener('click',click);root.removeEventListener('toggle',update,true);root.removeEventListener('change',update);root.remove();}};
}
