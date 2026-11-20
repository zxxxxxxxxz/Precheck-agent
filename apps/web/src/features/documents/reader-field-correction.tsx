import React, {useState} from 'react';
import {Button, Modal, Select} from 'antd';
import {Link} from 'react-router';
import {reviewEvidenceInScope, type ReviewEvidence, type ReviewFact, type ReviewState} from '@hsbc/contracts/review';
import type {CaseSummary} from '../cases/types.ts';
import type {Material} from '../materials/types.ts';
import type {EvidenceAnchor} from './types.ts';
import type {FieldCorrectionTarget} from './personal-guarantor-fields.tsx';
import {can} from '../identity/permissions.ts';
import {ErrorNotice, Loading} from '../../ui.tsx';
import {FactDialog, ObjectDialog, useCaseReview} from '../../pages/review-loop.tsx';

/** Reuse the revisioned review commands; the reader never edits OCR receipts. */
export function ReaderFieldCorrection({item, material, materials, target, parseRevision, directoryRevision, anchors, close}: {item: CaseSummary; material: Material; materials: Material[]; target: FieldCorrectionTarget; parseRevision: string; directoryRevision: string | number; anchors: EvidenceAnchor[]; close: () => void}) {
  const query = useCaseReview(item);
  const [step, setStep] = useState<'choose' | 'object' | 'fact'>('choose');
  const [objectId, setObjectId] = useState<string>();
  const [editing, setEditing] = useState<{state: ReviewState; value?: ReviewFact; objectId: string}>();
  const state = query.data;
  const definition = state?.configuration?.fields.find(field => field.id === target.fieldId);
  const objects = state?.objects.filter(object => object.validity !== 'stale' && object.kind === definition?.objectKind && (!definition?.objectRole || object.role === definition.objectRole)) ?? [];
  const sourceAnchors=anchors.filter(anchor=>target.anchorIds.includes(anchor.anchor_id)&&anchor.document_version_id===material.id&&anchor.parse_revision===parseRevision);
  const adopted = state?.materials.find(entry => entry.operation === 'adopt' && entry.documentVersionId === material.id && (!entry.logicalDocumentId || sourceAnchors.length>0&&sourceAnchors.every(anchor=>{const detail=state.materialDetails?.find(d=>d.documentVersionId===entry.documentVersionId&&d.logicalDocumentId===entry.logicalDocumentId);return !!detail&&reviewEvidenceInScope(detail,anchor);})));
  const current = adopted?.parseRevision === parseRevision && Number(adopted.directoryRevision) === Number(directoryRevision);
  const permitted = !!state && query.loopEnabled && can(state.allowedActions, 'field:correct') && !!definition;
  const evidence: ReviewEvidence[] = current ? anchors.filter(anchor => target.anchorIds.includes(anchor.anchor_id) && anchor.document_version_id === material.id && anchor.parse_revision === parseRevision).map(anchor => ({documentVersionId: material.id, parseRevision, directoryRevision: Number(directoryRevision), anchorId: anchor.anchor_id,materialScope:{logicalDocumentId:adopted!.logicalDocumentId,caseRevision:adopted!.caseRevision}})) : [];
  const old = state?.facts.find(fact => fact.objectId === objectId && fact.fieldId === target.fieldId);
  const draft = {documentId: material.id, pageNumber: target.pageNumber ?? 1, evidence};
  if (state && permitted && current && step === 'object') return <ObjectDialog item={item} state={state} draft={{...draft, label: target.personName}} close={() => {void query.refetch(); setStep('choose');}}/>;
  if (state && permitted && current && step === 'fact' && editing && objects.some(object => object.objectId === objectId)) return <FactDialog item={item} state={editing.state} value={editing.value} draft={{...draft, fieldId: target.fieldId, objectId: editing.objectId, rawValue: target.rawValue}} close={close}/>;
  return <Modal open title={`更正：${target.label}`} onCancel={close} footer={<><Button onClick={close}>取消</Button><Button type="primary" disabled={!permitted || !current || !objects.some(object => object.objectId === objectId)} onClick={() => {if (state && objectId) {setEditing({state, value: old, objectId}); setStep('fact');}}}>继续填写</Button></>}>
    <div className="reader-correction-guide">
      <p>{material.filename}{target.pageNumber ? ` · 第 ${target.pageNumber} 页` : ''}{target.personName ? ` · 签署栏：${target.personName}` : ''}</p>
      <p>选择本次更正属于哪位业务对象，再填写正确值及原文依据。保存将建立人工事实修订，原识别记录保留。</p>
      {query.isPending && query.enabled ? <Loading/> : <ErrorNotice error={query.error} retry={() => void query.refetch()}/>}
      {!query.enabled && <p>当前未开放人工确认。请检查案件权限。</p>}
      {state && !permitted && <p>当前无权更正此字段，或当前配置不包含该字段。</p>}
      {state && permitted && !current && <p>请确认文件仍在本轮清单中，并完成提取与分类后再核对原文依据。</p>}
      {permitted && current && <><Select aria-label="本次更正的业务对象" placeholder="选择属于此人的业务对象" value={objectId} onChange={setObjectId} options={objects.map(object => ({value: object.objectId, label: object.label}))}/><Button onClick={() => setStep('object')}>新增业务对象</Button>{old && <p>该对象已有人工事实，本次将更正已保存的值：{String(old.rawValue ?? '未填写')}{old.validity === 'stale' ? '（原依据已更新）' : ''}。</p>}</>}
      <Link to={`/cases/${item.id}/review?mode=business`}>查看已保存的业务对象与人工事实</Link>
    </div>
  </Modal>;
}
