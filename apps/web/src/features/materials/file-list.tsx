import {materialReaderPath,materialContentPath} from './navigation.ts';
import {processingView} from '../documents/processing-presentation.ts';
import React,{useState} from 'react';
import {Button,Checkbox,Dropdown,Segmented} from 'antd';
import {Link} from 'react-router';
import type {Material} from './types.ts';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ProcessingStatus} from '../documents/types.ts';
import {formatSize} from '../../shared/format.ts';
import {can} from '../identity/permissions.ts';
import {shortVersion} from './presentation.ts';
import {fileParsingLabel} from './processing.ts';
import './file-list.css';
export {fileProcessingLabel} from './processing.ts';

/** Selection is only for bulk removal. Every displayed file belongs to the round. */
type FileFilter='all'|'ready'|'working'|'failed';
const fileGroupLabels={ready:'解析成功',working:'解析中',failed:'解析失败'} as const;
const fileGroup=(status:string):Exclude<FileFilter,'all'>|undefined=>status==='解析成功'?'ready':['等待解析','解析中'].includes(status)?'working':status==='解析失败'?'failed':undefined;

export function MaterialFileList({rows,caseId,roundId,state,roundLabel,canRemove,pending,reader,parsing,processing,onRemove,onDetails,historyAction}:{
  rows:Material[];caseId:string;roundId?:string|null;state?:ReviewState;roundLabel:string;canRemove:boolean;pending:boolean;reader:boolean;parsing?:boolean;
  processing:(material:Material)=>{data?:ProcessingStatus;error?:unknown};
  onRemove:(ids:string[])=>void;onDetails:(material:Material)=>void;
  historyAction?:React.ReactNode;
}){
  const [selection,setSelection]=useState<string[]>([]),[filter,setFilter]=useState<FileFilter>('all');
  const statusOf=(material:Material)=>{const p=processing(material);return fileParsingLabel(material,p.data,p.error);};
  const counts={ready:0,working:0,failed:0};for(const material of rows){const group=fileGroup(statusOf(material));if(group)counts[group]++;}
  const visible=filter==='all'?rows:rows.filter(material=>fileGroup(statusOf(material))===filter);
  const selected=selection.filter(id=>rows.some(row=>row.id===id)),allSelected=rows.length>0&&selected.length===rows.length;
  return <section className="material-file-list" aria-label={`${roundLabel}待审文件`}>
    <header className="material-file-header"><div className="material-file-title"><h2>{roundLabel}待审文件</h2><p role="status">{rows.length} 份文件{canRemove&&selected.length?` · ${selected.length} 份已选`:''}</p></div>
      {rows.length>0&&<Segmented<FileFilter> size="small" aria-label="按解析状态筛选" value={filter} onChange={setFilter} options={[{value:'all',label:`全部 ${rows.length}`},...(['ready','working','failed'] as const).filter(group=>counts[group]>0).map(group=>({value:group,label:`${fileGroupLabels[group]} ${counts[group]}`}))]}/>}
      {historyAction&&<div className="material-file-tools">{historyAction}</div>}
    </header>
    {canRemove&&selected.length>0&&<div className="material-selection-toolbar" aria-label="已选文件操作"><span>已选 {selected.length} 份</span><div>
      {!allSelected&&<Button type="link" disabled={pending} onClick={()=>setSelection(rows.map(row=>row.id))}>全选</Button>}
      <Button type="link" disabled={pending} onClick={()=>setSelection([])}>取消选择</Button>
      <Button type="link" danger disabled={pending} onClick={()=>onRemove(selected)}>移除所选</Button>
    </div></div>}
    <ul className={`material-file-rows${canRemove?'':' is-readonly'}`}>
      {visible.map(material=>{
        const p=processing(material),status=fileParsingLabel(material,p.data,p.error),group=fileGroup(status);
        const types=[...new Set(state?.materials.filter(m=>m.documentVersionId===material.id&&m.operation==='adopt').map(m=>state.configuration?.taxonomy.find(t=>t.id===m.documentTypeId)?.label??m.documentTypeId)??[])];
        const reviewUrl=materialReaderPath(caseId,material.id,roundId??(state?.legacyView?'legacy':undefined));
        const readable=reader&&can(material.allowed_actions,'evidence:read');
        const sameName=rows.filter(row=>row.filename===material.filename).length>1;
        const menu=[...(readable?[{key:'review',label:<Link to={reviewUrl}>{material.format==='png'||material.format==='jpg'?'预览原图':'提取与核对'}</Link>}]:[]),
          ...(can(material.allowed_actions,'evidence:read')?[{key:'original',label:<a href={materialContentPath(caseId,material.id,true)} download={material.filename}>下载原件</a>}]:[]),
          {key:'details',label:'文件详情与处理记录',onClick:()=>onDetails(material)},
          ...(canRemove?[{key:'remove',label:'从本轮移除',danger:true,disabled:pending,onClick:()=>onRemove([material.id])}]:[])];
        return <li key={material.id} className="material-file-row">
          {canRemove&&<Checkbox aria-label={`选择文件 ${material.filename}`} checked={selected.includes(material.id)} disabled={pending} onChange={event=>setSelection(event.target.checked?[...selected,material.id]:selected.filter(id=>id!==material.id))}/>}
          <div className="material-file-identity">{readable?<Link className="material-file-name" to={reviewUrl}>{material.filename}</Link>:<button className="material-file-name" onClick={()=>onDetails(material)}>{material.filename}</button>}
            <p>{material.uploadedRoundNumber?`第 ${material.uploadedRoundNumber} 轮已上传`:roundLabel}{material.historySourceDocumentId?' · 历史材料':''} · {types.join('、')||'类型待识别'}{sameName&&<> · 版本 {shortVersion(material.ossVersionId,rows.map(row=>row.ossVersionId))}</>}</p>
          </div>
          <div className="material-file-size"><span>{material.pageCount==null?'页数待确认':`${material.pageCount} 页`}</span><span>{formatSize(material.size)}</span></div>
          <div className={`material-file-status${status==='解析失败'?' has-error':''}`}><span className={`status-mark${group==='ready'?' status-mark-success':group==='failed'?' status-mark-error':group==='working'?'':' status-mark-muted'}`}>{status}</span></div>
          <div className="material-file-actions"><Dropdown trigger={['click']} menu={{items:menu}}><Button type="text" className="material-file-more" aria-label={`更多操作 ${material.filename}`}><span aria-hidden="true">⋯</span></Button></Dropdown></div>
          {group==='failed'&&<p className="material-file-note">{processingView(material.format,p.data).extraction}<button type="button" onClick={()=>onDetails(material)}>查看处理记录</button></p>}
        </li>;
      })}
    </ul>
    {!rows.length&&<p className="material-file-empty">本轮暂无待审文件</p>}
    {rows.length>0&&!visible.length&&<p className="material-file-empty">没有符合筛选的文件<button type="button" onClick={()=>setFilter('all')}>查看全部</button></p>}
  </section>;
}
