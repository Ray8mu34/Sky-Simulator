import type {SimulationState} from '../contracts';
import {parseState} from '../state';
export interface CourseStep {title:string;text:string;durationSeconds:number;scene:SimulationState}
export interface Course {version:1;title:string;steps:CourseStep[]}
export function parseCourse(input:string|unknown):Course {
  if(typeof input==='string'&&input.length>2000000)throw Error('课程文件最大2 MB。');
  const value=typeof input==='string'?JSON.parse(input):input;
  if(!value||value.version!==1||typeof value.title!=='string'||value.title.length>120||!Array.isArray(value.steps)||!value.steps.length||value.steps.length>100)throw Error('课程需要标题及1–100个步骤。');
  return {version:1,title:value.title,steps:value.steps.map((step:CourseStep)=>{if(typeof step.title!=='string'||step.title.length>120||typeof step.text!=='string'||step.text.length>4000||!Number.isFinite(step.durationSeconds)||step.durationSeconds<2||step.durationSeconds>600)throw Error('步骤标题/讲解无效，时长需为2–600秒。');const scene=parseState(step.scene);scene.time.running=false;return {...step,scene};})};
}
