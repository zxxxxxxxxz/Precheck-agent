import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useIsFetching, useQuery} from '@tanstack/react-query';
import {Button, Checkbox, Input, Modal, Select, Spin} from 'antd';
import type {ReviewState} from '@hsbc/contracts/review';
import {SUBJECT_ROLE_LABELS, type SubjectCandidate, type SubjectConfirmationState, type SubjectRole, type SubjectWorkState} from '@hsbc/contracts/review-subjects';
import {api, ApiError, errorText, newKey, queryClient} from '../../api.ts';
import {useAuth} from '../../auth.tsx';
import {roundQuery} from './round-controls.tsx';
import './subject-confirmation.css';

const base = (caseId: string) => `/api/cases/${encodeURIComponent(caseId)}/review/subjects`;
/** Candidates and the reviewer's decision for the viewed round.
 * One person's reads run one after another on the server, so this several-second read waits until the checklist has loaded
 * instead of queueing behind it and the review state past the server's time limit. */
export function useSubjects(state: Pick<ReviewState, 'caseId' | 'roundId' | 'revision' | 'legacyView'>) {
  const {session} = useAuth();
  const round = state.roundId ?? (state.legacyView ? 'legacy' : null);
  // Wait one tick after mounting so the page's own reads have started, then for them to finish.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {const timer = setTimeout(() => setMounted(true), 0);return () => clearTimeout(timer);}, []);
  const pageLoading = useIsFetching({queryKey: ['review-checklist']}) + useIsFetching({queryKey: ['case-review']}) > 0;
  return useQuery({queryKey: ['case-review-subjects', session.user?.accountId, state.caseId, round ?? 'current', state.revision],
    queryFn: ({signal}) => api<SubjectConfirmationState>(`${base(state.caseId)}${roundQuery(round)}`, {signal}), enabled: mounted && !pageLoading});
}
/** Only what still runs in the current round: a short read, polled while a confirmation waits. */
function useSubjectWork(caseId: string, enabled: boolean) {
  const {session} = useAuth();
  return useQuery({queryKey: ['case-review-subject-work', session.user?.accountId, caseId], enabled, refetchInterval: enabled ? 3000 : false, staleTime: 0,
    queryFn: ({signal}) => api<SubjectWorkState>(`${base(caseId)}/work`, {signal})});
}
const workLabels: Record<string, string> = {upload: '上传', parse_document: '解析', extract_fields: '字段提取', translate_document: '翻译', compare_document_versions: '版本比对',
  review_signatures: '签章核查', formal_review: '正式审查', supplement: '补查'};
/** "02_公司保证书.pdf 翻译；正式审查" — what is still running, by file. */
export const workText = (items: NonNullable<SubjectConfirmationState['inProgress']>) =>
  items.map(item => [item.filename, workLabels[item.kind] ?? '处理'].filter(Boolean).join(' ')).join('；');
const candidateKeys = (data: SubjectConfirmationState) => data.candidates.map(candidate => rowKey(candidate.role, candidate.name)).sort().join('\u0001');

interface Row {key: string; role: SubjectRole; name: string; sources: string; manual: boolean}
const rowKey = (role: SubjectRole, name: string) => `${role}\u0000${name}`;
type Choice = {checked: boolean; primary: string};
/** A suggested writing starts as its own subject, or under the writing of the same company the server offers it with. */
const startingChoice = (candidate: SubjectCandidate): Choice => ({checked: true, primary: rowKey(candidate.role, candidate.sameAs ?? candidate.name)});

/** The reviewer says who the subjects are before any file is attached: pick the names, join the writings of one subject, or type a name. */
export function SubjectConfirmationDialog({state, data, open, close}: {state: ReviewState; data: SubjectConfirmationState; open: boolean; close: () => void}) {
  const [manual, setManual] = useState<Row[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [draft, setDraft] = useState<{role: SubjectRole; name: string}>({role: data.roles[0] ?? 'corporate_guarantee', name: ''});
  const [pending, setPending] = useState(false);const [failure, setFailure] = useState<unknown>();
  // Confirming while work runs would void that work, so the reviewer can ask for the confirmation to be sent once it settles.
  const [queued, setQueued] = useState<string | null>(null);const [changed, setChanged] = useState(false);
  const working = data.inProgress ?? [];
  // Poll the short read; the candidates are read again once, when the work has settled.
  const work = useSubjectWork(state.caseId, open && working.length > 0);
  useEffect(() => {
    if (open && working.length && work.data && !work.data.inProgress.length) void queryClient.invalidateQueries({queryKey: ['case-review-subjects']});
  }, [open, working.length, work.data]);
  const found = useMemo<Row[]>(() => data.candidates.map(candidate => ({key: rowKey(candidate.role, candidate.name), role: candidate.role, name: candidate.name, manual: false,
    sources: [...new Set(candidate.sources.map(source => `${source.filename} · ${source.fieldLabel}`))].join('；')})), [data.candidates]);
  // Start from the last confirmation when there is one, otherwise from the names read from the guarantees themselves.
  // Choices are set when the dialog opens; names that appear while it is open are added without undoing the reviewer's picks.
  const opened = useRef(false);
  useEffect(() => {
    if (!open) {opened.current = false;return;}
    if (opened.current) {
      if (!data.confirmed) setChoices(current => {
        const next = {...current};
        for (const candidate of data.candidates) {const key = rowKey(candidate.role, candidate.name);if (candidate.suggested && !(key in next)) next[key] = startingChoice(candidate);}
        return next;
      });
      return;
    }
    opened.current = true;setQueued(null);setChanged(false);
    const next: Record<string, Choice> = {}, typed: Row[] = [];
    if (data.confirmed) for (const subject of data.confirmed.subjects) {
      const primary = rowKey(subject.role, subject.label);
      for (const name of new Set([subject.label, ...subject.names])) {
        const key = rowKey(subject.role, name);next[key] = {checked: true, primary};
        if (!found.some(row => row.key === key)) typed.push({key, role: subject.role, name, sources: '手动输入', manual: true});
      }
    } else for (const candidate of data.candidates) if (candidate.suggested) next[rowKey(candidate.role, candidate.name)] = startingChoice(candidate);
    setChoices(next);setManual(typed);setFailure(undefined);setDraft(current => ({...current, name: ''}));
  }, [open, data.confirmed, data.candidates, found]);
  const rows = [...found, ...manual.filter(row => !found.some(item => item.key === row.key))];
  const choice = (key: string): Choice => choices[key] ?? {checked: false, primary: key};
  const primaries = (role: SubjectRole) => rows.filter(row => row.role === role && choice(row.key).checked && choice(row.key).primary === row.key);
  const toggle = (row: Row, checked: boolean) => setChoices(current => {
    const next = {...current, [row.key]: {checked, primary: row.key}};
    // Writings joined to a subject that is no longer selected stand on their own again.
    if (!checked) for (const [key, value] of Object.entries(next)) if (value.primary === row.key && key !== row.key) next[key] = {...value, primary: key};
    return next;
  });
  const join = (row: Row, primary: string) => setChoices(current => {
    const next = {...current, [row.key]: {checked: true, primary}};
    if (primary !== row.key) for (const [key, value] of Object.entries(next)) if (value.primary === row.key && key !== row.key) next[key] = {...value, primary};
    return next;
  });
  const add = () => {
    const name = draft.name.trim();if (!name) return;
    const key = rowKey(draft.role, name);
    if (!rows.some(row => row.key === key)) setManual(current => [...current, {key, role: draft.role, name, sources: '手动输入', manual: true}]);
    setChoices(current => ({...current, [key]: {checked: true, primary: key}}));setDraft(current => ({...current, name: ''}));
  };
  const subjects = data.roles.flatMap(role => primaries(role).map(primary => ({role, label: primary.name,
    names: rows.filter(row => row.role === role && choice(row.key).checked && choice(row.key).primary === primary.key).map(row => row.name)})));
  const submit = async () => {
    setPending(true);setFailure(undefined);setChanged(false);
    try {
      await api(base(state.caseId), {method: 'POST', body: {expectedRevision: data.revision ?? state.revision, ...(state.roundId ? {roundId: state.roundId} : {}), idempotencyKey: newKey(), reason: '确认本轮主体', subjects}});
      setQueued(null);
      // The confirmation is recorded; the page reloads in the background instead of keeping the dialog open for it.
      close();
      for (const name of ['case-review', 'review-checklist', 'case-review-subjects', 'review-rounds']) void queryClient.invalidateQueries({queryKey: [name]});
    } catch (error) {
      // Work that started after the dialog last looked: wait for it instead of failing.
      if (error instanceof ApiError && error.code === 'review_round_inputs_processing') {
        // Read the running work before trying again, so the queued confirmation is not resent against the same view.
        setQueued(candidateKeys(data));await queryClient.refetchQueries({queryKey: ['case-review-subjects']});
      }
      else {setQueued(null);setFailure(error);}
    } finally {setPending(false);}
  };
  // Once the work settles, send the queued confirmation, unless the names read from the files changed meanwhile.
  useEffect(() => {
    if (!open || queued === null || working.length || pending) return;
    if (candidateKeys(data) !== queued) {setQueued(null);setChanged(true);return;}
    void submit();
  });
  return <Modal className="subject-confirmation" title="确认本轮主体" open={open} width={720} onCancel={close} destroyOnHidden mask={{closable: false}}
    footer={<><Button onClick={close} disabled={pending}>稍后确认</Button>
      {queued !== null
        ? <Button type="primary" loading>处理完成后自动确认</Button>
        : <Button type="primary" loading={pending} disabled={!subjects.length} onClick={() => working.length ? setQueued(candidateKeys(data)) : void submit()}>
          {working.length ? '完成后确认' : '确认主体'}{subjects.length ? `（${subjects.length}）` : ''}</Button>}</>}>
    <p className="subject-confirmation-intro">勾选本轮的担保主体。同一主体有多种写法时，把它们归为同一主体。确认后，材料才会挂到主体下并开始比对；之后可以重新确认。</p>
    {data.roles.map(role => {
      const own = rows.filter(row => row.role === role);
      return <section className="subject-confirmation-group" key={role} aria-label={SUBJECT_ROLE_LABELS[role]}>
        <h3>{SUBJECT_ROLE_LABELS[role]}<span>已选 {primaries(role).length} 个主体</span></h3>
        {own.length ? <ul>{own.map(row => {
          const value = choice(row.key), others = primaries(role).filter(primary => primary.key !== row.key);
          return <li key={row.key} className={value.checked ? 'is-checked' : undefined}>
            <Checkbox checked={value.checked} onChange={event => toggle(row, event.target.checked)}><span className="subject-confirmation-name">{row.name}</span></Checkbox>
            <span className="subject-confirmation-sources">{!row.manual && <span className="subject-confirmation-source-label">来源：</span>}{row.sources}</span>
            {value.checked && others.length > 0 && <Select className="subject-confirmation-join" aria-label={`${row.name} 归为`} value={value.primary} onChange={primary => join(row, primary)}
              options={[{value: row.key, label: '单独作为一个主体'}, ...others.map(primary => ({value: primary.key, label: `与“${primary.name}”为同一主体`}))]}/>}
          </li>;
        })}</ul> : <p className="subject-confirmation-empty">本轮材料里没有读到{SUBJECT_ROLE_LABELS[role]}的名称，请在下方手动输入。</p>}
      </section>;
    })}
    <section className="subject-confirmation-add" aria-label="手动添加主体">
      <div className="subject-confirmation-add-heading"><h4>手动添加主体</h4><span>未找到正确名称时，可在此补充</span></div>
      <div className={`subject-confirmation-add-fields${data.roles.length > 1 ? ' has-role' : ''}`}>
        {data.roles.length > 1 && <Select aria-label="主体类型" value={draft.role} onChange={role => setDraft(current => ({...current, role}))} options={data.roles.map(role => ({value: role, label: SUBJECT_ROLE_LABELS[role]}))}/>}
        <Input aria-label="主体名称" maxLength={300} placeholder="输入主体名称" value={draft.name} onChange={event => setDraft(current => ({...current, name: event.target.value}))} onPressEnter={add}/>
        <Button disabled={!draft.name.trim()} onClick={add}>添加</Button>
      </div>
    </section>
    {working.length > 0 && <div className="subject-confirmation-waiting" role="status">
      <Spin size="small"/>
      <div>
        <p>正在处理：{workText(working)}</p>
        <p>{queued !== null ? '处理完成后会按当前勾选自动确认；期间若读到新的写法，会停下来请你核对。' : '确认主体会让进行中的处理失效，所以要等它完成。可以先勾选，再点“完成后确认”。'}
          {queued !== null && <Button type="link" size="small" onClick={() => setQueued(null)}>不自动确认</Button>}</p>
      </div>
    </div>}
    {changed && <p className="subject-confirmation-notice" role="status">处理已完成，读到的主体写法有变化，请核对后再确认。</p>}
    {failure !== undefined && <p className="subject-confirmation-error" role="alert">{errorText(failure)}</p>}
  </Modal>;
}

/** Opens the dialog when the round's subjects are still unconfirmed, and keeps a way back to it afterwards. */
export function SubjectConfirmation({state}: {state: ReviewState}) {
  const [open, setOpen] = useState(false);const [asked, setAsked] = useState(false);
  const subjects = useSubjects(state);
  const data = subjects.data, needed = !!data?.editable && !data.confirmed;
  useEffect(() => {if (needed && !asked) {setOpen(true);setAsked(true);}}, [needed, asked]);
  if (!data?.editable) return null;
  return <>
    <p className={`subject-confirmation-status${needed ? ' is-needed' : ''}`} role="status">
      {needed ? '本轮主体尚未确认，材料暂未挂到主体，以下各项不会比对。' : `本轮主体已确认：${data.confirmed!.subjects.map(subject => subject.label).join('、') || '无'}。`}
      <Button size="small" type={needed ? 'primary' : 'default'} onClick={() => setOpen(true)}>{needed ? '确认主体' : '重新确认'}</Button>
    </p>
    <SubjectConfirmationDialog state={state} data={data} open={open} close={() => setOpen(false)}/>
  </>;
}
