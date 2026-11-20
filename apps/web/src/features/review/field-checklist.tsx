import {fieldIncompleteReason,incompleteFieldCounts,incompleteReasonLabels} from './field-incomplete-reason.ts';
import {CorporateSemanticActions} from './corporate-semantic-actions.tsx';
import {pendingTaskGroups,pendingTaskRow} from './field-pending-tasks.ts';
import {PersonalFieldReviewAction} from './personal-field-review-action.tsx';
import {FieldRecheckAction} from './field-recheck-action.tsx';
import {checklistFieldLabel} from './personal-field-presentation.ts';
import {checklistReviewStatus,checklistReviewLabel,FieldVerificationEvidence} from './field-verification.tsx';
import {fieldDeskChecks} from './field-desk-checks.ts';
import React,{useEffect,useId,useState} from 'react';
import {Button,Input,Select} from 'antd';
import {useSearchParams} from 'react-router';
import type {ReviewState} from '@hsbc/contracts/review';
import type {ChecklistRow,ChecklistStatus} from '@hsbc/contracts/review-checklist';
import {GUARANTEE_LABELS} from '@hsbc/contracts/mixed-guarantee';
import {ErrorNotice,Loading} from '../../ui.tsx';
import {useChecklist,useRoundTranslations} from './checklist-translations.tsx';
import {FieldEvidence} from './field-evidence.tsx';
import {useDeskHeight} from './use-desk-height.ts';
import {checklistGroups,filterChecklist,visibleSelection} from './field-desk-presentation.ts';
import {FieldReview, type FieldDeskActions} from './field-review.tsx';
import {fieldComparison} from './field-comparison.ts';
import './field-checklist.css';
import './bilingual-evidence.css';
import {useEvidenceTranslationGeneration} from './use-evidence-translation-generation.ts';
import {useCheckerEntryState} from '../review-checker/checker-entry.tsx';
import {InitialReviewResult} from './initial-review-panel.tsx';

export const checklistStatusLabels:Record<ChecklistStatus,string>={missing_material:'缺少材料',unprocessed:'尚未处理',not_found:'未提取到',pending_confirmation:'待确认',extracted:'已提取',confirmed:'已确认',not_applicable:'不适用',uncertain:'处理失败或无法判断'};
const quickFilters=[{key:'all',label:'全部'},{key:'attention',label:'需关注'},{key:'consistent',label:'一致'},{key:'confirmed',label:'已确认'},{key:'checking',label:'核对中'},{key:'not_applicable',label:'不适用'}];
export function FieldChecklist({state,indexFooter,...actions}:{state:ReviewState;indexFooter?:React.ReactNode}&FieldDeskActions){
  const query=useChecklist(state);
  const checker=useCheckerEntryState(state.caseId,state.roundId??undefined,!!state.roundId);
  const deskRef=useDeskHeight(!query.isPending&&!query.error);
  const [typeFilter,setType]=useState<string>(),[objectFilter,setObject]=useState<string>(),[text,setText]=useState(''),[document,setDocument]=useState<string>();
  const [params,setParams]=useSearchParams();
  const [quick,setQuick]=useState<string|undefined>('all');
  const groupId=useId();
  const [collapsedGroups,setCollapsedGroups]=useState<Set<string>>(()=>new Set());
  const names=Object.fromEntries((query.data?.documents??[]).map(d=>[d.id,d.filename]));
  const allRows=query.data?.rows??[],rows=filterChecklist(allRows,{});
  const typeOptions=[...new Set(rows.flatMap(row=>row.guaranteeTypes))].map(value=>({value,label:GUARANTEE_LABELS[value]??value}));
  const objectOptions=[...new Map(rows.map(row=>[row.objectId??'pending',row.objectLabel])).entries()].map(([value,label])=>({value,label}));
  const showTypeFilter=typeOptions.length>1,showObjectFilter=objectOptions.filter(option=>option.value!=='pending').length>1;
  const type=showTypeFilter&&typeOptions.some(option=>option.value===typeFilter)?typeFilter:undefined;
  const object=showObjectFilter&&objectOptions.some(option=>option.value===objectFilter)?objectFilter:undefined;
  const moreFilterCount=[type,object,document].filter(Boolean).length;
  const showResultCount=!!text.trim()||moreFilterCount>0;
  // Clear obsolete selections after a successful refresh; hidden filters never restrict the list.
  useEffect(()=>{
    if(!query.isSuccess)return;
    if(typeFilter!==type)setType(type);
    if(objectFilter!==object)setObject(object);
  },[query.isSuccess,typeFilter,type,objectFilter,object]);
  const scope=filterChecklist(rows,{text,type,object,document},names);
  // Rows scoped to this round's files are checked automatically on entry, for corporate and personal guarantees alike.
  const corporateRows=rows.filter(row=>(row.objectRole==='corporate_guarantee'||row.objectRole==='personal_guarantee')&&row.documentScope);
  const matchesQuick=(row:ChecklistRow,filter:typeof quickFilters[number]|undefined)=>!filter||filter.key==='all'||(filter.key==='attention'?['different','incomplete','missing_material','pending'].includes(checklistReviewStatus(row,state)):checklistReviewStatus(row,state)===filter.key);
  const incompleteCounts=incompleteFieldCounts(scope,state);
  const activeFilter=quickFilters.find(filter=>filter.key===quick);
  const matched=scope.filter(row=>matchesQuick(row,activeFilter));
  const taskMode=quick==='attention',taskGroups=taskMode?[...pendingTaskGroups(matched.filter(row=>checklistReviewStatus(row,state)==='pending')),...matched.filter(row=>checklistReviewStatus(row,state)!=='pending').map(row=>[row])]:matched.map(row=>[row]);
  const shown=taskGroups.map(pendingTaskRow),requestedGroup=taskGroups.find(g=>g.some(r=>r.id===params.get('field')));
  const selected=visibleSelection(shown,requestedGroup?.[0]?.id??params.get('field'));
  const members=taskGroups.find(g=>g[0]?.id===selected?.id)??[];
  // Quick filters count fields consistently. The pending view separately shows
  // deduplicated tasks and how many fields those tasks cover.
  const countFor=(filter:typeof quickFilters[number])=>scope.filter(row=>matchesQuick(row,filter)).length;
  const savedEvidence=selected?.verification;
  // A saved pending task can have no verified quotations yet. Keep the current
  // candidate's original accessible so the reviewer can resolve that task.
  const showSavedEvidence=!!savedEvidence&&(savedEvidence.validity!=='current'||savedEvidence.status!=='pending'||savedEvidence.sources.some(s=>s.kind==='original'));
  const evidence=showSavedEvidence?savedEvidence!.sources.filter(s=>s.kind==='original').map(s=>({...s.evidence,quote:s.quote})):selected?.crossChecks?.length?fieldDeskChecks(selected,allRows).flatMap(check=>check.sources.flatMap(source=>source.evidence)):selected?fieldComparison(selected,allRows,state).evidence:[];
  const translation=useRoundTranslations(state,query.data,evidence);
  const translationStatus=useEvidenceTranslationGeneration(state,translation.data,!query.isPending&&!query.error&&!translation.isFetching&&!translation.error);
  const translationProps={referenceRoundId:state.readOnly&&state.roundId?state.roundId:undefined,translationStatus,data:translation.data,translationPending:translation.isFetching,translationError:translation.error};
  if(query.isPending)return <Loading label="正在同步本轮核对数据"/>;
  if(query.error)return <ErrorNotice error={query.error} retry={()=>void query.refetch()}/>;
  const choose=(id:string)=>setParams(current=>{const next=new URLSearchParams(current);next.set('field',id);return next;},{replace:true});
  const personal=rows.some(row=>row.objectRole==='personal_guarantee');
  const selectedStatus=selected?checklistReviewStatus(selected,state):'pending';
  return <div className={`case-field-checklist${personal?' personal-field-desk':''}`}>
    <CorporateSemanticActions rows={corporateRows} progressRows={rows} state={state}/>
    <nav className="field-mobile-jumps" aria-label="审查分栏定位"><a href="#field-index">字段列表</a><a href="#field-review">字段核对</a><a href="#field-evidence">原文与译文</a></nav>
    <div className="field-desk" ref={deskRef}>
      <aside id="field-index" tabIndex={-1} className="field-index" aria-label="完整字段索引">
        <div className="field-index-head"><div className="field-index-title"><h2>{corporateRows.length?'本轮文档核对字段':'完整提取字段'}</h2><span>共 {rows.length} 项</span></div>
          {!state.configuration&&<p className="help-text">请先绑定本轮审核配置，系统才能列出应核对的字段。</p>}
          <Input aria-label="搜索完整字段" placeholder="搜索文件、字段或对象" value={text} onChange={e=>setText(e.target.value)} allowClear/>
          <div className="field-quick-filters" role="group" aria-label="字段快捷筛选">{quickFilters.filter(filter=>filter.key==='all'||filter.key===quick||countFor(filter)>0).map(filter=><button type="button" key={filter.key} title={filter.key==='consistent'?'字面不同，语义一致':undefined} aria-pressed={quick===filter.key} onClick={()=>setQuick(filter.key)}>{filter.label} <span>{countFor(filter)}</span></button>)}</div>
          <details className="field-more-filters"><summary>更多筛选{moreFilterCount ? ` · ${moreFilterCount} 项已启用` : ''}</summary><div>
            {showTypeFilter&&<label className="field-scope-filter">担保类型<Select aria-label="完整字段担保类型" allowClear placeholder="全部类型" value={type} onChange={setType} options={typeOptions}/></label>}
            {showObjectFilter&&<label className="field-scope-filter">核对对象<Select aria-label="完整字段核对对象" allowClear placeholder="全部对象" value={object} onChange={setObject} options={objectOptions}/></label>}
            <label>证据文件<Select aria-label="完整字段证据文件" allowClear placeholder="全部来源（含无来源项）" value={document} onChange={setDocument} options={Object.entries(names).map(([value,label])=>({value,label:`${label} · ${value.slice(0,6)}`}))}/></label>
          </div></details>
          {showResultCount&&<p className="field-filter-count" role="status">找到 {shown.length} {taskMode?`项待办，涉及 ${matched.length} 个字段`:'项'}</p>}
          {quick==='attention'&&Object.values(incompleteCounts).some(Boolean)&&<p className="field-filter-count" role="status">其中未完成：{Object.entries(incompleteCounts).filter(([,count])=>count).map(([key,count])=>`${incompleteReasonLabels[key as keyof typeof incompleteReasonLabels]} ${count}`).join(' · ')}</p>}
        </div>
        <nav aria-label="选择核对字段" className="field-index-list" onKeyDown={event=>{
          if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
          const order=checklistGroups(shown).filter(group=>!collapsedGroups.has(group.key)).flatMap(group=>group.rows.map(row=>row.id));
          const from=(event.target as HTMLElement).closest<HTMLElement>('[data-field-row]')?.dataset.fieldRow??selected?.id??'';
          const at=order.indexOf(from),next=order[Math.min(order.length-1,Math.max(0,at<0?0:at+(event.key==='ArrowDown'?1:-1)))];
          if(!next)return;event.preventDefault();choose(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-field-row="${CSS.escape(next)}"]`)?.focus();
        }}>{checklistGroups(shown).map(group=>{
          const expanded=!collapsedGroups.has(group.key),contentId=`${groupId}-${encodeURIComponent(group.key)}`;
          return <section key={group.key}>
            <h3><Button type="text" className="field-group-toggle" aria-expanded={expanded} aria-controls={contentId} aria-label={`${expanded?'收起':'展开'}${group.label}`} onClick={()=>setCollapsedGroups(current=>{
              const next=new Set(current);if(next.has(group.key))next.delete(group.key);else next.add(group.key);return next;
            })}><span className="field-group-label">{group.label}</span><span className="field-group-chevron" aria-hidden="true"/></Button></h3>
            <div id={contentId} hidden={!expanded}>{group.rows.map(row=>{
              const label=quick==='attention'&&fieldIncompleteReason(row,state)?incompleteReasonLabels[fieldIncompleteReason(row,state)!]:checklistReviewLabel(row,state);
              // The subject repeats on every row of a single-subject group; name it only where the group mixes subjects.
              const subject=row.objectId&&new Set(group.rows.map(entry=>entry.objectId)).size>1?row.objectLabel:undefined;
              return <button type="button" key={row.id} data-field-row={row.id} className={`field-index-item field-item-${row.status} field-review-item-${checklistReviewStatus(row,state)}`} aria-current={selected?.id===row.id?'true':undefined} title={row.objectId?`${checklistFieldLabel(row)} · ${row.objectLabel}`:undefined} onClick={()=>choose(row.id)}><span className="field-index-item-copy"><strong>{checklistFieldLabel(row)}</strong>{subject&&<small>{subject}</small>}</span><span className="field-index-item-status"><span className={`field-status-dot field-status-dot-verified-${checklistReviewStatus(row,state)}`} aria-hidden="true"/>{label}</span></button>;
            })}</div>
          </section>;
        })}</nav>
        {!shown.length&&<p className="field-empty">没有匹配字段，请调整筛选。</p>}
        {indexFooter&&<div className="field-index-foot">{indexFooter}</div>}
      </aside>
      <section id="field-review" tabIndex={-1} className={`field-review${selected?.objectRole==='personal_guarantee'?` personal-review personal-review-${selectedStatus}`:''}`} aria-label="当前字段核对">{selected?<><div className="field-review-heading"><div><p>{query.data?.roundNumber ? `第 ${query.data.roundNumber} 轮 · ` : ''}{selected.materialTypes.map(type=>type.label).join(' / ')}</p><h2>{checklistFieldLabel(selected)}</h2></div><div className="field-review-heading-actions"><span className={`field-review-status field-status-${selected.status} field-verified-${selectedStatus}`}>{checklistReviewLabel(selected,state)}</span><FieldRecheckAction key={selected.id} state={state} rows={members.length?members:[selected]}/>{selected.objectRole==='personal_guarantee'&&<PersonalFieldReviewAction key={selected.id} state={state} rowId={selected.id} hasSources={!!query.data?.documents.some(d=>d.parseRevision&&d.directoryRevision)}/>}</div></div><div className="field-review-body" key={selected.id}>
        {taskMode&&members.length>1&&<p className="help-text">已合并 {members.length} 个字段：{members.map(r=>r.label).join('、')}。同一事项只需处理一次。</p>}
        {checker.error?<p role="status">初审提交记录读取失败，请刷新后重试。</p>:checker.isPending&&state.readOnly&&state.roundId?<p role="status">正在读取初审结果…</p>:<InitialReviewResult row={selected} state={state} checker={checker.data}/>}
        <FieldReview key={selected.id} row={selected} rows={allRows} state={state} names={names} {...actions}/>
      </div></>:<p className="field-empty">选择左侧字段，查看提取值与判断依据。</p>}</section>
      <aside id="field-evidence" tabIndex={-1} className={`field-evidence${selected?.objectRole==='personal_guarantee'&&selectedStatus==='different'?' personal-evidence-different':''}`} aria-label="当前字段原文与译文">{showSavedEvidence?<FieldVerificationEvidence record={savedEvidence!} state={state} {...translationProps}/>:selected?<FieldEvidence key={selected.id} caseId={state.caseId} roundId={state.roundId??(state.legacyView?'legacy':null)} {...translationProps} names={names} evidence={evidence}/>:<p className="field-empty">尚未选择字段。</p>}</aside>
    </div>
  </div>;
}
