import React,{useEffect,useRef,useState} from 'react';
import {Button,Modal} from 'antd';
import {useNavigate} from 'react-router';
import type {ReviewState} from '@hsbc/contracts/review';
import {api,ApiError,errorText,newKey,queryClient} from '../../api.ts';
import {caseMaterialsPath,reviewResultsPath} from '../cases/workspace-navigation.ts';
import {isReviewRunning} from './presentation.ts';
import './start-review.css';

export function StartReviewButton({state,primary=true,label='开始预审'}:{state:ReviewState;primary?:boolean;label?:string}){
  const navigate=useNavigate();
  const [pending,setPending]=useState(false),[confirming,setConfirming]=useState(false),[error,setError]=useState<unknown>();
  const busy=useRef(false),attempt=useRef<{revision:number;key:string}|undefined>(undefined),controller=useRef<AbortController|undefined>(undefined);
  const allowed=!state.readOnly&&state.allowedActions.includes('case:start');
  const roundId=state.roundId??(state.legacyView?'legacy':null);
  useEffect(()=>{
    busy.current=false;attempt.current=undefined;setPending(false);setConfirming(false);setError(undefined);
    return()=>{controller.current?.abort();controller.current=undefined;};
  },[state.caseId,roundId]);
  useEffect(()=>{if(!pending&&!allowed)setConfirming(false);},[allowed,pending]);
  if(!allowed)return null;
  const running=state.runs.some(run=>isReviewRunning(run.state));
  const inputsProcessing=error instanceof ApiError&&error.code==='review_round_inputs_processing';
  // Query refresh must never keep a completed submission locked or replace its error.
  const refresh=()=>Promise.allSettled(['review-rounds','case-review','case','cases','workbench','materials','review-checklist'].map(name=>queryClient.invalidateQueries({queryKey:[name]})));
  const start=async()=>{
    if(busy.current||running||!state.configurationReleaseId)return;
    busy.current=true;setPending(true);setError(undefined);
    const control=new AbortController();controller.current=control;
    try{
      attempt.current=attempt.current?.revision===state.revision?attempt.current:{revision:state.revision,key:newKey()};
      await api<ReviewState>(`/api/cases/${state.caseId}/review/start`,{method:'POST',signal:control.signal,body:{expectedRevision:state.revision,idempotencyKey:attempt.current.key,...(state.roundId?{roundId:state.roundId}:{})}});
      if(control.signal.aborted)return;
      setConfirming(false);
      navigate(reviewResultsPath(state.caseId,roundId));
    }catch(failure){if(!control.signal.aborted)setError(failure);}
    finally{
      if(controller.current===control&&!control.signal.aborted){
        busy.current=false;setPending(false);void refresh();
      }
    }
  };
  const close=()=>{if(!busy.current){setConfirming(false);setError(undefined);}};
  const confirm=()=>{
    if(busy.current)return;
    if(inputsProcessing){close();navigate(caseMaterialsPath(state.caseId,roundId));}
    else void start();
  };
  return <div className="start-review-action"><Button type={primary?'primary':'default'} loading={pending} disabled={!state.configurationReleaseId||running} title={!state.configurationReleaseId?'请先选择审核配置':running?'本轮审查正在执行':undefined} onClick={()=>{setError(undefined);setConfirming(true);}}>{label}</Button>
    {confirming&&<Modal className="start-review-dialog" title={state.roundsEnabled?'开始本轮预审':label} open width={480}
      onCancel={close} closable={!pending} keyboard={!pending} mask={{closable:false}} destroyOnHidden
      onOk={confirm} okText={inputsProcessing?'查看本轮材料':error?'重试预审':'确认开始预审'} cancelText={error?'关闭':'暂不开始'}
      confirmLoading={pending} cancelButtonProps={{disabled:pending}} okButtonProps={{disabled:!inputsProcessing&&(!state.configurationReleaseId||running)}}>
      <div className="start-review-content" onKeyDown={event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();confirm();}}}>
        {error?<div className="start-review-error" role="alert">
          <p className="start-review-error-title">{inputsProcessing?'本轮材料仍在处理中':'暂未完成预审请求'}</p>
          <p>{inputsProcessing?'本轮仍有上传、解析或检查任务未结束。请先查看材料处理状态，待任务完成或取消后，再开始预审。':errorText(error)}</p>
          {error instanceof ApiError&&error.requestId&&<details><summary>错误详情</summary><span>请求编号：{error.requestId}</span></details>}
        </div>:<>
          <p className="start-review-lead">将使用当前材料与核对依据，生成{state.roundsEnabled?'本轮':''}预审结果。</p>
          <dl className="start-review-expectations">
            <div><dt>执行期间</dt><dd>暂不能修改材料，请确认本轮文件已准备完整。</dd></div>
            <div><dt>结果生成后</dt><dd>{state.roundsEnabled?'可继续更正。确认初审结果后提交独立复核，复核确认后结束本轮。':'可查看预审结果并继续核对。'}</dd></div>
          </dl>
        </>}
      </div>
    </Modal>}
  </div>;
}
