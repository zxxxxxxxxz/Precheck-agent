import React,{useRef,useState} from 'react';
import {Button,Checkbox,Form,Input,Modal,Select} from 'antd';
import type {CheckerState,CheckerSubmission,CheckerTarget} from '@hsbc/contracts/review-checker';
import {api,ApiError,newKey,queryClient} from '../../api.ts';
import {ActionModal,ErrorNotice,ReasonField} from '../../ui.tsx';
import {refreshRounds} from '../review/round-controls.tsx';

export type CheckerDialogAction={kind:'assign'|'submit'|'disposition'|'terminate'|'confirm-correction'}|{kind:'note'|'correct'|'confirm';submission:CheckerSubmission};
const titles={assign:'指派独立复核人',submit:'提交本轮复核',note:'添加复核意见',correct:'修改审核结果',confirm:'结束本轮','confirm-correction':'结束本轮',disposition:'记录人工处理依据',terminate:'未完成复核即终止'};
const required=[{required:true,whitespace:true,message:'请填写完整'}];
export function CheckerDialog({action,state,close}:{action:CheckerDialogAction;state:CheckerState;close:()=>void}){
 const [form]=Form.useForm(),[busy,setBusy]=useState(false),[error,setError]=useState<unknown>(),[conflict,setConflict]=useState(false);
 const confirmationReason=({submit:'经办提交本轮审核结果供独立复核',confirm:'复核人确认本轮审核结果', 'confirm-correction':'复核人确认更正后的本轮审核结果',correct:'复核人开始修改本轮审核结果'} as Partial<Record<CheckerDialogAction['kind'],string>>)[action.kind];
 const pending=useRef<{path:string;body:Record<string,unknown>}|undefined>(undefined);
 const kind=Form.useWatch('kind',form)??'manual_satisfied';
 const submission='submission'in action?action.submission:undefined,snapshot=submission?.snapshot as any;
 const targetOptions:Array<{value:string;label:string}>=[{value:'case',label:'本案审核事项'},...(snapshot?.results??[]).map((f:any)=>({value:`finding:${f.evaluationId}`,label:`检查项 · ${state.findings.find(x=>x.id===f.evaluationId)?.label??f.ruleId}`})),...(snapshot?.reviewSnapshot?.facts??[]).map((f:any)=>({value:`field:${f.factId}`,label:`字段 · ${snapshot.reviewSnapshot.objects.find((o:any)=>o.objectId===f.objectId)?.label??'对象'} · ${snapshot.configuration.fields.find((v:any)=>v.id===f.fieldId)?.label??f.fieldId}`})),...(snapshot?.sources??[]).map((d:any)=>({value:`material:${d.id}`,label:`材料 · ${d.filename??d.id.slice(0,8)}`})),...(snapshot?.mail?[{value:`mail:${snapshot.mail.id}`,label:`邮件 · 版本 ${snapshot.mail.version}`}]:[])];
 const target=(value:string):CheckerTarget=>{const [kind,...rest]=value.split(':');return kind==='case'?{kind:'case'}:{kind:kind as CheckerTarget['kind'],id:rest.join(':')};};
 const evidence=(keys:string[]=[])=>keys.map(key=>state.evidenceChoices.find(e=>e.key===key)!.evidence);
 const kinds=[...(state.allowedActions.includes('finding:decide')?[{value:'manual_satisfied',label:'人工判断已满足'}]:[]),...(state.allowedActions.includes('consultation:record')?[{value:'professional_opinion',label:'外部专业意见'}]:[]),...(state.allowedActions.includes('exception:decide')?[{value:'exception',label:'例外决定记录（未配置适用口径时不视为已解决）'}]:[])];
 async function finish(values:any){
  if(conflict||busy)return;setBusy(true);setError(undefined);
  try{
   if(!pending.current){
    const base=`/api/cases/${state.caseId}/checker`,body:Record<string,unknown>={expectedRevision:state.revision,idempotencyKey:newKey(),reason:confirmationReason??(action.kind==='note'?'记录复核意见':action.kind==='assign'?'指派独立复核人':values.reason)};let path=base;
    if(submission)body.submissionVersion=submission.version;
    switch(action.kind){
     case 'assign':path+='/assignment';body.checkerPersonId=values.checkerPersonId;break;
     case 'submit':path+='/submissions';Object.assign(body,{roundId:state.roundId,runId:state.runId,previewHash:state.previewHash});break;
     case 'confirm-correction':path+='/corrections/confirm';Object.assign(body,{roundId:state.roundId,runId:state.runId,previewHash:state.previewHash});break;
     case 'note':path+=`/submissions/${submission!.id}/notes`;Object.assign(body,{target:target(values.target),text:values.text});break;
     case 'correct':case 'confirm':path+=`/submissions/${submission!.id}/${action.kind}`;break;
     case 'terminate':path+='/terminate';body.confirmUnreviewed=values.confirmUnreviewed;break;
     case 'disposition':path+='/dispositions';Object.assign(body,{roundId:state.roundId,runId:state.runId,findingId:values.findingId,kind:values.kind,evidence:evidence(values.evidence),verified:values.verified===true,opinionIds:values.opinionIds??[]});
      for(const key of ['externalAuthor','source','conditions'])if(values[key]?.trim())body[key]=values[key].trim();
      for(const key of ['receivedAt','validUntil'])if(values[key])body[key]=new Date(values[key]).toISOString();break;
    }
    pending.current={path,body};
   }
   await api(pending.current.path,{method:'POST',body:pending.current.body});
   await Promise.all([refreshRounds(state.caseId),queryClient.invalidateQueries({queryKey:['checker']}),queryClient.invalidateQueries({queryKey:['checker-inbox']}),queryClient.invalidateQueries({queryKey:['review-delivery']})]);close();
  }catch(e){setError(e);if(e instanceof ApiError&&e.status>=400&&e.status<500){pending.current=undefined;setConflict(true);}}finally{setBusy(false);}
 }
 if(confirmationReason)return <Modal open title={action.kind==='submit'?'提交本轮复核？':action.kind==='correct'?'修改本轮审核结果？':'结束本轮？'} width={520} okText={conflict?'关闭并刷新':pending.current?'核对上次操作':action.kind==='submit'?'确认提交':action.kind==='correct'?'确认修改':'结束本轮'} cancelText="取消" confirmLoading={busy} closable={!busy} keyboard={!busy} mask={{closable:false}} cancelButtonProps={{disabled:busy}} onCancel={close} onOk={async()=>{if(conflict){await queryClient.invalidateQueries({queryKey:['checker']});close();return;}await finish({});}}>
  <ErrorNotice error={error}/>
  <p>{action.kind==='submit'?`将本轮审核结果提交给${state.summary.displayName??'独立复核人'}审核，未解决事项一并保留。`:action.kind==='correct'?'修改后需重新预审并核对结果，再结束本轮。原初审及提交版本保留。':'结束后完成本轮复核。未解决事项保留原状态，可在下一轮继续处理；案件不会自动完结。'}</p>
 </Modal>;
 return <ActionModal title={titles[action.kind]} okText={conflict?'请刷新后重新操作':pending.current?'核对上次操作':action.kind==='note'?'保存意见':titles[action.kind]} pending={busy||conflict} onCancel={close} onFinish={finish} form={form} width={720} initialValues={{kind:kinds[0]?.value}} warning={action.kind==='terminate'?'此操作不会产生复核通过记录。终止后案件只读。':action.kind==='assign'?'初审经办人不能担任本案复核人；Checker 在复核中可直接更正，指派不代替访问授权。':undefined} error={<><ErrorNotice error={error}/>{!!error&&pending.current&&<p role="status">上次操作结果尚未确认。“核对上次操作”会原样核对同一请求，不会提交新决定；本次输入的改动不会用于该重试。</p>}{conflict&&<Button onClick={async()=>{await queryClient.invalidateQueries({queryKey:['checker']});close();}}>关闭并刷新当前状态</Button>}</>}>
  {action.kind==='assign'&&<><Form.Item label="复核人" name="checkerPersonId" rules={[{required:true,message:'请选择合格复核人'}]}><Select showSearch={{optionFilterProp:'label'}} options={state.candidates.map(p=>({value:p.personId,label:p.displayName,disabled:!p.eligible}))}/></Form.Item><details><summary>查看候选资格与不可指派原因</summary>{state.candidates.map(p=><p key={p.personId}>{p.displayName}：{p.eligible?'当前具备资格':p.reasons.join('；')}</p>)}{!state.candidates.length&&<p>没有可指派人员，请通过现有人员与授权管理配置 BCO 资格、案件范围和复核权限。</p>}</details></>}
  {action.kind==='note'&&<><Form.Item name="target" label="关联事项" rules={required}><Select options={targetOptions}/></Form.Item><Form.Item name="text" label="复核意见" rules={required}><Input.TextArea rows={4} maxLength={4000}/></Form.Item></>}
  {action.kind==='disposition'&&<><Form.Item name="kind" label="记录类型" rules={required}><Select options={kinds}/></Form.Item><Form.Item name="findingId" label="对应检查项" rules={required}><Select showSearch={{optionFilterProp:'label'}} options={state.findings.map(f=>({value:f.id,label:f.label,disabled:kind==='manual_satisfied'&&!f.manualAllowed}))}/></Form.Item><Form.Item name="evidence" label="本轮原文依据" rules={[{required:true,type:'array',min:1,message:'请选择可核对的原文依据'}]}><Select mode="multiple" options={state.evidenceChoices.map(e=>({value:e.key,label:e.label}))}/></Form.Item>
   {kind!=='manual_satisfied'&&<><div className="checker-dialog-fields"><Form.Item name="externalAuthor" label="外部作者／决定人" rules={required}><Input maxLength={300}/></Form.Item><Form.Item name="receivedAt" label="实际收到时间" rules={required}><Input type="datetime-local"/></Form.Item></div><Form.Item name="source" label="来源及批准依据" rules={required}><Input maxLength={1000}/></Form.Item></>}
   <Form.Item name="verified" valuePropName="checked" rules={kind==='manual_satisfied'?[{validator:(_,v)=>v===true?Promise.resolve():Promise.reject(new Error('人工判断须核实依据'))}]:[]}><Checkbox>已核实上述依据及来源</Checkbox></Form.Item>
   {kind==='manual_satisfied'&&<Form.Item name="opinionIds" label="所依赖的专业意见"><Select mode="multiple" options={state.dispositions.filter(d=>d.kind==='professional_opinion').map(d=>({value:d.id,label:`${d.externalAuthor} · ${d.source}`}))}/></Form.Item>}
   <Form.Item name="validUntil" label={kind==='exception'?'有效期至（必须）':'有效期至（如适用）'} rules={kind==='exception'?required:[]}><Input type="datetime-local"/></Form.Item><Form.Item name="conditions" label="适用范围及附加条件" rules={kind==='exception'?required:[]}><Input.TextArea rows={2} maxLength={2000}/></Form.Item>
  </>}
  {action.kind==='terminate'&&<Form.Item name="confirmUnreviewed" valuePropName="checked" rules={[{validator:(_,v)=>v===true?Promise.resolve():Promise.reject(new Error('请确认终止范围'))}]}><Checkbox>确认未完成复核即终止，不表示审核通过</Checkbox></Form.Item>}
  {(action.kind==='disposition'||action.kind==='terminate')&&<ReasonField label={action.kind==='disposition'?'处理结论和理由':'终止原因'}/>}
 </ActionModal>;
}
