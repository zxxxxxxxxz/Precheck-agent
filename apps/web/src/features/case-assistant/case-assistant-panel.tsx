import {SupplementResult, SupplementScope} from './supplement-panel.tsx';
import {useSupplements} from './use-supplements.ts';
import {conversationEntries} from './supplement-conversation.ts';
import {QuickPrompts} from './quick-prompts.tsx';
import {promptDrafts} from './prompt-drafts.ts';
import {useAuth} from '../../auth.tsx';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import type {CaseAssistantState} from '@hsbc/contracts/case-assistant';
import {App, Button, Drawer, Input, Segmented} from 'antd';
import {Bubble, Sender} from '@ant-design/x';
import {Link, useLocation, useNavigate, useSearchParams} from 'react-router';
import type {CaseAssistCard, CaseAssistFieldValueProposal, CaseAssistGuidanceProposal, CaseAssistLegalPoint, CaseAssistPage, CaseAssistProposalView, CaseAssistTarget, CaseAssistTurnView} from '@hsbc/contracts/case-assistant';
import {SEMANTIC_GUIDANCE_KIND_LABELS, type CaseGuidance, type GuidanceDigestView} from '@hsbc/contracts/review-guidance';
import type {ReviewState} from '@hsbc/contracts/review';
import {errorText, newKey} from '../../api.ts';
import {palette, semantic} from '../../theme.ts';
import {blocksView, ErrorNotice, Loading} from '../../ui.tsx';
import {can} from '../identity/permissions.ts';
import {evidenceUrl} from '../review/presentation.ts';
import {applyProposal, cancelProposal, cancelTurn, loadedFieldLabel, recheckGuided, refreshAfterRule, refreshConversation, requestDigest, retireGuidance, sendTurn, withdrawFieldValue, useAssistantReview, useAssistantState, useCaseDigests} from './api.ts';
import {useOpenDocument, type OpenDocument} from './focus.ts';
import {quoteText} from './quote-text.ts';
import './case-assistant.css';

const unavailable: Record<string, string> = {
  case_assistant_disabled: '案件助手未开启。', case_assistant_policy_expired: '案件助手的出站授权已到期，请联系管理员。',
  case_assistant_case_not_authorized: '本案不在案件助手的授权范围内。仅使用合成验证配置的案件，或已列明的案件可以使用。', review_configuration_required: '请先为本案选择审核配置。',
};
const categoryLabels: Record<CaseAssistLegalPoint['category'], string> = {assumption: '假设前提', condition: '生效前提与后续事项', qualification: '保留与限制', baseline: '触及底线'};
const proposalStates: Record<CaseAssistProposalView['state'], string> = {pending: '', applied: '已记为本案规则', canceled: '未采用', expired: '已过期，请重新描述', stale: '审核配置已变化，请重新描述', superseded: '已被后面的建议替代'};
const fieldValueStates: Record<CaseAssistProposalView['state'], string> = {pending: '', applied: '', canceled: '未采用', expired: '已过期，请重新提问', stale: '审核配置已变化，请重新提问', superseded: '已被后面的建议替代'};
const digestStates: Record<GuidanceDigestView['state'], string> = {pending: '整理中', running: '整理中', ready: '待规则审批人处理', adopted: '已发布到规则中心', declined: '规则中心未采纳', failed: '整理未完成'};
/** Why a message got no answer, in the reviewer's terms. Unlisted codes fall back to a plain retry prompt. */
const turnFailures: Record<string, string> = {
  egress_denied: '这条消息有内容没能通过隐私处理，没有发送给模型。可以换一种说法再试。',
  budget_exhausted: '案件助手的用量额度已用完，请联系管理员。',
  call_budget_exhausted: '这次要发送的内容超过单次额度。请缩短问题，或先取消“当前文件”。',
  input_budget_exhausted: '这次要发送的内容过长。请缩短问题，或先取消“当前文件”。',
  provider_rejected: '模型没有接受这次请求，请换一种说法再试。',
  invalid_output: '模型的回答不符合格式要求，已丢弃。', truncated: '模型的回答不完整，已丢弃。',
  assistant_turn_abandoned: '这条消息没有被处理，请重新发送。',
  assistant_legal_material_required: '本轮尚未采用法律意见书材料。',
};
// Answers sit flat on the canvas; only the reviewer's own words are boxed.
const bubbleRoles = {
  user: {placement: 'end' as const, styles: {root: {paddingBlock: 6}, content: {padding: '6px 10px', minHeight: 0, fontSize: 14, lineHeight: '22px', background: semantic.chatUserBackground, color: palette.text}}},
  assistant: {placement: 'start' as const, variant: 'borderless' as const, styles: {root: {paddingBlock: 6, paddingInlineEnd: 0}, content: {padding: 0, minHeight: 0, fontSize: 14, lineHeight: '22px', color: palette.text}, body: {maxWidth: '100%', flex: 1}}},
};
// The kit's own rules outrank class selectors, so the compact sizes go through its style slots.
const senderStyles = {content: {padding: '2px 6px 6px 12px'}, input: {fontSize: 14, lineHeight: '22px'}};
type PageHint = Omit<CaseAssistPage, 'documentId'>;
type Ask = (text: string, mode?: 'chat' | 'legal_opinion') => Promise<void>;
const busy = (turn: CaseAssistTurnView) => turn.state === 'pending' || turn.state === 'running';

/** Page hints sent with each message; the server re-reads everything with the user's own access. */
function usePage(): PageHint {
  const {pathname} = useLocation();const [params] = useSearchParams();
  const round = params.get('round');const roundId = round && round !== 'legacy' ? round : null;
  const tab = /^\/cases\/[^/]+\/([^/?]+)/.exec(pathname)?.[1];
  const reader = tab === 'review' && (params.get('mode') === 'reader' || ['document', 'anchor', 'sourceNode'].some(key => params.has(key)));
  const view: CaseAssistPage['view'] = tab === 'review' ? reader ? 'reader' : 'desk' : tab === 'reports' || tab === 'collaboration' ? 'result' : pathname === '/cases' ? 'materials' : 'other';
  return {view, roundId, rowId: view === 'desk' ? params.get('field') : null};
}

export function CaseAssistantPanel({caseId, open, onClose}: {caseId: string; open: boolean; onClose: () => void}) {
  const page = usePage();
  const {session} = useAuth();
  const [view, setView] = useState<'chat' | 'rules'>('chat');
  const assistant = useAssistantState(caseId, open);
  const review = useAssistantReview(caseId, page.roundId, open);
  const active = review.data?.guidance?.filter(rule => rule.status === 'active') ?? [];
  const round = review.data?.roundNumber ? `第 ${review.data.roundNumber} 轮${review.data.readOnly ? ' · 只读' : ''}` : null;
  return <Drawer className="case-assistant" rootClassName="case-assistant-root" placement="right" size={420} open={open} onClose={onClose} mask={false} destroyOnHidden={false}
    title={<span className="case-assistant-title">案件助手{round && <span>{round}</span>}</span>}
    classNames={{body: 'case-assistant-body'}} styles={{header: {padding: '8px 12px 8px 8px'}, body: {padding: 0}}}
    extra={<Segmented size="small" value={view} onChange={value => setView(value as 'chat' | 'rules')} options={[{value: 'chat', label: '对话'}, {value: 'rules', label: active.length ? `本案规则 ${active.length}` : '本案规则'}]}/>}>
{view === 'chat' ? <Conversation key={`${session.user?.accountId}:${caseId}:${review.data?.roundId ?? page.roundId ?? 'current'}`} caseId={caseId} page={page}
      state={blocksView(assistant) ? undefined : assistant.data} loading={assistant.isPending} error={assistant.error}
      review={blocksView(review) ? undefined : review.data} reviewError={review.error} onRefreshReview={() => void review.refetch()} active={open} onLocate={onClose}/>
      : <Rules caseId={caseId} review={review.data} loading={review.isPending}/>}
  </Drawer>;
}

function Conversation({caseId, page, state, loading, error, review, reviewError, onRefreshReview, active, onLocate}: {caseId: string; page: PageHint; state?: CaseAssistantState; loading: boolean; error: unknown; review?: ReviewState; reviewError: unknown; onRefreshReview: () => void; active: boolean; onLocate: () => void}) {
  const [input, setInput] = useState('');const [sending, setSending] = useState<{clientTurnId: string; text: string}>();const [failure, setFailure] = useState<unknown>();
  const [extracting, setExtracting] = useState(false);
  const [draftMode, setDraftMode] = useState<'chat' | 'legal_opinion'>('chat');
  const [detached, setDetached] = useState<string>();
  const list = useRef<React.ComponentRef<typeof Bubble.List>>(null);
  const sender = useRef<React.ComponentRef<typeof Sender>>(null);
  const sendingRef = useRef(false);
  const open = useOpenDocument(caseId);
  const attached = open && detached !== open.documentId ? open : undefined;
  const supplement = useSupplements(caseId, review?.roundId ?? page.roundId, review?.revision, active, open?.documentId);
  const fieldLabel = open ? undefined : loadedFieldLabel(caseId, page.rowId);
  const turns = state?.available ? state.turns : [];
  const jobs = supplement.data?.items ?? [];
  const working = turns.some(busy);
  const allowed = !!state?.available && !!state.allowedActions.includes('assistant:ask') && !error;
  const local = sending && !turns.some(turn => turn.clientTurnId === sending.clientTurnId) ? sending : undefined;
  const entries = conversationEntries(turns, jobs);
  const tail = entries.map(entry => `${entry.kind}:${entry.id}:${entry.kind === 'chat' ? entry.turn.state : entry.job.state}`).join('|') + (local?.clientTurnId ?? '');
  useEffect(() => {if (list.current?.scrollBoxNativeElement) list.current.scrollTo({top: 'bottom'});}, [tail]);
  const send: Ask = async (text, mode = 'chat') => {
    const message = text.trim();
    if (!message || sendingRef.current || supplement.sending || working || !allowed) return;
    const typed = input.trim() === message, clientTurnId = newKey();
    sendingRef.current = true;setExtracting(false);
    setSending({clientTurnId, text: message});setFailure(undefined);if (typed) setInput('');
    const hint: CaseAssistPage = {view: open ? 'reader' : page.view, roundId: page.roundId, rowId: open ? null : page.rowId, documentId: attached?.documentId ?? null};
    try {await sendTurn(caseId, clientTurnId, message, hint, mode);if (typed) setDraftMode('chat');await refreshConversation();}
    catch (reason) {setFailure(reason);if (typed) setInput(current => current || message);}
    finally {sendingRef.current = false;setSending(undefined);}
  };
  const submit = async (text: string) => {
    if (!extracting) {await send(text, draftMode);return;}
    if (sendingRef.current) return;
    if (await supplement.send(text)) setInput(current => current === text ? '' : current);
  };
  const items = [
    ...entries.flatMap(entry => {
      if (entry.kind === 'supplement') return [
        {key: `supplement:${entry.id}:user`, role: 'user', content: <p className="case-assistant-text">{entry.job.request}</p>},
        {key: `supplement:${entry.id}:assistant`, role: 'assistant', content: <SupplementResult job={entry.job} item={{id: caseId, revision: review?.revision ?? 0, selectedRoundId: review?.roundId ?? page.roundId}} documents={supplement.data?.documents ?? []} onLocate={onLocate}/>},
      ];
      const turn = entry.turn;
      return [
        {key: `${turn.id}:user`, role: 'user', content: <p className="case-assistant-text">{turn.text}</p>},
        {key: `${turn.id}:assistant`, role: 'assistant', content: <Answer caseId={caseId} turn={turn} state={state!} review={review} send={send}
          retry={turn.id === turns.at(-1)?.id && allowed && !working && !sending && !supplement.sending ? () => void send(turn.text, turn.mode) : undefined}/>},
      ];
    }),
    ...(local ? [{key: `${local.clientTurnId}:user`, role: 'user', content: <p className="case-assistant-text">{local.text}</p>},
      {key: `${local.clientTurnId}:assistant`, role: 'assistant', content: <p className="case-assistant-working" role="status">正在发送</p>}] : []),
  ];
  const locked = !!sending || supplement.sending;
  const prompts = [
    {key: 'supplement', label: '提取补充字段', disabled: locked, selected: extracting},
    ...(attached ? [{key: 'file', label: '这份文件写了什么'}] : []),
    ...(page.rowId && !open ? [{key: 'explain', label: '解释这项结论'}] : []),
    {key: 'wrong', label: '这项判断不对'}, {key: 'summary', label: '总结本轮结果'}, {key: 'legal', label: '法律意见书要点'}, {key: 'rules', label: '整理本次口径'},
  ].map(item => ({...item, disabled: item.key === 'supplement' ? locked : !allowed || working || locked}));
  const about = extracting ? <SupplementScope supplement={supplement} currentDocumentId={open?.documentId}/>
    : open || fieldLabel ? <About open={open} attached={!!attached} fieldLabel={fieldLabel} disabled={!allowed || locked}
      onToggle={() => setDetached(current => open && current !== open.documentId ? open.documentId : undefined)}/> : undefined;
  return <div className="case-assistant-chat">
    {items.length ? <Bubble.List ref={list} className="case-assistant-messages" role={bubbleRoles} items={items}/> : <div className="case-assistant-empty">
      <h3>直接说出你的判断</h3>
      <p>问当前文件、核对字段，或说出你对本轮结果的判断。</p>
      <p>需要自定义提取时，点击“提取补充字段”，选择文件后直接在这里说出要求。</p>
      <p>口径经你确认后才记为本案规则；补充提取不改变正式审核结论。</p>
    </div>}
    <div className="case-assistant-compose">
      <QuickPrompts items={prompts} onSelect={key => {
        if (key === 'supplement') {setExtracting(value => !value);setDraftMode('chat');setInput('');setFailure(undefined);sender.current?.focus();return;}
        const draft = promptDrafts[key];
        if (!draft) return;
        setExtracting(false);setDraftMode(draft.mode);setInput(draft.text);setFailure(undefined);sender.current?.focus();
      }}/>
      {!extracting && (loading ? <p className="case-assistant-note" role="status">正在读取对话</p> : error ? <ErrorNotice error={error} retry={() => void refreshConversation()}/>
        : !state?.available ? <p className="case-assistant-note" role="status">{unavailable[state?.reason ?? ''] ?? '案件助手暂不可用。'}</p> : null)}
      {extracting && <ErrorNotice error={reviewError} retry={onRefreshReview}/>}
      <ErrorNotice error={supplement.query.error} retry={() => void supplement.query.refetch()}/>
      {(extracting ? supplement.error : failure) !== undefined && <p className="case-assistant-error" role="alert">{errorText(extracting ? supplement.error : failure)}</p>}
      <Sender ref={sender} className="case-assistant-sender" styles={senderStyles} header={about} value={input} onChange={value => setInput(value.slice(0, 2000))}
        onSubmit={value => void submit(value)} loading={extracting ? supplement.sending : !!sending || working}
        disabled={extracting ? !!supplement.hint : !allowed} readOnly={locked} autoSize={{minRows: 1, maxRows: 4}}
        placeholder={extracting ? '例如：提取被授权人、授权事项和有效期' : working || sending ? '正在处理上一条消息' : attached ? '问这份文件，或直接说出你的判断' : '例如：借款人两种写法是同一家公司'}/>
    </div>
  </div>;
}

/** Names what the next question is about. The file can be taken off; the selected field follows the page. */
function About({open, attached, fieldLabel, disabled, onToggle}: {open?: OpenDocument; attached: boolean; fieldLabel?: string; disabled: boolean; onToggle: () => void}) {
  return <div className="case-assistant-about">
    <span className="case-assistant-about-label">关于</span>
    {fieldLabel && <span className="case-assistant-subject">字段<strong>{fieldLabel}</strong></span>}
    {open && (attached
      ? <button type="button" className="case-assistant-subject is-file" aria-pressed="true" disabled={disabled} aria-label={`提问带上当前文件 ${open.filename}`} title="点击后，提问不再带这份文件" onClick={onToggle}>当前文件<strong>{open.filename}</strong><span aria-hidden="true">×</span></button>
      : <button type="button" className="case-assistant-subject is-file is-off" aria-pressed="false" disabled={disabled} aria-label={`提问带上当前文件 ${open.filename}`} title={open.filename} onClick={onToggle}>＋ 当前文件</button>)}
  </div>;
}

/** A message that has waited half a minute offers a way out, so the conversation is never held by one message. */
function Working({caseId, turn}: {caseId: string; turn: CaseAssistTurnView}) {
  const [waited, setWaited] = useState(() => Date.now() - Date.parse(turn.createdAt) >= 30_000), [pending, setPending] = useState(false), [failure, setFailure] = useState<unknown>();
  useEffect(() => {
    if (waited) return;
    const timer = setTimeout(() => setWaited(true), Math.max(0, 30_000 - (Date.now() - Date.parse(turn.createdAt))));
    return () => clearTimeout(timer);
  }, [waited, turn.createdAt]);
  const stop = async () => {
    setPending(true);setFailure(undefined);
    try {await cancelTurn(caseId, turn.id);await refreshConversation();} catch (error) {setFailure(error);} finally {setPending(false);}
  };
  return <div role="status">
    <p className="case-assistant-working">正在读取案件并核对</p>
    {waited && <p className="case-assistant-note">等待时间较长。可以继续等待，或取消后重新提问。<Button size="small" loading={pending} onClick={() => void stop()}>取消等待</Button></p>}
    <ErrorNotice error={failure}/>
  </div>;
}
function Answer({caseId, turn, state, review, send, retry}: {caseId: string; turn: CaseAssistTurnView; state: CaseAssistantState; review?: ReviewState; send: Ask; retry?: () => void}) {
  if (busy(turn)) return <Working caseId={caseId} turn={turn}/>;
  if (turn.state === 'canceled') return <p className="case-assistant-note">已取消等待这条消息的回答。</p>;
  if (turn.state === 'unknown') return <p className="case-assistant-note">这条消息的处理结果无法确认，为避免重复发送不会自动重试。请换一种说法重新提问。</p>;
  if (turn.state !== 'ready' || !turn.reply) return <div className="case-assistant-failed" role="status">
    <p className="case-assistant-note">{turnFailures[turn.errorCode ?? ''] ?? '这条消息没有得到回答。'}</p>
    {retry && turn.errorCode !== 'assistant_legal_material_required' && <Button size="small" onClick={retry}>重新发送</Button>}
  </div>;
  return <div className="case-assistant-answer">
    <p className="case-assistant-text">{turn.reply.text}</p>
    {turn.reply.cards.map((card, index) => <Card key={index} caseId={caseId} card={card} state={state} review={review} send={send}/>)}
    {turn.reply.notes.map((note, index) => <p key={index} className="case-assistant-note">{note}</p>)}
  </div>;
}

function Card({caseId, card, state, review, send}: {caseId: string; card: CaseAssistCard; state: CaseAssistantState; review?: ReviewState; send: Ask}) {
  if (card.kind === 'targets' || card.kind === 'choices') return <div className="case-assistant-targets">{card.kind === 'choices' && <p className="case-assistant-question">{card.question}</p>}<ul>{card.items.map(item => <TargetLink key={item.rowId} caseId={caseId} item={item}/>)}</ul></div>;
  if (card.kind === 'proposal') {const proposal = state.proposals.find(item => item.id === card.proposalId);return !proposal ? null : proposal.kind === 'field_value' ? <FieldValueSlip caseId={caseId} proposal={proposal} review={review}/> : <ProposalSlip caseId={caseId} proposal={proposal} review={review}/>;}
  if (card.kind === 'rules') return <div className="case-assistant-rules-card">
    {card.active.length ? <ul>{card.active.map(rule => <li key={rule.id}><strong>{rule.label}</strong>{rule.statement}</li>)}</ul> : <p>本案还没有生效的规则。</p>}
    {card.pendingProposalIds.length > 0 && <p className="case-assistant-note">还有 {card.pendingProposalIds.length} 条口径建议等你确认。</p>}
    {card.nextRunLabels.length > 0 && <p className="case-assistant-note">下次预审将采用：{card.nextRunLabels.join('、')}</p>}
  </div>;
  if (card.kind === 'legal') return <LegalPoints caseId={caseId} card={card}/>;
  if (card.kind === 'quotes') return <figure className="case-assistant-quotes"><figcaption>原文 · {card.filename}</figcaption>
    {card.items.map((item, index) => <blockquote key={index}>{quoteText(item.quote)}{item.evidence && <Link to={evidenceUrl(caseId, item.evidence)}>在原件中定位</Link>}</blockquote>)}</figure>;
  if (card.kind === 'action' && card.action === 'legal_opinion') return <Button size="small" onClick={() => void send('整理法律意见书的假设、生效前提和底线问题', 'legal_opinion')}>{card.label}</Button>;
  if (card.kind === 'action' && card.action === 'rule_digest') return <DigestButton caseId={caseId} label={card.label} allowed={can(review?.allowedActions, 'finding:decide')}/>;
  return null;
}

function TargetLink({caseId, item}: {caseId: string; item: CaseAssistTarget}) {
  const navigate = useNavigate();const [params] = useSearchParams();
  const open = useOpenDocument(caseId);
  // While a file is open, "查看字段" stays in the reader and marks the field in that file's extracted list.
  // Only from other pages does it go to the field's place in the information check.
  const field = open
    ? `/cases/${encodeURIComponent(caseId)}/review?${(() => {const next = new URLSearchParams(params);next.set('mode', 'reader');next.set('document', open.documentId);next.set('field', item.fieldId);
      for (const key of ['anchor', 'sourceNode', 'tab', 'manage']) next.delete(key);return next;})()}`
    : `/cases/${encodeURIComponent(caseId)}/review?${new URLSearchParams({mode: 'business', tab: 'checklist', field: item.rowId, ...(item.roundId ? {round: item.roundId} : {})})}`;
  return <li><span className="case-assistant-target"><strong>{item.label}</strong><span>{item.objectLabel}</span><span className="case-assistant-status">{item.status}</span></span>
    <span className="case-assistant-links"><Button type="link" size="small" onClick={() => navigate(field)}>查看字段</Button>{item.evidence && <Link to={evidenceUrl(caseId, item.evidence)} target="_blank" rel="noreferrer">查看原文</Link>}</span></li>;
}

/** The one place a conversation turns into a durable rule: the reviewer's own words, the rule, its scope. */
/** The other durable outcome of a conversation: a value read from the open file, filled into an empty field once confirmed. */
function FieldValueSlip({caseId, proposal, review}: {caseId: string; proposal: CaseAssistFieldValueProposal; review?: ReviewState}) {
  const [pending, setPending] = useState<'apply' | 'cancel' | 'withdraw'>();const [failure, setFailure] = useState<unknown>();const [withdrawnNow, setWithdrawn] = useState(false);
  // The server says whether the value is still in place; the local flag only covers the moment before the next read.
  const withdrawn = withdrawnNow || proposal.state === 'applied' && proposal.inPlace === false;
  const body = proposal.body, correcting = !!body.replaces?.length;
  const editable = can(review?.allowedActions, 'field:correct') && !review?.readOnly;
  const act = async (kind: 'apply' | 'cancel' | 'withdraw') => {
    if (!review) return;setPending(kind);setFailure(undefined);
    try {
      if (kind === 'apply') await applyProposal(caseId, proposal.id, {contentHash: proposal.contentHash, expectedRevision: review.revision});
      else if (kind === 'cancel') await cancelProposal(caseId, proposal.id);
      else {await withdrawFieldValue(caseId, {documentId: body.documentId, fieldId: body.fieldId, expectedRevision: review.revision, ...(review.roundId ? {roundId: review.roundId} : {})});setWithdrawn(true);}
      await refreshAfterRule(caseId);
    } catch (error) {setFailure(error);} finally {setPending(undefined);}
  };
  return <section className={`case-assistant-slip${proposal.state === 'pending' ? '' : ' is-settled'}`} aria-label="填入字段建议">
    <p className="case-assistant-slip-kind">{correcting ? '更正字段' : '填入字段'} · {body.fieldLabel}<span className="case-assistant-slip-object">{body.objectLabel}</span></p>
    {correcting && <p className="case-assistant-slip-before"><span>现有取值</span>{body.replaces!.map(quoteText).join(' ／ ')}</p>}
    <p className="case-assistant-slip-statement">{quoteText(body.value)}</p>
    <blockquote>{quoteText(body.quote)}<Link to={evidenceUrl(caseId, body.evidence)}>在原件中定位</Link></blockquote>
    <p className="case-assistant-note">来自 {body.filename}。确认后{correcting ? '替换这份文件里该字段的现有取值' : '记为这份文件里该字段的取值'}，当前预审结果需要重新预审。</p>
    {proposal.state === 'pending' ? editable ? <div className="case-assistant-actions">
      <Button type="primary" loading={pending === 'apply'} disabled={!!pending} onClick={() => void act('apply')}>{correcting ? '更正字段' : '填入字段'}</Button>
      <Button disabled={!!pending} loading={pending === 'cancel'} onClick={() => void act('cancel')}>不采用</Button>
    </div> : <p className="case-assistant-note" role="status">{!review ? '正在读取本案的核对信息，读取完成后可以填入。' : review.readOnly ? '当前轮次只读，不能填入字段。' : '你没有更正字段的权限。'}</p>
      : <div className="case-assistant-settled"><p>{proposal.state !== 'applied' ? fieldValueStates[proposal.state] : withdrawn ? `已撤回，${body.fieldLabel}恢复为原来的提取结果。` : `已${correcting ? '更正' : '填入'}${body.fieldLabel}。`}</p>
        {proposal.state === 'applied' && !withdrawn && editable && <Button size="small" loading={pending === 'withdraw'} disabled={!!pending} onClick={() => void act('withdraw')}>{correcting ? '撤回更正' : '撤回填入'}</Button>}</div>}
    {failure !== undefined && <p className="case-assistant-error" role="alert">{errorText(failure)}</p>}
  </section>;
}

function ProposalSlip({caseId, proposal, review}: {caseId: string; proposal: CaseAssistGuidanceProposal; review?: ReviewState}) {
  const [statement, setStatement] = useState(proposal.body.statement);const [pending, setPending] = useState<'apply' | 'cancel' | 'recheck'>();
  const [failure, setFailure] = useState<unknown>();const [receipt, setReceipt] = useState<string>();
  const editable = proposal.state === 'pending' && can(review?.allowedActions, 'finding:decide') && !review?.readOnly;
  const saved = review?.guidance?.find(rule => rule.id === proposal.guidanceId);
  const act = async (kind: 'apply' | 'cancel') => {
    if (!review) return;setPending(kind);setFailure(undefined);
    try {
      if (kind === 'apply') await applyProposal(caseId, proposal.id, {contentHash: proposal.contentHash, expectedRevision: review.revision, ...(statement.trim() !== proposal.body.statement ? {statement: statement.trim()} : {})});
      else await cancelProposal(caseId, proposal.id);
      await refreshAfterRule(caseId);
    } catch (error) {setFailure(error);} finally {setPending(undefined);}
  };
  const recheck = async () => {setPending('recheck');setFailure(undefined);
    try {const result = await recheckGuided(caseId, review?.roundId ?? null);await refreshAfterRule(caseId);
      setReceipt(result.submitted ? `已提交 ${result.submitted} 项含义核对${result.remaining ? `，其余 ${result.remaining} 项打开字段时会自动核对` : ''}。完成后在字段工作台查看结论，再重新预审。` : '暂无需要重新核对的字段；打开相关字段时会自动按新口径核对。');}
    catch (error) {setFailure(error);} finally {setPending(undefined);}};
  return <section className={`case-assistant-slip${proposal.state === 'pending' ? '' : ' is-settled'}`} aria-label="口径建议">
    <blockquote>{proposal.body.quote}</blockquote>
    <p className="case-assistant-slip-kind">{SEMANTIC_GUIDANCE_KIND_LABELS[proposal.body.kind]}{proposal.body.replacesLabel ? `，替换${proposal.body.replacesLabel}` : ''}</p>
    {editable ? <Input.TextArea aria-label="口径内容" value={statement} onChange={event => setStatement(event.target.value)} autoSize={{minRows: 2, maxRows: 5}} maxLength={500}/> : <p className="case-assistant-slip-statement">{saved?.statement ?? proposal.body.statement}</p>}
    <dl>
      {proposal.body.fieldLabels.length > 0 && <><dt>适用字段</dt><dd>{proposal.body.fieldLabels.join('、')}</dd></>}
      {proposal.body.expressions.length > 0 && <><dt>相关写法</dt><dd>{proposal.body.expressions.map(text => <span key={text} className="case-assistant-expression">{text}</span>)}</dd></>}
    </dl>
    {proposal.notes.map((note, index) => <p key={index} className="case-assistant-note">{note}</p>)}
    {proposal.state === 'pending' ? editable ? <div className="case-assistant-actions">
      <Button type="primary" loading={pending === 'apply'} disabled={!!pending || statement.trim().length < 4} onClick={() => void act('apply')}>记为本案规则</Button>
      <Button disabled={!!pending} loading={pending === 'cancel'} onClick={() => void act('cancel')}>不采用</Button>
    </div> : <p className="case-assistant-note" role="status">{!review ? '正在读取本案的核对信息，读取完成后可以确认。' : review.readOnly ? '当前轮次只读，口径需在可编辑的轮次中确认。' : '你没有确认本案规则的权限。'}</p>
      : <div className="case-assistant-settled"><p>{proposal.state === 'applied' && saved ? `已记为${saved.label}。当前预审结果需要重新预审。` : proposalStates[proposal.state]}</p>
        {proposal.state === 'applied' && !review?.readOnly && <Button size="small" loading={pending === 'recheck'} disabled={!!pending} onClick={() => void recheck()}>按新口径重新核对</Button>}
        {receipt && <p className="case-assistant-note" role="status">{receipt}</p>}</div>}
    {failure !== undefined && <p className="case-assistant-error" role="alert">{errorText(failure)}</p>}
  </section>;
}

function LegalPoints({caseId, card}: {caseId: string; card: Extract<CaseAssistCard, {kind: 'legal'}>}) {
  const groups = (Object.keys(categoryLabels) as CaseAssistLegalPoint['category'][]).map(category => ({category, points: card.points.filter(point => point.category === category)})).filter(group => group.points.length);
  return <div className="case-assistant-legal">
    {card.documents.length > 0 && <p className="case-assistant-note">依据：{card.documents.join('、')}</p>}
    {groups.map(group => <section key={group.category}><h4>{categoryLabels[group.category]}</h4><ul>{group.points.map((point, index) => <li key={index}>
      <p>{point.summary}{point.baselineLabel && <span className="case-assistant-baseline">{point.baselineLabel}</span>}</p>
      <blockquote>{quoteText(point.quote)}</blockquote>
      {point.evidence && <Link to={evidenceUrl(caseId, point.evidence)} target="_blank" rel="noreferrer">在{point.filename}中查看</Link>}
    </li>)}</ul></section>)}
    {!card.points.length && <p>没有找到需要提示的条目。</p>}
    {card.limitations.map((note, index) => <p key={index} className="case-assistant-note">{note}</p>)}
    <p className="case-assistant-footnote">以上为需人工判断的提示，不代表通过或不通过。</p>
  </div>;
}

function DigestButton({caseId, label, allowed}: {caseId: string; label: string; allowed: boolean}) {
  const [pending, setPending] = useState(false);const [result, setResult] = useState<string>();const [failure, setFailure] = useState<unknown>();
  if (!allowed) return <p className="case-assistant-note">提交规则中心需要确认本案规则的权限。</p>;
  return <div className="case-assistant-digest"><Button size="small" loading={pending} disabled={pending || !!result} onClick={async () => {setPending(true);setFailure(undefined);
    try {const digest = await requestDigest(caseId);setResult(`已整理 ${digest.body?.entries.length ?? 0} 条口径，等待规则审批人在规则中心处理。`);await refreshAfterRule(caseId);} catch (error) {setFailure(error);} finally {setPending(false);}}}>{label}</Button>
    {result && <p className="case-assistant-note" role="status">{result}</p>}{failure !== undefined && <p className="case-assistant-error" role="alert">{errorText(failure)}</p>}</div>;
}

function Rules({caseId, review, loading}: {caseId: string; review?: ReviewState; loading: boolean}) {
  const {modal} = App.useApp();
  const digests = useCaseDigests(caseId, !!review);
  const [failure, setFailure] = useState<unknown>();
  const rules = review?.guidance ?? [];
  const active = rules.filter(rule => rule.status === 'active'), retired = rules.filter(rule => rule.status === 'retired');
  const fields = useMemo(() => new Map((review?.configuration?.fields ?? []).map(field => [field.id, field.label])), [review?.configuration]);
  const editable = can(review?.allowedActions, 'finding:decide') && !review?.readOnly;
  if (loading) return <Loading label="正在读取本案规则"/>;
  if (!review) return null;
  const retire = (rule: CaseGuidance) => {let reason = '';modal.confirm({title: `停用${rule.label}？`, okText: '停用', cancelText: '取消',
    content: <><p>停用后，依据这条规则的结论会恢复原判断，当前预审结果需重新预审。</p><Input.TextArea aria-label="停用原因" maxLength={300} onChange={event => {reason = event.target.value;}} placeholder="说明停用原因"/></>,
    onOk: async () => {if (!reason.trim()) throw new Error('reason');setFailure(undefined);try {await retireGuidance(caseId, rule.id, {expectedRevision: review.revision, ...(review.roundId ? {roundId: review.roundId} : {}), reason: reason.trim()});await refreshAfterRule(caseId);} catch (error) {setFailure(error);}}});};
  return <div className="case-assistant-rules">
    {review.configuration?.label && <p className="case-assistant-rules-config">审核配置<span>{review.configuration.label}</span></p>}
    <p className="case-assistant-note">本案规则跟随案件，换人接手仍然有效；只影响文字含义的核对，金额、币种、日期和编号仍逐字核对。</p>
    {failure !== undefined && <p className="case-assistant-error" role="alert">{errorText(failure)}</p>}
    {active.length ? <ol className="case-assistant-rule-list">{active.map(rule => <li key={rule.id}>
      <div className="case-assistant-rule-head"><strong>{rule.label}</strong><span>{SEMANTIC_GUIDANCE_KIND_LABELS[rule.kind]}</span>{editable && <Button type="link" size="small" onClick={() => retire(rule)}>停用</Button>}</div>
      <p>{rule.statement}</p>
      {(rule.fieldIds.length > 0 || rule.expressions.length > 0) && <p className="case-assistant-rule-scope">{rule.fieldIds.length > 0 && `字段：${rule.fieldIds.map(id => fields.get(id) ?? id).join('、')}`}{rule.fieldIds.length > 0 && rule.expressions.length > 0 && '；'}{rule.expressions.length > 0 && `写法：${rule.expressions.join('｜')}`}</p>}
      <p className="case-assistant-rule-meta">{rule.origin.kind === 'assistant' ? '经案件助手确认' : '手动添加'}{rule.createdByName ? `，${rule.createdByName}` : ''}{rule.roundNumber ? `，第 ${rule.roundNumber} 轮` : ''}{rule.adoptions.length ? `，已纳入规则中心版本 ${rule.adoptions.map(item => item.releaseId).join('、')}` : ''}</p>
    </li>)}</ol> : <p className="case-assistant-empty-rules">还没有本案规则。在对话里说出你的判断，确认后会出现在这里。</p>}
    {retired.length > 0 && <details className="case-assistant-retired"><summary>已停用 {retired.length} 条</summary><ul>{retired.map(rule => <li key={rule.id}><strong>{rule.label}</strong>{rule.statement}<span>{rule.retireReason}</span></li>)}</ul></details>}
    <section className="case-assistant-digests" aria-labelledby="case-assistant-digests-title">
      <h4 id="case-assistant-digests-title">提交规则中心</h4>
      <p className="case-assistant-note">确认预审结果时，本轮实际用到的规则会自动整理，交由规则审批人决定是否纳入后续案件。</p>
      {can(review.allowedActions, 'finding:decide') && <DigestButton caseId={caseId} label="现在整理本案规则" allowed/>}
      {digests.data?.items.length ? <ul>{digests.data.items.map(digest => <li key={digest.id}><span>{digest.trigger === 'manual' ? '手动整理' : `第 ${digest.roundNumber ?? '-'} 轮确认时整理`}，{digest.body?.entries.length ?? 0} 条</span><span className="case-assistant-status">{digestStates[digest.state]}{digest.adoption?.releaseId && digest.state === 'adopted' ? `：${digest.adoption.releaseId}` : ''}</span></li>)}</ul> : null}
    </section>
  </div>;
}
