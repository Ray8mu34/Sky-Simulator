import type {Mat3,Vec3} from '../contracts';
import type {RefractionProfile} from '../core/refraction';
import {refractEnuDirectionInto} from '../core/refraction';

/** One update's immutable projection inputs, with fixed scratch and no per-sample vector allocations. */
export function createArcProjector(frame:Mat3,profile:RefractionProfile,worldToCamera:Mat3,cameraPosition:Vec3,finite:boolean,width:number,height:number,tanFov:number,maximumCorrectionDeg:number){
  const input=new Float64Array(3),mapped=new Float64Array(3),screen:[number,number]=[0,0];
  const [fx,fy,fz]=frame,[rx,ry,rz]=worldToCamera,aspect=width/height;
  const behindBound=Math.sin(maximumCorrectionDeg*Math.PI/180);
  return (direction:readonly[number,number,number]):readonly[number,number]|null=>{
    const a=direction[0],b=direction[1],c=direction[2];
    let x=fx[0]*a+fx[1]*b+fx[2]*c,y=fy[0]*a+fy[1]*b+fy[2]*c,z=fz[0]*a+fz[1]*b+fz[2]*c;
    if(!profile.identity){
      // F rotates a direction by at most the maximum stored correction. A geometric
      // direction strictly farther than that angle behind the camera cannot enter its front half.
      const geometricZ=rz[0]*x+rz[1]*y+rz[2]*z;
      if(!finite&&!(behindBound>=0&&geometricZ<=0)&&geometricZ>Math.hypot(x,y,z)*behindBound+1e-12)return null;
      input[0]=x;input[1]=-z;input[2]=y;refractEnuDirectionInto(input,profile,mapped);
      x=mapped[0]!;y=mapped[2]!;z=-mapped[1]!;
    }
    if(finite){x-=cameraPosition[0];y-=cameraPosition[1];z-=cameraPosition[2];}
    const depth=rz[0]*x+rz[1]*y+rz[2]*z;if(depth>=-1e-8)return null;
    const depthScale=-depth*tanFov;
    screen[0]=((rx[0]*x+rx[1]*y+rx[2]*z)/(depthScale*aspect)+1)*width/2;
    screen[1]=(1-(ry[0]*x+ry[1]*y+ry[2]*z)/depthScale)*height/2;
    return screen;
  };
}
