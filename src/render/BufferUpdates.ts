import type { BufferAttribute } from 'three';

/** Preserve every pending change while keeping at most one queued range, including hidden geometry. */
export function queueBufferUpdate(attribute:BufferAttribute,start:number,count:number):void {
  if(count<=0)return;
  let first=start,last=start+count;
  for(const range of attribute.updateRanges){first=Math.min(first,range.start);last=Math.max(last,range.start+range.count);}
  attribute.clearUpdateRanges();attribute.addUpdateRange(first,last-first);attribute.needsUpdate=true;
}
