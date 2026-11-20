import React from 'react';
import {Button,Dropdown,Tooltip} from 'antd';
import {NavIcon} from '../../brand.tsx';
import {pageTransform} from './presentation.ts';

export type ReaderZoom = 'page' | number;
const zoomOptions = [{value:'page',label:'适应页面'},{value:100,label:'适应宽度'},...[50,75,125,150,200].map(value=>({value,label:`${value}%`}))];

/** Original images and parsed document pages share geometry and viewing controls. */
export function ReaderViewControls({zoom,onZoom,onRotate,disabled=false}:{zoom:ReaderZoom;onZoom:(zoom:ReaderZoom)=>void;onRotate:()=>void;disabled?:boolean}) {
  const label=`页面缩放：${zoomOptions.find(option=>option.value===zoom)?.label}`;
  return <>
    <Dropdown disabled={disabled} trigger={['click']} placement="topLeft" menu={{selectable:true,selectedKeys:[String(zoom)],items:zoomOptions.map(option=>({key:String(option.value),label:option.label})),onClick:({key})=>onZoom(key==='page'?'page':Number(key))}}><Button type="text" disabled={disabled} aria-label={label} title={label} icon={<NavIcon name="fit-width"/>}/></Dropdown>
    <Tooltip title="顺时针旋转页面"><Button type="text" disabled={disabled} aria-label="顺时针旋转页面" icon={<NavIcon name="rotate"/>} onClick={onRotate}/></Tooltip>
  </>;
}

export function ReaderPage({src,width,height,rotation,zoom,label,className='',onImageError,children}:{src:string;width:number;height:number;rotation:number;zoom:ReaderZoom;label:string;className?:string;onImageError:()=>void;children?:React.ReactNode}) {
  const transform=pageTransform(width,height,rotation);
  return <svg className={`review-paper ${className}`} role="group" aria-label={label} viewBox={`0 0 ${transform.width} ${transform.height}`} style={zoom==='page'?undefined:{width:`${zoom}%`,maxWidth:'none'}}>
    <title>{label}</title><g transform={transform.transform}><image href={src} width={width} height={height} onError={onImageError}/>{children}</g>
  </svg>;
}
