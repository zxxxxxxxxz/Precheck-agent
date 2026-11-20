import React from 'react';
import {Form,Select} from 'antd';
import {GUARANTEE_LABELS,guaranteeSelectionKey} from '@hsbc/contracts/mixed-guarantee';
import type {ReviewState} from '@hsbc/contracts/review';
import {materialIdentification} from '../materials/processing.ts';
import {reviewBankMaterialChecklist} from '../materials/bank-material-checklist.ts';

/** Selection changes the bound release, never builds a configuration in the browser. */
export function ConfigurationPicker({state}:{state:ReviewState}) {
  const form=Form.useFormInstance();
  const types=Form.useWatch('guaranteeTypes',form) as string[]|undefined;
  const typesEditable=state.roundNumber===1&&!state.readOnly&&state.allowedActions.includes('case:configure');
  const selected=typesEditable?types??state.guaranteeTypes??[]:state.guaranteeTypes??[];
  const supported=new Set(['corporate_guarantee','personal_guarantee','mortgage',...state.availableConfigurations.flatMap(config=>config.guaranteeTypes??[])]);
  const choices=state.availableConfigurations.filter(config=>typesEditable&&(!selected.length||!config.guaranteeTypes)||!!config.guaranteeTypes&&guaranteeSelectionKey(config.guaranteeTypes)===guaranteeSelectionKey(selected));
  return <>
    <Form.Item name="guaranteeTypes" label="担保类型" initialValue={state.guaranteeTypes??[]}>
      <Select mode="multiple" disabled={!typesEditable} placeholder="选择本案担保类型，可同时选择公司和个人" options={Object.entries(GUARANTEE_LABELS).filter(([value])=>supported.has(value)).map(([value,label])=>({value,label}))}
        onChange={()=>form.setFieldValue('releaseId',undefined)}/>
    </Form.Item>
    <Form.Item name="releaseId" label="已发布配置" initialValue={state.configurationReleaseId??undefined} rules={[{required:true,message:'请选择与担保类型匹配的已发布配置'}]}>
      <Select options={choices.map(config=>({value:config.releaseId,label:config.label}))} notFoundContent="没有匹配的已发布配置，请联系配置负责人"/>
    </Form.Item>
  </>;
}

export function MaterialRequirements({state}:{state:ReviewState}){
  if(!state.configuration)return null;
  const materials=reviewBankMaterialChecklist(state);
  const roles=[...new Set(materials.map(material=>material.objectRole))];
  return <details className="review-loop-subpanel"><summary>查看各类担保所需材料</summary>
    {(state.guaranteeTypes?.length??0)>1&&<p>共用授信函上传一份即可；身份证明和签署依据按担保人分别核对。</p>}
    {roles.map(role=><div key={role}><strong>{role==='common'?'共用核对材料':GUARANTEE_LABELS[role]??'本案材料'}</strong><ul>{materials.filter(m=>m.objectRole===role).map(m=><li key={m.id}>{m.label}：{m.condition}</li>)}</ul></div>)}
    <p>按银行材料清单及本轮配置中的授信函列示；列表中保留的文件均参与本轮审核。</p>
  </details>;
}

/** Counts describe adopted files, never infer object coverage or rule satisfaction. */
export function MaterialRequirementsList({state}:{state:ReviewState}) {
  if(!state.configuration)return <p className="muted">选择本轮审核配置后，显示对应材料要求。</p>;
  const identification=materialIdentification(state);
  const materials=reviewBankMaterialChecklist(state);
  const roles=[...new Set(materials.map(m=>m.objectRole))];
  return <div className="workspace-requirements"><p className="muted">{state.configuration.label}</p>{identification.unidentified>0&&<p role="status">本轮已上传 {identification.total} 份文件，其中 {identification.unidentified} 份尚未完成类型识别。识别完成后更新下方清单。</p>}{!materials.length&&<p className="muted">暂无对应的银行材料清单。</p>}{roles.map(role=><section key={role}><h3>{role==='common'?'共用核对材料':GUARANTEE_LABELS[role]??'业务对象材料'}</h3><ul>{materials.filter(m=>m.objectRole===role).map(m=>{
    const adopted=m.taxonomyId?[...new Set(state.materials.filter(a=>a.operation==='adopt'&&a.documentTypeId===m.taxonomyId).map(a=>a.documentVersionId))]:[];
    return <li key={m.id}><strong>{m.label}</strong><span>{m.condition}</span>{m.taxonomyId&&<span>{adopted.length?`已识别 ${adopted.length} 份`:m.reference?'待补':identification.unidentified?'待文件类型识别后确认':'尚未识别到此类型材料'}</span>}</li>;
  })}</ul></section>)}<p className="help-text">按银行材料清单及本轮配置中的授信函列示。共用文件可关联多个对象；材料数量不代表材料齐全，适用条件及缺件以预审检查为准。</p></div>;
}
