import {createCanvas,loadImage} from '@napi-rs/canvas';
import {sha256} from '../../document/evidence.js';
import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {FormBox} from './director-notice-source.js';

export type FormPixels={width:number;height:number;data:Uint8ClampedArray};
export async function formPixels(page:DocumentPageArtifact,bytes:Uint8Array):Promise<FormPixels|null>{
  if(sha256(bytes)!==page.imageSha256)return null;
  const image=await loadImage(bytes);
  if(image.width!==page.page.width||image.height!==page.page.height||image.width*image.height>20000000)return null;
  const canvas=createCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);
  return {width:image.width,height:image.height,data:context.getImageData(0,0,image.width,image.height).data};
}
/** Only a closed square immediately before a printed choice is supported.
 * Interior ink is a selected-box candidate, never a handwriting assessment.
 * Weak/broken frames and intermediate ink densities remain unknown. */
export function formCheckbox(pixels:FormPixels,label:FormBox):{box:FormBox;state:'checked'|'blank'|'unknown'}|null{
  const dark=(x:number,y:number)=>{
    if(x<0||y<0||x>=pixels.width||y>=pixels.height)return false;
    const at=(y*pixels.width+x)*4;return pixels.data[at+3]!>200&&(pixels.data[at]!+pixels.data[at+1]!+pixels.data[at+2]!)/3<150;
  };
  const h=label.height,min=Math.max(10,Math.floor(h*.8)),max=Math.min(42,Math.ceil(h*1.8));
  let best:{box:FormBox;score:number}|undefined;
  for(let size=min;size<=max;size++)for(let y=Math.max(0,Math.floor(label.y-h*.6));y<=label.y+h*.35;y++)for(let x=Math.max(0,Math.floor(label.x-h*3.2));x+size<label.x-2;x++){
    const edge=(vertical:boolean,offset:number)=>{
      let count=0;for(let i=2;i<size-2;i++)if([-1,0,1].some(d=>dark(x+(vertical?offset+d:i),y+(vertical?i:offset+d))))count++;
      return count/(size-4);
    };
    const scores=[edge(false,0),edge(false,size-1),edge(true,0),edge(true,size-1)];
    if(scores.some(score=>score<.85))continue;
    const score=scores.reduce((a,b)=>a+b,0)/4-(label.x-x-size)/(h*100)-Math.abs(y-label.y)/(h*100);
    if(!best||score>best.score)best={box:{x,y,width:size,height:size},score};
  }
  if(!best)return null;
  const b=best.box,pad=Math.max(3,Math.ceil(b.width*.2));let ink=0,total=0;
  for(let y=b.y+pad;y<b.y+b.height-pad;y++)for(let x=b.x+pad;x<b.x+b.width-pad;x++){total++;if(dark(x,y))ink++;}
  const fraction=ink/total;
  return {box:b,state:fraction>.08&&fraction<.65?'checked':fraction<.02?'blank':'unknown'};
}
