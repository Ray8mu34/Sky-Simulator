/** DOM/clock/Three-free pointer state. Only the first two contacts participate in camera motion. */
export interface GestureContact { id:number;x:number;y:number;startX:number;startY:number;active:boolean;dragging:boolean }
export interface PointerGestureState { pointers:ReadonlyMap<number,GestureContact>;tapSuppressed:boolean;pinchDistance:number|null }
export type PointerGestureInput={type:'down'|'move'|'up'|'cancel'|'lost-capture';id:number;x:number;y:number}|{type:'reset'};
export type PointerGestureAction={type:'pan';dx:number;dy:number}|{type:'zoom';scale:number}|{type:'tap';x:number;y:number};
export interface PointerGestureResult {state:PointerGestureState;action:PointerGestureAction|null;captureIds:number[];releaseIds:number[]}
export const MAX_GESTURE_CONTACTS=16;
export const TAP_MOTION_THRESHOLD_CSS_PX=4;
export function createPointerGesture():PointerGestureState{return {pointers:new Map(),tapSuppressed:false,pinchDistance:null};}
export function gestureActiveContacts(state:PointerGestureState):GestureContact[]{return [...state.pointers.values()].filter(pointer=>pointer.active);}
export function gestureMode(state:PointerGestureState):'idle'|'single'|'pinch'|'suppressed'{
  const count=gestureActiveContacts(state).length;return count===2?'pinch':count===1?'single':state.pointers.size?'suppressed':'idle';
}
function span(contacts:GestureContact[]):number|null {
  if(contacts.length!==2)return null;
  const distance=Math.hypot(contacts[0]!.x-contacts[1]!.x,contacts[0]!.y-contacts[1]!.y);
  return distance>=1?distance:null;
}
export function reducePointerGesture(state:PointerGestureState,input:PointerGestureInput):PointerGestureResult {
  const unchanged=():PointerGestureResult=>({state,action:null,captureIds:[],releaseIds:[]});
  if(input.type==='reset'||((input.type==='cancel'||input.type==='lost-capture')&&state.pointers.has(input.id))){
    return {state:createPointerGesture(),action:null,captureIds:[],releaseIds:[...state.pointers.keys()]};
  }
  if(input.type==='cancel'||input.type==='lost-capture')return unchanged();
  const previous=state.pointers.get(input.id);
  if(input.type==='down'){
    if(previous)return unchanged();
    if(state.pointers.size>=MAX_GESTURE_CONTACTS)return {...unchanged(),state:{...state,tapSuppressed:true}};
    const active=gestureActiveContacts(state).length<2,pointers=new Map(state.pointers);
    pointers.set(input.id,{id:input.id,x:input.x,y:input.y,startX:input.x,startY:input.y,active,dragging:state.tapSuppressed});
    const multi=pointers.size>1;
    if(multi)for(const [id,contact]of pointers)if(contact.active)pointers.set(id,{...contact,dragging:true});
    const next={pointers,tapSuppressed:state.tapSuppressed||multi,pinchDistance:span([...pointers.values()].filter(p=>p.active))};
    return {state:next,action:null,captureIds:[input.id],releaseIds:[]};
  }
  if(!previous)return unchanged();
  if(input.type==='up'){
    const tap=previous.active&&state.pointers.size===1&&!state.tapSuppressed&&!previous.dragging
      &&Math.hypot(input.x-previous.startX,input.y-previous.startY)<=TAP_MOTION_THRESHOLD_CSS_PX;
    const pointers=new Map(state.pointers);pointers.delete(input.id);
    // Rebase only: lifting one finger never emits a pan or zoom.
    for(const [id,contact]of pointers)if(contact.active)pointers.set(id,{...contact,startX:contact.x,startY:contact.y,dragging:true});
    const next=pointers.size?{pointers,tapSuppressed:true,pinchDistance:span([...pointers.values()].filter(p=>p.active))}:createPointerGesture();
    return {state:next,action:tap?{type:'tap',x:input.x,y:input.y}:null,captureIds:[],releaseIds:[input.id]};
  }
  if(!previous.active)return unchanged();
  const pointers=new Map(state.pointers),moved=Math.hypot(input.x-previous.startX,input.y-previous.startY)>TAP_MOTION_THRESHOLD_CSS_PX;
  const current={...previous,x:input.x,y:input.y,dragging:previous.dragging||moved};pointers.set(input.id,current);
  const contacts=[...pointers.values()].filter(pointer=>pointer.active),distance=span(contacts);
  const next={pointers,tapSuppressed:state.tapSuppressed||moved,pinchDistance:distance};
  if(contacts.length===2)return {state:next,action:state.pinchDistance!==null&&distance!==null&&distance!==state.pinchDistance?{type:'zoom',scale:state.pinchDistance/distance}:null,captureIds:[],releaseIds:[]};
  const dx=input.x-(previous.dragging?previous.x:previous.startX),dy=input.y-(previous.dragging?previous.y:previous.startY);
  return {state:next,action:current.dragging&&(dx!==0||dy!==0)?{type:'pan',dx,dy}:null,captureIds:[],releaseIds:[]};
}
