import type {Vec3} from '../contracts';
import {normalize} from '../core/math';
import {createMinorArcSampler,minorArcAltitudeCrossings} from './SphericalArcBuffer';
import type {MinorArcSampler} from './SphericalArcBuffer';

/** Immutable sampler mathematics changes only with the unique source-star cache epoch. */
export class ArcKnotsCache {
  readonly knots:(readonly number[]|undefined)[];
  private readonly samplers:(MinorArcSampler|null)[];
  private readonly cosines:Float64Array;
  private readonly sines:Float64Array;
  constructor(private readonly endpoints:ArrayLike<number>){
    const count=endpoints.length/2;this.knots=Array(count).fill(undefined);this.samplers=Array(count).fill(null);this.cosines=new Float64Array(count);this.sines=new Float64Array(count);
  }
  updateEpoch(directions:ArrayLike<number>):void {
    for(let arc=0;arc<this.samplers.length;arc++){
      const a=this.endpoints[arc*2]!*3,b=this.endpoints[arc*2+1]!*3;
      const sampler=createMinorArcSampler([directions[a]!,directions[a+1]!,directions[a+2]!],[directions[b]!,directions[b+1]!,directions[b+2]!]);
      this.samplers[arc]=sampler;this.cosines[arc]=Math.cos(sampler?.angleRad??0);this.sines[arc]=Math.sin(sampler?.angleRad??0);
    }
  }
  update(upDirection:Vec3,horizonDeg:number):readonly(ArrayLike<number>|undefined)[]{
    const up=normalize(upDirection),thresholds=[-1,horizonDeg],sines=thresholds.map(deg=>Math.sin(deg*Math.PI/180));
    for(let arc=0;arc<this.samplers.length;arc++){
      this.knots[arc]=undefined;const s=this.samplers[arc];if(!s||s.coincident)continue;
      const a=s.start[0]*up[0]+s.start[1]*up[1]+s.start[2]*up[2],b=s.tangent[0]*up[0]+s.tangent[1]*up[1]+s.tangent[2]*up[2];
      const end=s.end[0]*up[0]+s.end[1]*up[1]+s.end[2]*up[2],endDerivative=-a*this.sines[arc]!+b*this.cosines[arc]!;
      let low=Math.min(a,end),high=Math.max(a,end);
      if(b<0&&endDerivative>0)low=-Math.hypot(a,b);else if(b>0&&endDerivative<0)high=Math.hypot(a,b);
      let knots:number[]|undefined;
      for(let index=0;index<2;index++){
        const threshold=sines[index]!;
        // Exact sinusoidal extrema bound; the guard only enlarges it at numeric boundaries.
        if(threshold<low-1e-12||threshold>high+1e-12)continue;
        const roots=minorArcAltitudeCrossings(s,upDirection,thresholds[index]!);if(roots.length){knots??=[];knots.push(...roots);}
      }this.knots[arc]=knots;
    }return this.knots;
  }
}
