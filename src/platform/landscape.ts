export interface Landscape {version:1;name:string;dataUrl:string;northOffsetDeg:number;enabled:boolean}
let current:Landscape|null=null,pixels:ImageData|null=null,generation=0;
export const landscapeState=()=>({current,pixels,generation});
export async function setLandscape(value:Landscape|null):Promise<void>{
  if(!value){current=null;pixels=null;generation++;window.dispatchEvent(new Event('sky:landscape'));return;}
  if(value.version!==1||typeof value.name!=='string'||value.name.length>120||!/^data:image\/(png|webp);base64,/.test(value.dataUrl)||value.dataUrl.length>12000000||!Number.isFinite(value.northOffsetDeg)||Math.abs(value.northOffsetDeg)>360||typeof value.enabled!=='boolean')throw Error('地景包无效：需要PNG/WebP全景，偏角−360至360°。');
  const img=new Image();img.src=value.dataUrl;await img.decode();if(img.width<2||img.height<2||img.width>8192||img.height>4096||Math.abs(img.width/img.height-2)>.05)throw Error('请使用2:1等距柱状全景，最大8192×4096，天空区域透明。');
  const canvas=document.createElement('canvas');canvas.width=Math.min(2048,img.width);canvas.height=canvas.width/2;canvas.getContext('2d')!.drawImage(img,0,0,canvas.width,canvas.height);
  pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height);current={...value};generation++;window.dispatchEvent(new Event('sky:landscape'));
}
export function updateLandscape(patch:Partial<Pick<Landscape,'enabled'|'northOffsetDeg'>>):void{if(current){Object.assign(current,patch);generation++;window.dispatchEvent(new Event('sky:landscape'));}}
export function landscapeAlpha(azimuth:number,altitude:number):number{
  if(!current?.enabled||!pixels)return 0;const u=((azimuth-current.northOffsetDeg)%360+360)%360/360,v=(90-altitude)/180;
  const x=Math.min(pixels.width-1,Math.floor(u*pixels.width)),y=Math.max(0,Math.min(pixels.height-1,Math.floor(v*pixels.height)));return pixels.data[(y*pixels.width+x)*4+3]!/255;
}
