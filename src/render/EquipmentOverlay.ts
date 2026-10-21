import * as THREE from 'three';
import type {SimulationState} from '../contracts';
import {instrumentField} from '../core/instruments';
import {landscapeState} from '../platform/landscape';
export class EquipmentOverlay {
  private canvas=document.createElement('canvas');private key='';
  draw(ctx:CanvasRenderingContext2D,state:SimulationState,camera:THREE.PerspectiveCamera,width:number,height:number):void{
    if(state.viewMode!=='ground')return;
    const {current,pixels,generation}=landscapeState();
    if(current?.enabled&&pixels&&state.layers.terrain){
      const key=JSON.stringify([generation,width,height,camera.fov,camera.quaternion.toArray()]);
      if(key!==this.key){this.key=key;const w=Math.min(640,Math.round(width)),h=Math.max(1,Math.round(height*w/width));this.canvas.width=w;this.canvas.height=h;
        const c=this.canvas.getContext('2d')!,out=c.createImageData(w,h),tan=Math.tan(camera.fov*Math.PI/360),ray=new THREE.Vector3();
        for(let y=0;y<h;y++)for(let x=0;x<w;x++){
          ray.set((2*(x+.5)/w-1)*camera.aspect*tan,(1-2*(y+.5)/h)*tan,-1).normalize().applyQuaternion(camera.quaternion);
          const az=Math.atan2(ray.x,-ray.z)*180/Math.PI,alt=Math.asin(ray.y)*180/Math.PI;
          const sx=Math.floor(((az-current.northOffsetDeg)%360+360)%360/360*pixels.width),sy=Math.min(pixels.height-1,Math.floor((90-alt)/180*pixels.height));
          const src=(sy*pixels.width+sx)*4,dst=(y*w+x)*4;out.data.set(pixels.data.subarray(src,src+4),dst);
        }c.putImageData(out,0,0);
      }ctx.drawImage(this.canvas,0,0,width,height);
    }
    const v=state.instrument;if(!v||v.mode==='off')return;const f=instrumentField(v),scale=height/(2*Math.tan(camera.fov*Math.PI/360));
    ctx.save();ctx.translate(width/2,height/2);ctx.rotate(v.rotationDeg*Math.PI/180);ctx.strokeStyle='#c6b38d';ctx.lineWidth=1.3;
    if(v.mode==='camera'){const w=2*scale*Math.tan(f.widthDeg*Math.PI/360),h=2*scale*Math.tan(f.heightDeg*Math.PI/360);ctx.strokeRect(-w/2,-h/2,w,h);}
    else {const r=scale*Math.tan(f.trueFovDeg*Math.PI/360);ctx.beginPath();ctx.rect(-width,-height,width*2,height*2);ctx.arc(0,0,r,0,Math.PI*2,true);ctx.fillStyle='rgba(0,0,0,.86)';ctx.fill('evenodd');ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();}
    ctx.restore();ctx.save();ctx.fillStyle='#c6b38d';ctx.font='12px sans-serif';ctx.fillText(v.mode==='camera'?`相机 ${f.widthDeg.toFixed(2)}° × ${f.heightDeg.toFixed(2)}°`:`目镜 ${f.magnification.toFixed(1)}× · ${f.trueFovDeg.toFixed(2)}°`,width/2-80,height-22);ctx.restore();
  }
}
