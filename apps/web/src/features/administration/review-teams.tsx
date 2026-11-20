import React, {useState} from 'react';
import {Button, Form, Select, Tag} from 'antd';
import {useQuery} from '@tanstack/react-query';
import type {ReviewTeam, ReviewTeamCommand} from '@hsbc/contracts/identity';
import {api, queryClient} from '../../api.ts';
import type {Person} from './types.ts';
import {ActionModal, blocksView, ErrorNotice, Loading, ReasonField, Section} from '../../ui.tsx';

export function ReviewTeams() {
  const [edit,setEdit]=useState<{team?:ReviewTeam}>();
  const [pending,setPending]=useState(false),[error,setError]=useState<unknown>();
  const teams=useQuery({queryKey:['review-teams'],queryFn:({signal})=>api<{items:ReviewTeam[]}>('/api/admin/review-teams',{signal})});
  const people=useQuery({queryKey:['people'],queryFn:({signal})=>api<{items:Person[]}>('/api/admin/people',{signal})});
  const choices=(people.data?.items??[]).filter(p=>p.enabled&&(p.businessRole??p.business_role)==='BCO').map(p=>({value:p.id,label:`${p.displayName} · ${p.id.slice(0,6)}`}));
  const open=(team?:ReviewTeam)=>{setError(undefined);setEdit({team});};
  return <Section title="固定经办与复核搭档" info={<strong>固定经办与复核搭档</strong>} actions={<Button onClick={()=>open()} disabled={teams.isPending||blocksView(teams)||people.isPending||blocksView(people)}>设置固定分工</Button>}>
    <p className="help-text">一次配置经办和 Checker 权限。经办创建新案件时，自动指派对应复核人并开通该案访问权限；同一案件后续轮次沿用。</p>
    <ErrorNotice error={teams.error??people.error} retry={()=>{void teams.refetch();void people.refetch();}}/>
    {teams.isPending?<Loading/>:!blocksView(teams)&&teams.data&&<>{teams.data.items.length?teams.data.items.map(team=><div key={team.makerPersonId}>
      <dl className="case-facts"><div><dt>初审经办</dt><dd>{team.makerName}</dd></div><div><dt>独立复核</dt><dd>{team.checkerName}</dd></div><div><dt>新案件自动指派</dt><dd><Tag>{team.enabled?'已启用':'已停用'}</Tag></dd></div></dl>
      <Button onClick={()=>open(team)}>调整分工</Button>
    </div>):<p>尚未设置固定搭档。</p>}</>}
    {edit&&<ActionModal title={edit.team?'调整固定分工':'设置固定分工'} okText="保存分工" pending={pending} onCancel={()=>setEdit(undefined)} width={640}
      initialValues={{makerPersonId:edit.team?.makerPersonId,checkerPersonId:edit.team?.checkerPersonId,enabled:edit.team?.enabled??true}}
      warning="保存会为两人补齐各自的业务操作权限。仅为新案件自动开通复核访问，不批量改派或开放其他案件。停用自动指派不会撤销已有权限或案件分工。"
      error={<ErrorNotice error={error}/>}
      onFinish={async(values:Omit<ReviewTeamCommand,'expectedVersion'>)=>{setPending(true);setError(undefined);try{
        await api('/api/admin/review-teams',{method:'POST',body:{...values,expectedVersion:edit.team?.version??0}});
        setEdit(undefined);await Promise.all([teams.refetch(),queryClient.invalidateQueries({queryKey:['grants']})]);
      }catch(e){setError(e);}finally{setPending(false);}}}>
      <Form.Item name="makerPersonId" label="初审经办" rules={[{required:true,message:'请选择初审经办人'}]}><Select disabled={!!edit.team} showSearch={{optionFilterProp:'label'}} options={choices.filter(p=>!!edit.team||!teams.data?.items.some(t=>t.makerPersonId===p.value))}/></Form.Item>
      <Form.Item name="checkerPersonId" label="独立复核人（Checker）" dependencies={['makerPersonId']} rules={[{required:true,message:'请选择独立复核人'},({getFieldValue})=>({validator:(_,value)=>value&&value===getFieldValue('makerPersonId')?Promise.reject(new Error('初审与复核必须由不同人员承担')):Promise.resolve()})]}><Select showSearch={{optionFilterProp:'label'}} options={choices}/></Form.Item>
      <Form.Item name="enabled" label="新案件自动指派" rules={[{required:true}]}><Select options={[{value:true,label:'启用'},{value:false,label:'停用'}]}/></Form.Item>
      <p className="help-text">经办负责材料、初审、邮件和提交复核；Checker 负责独立复核，可直接更正字段、重新检查并确认。人员停用或必要权限被撤销后，自动指派会被阻止。</p>
      <ReasonField label="配置原因"/>
    </ActionModal>}
  </Section>;
}
