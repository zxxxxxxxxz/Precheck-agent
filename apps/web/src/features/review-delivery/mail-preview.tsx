import React,{useState} from 'react';
import {Segmented,Table} from 'antd';
import type {TableColumnsType} from 'antd';
import type {MailBody,MailDraft,MailFormat,MailRow} from '@hsbc/contracts/review-delivery';
import {omittedMailReplies,currentMailFollowUp,mailCoverageNotice,isGroupedMailTemplate,MAIL_FOLLOWUP_COLORS,mailDisplayRows,type MailDisplayRow} from '@hsbc/contracts/review-delivery';

// The result workspace shows all frozen conclusions in the mockup's grouped table.
// Copying still uses the server's outward-facing projection, never the DOM.

/** File-type groups in mail order with their open and needs-judgement counts; ids anchor the preview rows. */
export function mailGroupSummary(body:MailBody){
  const groups=new Map<string,{id:string;label:string;open:number;confirm:number;total:number}>();
  for(const row of mailDisplayRows(body,true)){
    const entry=groups.get(row.group)??{id:`mail-group-${groups.size+1}`,label:row.group,open:0,confirm:0,total:0};
    entry.total++;if(row.tone==='open')entry.open++;if(row.tone==='confirm')entry.confirm++;
    groups.set(row.group,entry);
  }
  return [...groups.values()];
}
export function mailToneLabels(body:MailBody){
  return ['pre-review-mail.v4','pre-review-mail.v5'].includes(body.templateVersion)?{open:'发现问题',confirm:'需要人工判断'}:{open:'未解决',confirm:'待确认'};
}
type ToneFilter='all'|'open'|'confirm';
export function MailPreview({body,format,validity='current',showSubject=true,showAllChecks=false}:{body:MailBody;format:MailFormat;validity?:MailDraft['validity'];showSubject?:boolean;showAllChecks?:boolean}) {
  const [page,setPage]=useState(1),[toneFilter,setToneFilter]=useState<ToneFilter>('all');
  const incomplete=body.templateVersion==='pre-review-mail.v5'?mailDisplayRows(body,true).filter(r=>r.tone==='incomplete'):[];
  const coverage=showAllChecks&&body.templateVersion==='pre-review-mail.v5'
    ?[incomplete.length?`本轮仍有 ${incomplete.length} 项检查未完成，不代表全部检查通过。`:'','表内保留全部检查结果；复制邮件仅包含已识别的问题及需要人工判断的事项。'].filter(Boolean).join('\n')
    :mailCoverageNotice(body);
  const notice=[validity==='stale'?'历史草稿：来源已有更新，仅供回查。':validity==='history'?'历史轮次草稿，仅适用于所列轮次。':'',body.notice,coverage].filter(Boolean).join('\n');
  const displayRows=mailDisplayRows(body,showAllChecks);
  // Filtering only narrows the preview; spans are recomputed so each visible group keeps its file-type cell.
  const visibleRows=toneFilter==='all'?displayRows:displayRows.filter(row=>row.tone===toneFilter).map((row,index,rows)=>{
    if(index>0&&rows[index-1]!.group===row.group)return {...row,rowSpan:0};
    const end=rows.findIndex((other,at)=>at>index&&other.group!==row.group);
    return {...row,rowSpan:(end<0?rows.length:end)-index};
  });
  const anchors=new Map(mailGroupSummary(body).map(group=>[group.label,group.id]));
  const toneCounts={open:displayRows.filter(row=>row.tone==='open').length,confirm:displayRows.filter(row=>row.tone==='confirm').length},toneLabels=mailToneLabels(body);
  if(format==='documents'&&isGroupedMailTemplate(body.templateVersion))return <div className={`mail-preview mail-preview-grouped${showAllChecks?' mail-preview-report':''}`}>
    {showSubject&&<div className="mail-subject"><span>邮件标题</span><h3>{body.subject}</h3></div>}
    <p className="mail-caption">邮件正文预览</p><p className="mail-context">客户／案件：{body.caseLabel}</p><p className="mail-preview-cell mail-notice">{notice}</p>
    {!showAllChecks&&!!incomplete.length&&<details className="mail-incomplete"><summary>检查未完成 · {incomplete.length} 项（不计入人工待办，不进入邮件逐项反馈）</summary><ul>{incomplete.map(row=><li key={row.key}>{row.action}</li>)}</ul></details>}
    {(toneCounts.open>0||toneCounts.confirm>0)&&<div className="mail-tone-filter"><Segmented<ToneFilter> size="small" aria-label="按跟进状态筛选预览" value={toneFilter} onChange={setToneFilter} options={[{value:'all',label:`全部 ${displayRows.length}`},...(toneCounts.open?[{value:'open' as const,label:`${toneLabels.open} ${toneCounts.open}`}]:[]),...(toneCounts.confirm?[{value:'confirm' as const,label:`${toneLabels.confirm} ${toneCounts.confirm}`}]:[])]}/>{toneFilter!=='all'&&<span>仅筛选预览，复制的邮件仍包含全部事项</span>}</div>}
    <Table<MailDisplayRow> className="delivery-table mail-table mail-table-grouped" bordered rowKey="key" dataSource={visibleRows} onRow={row=>row.rowSpan>0?{id:anchors.get(row.group)}:{}} pagination={false} scroll={{x:780}} classNames={{header:{cell:'mail-table-heading'}}}
      locale={{emptyText:body.templateVersion==='pre-review-mail.v5'?'本轮暂无已识别的问题或人工待办；检查完成情况以上述范围说明为准。':'本轮暂无可展示的预审事项，请核对检查范围；此草稿不代表业务批准。'}} columns={[
        {title:'文件类型',dataIndex:'group',width:176,className:'mail-condition',onCell:row=>({rowSpan:row.rowSpan}),render:value=><span className="mail-preview-cell">{value}</span>},
        {title:'信贷运营部 回复',dataIndex:'action',render:value=><span className="mail-preview-cell">{value}</span>},
        {title:'跟进',dataIndex:'followUp',width:184,onCell:row=>({style:MAIL_FOLLOWUP_COLORS[row.tone],className:'mail-followup'}),render:value=><span className="mail-preview-cell">{value}</span>},
      ]}/>
    {!!omittedMailReplies(body)&&<p className="mail-preview-cell">{omittedMailReplies(body)}</p>}
  </div>;
  const condition:TableColumnsType<MailRow>[number]={title:'文件／条件',key:'condition',width:260,className:'mail-condition',
    render:(_,row)=><span className="mail-preview-cell">{`${row.documentLabels.join('、')||'材料待确认'}\n${row.objectLabel} · ${row.ruleLabel}`}</span>};
  const columns:TableColumnsType<MailRow>=format==='rounds'?[
    {title:'序号',key:'number',width:72,render:(_,row)=>body.rows.indexOf(row)+1},
    condition,
    ...body.rounds.flatMap((round,index)=>[
      {title:`${round.label}：问题及所需行动`,key:`action-${index}`,width:300,render:(_:unknown,row:MailRow)=><span className="mail-preview-cell">{row.cells[index]?.action}</span>},
      {title:'客户经理回复',key:`reply-${index}`,width:260,render:(_:unknown,row:MailRow)=><span className="mail-preview-cell">{row.cells[index]?.reply||'尚无已选定的外部回复'}</span>},
    ]),
  ]:[
    condition,
    {title:'本轮跟进事项',key:'action',width:350,render:(_,row)=><span className="mail-preview-cell">{row.cells.at(-1)?.action}</span>},
    {title:'回复／跟进状态',key:'reply',width:300,onCell:row=>({className:`mail-followup mail-followup-${row.cells.at(-1)?.issueStatus??'unrecorded'}`}),render:(_,row)=>{
      const cell=row.cells.at(-1);
      return <span className="mail-preview-cell">{[cell?.reply||'尚无已选定的外部回复',cell?.issueStatus==='resolved'?'问题记录已关闭':cell?.issueStatus==='acknowledged'?'已记录，仍须按要求核对':cell?.issueStatus?'问题记录待处理':'未记录问题处置'].join('\n')}</span>;
    }},
  ];
  return <div className="mail-preview">
    {showSubject&&<div className="mail-subject"><span>邮件标题</span><h3>{body.subject}</h3></div>}
    <p className="mail-caption">邮件正文预览</p>
    <p className="mail-context">客户／案件：{body.caseLabel}</p><p className="mail-preview-cell mail-notice">{notice}</p>
    <Table<MailRow> className="delivery-table mail-table" bordered classNames={{header:{cell:'mail-table-heading'}}} rowKey="key" dataSource={!showAllChecks&&body.templateVersion==='pre-review-mail.v5'?body.rows.filter(r=>['open','confirm'].includes(currentMailFollowUp(r.cells.at(-1)).tone)):body.rows} columns={columns}
      scroll={{x:format==='rounds'?332+560*body.rounds.length:910}}
      pagination={{current:page,pageSize:10,showSizeChanger:false,hideOnSinglePage:true,onChange:setPage}}
      locale={{emptyText:'当前结果中没有列出的待跟进事项。请核对检查范围及人工要求；此草稿不代表业务批准。'}}/>
    {!!omittedMailReplies(body)&&<p className="mail-preview-cell">{omittedMailReplies(body)}</p>}
  </div>;
}
