import React,{useState} from 'react';
import type {SignatureBox} from '@hsbc/contracts/signature-review';
/** Coordinates are always in original page units; the enclosing SVG handles rotation/zoom. */
export function SignatureRegionOverlay({width,height,box,drawing,onComplete}:{width:number;height:number;box?:SignatureBox|null;drawing:boolean;onComplete:(box:SignatureBox|null)=>void}){
 const [start,setStart]=useState<{x:number;y:number}>(),[end,setEnd]=useState<{x:number;y:number}>();
 const point=(e:React.PointerEvent<SVGRectElement>)=>{const matrix=e.currentTarget.getScreenCTM();if(!matrix)return null;const p=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());return {x:Math.min(width,Math.max(0,p.x)),y:Math.min(height,Math.max(0,p.y))};};
 const selected=start&&end?{x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(start.x-end.x),height:Math.abs(start.y-end.y)}:box;
 return <g>{selected&&<rect {...selected} data-signature-region fill="rgba(219,0,17,.08)" stroke="#db0011" strokeWidth={2} pointerEvents="none"/>}{drawing&&<rect width={width} height={height} fill="transparent" style={{cursor:'crosshair',touchAction:'none'}} role="button" tabIndex={0} aria-label="在原件上拖动框选签署区域，按 Escape 取消" onKeyDown={e=>{if(e.key==='Escape'){setStart(undefined);setEnd(undefined);onComplete(null);}}} onPointerDown={e=>{const p=point(e);if(p){e.currentTarget.setPointerCapture(e.pointerId);setStart(p);setEnd(p);}}} onPointerMove={e=>{if(start){const p=point(e);if(p)setEnd(p);}}} onPointerUp={e=>{const p=point(e);if(start&&p){const next={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),width:Math.abs(start.x-p.x),height:Math.abs(start.y-p.y)};if(next.width>=1&&next.height>=1)onComplete(next);}setStart(undefined);setEnd(undefined);}}/>}</g>;
}
