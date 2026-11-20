import React, {useState} from 'react';
import {Button, Checkbox, Form, Input, Segmented, Select, Table} from 'antd';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router';
import type {ReviewEvidence, ReviewState} from '@hsbc/contracts/review';
import type {SignatureConfirmation, SignatureObservation, SignatureRequirement, SignatureRequirementRecord, SignatureReviewProjection} from '@hsbc/contracts/signature-review';
import {SignatureConfirmationCommandSchema} from '@hsbc/contracts/signature-review';
import {api, ApiError, newKey, queryClient} from '../../api.ts';
import type {CaseSummary} from '../cases/types.ts';
import {ActionModal, Blank, blocksView, ErrorNotice, ReasonField} from '../../ui.tsx';
import {formatTime} from '../../shared/format.ts';
import {EvidencePicker} from '../../pages/review-loop.tsx';
import {SignatureRequirementEditor} from '../review/signature-requirement-editor.tsx';
import {OcrMarkClues} from './ocr-mark-clues.tsx';
import type {DocumentOcrMark, DocumentOcrMarkPage} from './types.ts';
import {observationLabels, requirementExpressionText, signatureObservationSummary, signatureReason, signatureRequirementCoverageNotice, signatureRoleLabel, signatureRows, signatureRowNeedsAttention, signatureRowResult, signatureStatusLabels, type SignatureRow} from './signature-presentation.ts';

type SourceRenderer = (ids: string[], pages: number[]) => React.ReactNode;
type ConfirmationChoice = {action: SignatureConfirmation['action']; observation?: SignatureObservation; requirement?: SignatureRequirementRecord};
const running = (status?: string) => status === 'running' || status === 'pending';
const actionLabels = {accept: '确认观察', exclude: '排除观察', adopt_requirement: '采用签署要求', exclude_requirement: '排除签署要求', set_transaction: '核对交易条件'};
const finalMarkLabels = {handwriting: '签字', stamp: '印章', blank_signing_slot: '空白签署栏', printed_name: '打印姓名', uncertain: '无法判断'};
const inputRequired = [{required: true, message: '请选择此项'}];
export function SignatureCrop({observation, base}: {observation: SignatureObservation; base: string}) {
  const {box, imageWidth, imageHeight} = observation;
  const valid = [box.x, box.y, box.width, box.height, imageWidth, imageHeight].every(Number.isFinite) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= imageWidth && box.y + box.height <= imageHeight;
  const [failed, setFailed] = useState(false);
  if (!valid || failed) return <p className="muted">裁剪图暂不可用，请查看原页。</p>;
  return <svg className="signature-crop" role="img" aria-label={`第 ${observation.pageNumber} 页${observationLabels[observation.kind]}区域`} viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}><title>签署区域原图</title><image href={`${base}/pages/${observation.pageNumber}/image?parseRevision=${encodeURIComponent(observation.parseRevision)}`} width={imageWidth} height={imageHeight} onError={() => setFailed(true)}/></svg>;
}
export function SignatureReviewPanel({item, base, review, ocrMarkPages, historical, isProcessing, selectedReviewId, onReviewChange, onObservation, onOcrMark, source, refresh}: {item: CaseSummary; base: string; review?: SignatureReviewProjection; ocrMarkPages?: readonly DocumentOcrMarkPage[]; historical: boolean; isProcessing: boolean; selectedReviewId?: string; onReviewChange: (value?: string) => void; onObservation: (value: SignatureObservation) => void; onOcrMark: (page: DocumentOcrMarkPage, mark?: DocumentOcrMark) => void; source: SourceRenderer; refresh: () => Promise<unknown>}) {
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(), [key, setKey] = useState(newKey);
  const [filter, setFilter] = useState<'attention' | 'all'>('attention');
  const [choice, setChoice] = useState<ConfirmationChoice>();
  const state = useQuery({queryKey: ['signature-case-objects', item.id, item.revision], queryFn: ({signal}) => api<ReviewState>(`/api/cases/${encodeURIComponent(item.id)}/review`, {signal}), enabled: !!review?.reviewId});
  const business = blocksView(state) ? undefined : state.data;
  const rows = signatureRows(review);
  const requirementCoverageNotice = signatureRequirementCoverageNotice(review?.coverage);
  const needsAttention = signatureRowNeedsAttention;
  const attentionCount = rows.filter(needsAttention).length;
  const mutable = !!review && !historical && review.validity === 'current';
  const canConfirm = mutable && review.allowedActions.includes('confirm') && !pending && !isProcessing;
  const command = async (kind: 'check' | 'cancel') => {
    if (!review || pending) return;
    setPending(true); setError(undefined);
    try {
      if (kind === 'cancel' && review.jobId) await api(`/api/tool-jobs/${encodeURIComponent(review.jobId)}/cancel`, {method: 'POST'});
      else await api(`${base}/signatures/check`, {method: 'POST', body: {...(item.selectedRoundId&&item.selectedRoundId!=='legacy'?{roundId:item.selectedRoundId}:{}),expectedRevision: item.revision, expectedDirectoryRevision: review.directoryRevision, parseRevision: review.parseRevision, idempotencyKey: key, reason: '重新核对本份材料的签字、盖章及签署要求'}});
      setKey(newKey()); await refresh();
    } catch (failure) {setError(failure);} finally {setPending(false);}
  };
  const confirmed = (observation: SignatureObservation) => review?.confirmations.filter(value => value.observationId === observation.id).at(-1);
  const showChoice = (value: ConfirmationChoice) => {setError(undefined); setChoice(value);};
  const observationSource = (observation: SignatureObservation) => <Button type="link" className="link-button" onClick={() => onObservation(observation)} aria-label={`定位第 ${observation.pageNumber} 页${observationLabels[observation.kind]}区域`}>p{observation.pageNumber}</Button>;
  const detail = (row: SignatureRow) => <div className="signature-detail">
    {row.requirement && <section><strong>{row.requirement.requirement.label}</strong><p>{requirementExpressionText(row.requirement.requirement.expression)}</p><p className="muted">{row.requirement.source === 'published_configuration' ? '已发布配置' : row.requirement.status === 'adopted' ? '原文条款 · 已采用' : '原文条款 · 待采用'}</p>{row.requirement.clauseText && <p className="evidence-excerpt">{row.requirement.clauseText}</p>}{source(row.requirement.anchorIds, row.requirement.pageNumbers)}
      {canConfirm && row.requirement.source === 'document_clause' && <div className="signature-row-actions"><Button size="small" onClick={() => showChoice({action: 'adopt_requirement', requirement: row.requirement})}>{row.requirement.status === 'adopted' ? '更正要求' : '核对并采用'}</Button><Button size="small" onClick={() => showChoice({action: 'exclude_requirement', requirement: row.requirement})}>排除</Button></div>}
    </section>}
    {row.check && row.check.reasonCodes.length > 0 && <p className="muted">{[...new Set(row.check.reasonCodes.map(signatureReason))].join('；')}</p>}
    {row.observations.map(observation => {const confirmation = confirmed(observation); const identity = confirmation?.identity; return <section key={observation.id} className="signature-observation"><div className="signature-observation-heading"><strong>第 {observation.pageNumber} 页 · {confirmation?.action === 'accept' ? finalMarkLabels[confirmation.observedKind ?? observation.kind] : observationLabels[observation.kind]}</strong><span className="muted">{confirmation?.action === 'accept' ? '已人工确认' : confirmation?.action === 'exclude' ? '已排除' : '待人工确认'}</span></div><SignatureCrop observation={observation} base={base}/>{observationSource(observation)}
      {identity && <p>{business?.objects.find(value => value.objectId === identity.personId)?.label ?? '已确认签署人'} · {signatureRoleLabel(identity.role)}<br/>代表 {business?.objects.find(value => value.objectId === identity.subjectId)?.label ?? signatureRoleLabel(identity.subjectRole)}</p>}
      {canConfirm && <div className="signature-row-actions"><Button size="small" onClick={() => showChoice({action: 'accept', observation})}>{confirmation ? '更正确认' : '核对观察'}</Button><Button size="small" onClick={() => showChoice({action: 'exclude', observation})}>排除</Button></div>}
    </section>;})}
  </div>;
  return <div className="signature-review">{review && review.history.length > 1 && <label className="signature-record-picker">检查记录<Select aria-label="选择签署检查记录" value={selectedReviewId ?? 'latest'} onChange={value => onReviewChange(value === 'latest' ? undefined : value)} options={[{value: 'latest', label: '最新检查'}, ...review.history.map(record => ({value: record.reviewId, label: `${formatTime(record.createdAt)} · ${signatureStatusLabels[record.status as keyof typeof signatureStatusLabels] ?? '历史记录'}`}))]}/></label>}<div className="signature-review-toolbar"><span role="status">{review ? signatureStatusLabels[review.status] : '尚未检查'}{review && running(review.status) && ` · ${review.coverage.completedPages.length} / ${review.coverage.expectedPages} 页`}</span><div className="signature-row-actions">
    {review?.allowedActions.includes('cancel') && mutable && <Button size="small" disabled={pending} loading={pending} onClick={() => void command('cancel')}>取消检查</Button>}
    {review?.allowedActions.includes('check') && !historical && <Button size="small" loading={pending && !running(review.status)} disabled={pending || isProcessing || running(review.status)} onClick={() => void command('check')}>{review.status === 'not_started' ? '检查签署' : review.status === 'failed' || review.status === 'canceled' ? '重试检查' : '重新检查签署'}</Button>}
  </div></div><ErrorNotice error={error} retry={() => void refresh()}/>
    {historical || review?.validity !== 'current' && review?.reviewId ? <p className="muted">历史签署记录，仅供回查。</p> : null}
    {review && !review.enabled && <p className="muted">签署图像检查暂未开放。</p>}
    {review?.errorCode && <p className="tone-warning">本次检查未完成，请重新查询状态后重试。</p>}
    {requirementCoverageNotice && <p className="tone-warning" role="status">{requirementCoverageNotice}</p>}
    {rows.length ? <><Segmented<'attention' | 'all'> block className="signature-filter" aria-label="签署检查筛选" value={filter} onChange={setFilter} options={[{value: 'attention', label: `待核对 ${attentionCount}`}, {value: 'all', label: `全部 ${rows.length}`}]}/><Table<SignatureRow> rowKey="id" size="small" tableLayout="fixed" pagination={false} className="signature-table" scroll={{x: 560}} dataSource={rows.filter(row => filter === 'all' || needsAttention(row))} columns={[
      {title: '主体', key: 'subject', width: '18%', render: (_, row) => row.subjectId ? business?.objects.find(value => value.objectId === row.subjectId)?.label ?? signatureRoleLabel(row.subjectRole) : row.subjectRole && row.subjectRole !== 'unassigned' ? signatureRoleLabel(row.subjectRole) : <span className="muted">待关联</span>},
      {title: '要求', key: 'requirement', width: '25%', render: (_, row) => row.requirement ? requirementExpressionText(row.requirement.requirement.expression) : <span className="muted">待核对要求</span>},
      {title: '观察', key: 'observation', render: (_, row) => signatureObservationSummary(row.observations, review?.confirmations)},
      {title: '结果', key: 'result', width: 90, render: (_, row) => <span className={needsAttention(row) ? 'tone-warning' : undefined}>{signatureRowResult(row)}</span>},
      {title: '来源', key: 'source', width: 68, render: (_, row) => row.observations.length ? <span className="source-links">{row.observations.map(observation => <React.Fragment key={observation.id}>{observationSource(observation)}</React.Fragment>)}</span> : source(row.anchorIds, row.pageNumbers)},
    ]} expandable={{columnWidth: 28, expandedRowRender: detail}}/></> : <Blank title={review?.reviewId ? '没有待核对的签署记录' : '尚无签署图像检查记录'}/>}
    {canConfirm && review?.reviewId && <div className="signature-row-actions signature-transaction-action"><Button size="small" onClick={() => showChoice({action: 'set_transaction'})}>核对交易条件</Button></div>}
    <OcrMarkClues pages={ocrMarkPages} onSource={onOcrMark}/>
    {review?.coverage.uncertainPages.length ? <details className="signature-coverage"><summary>{review.coverage.uncertainPages.length} 页需核对清晰度或覆盖范围</summary>{review.coverage.uncertainPages.map(page => <span key={page}>{source([], [page])}</span>)}</details> : null}
    {review?.confirmations.length ? <details className="signature-history"><summary>人工确认记录 {review.confirmations.length}</summary>{review.confirmations.map(record => {const observation = review.observations.find(value => value.id === record.observationId); return <section key={record.id}><p><strong>{actionLabels[record.action]}</strong> · {formatTime(record.createdAt)}<br/>{record.reason}</p>{observation && <details><summary>查看原始观察</summary><p>模型原始观察：{observationLabels[observation.kind]}{record.observedKind && <>；人工核对：{finalMarkLabels[record.observedKind]}</>}</p><SignatureCrop observation={observation} base={base}/>{observationSource(observation)}{canConfirm && confirmed(observation)?.id === record.id && <Button size="small" onClick={() => showChoice({action: 'accept', observation})}>更正确认</Button>}</details>}</section>;})}</details> : null}
    {choice && review && <SignatureConfirmationDialog key={`${review.reviewId}:${choice.action}:${choice.observation?.id ?? choice.requirement?.requirement.id ?? ''}`} item={item} base={base} review={review} choice={choice} business={business} businessError={state.error} close={() => setChoice(undefined)} done={async () => {setChoice(undefined); await queryClient.invalidateQueries({queryKey: ['case', item.id]}); await queryClient.invalidateQueries({queryKey: ['signature-case-objects', item.id]}); await refresh();}} source={source}/>}
  </div>;
}
function SignatureConfirmationDialog({item: liveItem, base, review: liveReview, choice, business, businessError, close, done, source}: {item: CaseSummary; base: string; review: SignatureReviewProjection; choice: ConfirmationChoice; business?: ReviewState; businessError: unknown; close: () => void; done: () => Promise<void>; source: SourceRenderer}) {
  const [item] = useState(liveItem), [review] = useState(liveReview);
  const [form] = Form.useForm();
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(), [key, setKey] = useState(newKey);
  const previous = review.confirmations.filter(value => value.observationId && value.observationId === choice.observation?.id).at(-1);
  const [withIdentity, setWithIdentity] = useState(Boolean(previous?.identity)), [withAuthorization, setWithAuthorization] = useState(Boolean(previous?.identity?.authorization));
  const [authorizationEvidence, setAuthorizationEvidence] = useState<ReviewEvidence[]>(() => (business?.objects.flatMap(value => value.evidence) ?? []).filter(value => value.anchorId && previous?.identity?.authorization?.sourceAnchorIds.includes(value.anchorId)));
  const [requirement, setRequirement] = useState<SignatureRequirement | undefined>(choice.requirement?.requirement);
  const mutable = liveReview.validity === 'current' && liveReview.reviewId === review.reviewId && liveReview.inputSha256 === review.inputSha256 && liveReview.allowedActions.includes('confirm') && liveItem.revision === item.revision;
  const currentObjects = business?.objects.filter(object => object.validity === 'current' && object.evidence.length > 0) ?? [];
  const people = currentObjects.filter(object => object.kind === 'signatory'), subjects = currentObjects.filter(object => object.kind === 'party');
  const lastFacts = review.confirmations.filter(value => value.action === 'set_transaction').at(-1)?.transactionFacts;
  const businessLink = `/cases/${encodeURIComponent(item.id)}/review?mode=business`;
  return <ActionModal title={actionLabels[choice.action]} okText={actionLabels[choice.action]} pending={pending} onCancel={close} form={form} error={<ErrorNotice error={error}/>} summary={<><p>{choice.observation ? `第 ${choice.observation.pageNumber} 页 · ${observationLabels[choice.observation.kind]}` : choice.requirement?.requirement.label}</p>{choice.observation && <SignatureCrop observation={choice.observation} base={base}/>}<p className="muted">{choice.action === 'accept' ? '只确认可见图像；人员与授权需另有原文依据。' : choice.action === 'adopt_requirement' ? '核对条款和适用主体后采用。' : ''}</p></>} initialValues={{observedKind: previous?.observedKind ?? choice.observation?.kind, personId: previous?.identity?.personId, subjectId: previous?.identity?.subjectId, validFrom: previous?.identity?.authorization?.validFrom, validUntil: previous?.identity?.authorization?.validUntil, maxAmount: previous?.identity?.authorization?.maxAmount, authorizationCurrency: previous?.identity?.authorization?.currency, transactionTypes: previous?.identity?.authorization?.transactionTypes, date: lastFacts?.date ?? undefined, amount: lastFacts?.amount ?? undefined, currency: lastFacts?.currency ?? undefined, transactionType: lastFacts?.transactionType ?? undefined}} onValuesChange={() => setKey(newKey())} onFinish={async values => {
    if (!mutable) {setError(new ApiError(409, 'stale_signature_review', '记录已更新，请关闭后重新核对。')); return;}
    let identity;
    if (choice.action === 'accept' && withIdentity) {
      const person = people.find(value => value.objectId === values.personId), subject = subjects.find(value => value.objectId === values.subjectId);
      if (!person || !subject || withAuthorization && !authorizationEvidence.length) {setError(new ApiError(400, 'signature_identity_incomplete', '请补齐人员、主体及所选授权依据。')); return;}
      identity = {personId: person.objectId, subjectId: subject.objectId, subjectRole: subject.role, role: person.role, authorization: withAuthorization ? {sourceAnchorIds: authorizationEvidence.flatMap(value => value.anchorId ? [value.anchorId] : []), validFrom: values.validFrom || null, validUntil: values.validUntil || null, maxAmount: values.maxAmount || null, currency: values.authorizationCurrency || null, transactionTypes: values.transactionTypes ?? []} : null};
    }
    const payload = SignatureConfirmationCommandSchema.safeParse({...(item.selectedRoundId&&item.selectedRoundId!=='legacy'?{roundId:item.selectedRoundId}:{}),expectedRevision: item.revision, idempotencyKey: key, reason: values.reason, reviewId: review.reviewId, expectedInputSha256: review.inputSha256, action: choice.action,
      ...(choice.observation ? {observationId: choice.observation.id} : {}), ...(choice.requirement ? {requirementId: choice.requirement.requirement.id} : {}), ...(identity ? {identity} : {}), ...(choice.action === 'accept' ? {observedKind: values.observedKind} : {}),
      ...(choice.action === 'adopt_requirement' ? {requirement} : {}), ...(choice.action === 'set_transaction' ? {transactionFacts: {date: values.date || null, amount: values.amount || null, currency: values.currency || null, transactionType: values.transactionType || null}} : {}),
    });
    if (!payload.success) {setError(new ApiError(400, 'signature_input_invalid', '请检查填写内容；金额使用数字，币种使用三位大写代码。')); return;}
    setPending(true); setError(undefined);
    try {await api(`${base}/signatures/confirm`, {method: 'POST', body: payload.data}); await done();} catch (failure) {setError(failure);} finally {setPending(false);}
  }}>
    {!mutable && <p className="tone-warning">记录已更新，请关闭后重新核对。</p>}
    {choice.observation && source(choice.observation.anchorIds, [choice.observation.pageNumber])}
    {choice.action === 'accept' && <><Form.Item name="observedKind" label="实际观察" rules={inputRequired}><Select options={Object.entries(finalMarkLabels).map(([value, label]) => ({value, label}))}/></Form.Item><Checkbox checked={withIdentity} onChange={event => {setWithIdentity(event.target.checked); setKey(newKey());}}>关联已确认的人员和主体</Checkbox>
      {withIdentity && <><ErrorNotice error={businessError}/>{(!people.length || !subjects.length) && <p>请先在<Link to={businessLink} onClick={close}>业务核对</Link>确认签署人、代表主体及原文依据。</p>}<div className="signature-editor-grid"><Form.Item name="personId" label="签署人" rules={inputRequired}><Select showSearch={{optionFilterProp: 'label'}} options={people.map(person => ({value: person.objectId, label: `${person.label} · ${signatureRoleLabel(person.role)}`}))}/></Form.Item><Form.Item name="subjectId" label="代表主体" rules={inputRequired}><Select showSearch={{optionFilterProp: 'label'}} options={subjects.map(subject => ({value: subject.objectId, label: `${subject.label} · ${signatureRoleLabel(subject.role)}`}))}/></Form.Item></div><Checkbox checked={withAuthorization} onChange={event => {setWithAuthorization(event.target.checked); setKey(newKey());}}>登记授权依据及条件</Checkbox>
        {withAuthorization && <><div className="signature-editor-grid"><Form.Item name="validFrom" label="授权起始日"><Input type="date"/></Form.Item><Form.Item name="validUntil" label="授权截止日"><Input type="date"/></Form.Item><Form.Item name="maxAmount" label="授权金额上限"><Input inputMode="decimal"/></Form.Item><Form.Item name="authorizationCurrency" label="授权币种"><Input maxLength={3} placeholder="CNY"/></Form.Item><Form.Item name="transactionTypes" label="允许的交易范围"><Select mode="tags" options={[{value: 'mortgage', label: '抵押'}, {value: 'loan', label: '贷款'}, {value: 'guarantee', label: '担保'}]}/></Form.Item></div>{business && <EvidencePicker item={item} state={business} pageOnly value={authorizationEvidence} onChange={value => {setAuthorizationEvidence(value); setKey(newKey());}}/>}</>}
      </>}
    </>}
    {choice.action === 'adopt_requirement' && requirement && <>{choice.requirement?.clauseText && <p className="evidence-excerpt">{choice.requirement.clauseText}</p>}{source(choice.requirement?.anchorIds ?? [], choice.requirement?.pageNumbers ?? [])}<SignatureRequirementEditor value={requirement} onChange={value => {setRequirement(value); setKey(newKey());}} disabled={pending} lockScope taxonomyOptions={[]} sourceOptions={[]}/></>}
    {choice.action === 'set_transaction' && <div className="signature-editor-grid"><Form.Item name="date" label="本次签署日期"><Input type="date"/></Form.Item><Form.Item name="amount" label="本次交易金额"><Input inputMode="decimal"/></Form.Item><Form.Item name="currency" label="交易币种"><Input maxLength={3} placeholder="CNY"/></Form.Item><Form.Item name="transactionType" label="交易类型"><Select allowClear options={[{value: 'mortgage', label: '抵押'}, {value: 'loan', label: '贷款'}, {value: 'guarantee', label: '担保'}]}/></Form.Item></div>}
    <ReasonField label="核对依据"/>
  </ActionModal>;
}
