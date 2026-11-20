import React,{useEffect,useState} from 'react';
import {Alert,Button} from 'antd';
import type {Material} from '../materials/types.ts';
import {materialContentPath} from '../materials/navigation.ts';
import {Loading} from '../../ui.tsx';
import {ReaderPage,ReaderViewControls,type ReaderZoom} from './reader-page.tsx';

/** Mounted only after the case, round and evidence-read permissions are checked. */
export function ImageReader({caseId,material}:{caseId:string;material:Material}) {
  const [size,setSize]=useState<{width:number;height:number}>();
  const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  const [zoom,setZoom]=useState<ReaderZoom>(100),[rotation,setRotation]=useState(0);
  const src=materialContentPath(caseId,material.id);
  useEffect(()=>{
    setSize(undefined);setFailed(false);
    const image=new window.Image();
    image.onload=()=>{if(image.naturalWidth&&image.naturalHeight)setSize({width:image.naturalWidth,height:image.naturalHeight});else setFailed(true);};
    image.onerror=()=>setFailed(true);
    image.src=src;
    return ()=>{image.onload=null;image.onerror=null;};
  },[src,attempt]);
  return <section className="review-pane review-canvas-pane review-image-pane" aria-label="原件页面">
      {failed&&<Alert className="review-banner" type="error" showIcon title="原图暂不可用，请重试或核对读取权限。" action={<Button onClick={()=>setAttempt(value=>value+1)}>重试</Button>}/>}
      <div className="review-canvas-stage"><div className={`review-canvas${zoom==='page'?' fit-page':''}`}>
        {!failed&&(size?<ReaderPage key={attempt} src={src} width={size.width} height={size.height} rotation={rotation} zoom={zoom} label={`图片原件：${material.filename}，旋转 ${rotation} 度`} onImageError={()=>setFailed(true)}/>:<Loading/>)}
      </div></div>
      <footer className="review-footer" aria-label="原件预览控制"><div className="reader-tools" role="group" aria-label="原件阅读工具"><span className="reader-page-total mono">1 / 1</span><ReaderViewControls zoom={zoom} onZoom={setZoom} onRotate={()=>setRotation(value=>(value+90)%360)} disabled={!size||failed}/></div></footer>
    </section>;
}
