/** Closed-loop acceptance driver for a named isolated instance, using real services.
 * It walks one case through the business loop as the Maker and the independent
 * Checker would, and records where the flow stops.
 *
 *   P1_NATIVE_INSTANCE=<name> scripts/node24.sh --import tsx scripts/closed-loop-run.ts \
 *     --pack-dir=<pack> --guarantee=corporate_guarantee --report-dir=<new dir> [--variant=<negative id>] [--until=<step>] [--case=<id> [--from=<step>]]
 *
 * The report holds route templates, status and error codes, counts and durations only:
 * no response bodies, cookies, signed upload fields, material text or provider error text. */
import {randomUUID} from 'node:crypto';
import {appendFileSync,existsSync,mkdirSync,readdirSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename,join,resolve} from 'node:path';
import {HttpFailure,LoopClient,loopTarget,readPrivateJson,sleep,type Call} from './closed-loop-client.js';

export const STEPS=['preflight','create','processing','subjects','checklist','start','result','submit','return','resubmit','confirm','round2','close'] as const;
type Step=typeof STEPS[number];
type Severity='P0'|'P1'|'P2'|'info';
const option=(name:string)=>process.argv.slice(2).map(arg=>new RegExp(`^--${name}=(.+)$`).exec(arg)?.[1]).find(Boolean);
const packDir=resolve(option('pack-dir')??''),variant=option('variant')??'baseline',reportDir=resolve(option('report-dir')??'');
const guarantee=(option('guarantee')??'').split(',').filter(Boolean),until=(option('until')??'close') as Step,resumeCase=option('case'),from=(option('from')??'preflight') as Step;
if(!option('pack-dir')||!option('report-dir')||!guarantee.length||!STEPS.includes(until)||!STEPS.includes(from)||from!=='preflight'&&!resumeCase)throw new Error('Usage: closed-loop-run.ts --pack-dir=<pack> --guarantee=<type[,type]> --report-dir=<new dir> [--variant=<id>] [--until=<step>] [--case=<id> [--from=<step>]]');
if(existsSync(reportDir))throw new Error('report_dir_must_be_new');
const target=loopTarget();
mkdirSync(reportDir,{recursive:true,mode:0o700});
const write=(name:string,value:unknown)=>appendFileSync(join(reportDir,name),JSON.stringify(value)+'\n',{mode:0o600});
let step:Step='preflight',role='maker';
const observe=(call:Call)=>write('steps.jsonl',{at:new Date().toISOString(),step,role,...call});
const findings:Array<{id:string;severity:Severity;area:string;step:Step;expected:string;observed:string}>=[];
function finding(severity:Severity,area:string,expected:string,observed:string){
  const item={id:`F${String(findings.length+1).padStart(3,'0')}`,severity,area,step,expected,observed};findings.push(item);write('findings.jsonl',item);
  console.log(JSON.stringify({finding:item.id,severity,area,step,observed}));
}
const access=readPrivateJson<Record<'maker'|'checker',{username:string;password:string;personId:string}>&{origin:string}>(target.directory,'closed-loop-access.json');
if(access.origin!==target.web)throw new Error('access_file_instance_mismatch');
const maker=new LoopClient(target,observe),checker=new LoopClient(target,observe);
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const run={startedAt:new Date().toISOString(),instance:target.instance,commit:git('rev-parse','--short=12','HEAD'),dirty:git('status','--porcelain').split('\n').filter(Boolean).length,pack:basename(packDir),variant,guarantee,from,until,caseId:resumeCase??null as string|null};
const saveRun=(extra:Record<string,unknown>={})=>writeFileSync(join(reportDir,'run.json'),JSON.stringify({...run,...extra},null,2)+'\n',{mode:0o600});
saveRun();
const key=()=>randomUUID();
const count=<T>(items:T[],by:(item:T)=>string)=>items.reduce<Record<string,number>>((all,item)=>{const name=by(item);all[name]=(all[name]??0)+1;return all;},{});
const mime=(name:string)=>name.toLowerCase().endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':name.toLowerCase().endsWith('.png')?'image/png':/\.jpe?g$/i.test(name)?'image/jpeg':'application/pdf';

/** Baseline files, with a negative variant's replacement swapped in by filename. */
function packFiles(){
  const baseline=join(packDir,'baseline'),files=new Map(readdirSync(baseline).filter(name=>!name.startsWith('.')).sort().map(name=>[name,join(baseline,name)]));
  if(variant!=='baseline'){
    const replacement=join(packDir,'negative',variant);
    if(!existsSync(replacement))throw new Error('variant_not_found');
    for(const name of readdirSync(replacement).filter(name=>!name.startsWith('.')))files.set(name,join(replacement,name));
  }
  return [...files].map(([name,path])=>({name,path,size:statSync(path).size}));
}

type UploadTarget={purpose:'draft_attachment';draftId:string;expectedRevision:number}|{purpose:'case_document';caseId:string|null;roundId:string;expectedRevision:number};
async function upload(destination:UploadTarget,file:{name:string;path:string;size:number}){
  const ticket=await maker.request<{id:string;host:string;fields:Record<string,string>;state:string}>('/api/uploads',{...destination,filename:file.name,size:file.size,mimeType:mime(file.name),source:{kind:'maker'},idempotencyKey:key()});
  const host=new URL(ticket.host);
  if(host.protocol!=='https:'||host.username||host.password)throw new Error('upload_host_invalid');
  const form=new FormData();
  for(const [name,value] of Object.entries(ticket.fields))form.append(name,value);
  form.append('file',new Blob([readFileSync(file.path)],{type:mime(file.name)}),file.name);
  const started=Date.now(),transfer=await fetch(host,{method:'POST',body:form,signal:AbortSignal.timeout(300000)});
  observe({method:'POST',route:'object-store:form-upload',status:transfer.status,code:transfer.ok?null:'object_store_rejected',requestId:null,ms:Date.now()-started});
  if(!transfer.ok)throw new HttpFailure(transfer.status,'object_store_rejected',null,'object-store:form-upload');
  let state=(await maker.request<{state:string}>(`/api/uploads/${ticket.id}/complete`,{...(transfer.headers.get('x-oss-version-id')?{versionId:transfer.headers.get('x-oss-version-id')}:{}),...(transfer.headers.get('x-oss-request-id')?{requestId:transfer.headers.get('x-oss-request-id')}:{})})).state;
  for(let attempt=0;attempt<90&&!['registered','rejected','expired','canceled'].includes(state);attempt++){await sleep(2000);state=(await maker.request<{state:string;errorCode?:string}>(`/api/uploads/${ticket.id}`)).state;}
  return state;
}

const steps:Record<Step,()=>Promise<void>>={
  async preflight(){
    await maker.login(access.maker.username,access.maker.password);
    const capabilities=await maker.request<Record<string,unknown>>('/api/capabilities');
    const flags=Object.fromEntries(Object.entries(capabilities).map(([name,value])=>[name,typeof value==='object'&&value?(value as {available?:boolean}).available??null:value]));
    saveRun({capabilities:flags});
    for(const name of ['draftAttachments','parsing','automaticPreparse','documentReader','reviewConfiguration','reviewLoop'])if(flags[name]!==true)finding('P0','environment',`${name} is on`,`${name}=${String(flags[name])}`);
    if(flags.caseAssistant!==true)finding('info','case-assistant','case assistant available for the assistant pass','case assistant is not configured on this instance; the assistant pass is skipped');
  },
  async create(){
    if(run.caseId)return;
    const options=await maker.request<{canSelect:boolean;reason?:string;items:Array<{releaseId:string;guaranteeTypes:string[];scope:'synthetic'|'bank';publishedAt:string}>}>('/api/case-configuration-options');
    const typeKey=(types:string[])=>[...types].sort().join(','),match=options.items.filter(item=>typeKey(item.guaranteeTypes)===typeKey(guarantee)).sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt))[0];
    if(!options.canSelect||!match){finding('P0','configuration','a published configuration matches the guarantee types',`canSelect=${options.canSelect} reason=${options.reason??'none'} matches=${match?1:0}`);throw new Error('configuration_unavailable');}
    let draft=await maker.request<{id:string;revision:number}>('/api/case-drafts',{idempotencyKey:key()});
    const stamp=new Date().toISOString().slice(0,19).replace(/[-:T]/g,'');
    draft=await maker.request(`/api/case-drafts/${draft.id}/save`,{expectedRevision:draft.revision,idempotencyKey:key(),fields:{scenario:'overseas_loan',title:`闭环验收 ${run.pack} ${variant} ${stamp}`,reference:`LOOP-${stamp}`,background:'脱敏样例材料闭环验收。'},source:{kind:'maker'},guaranteeTypes:guarantee,touchedFields:['scenario','title','reference','background','guaranteeTypes']});
    const files=packFiles(),states:string[]=[];
    for(const file of files){
      const current=await maker.request<{revision:number}>(`/api/case-drafts/${draft.id}`);
      states.push(await upload({purpose:'draft_attachment',draftId:draft.id,expectedRevision:current.revision},file));
    }
    if(states.some(state=>state!=='registered'))finding('P0','upload','every draft file registers',JSON.stringify(count(states,state=>state)));
    draft=await maker.request(`/api/case-drafts/${draft.id}`);
    const created=await maker.request<{id:string}>('/api/cases',{draftId:draft.id,expectedRevision:draft.revision,idempotencyKey:key(),createReviewRound:true,reviewConfiguration:{releaseId:match.releaseId,guaranteeTypes:guarantee,scope:match.scope}});
    run.caseId=created.id;saveRun({releaseId:match.releaseId,files:files.length});
  },
  async processing(){
    const started=Date.now(),settled=new Set(['ready','succeeded','partial','failed','canceled','stale','configuration_required','capability_disabled','parked']);
    type Material={id:string;filename:string;format?:string|null;parseStatus:string};
    let materials:Material[]=[];
    const settle=async()=>{
      for(;;){
        materials=(await maker.request<{items:Material[]}>(`${base()}/materials`)).items;
        if(materials.every(item=>settled.has(item.parseStatus))||Date.now()-started>60*60_000)break;
        await sleep(10000);
      }
    };
    const read=async()=>{
      const details=[];
      for(const material of materials){
        const processing=await maker.request<{status:string;errorCode:string|null;progress:{completedPages:number;totalPages:number|null}}>(`${base()}/documents/${material.id}/processing`);
        details.push({id:material.id,format:material.format??null,parseStatus:material.parseStatus,errorCode:processing.errorCode,pages:processing.progress.totalPages});
      }
      return details;
    };
    await settle();
    let details=await read();
    // What a Maker does with a file that failed: ask for it to be parsed again. Each file gets two more tries.
    const firstFailures=details.filter(item=>item.parseStatus==='failed'),retried=new Map<string,number>();
    for(let round=0;round<2;round++){
      // Asking again cannot help once the instance has used up a model budget; that needs the operator.
      const failed=details.filter(item=>item.parseStatus==='failed'&&!/budget_exhausted$/u.test(item.errorCode??''));
      if(!failed.length)break;
      for(const item of failed){
        const review=await reviewState();
        await maker.request(`${base()}/documents/${item.id}/parse`,{reason:'处理失败后重新解析',roundId:review.roundId,expectedRevision:review.revision,idempotencyKey:key()}).then(()=>retried.set(item.id,(retried.get(item.id)??0)+1)).catch(()=>undefined);
      }
      await sleep(3000);await settle();details=await read();
    }
    write('summary.jsonl',{step,seconds:Math.round((Date.now()-started)/1000),materials:details.length,byStatus:count(details,item=>item.parseStatus),byError:count(details.filter(item=>item.errorCode&&item.parseStatus==='failed'),item=>item.errorCode!),byFormat:count(details,item=>`${item.format}:${item.parseStatus}`),
      firstAttemptFailures:count(firstFailures,item=>item.errorCode??'failed'),reparsed:[...retried.values()].reduce((sum,value)=>sum+value,0)});
    if(firstFailures.length)finding('P1','processing','every file is parsed without the Maker asking again',`${firstFailures.length} of ${details.length} failed on the first attempt: ${JSON.stringify(count(firstFailures,item=>item.errorCode??'failed'))}`);
    const unsettled=details.filter(item=>!settled.has(item.parseStatus)).length,failed=details.filter(item=>['failed','canceled','stale'].includes(item.parseStatus));
    if(unsettled)finding('P0','processing','every file settles within 60 minutes',`${unsettled} of ${details.length} still processing`);
    if(failed.length)finding('P0','processing','every file is parsed after retries',`${failed.length} of ${details.length} not parsed: ${JSON.stringify(count(failed,item=>item.errorCode??item.parseStatus))}`);
    if(failed.some(item=>/budget_exhausted$/u.test(item.errorCode??'')))finding('P0','environment','the instance has model budget left for the run','a model budget of this instance is used up; results after this point do not reflect the product');
    const idle=details.filter(item=>['configuration_required','capability_disabled','parked'].includes(item.parseStatus));
    if(idle.length)finding('P0','processing','parsing starts automatically after upload',JSON.stringify(count(idle,item=>item.parseStatus)));
    await confirmMixedTypes(materials.filter(item=>['ready','succeeded','partial'].includes(item.parseStatus)));
    await settle();
  },
  async subjects(){
    const state=await settleInputWork();
    if(!state.roles.length){write('summary.jsonl',{step,subjects:'not_required'});return;}
    if(!state.confirmed){
      // Without a suggestion a reviewer picks the name the files give for the guarantor, not the first name listed.
      const guarantor=(candidate:SubjectsState['candidates'][number])=>candidate.sources?.some(source=>/担保公司|担保人|保证人|guarantor/iu.test(source.fieldLabel))?0:1;
      const suggested=state.candidates.filter(candidate=>candidate.suggested),first=state.roles.flatMap(role=>state.candidates.filter(candidate=>candidate.role===role).sort((a,b)=>guarantor(a)-guarantor(b)).slice(0,1));
      const picked=suggested.length?suggested:first;
      if(!suggested.length)finding('P1','subjects','guarantor names are suggested from the guarantee itself',`${state.candidates.length} candidates, none suggested`);
      if(!picked.length){finding('P0','subjects','at least one subject can be confirmed','no subject candidate was read from the files');return;}
      if(!state.editable){finding('P0','subjects','the Maker can confirm subjects','subject confirmation is not editable');return;}
      const review=await reviewState();
      // As the page starts: a writing offered as the same company goes under that writing's subject.
      const primaries=picked.filter(candidate=>!candidate.sameAs||!picked.some(other=>other.role===candidate.role&&other.name===candidate.sameAs));
      const subjects=primaries.map(primary=>({role:primary.role,label:primary.name,names:[primary.name,...picked.filter(other=>other.role===primary.role&&other.sameAs===primary.name).map(other=>other.name)]}));
      await maker.request(`${base()}/review/subjects`,{expectedRevision:state.revision??review.revision,roundId:review.roundId,idempotencyKey:key(),reason:'确认本轮主体',subjects});
      await settleInputWork();
    }
    const after=await maker.request<SubjectsState>(`${base()}/review/subjects`);
    write('summary.jsonl',{step,roles:after.roles,candidates:after.candidates.length,suggested:after.candidates.filter(candidate=>candidate.suggested).length,confirmed:after.confirmed?.subjects.length??0});
  },
  async checklist(){
    await settleAnalysis();
    const checklist=await maker.request<Checklist>(`${base()}/review/checklist`);
    const adopted=(row:ChecklistRow)=>row.candidates.length>0||!!row.fact,checks=checklist.rows.flatMap(row=>row.crossChecks??[]);
    // A row also shows what its files say inside the judgement chain, including values that still carry doubts.
    const withValue=(row:ChecklistRow)=>adopted(row)||(row.crossChecks??[]).some(check=>check.sources?.some(source=>source.values?.length))||(row.sourceValues??[]).some(source=>source.values?.length);
    // What the per-document reader shows, against what reaches the checklist rows for the same fields.
    let readerFields=0,readerWithValue=0;const readerValueIds=new Set<string>();
    for(const document of checklist.documents){
      if(!document.parseRevision)continue;
      const fields=await maker.request<{presentationItems?:Field[];items?:Field[]}>(`${base()}/documents/${document.id}/fields?parseRevision=${document.parseRevision}`).catch(()=>null);
      for(const field of fields?.presentationItems??fields?.items??[]){readerFields++;if(field.candidates?.length){readerWithValue++;readerValueIds.add(field.fieldId);}}
    }
    const rowValueIds=new Set(checklist.rows.filter(withValue).map(row=>row.fieldId)),lost=[...readerValueIds].filter(id=>checklist.rows.some(row=>row.fieldId===id)&&!rowValueIds.has(id));
    write('summary.jsonl',{step,documents:count(checklist.documents,document=>`${document.state}:${document.adopted?'adopted':'not_adopted'}`),rows:checklist.rows.length,rowsWithValue:checklist.rows.filter(withValue).length,rowsAttributed:checklist.rows.filter(adopted).length,rowsExtracted:checklist.rows.filter(row=>row.status==='extracted').length,
      rowsByStatus:count(checklist.rows,row=>row.status),unassignedOnly:checklist.rows.filter(row=>!withValue(row)&&(row.unassignedCandidates?.length??0)>0).length,
      checks:checks.length,checksByOutcome:count(checks,check=>check.outcome),checksByMethod:count(checks,check=>`${check.method}:${check.outcome}`),
      semantic:count(checks.filter(check=>check.semantic),check=>`${check.semantic!.state}:${check.semantic!.outcome}`),semanticEligible:checks.filter(check=>check.semanticEligible).length,
      reader:{fields:readerFields,withValue:readerWithValue,fieldIdsWithValue:readerValueIds.size},fieldIdsShownInReaderButEmptyInChecklist:lost.length});
    if(!checklist.rows.some(withValue))finding('P0','checklist','extracted values reach the checklist','no checklist row carries a value');
    if(lost.length)finding('P1','checklist','a value shown in the per-document reader also appears on its checklist row',`${lost.length} of ${readerValueIds.size} fields with a reader value have no value on any checklist row`);
    const manual=checks.filter(check=>check.outcome==='manual').length;
    if(checks.length&&manual/checks.length>0.5)finding('P1','judgement','the system concludes where the source is readable',`${manual} of ${checks.length} checks end as manual confirmation`);
  },
  async start(){await startReview();},
  async result(){await confirmResult();},
  async submit(){await submitToChecker();},
  async return(){
    await ensureChecker();
    const inbox=await checker.request<{items:Array<{id:string}>}>('/api/checker/inbox');
    if(!inbox.items.some(item=>item.id===run.caseId))finding('P1','checker','the submitted case appears in the Checker inbox','the case is not in the inbox');
    let state=await checkerState(checker),submission=pendingSubmission(state);
    await checker.request(`${base()}/checker/submissions/${submission.id}/notes`,{expectedRevision:state.revision,idempotencyKey:key(),reason:'复核意见',submissionVersion:submission.version,target:{kind:'case'},text:'请核对本轮结果后重新提交。'});
    state=await checkerState(checker);submission=pendingSubmission(state);
    if(!state.allowedActions.includes('checker:return')){finding('P0','checker','the Checker can return the submission to the Maker',`allowed=${state.allowedActions.filter(action=>action.startsWith('checker:')).join(',')}`);throw new Error('checker_return_unavailable');}
    await checker.request(`${base()}/checker/submissions/${submission.id}/return`,{expectedRevision:state.revision,idempotencyKey:key(),reason:'退回经办补充核对',submissionVersion:submission.version});
    const rounds=await maker.request<Rounds>(`${base()}/review/rounds`),item=await maker.request<{preReviewStatus:string;stage?:string|null}>(base());
    write('summary.jsonl',{step,returnedToMaker:rounds.returnedToMaker??null,roundStatus:currentRound(rounds).status,caseStatus:item.preReviewStatus,stage:item.stage??null});
    if(item.stage!=='returned')finding('P2','flow','a returned case reads as returned to the Maker',`after the Checker returns it the case shows status "${item.preReviewStatus}" and stage "${item.stage??'none'}"`);
  },
  async resubmit(){await startReview();await confirmResult();await submitToChecker();},
  async confirm(){await checkerConfirm();},
  async round2(){
    await ensureChecker();
    const before=await checker.request<Rounds>(`${base()}/review/rounds`);
    if(!before.allowedActions.includes('round:create')){finding('P0','rounds','the Checker can prepare the next round after confirming',`allowed=${before.allowedActions.join(',')||'none'}`);throw new Error('round_create_unavailable');}
    const created=await checker.request<Rounds&{commandRoundId:string}>(`${base()}/review/rounds`,{expectedRevision:before.revision,idempotencyKey:key(),reason:'复核后准备下一轮材料'});
    role='maker';
    const history=await maker.request<{items:Array<{sourceDocumentVersionId:string;filename:string;alreadyInCurrent:boolean}>}>(`${base()}/materials/history?roundId=${created.commandRoundId}`);
    // A negative variant is repaired in round 2 by uploading the baseline file in place of the replaced one.
    const repaired=variant==='baseline'?[]:readdirSync(join(packDir,'negative',variant)).filter(name=>!name.startsWith('.'));
    const carried=history.items.filter(item=>!item.alreadyInCurrent&&!repaired.includes(item.filename));
    if(carried.length){const review=await reviewState();await maker.request(`${base()}/materials/history`,{roundId:created.commandRoundId,expectedRevision:review.revision,idempotencyKey:key(),documentVersionIds:carried.map(item=>item.sourceDocumentVersionId)});}
    for(const name of repaired){
      const path=join(packDir,'baseline',name),review=await reviewState();
      const state=await upload({purpose:'case_document',caseId:run.caseId,roundId:created.commandRoundId,expectedRevision:review.revision},{name,path,size:statSync(path).size});
      if(state!=='registered')finding('P0','upload','the supplementary file registers',state);
    }
    write('summary.jsonl',{step,round:created.items.length,carried:carried.length,uploaded:repaired.length});
    await steps.processing();await steps.subjects();await steps.checklist();
    await startReview();await confirmResult();await submitToChecker();
    role='checker';await checkerConfirm();
  },
  async close(){
    await ensureChecker();
    const item=await checker.request<{allowed_actions:string[]}>(base());
    if(!item.allowed_actions.includes('case:close'))finding('P1','closure','the Checker may close the case',`allowed=${item.allowed_actions.join(',')||'none'}`);
    const preview=await checker.request<{revision:number;roundId:string|null;runId:string;confirmationToken:string;items:Array<{id:string;outcome:string;reasonCode:string}>}>(`${base()}/closure-preview`);
    write('summary.jsonl',{step,outstanding:preview.items.length,byReason:count(preview.items,entry=>`${entry.outcome}:${entry.reasonCode}`)});
    await checker.request(`${base()}/close`,{expectedRevision:preview.revision,roundId:preview.roundId,runId:preview.runId,confirmationToken:preview.confirmationToken,acknowledgedItemIds:preview.items.map(entry=>entry.id),confirmPreReviewOnly:true,idempotencyKey:key(),reason:'闭环验收完结；遗留事项与原结论保留。'});
    const closed=await checker.request<{preReviewStatus:string;closure:unknown}>(base());
    if(!closed.closure||closed.preReviewStatus!=='closed')finding('P0','closure','the case is closed and read-only',`status=${closed.preReviewStatus}`);
    const work=await maker.request<{inProgress:unknown[]}>(`${base()}/review/subjects/work`).catch(()=>null);
    write('summary.jsonl',{step,closed:!!closed.closure,pendingWork:work?.inProgress.length??null});
  },
};

interface SubjectsState {editable:boolean;roles:string[];confirmed:{subjects:unknown[]}|null;candidates:Array<{role:string;name:string;suggested:boolean;sameAs?:string;sources?:Array<{fieldLabel:string}>}>;revision?:number;inProgress?:unknown[]}
interface Field {fieldId:string;candidates?:unknown[]}
interface Check {id:string;method:string;outcome:string;semanticEligible?:boolean;semantic?:{state:string;outcome:string};sources?:Array<{values?:string[]}>}
interface ChecklistRow {fieldId:string;status:string;candidates:unknown[];fact:unknown|null;unassignedCandidates?:unknown[];crossChecks?:Check[];sourceValues?:Array<{values?:string[]}>}
interface Checklist {rows:ChecklistRow[];documents:Array<{id:string;parseRevision:string|null;state:string;adopted:boolean}>}
interface Round {roundId:string;roundNumber:number;status:string;runId:string|null;snapshotHash:string|null;allowedActions:string[]}
interface Rounds {revision:number;currentRoundId:string|null;items:Round[];allowedActions:string[];returnedToMaker?:boolean}
interface Submission {id:string;version:number;state:string;validity:string;roundId:string}
interface CheckerView {revision:number;roundId:string|null;runId:string|null;previewHash:string|null;allowedActions:string[];blockers:Array<{code:string}>;outstandingFindings?:Array<{code:string}>;summary:{status:string};submissions:Submission[]}
function base(){return `/api/cases/${run.caseId}`;}
const reviewState=()=>maker.request<{revision:number;roundId:string}>(`${base()}/review`);
const currentRound=(rounds:Rounds)=>{const round=rounds.items.find(item=>item.roundId===rounds.currentRoundId);if(!round)throw new Error('current_round_missing');return round;};
const checkerState=(client:LoopClient)=>client.request<CheckerView>(`${base()}/checker`);
function pendingSubmission(state:CheckerView){
  const submission=state.submissions.find(item=>item.roundId===state.roundId&&item.state==='submitted'&&item.validity==='current');
  if(!submission){finding('P0','checker','a current submission awaits the Checker',`summary=${state.summary.status}`);throw new Error('checker_submission_missing');}
  return submission;
}
/** Subjects can only be read as final, and confirmed, once uploads, parses and translations of the round have settled. */
async function settleInputWork(){
  const started=Date.now();
  for(;;){
    const state=await maker.request<SubjectsState>(`${base()}/review/subjects`);
    const work=await maker.request<{inProgress:Array<{kind:string}>}>(`${base()}/review/subjects/work`);
    if(!work.inProgress.length)return state;
    if(Date.now()-started>30*60_000){finding('P0','processing','round work settles within 30 minutes',JSON.stringify(count(work.inProgress,item=>item.kind)));return state;}
    await sleep(10000);
  }
}
/** The review page asks for a model comparison of every eligible check when the reviewer opens it, at most four at a
 * time. The driver does the same and waits, so the pre-review starts from the conclusions a reviewer would see. */
interface Directory {revision:number;parseRevision:string;directory:Array<Record<string,unknown>&{labelId?:string|null}>;taxonomy:Array<{id:string;label:string}>}
/** What a Maker does with a file whose pages were read as different material types: choose one type for the whole
 * file, after which its fields are extracted. The type is the one the pack names for that file. */
async function confirmMixedTypes(materials:Array<{id:string;filename:string}>){
  const roles=new Map<string,string>();
  for(const entry of JSON.parse(readFileSync(join(packDir,'cases.json'),'utf8')) as Array<{documents?:Array<{role?:string;path?:string}>}>)
    for(const document of entry.documents??[])if(document.role&&document.path)roles.set(basename(document.path),document.role);
  let mixed=0,confirmed=0;
  for(const material of materials){
    const directory=await maker.request<Directory>(`${base()}/documents/${material.id}/directory`).catch(()=>null);
    if(!directory||new Set(directory.directory.flatMap(entry=>entry.labelId?[entry.labelId]:[])).size<2)continue;
    mixed++;
    const role=roles.get(material.filename),types=role?directory.taxonomy.filter(type=>type.label===role||type.label.includes(role)||role.includes(type.label)):[];
    if(types.length!==1)continue;
    const review=await reviewState();
    await maker.request(`${base()}/documents/${material.id}/directory`,{roundId:review.roundId,expectedRevision:review.revision,expectedDirectoryRevision:directory.revision,parseRevision:directory.parseRevision,idempotencyKey:key(),reason:'整份文件为同一种材料',
      logicalDocuments:directory.directory.map(entry=>({...entry,labelId:types[0]!.id,label:types[0]!.label,status:'confirmed',source:'manual'})),continueExtraction:true}).then(()=>confirmed++).catch(()=>undefined);
  }
  if(mixed){
    write('summary.jsonl',{step,phase:'material-type',mixed,confirmed});
    finding('P1','processing','each file is read as one material type',`${mixed} file(s) had pages read as different types and extracted nothing until the Maker chose a type; ${confirmed} confirmed by the driver`);
  }
}
/** A Maker who wants to work on a round they already confirmed reopens it first. */
async function ensureDraftRound(){
  const rounds=await maker.request<Rounds>(`${base()}/review/rounds`),round=currentRound(rounds);
  if(round.status==='draft'||!round.allowedActions.includes('round:reopen'))return;
  await maker.request(`${base()}/review/rounds/${round.roundId}/reopen`,{expectedRevision:rounds.revision,idempotencyKey:key(),reason:'重新打开本轮继续核对'});
}
async function settleAnalysis(){
  await ensureDraftRound();
  const started=Date.now(),refused=new Map<string,string>();let submitted=0;
  for(;;){
    const checklist=await maker.request<Checklist>(`${base()}/review/checklist`);
    const tasks=[...new Map(checklist.rows.flatMap(row=>(row.crossChecks??[]).filter(check=>check.semanticEligible).map(check=>[check.id,{check,fieldId:row.fieldId}] as const))).values()];
    const pending=tasks.filter(task=>task.check.semantic?.state==='pending').length;
    const waiting=tasks.filter(task=>!task.check.semantic&&task.check.outcome!=='consistent'&&!refused.has(task.check.id));
    if(!pending&&!waiting.length||Date.now()-started>30*60_000){
      const settled=tasks.filter(task=>task.check.semantic);
      write('summary.jsonl',{step,phase:'judgement',eligible:tasks.length,submitted,refused:count([...refused.values()],code=>code),seconds:Math.round((Date.now()-started)/1000),bySemantic:count(settled,task=>`${task.check.semantic!.state}:${task.check.semantic!.outcome}`)});
      if(pending||waiting.length)finding('P1','judgement','model-backed comparisons settle within 30 minutes',`${pending} pending, ${waiting.length} not started`);
      if(refused.size)finding('P1','judgement','every eligible check can be sent for comparison',`${refused.size} of ${tasks.length} were refused: ${JSON.stringify(count([...refused.values()],code=>code))}`);
      return;
    }
    let room=4-pending;
    for(const task of waiting){
      if(room<=0)break;
      const review=await reviewState();
      try{await maker.request(`${base()}/review-delivery/analysis/cross-file`,{checkId:task.check.id,fieldId:task.fieldId,expectedRevision:review.revision,idempotencyKey:key()});submitted++;room--;}
      catch(error){if(error instanceof HttpFailure&&error.code==='analysis_queue_full')break;refused.set(task.check.id,error instanceof HttpFailure?error.code:'failed');}
    }
    await sleep(8000);
  }
}
async function startReview(){
  await ensureDraftRound();
  const review=await reviewState();
  await maker.request(`${base()}/review/rounds/${review.roundId}/start`,{expectedRevision:review.revision,idempotencyKey:key(),reason:'开始预审'});
  const started=Date.now();let round:Round;
  for(;;){
    round=currentRound(await maker.request<Rounds>(`${base()}/review/rounds`));
    if(!['pending','running'].includes(round.status)||Date.now()-started>20*60_000)break;
    await sleep(5000);
  }
  write('summary.jsonl',{step,phase:'run',roundNumber:round.roundNumber,status:round.status,seconds:Math.round((Date.now()-started)/1000)});
  if(round.status!=='ready'){finding('P0','review','the pre-review run becomes ready',`round status ${round.status}`);throw new Error(`review_run_${round.status}`);}
}
async function confirmResult(){
  let rounds=await maker.request<Rounds>(`${base()}/review/rounds`);const round=currentRound(rounds);
  if(!round.runId||!round.snapshotHash)throw new Error('review_result_missing');
  const result=await maker.request<{results:Array<{outcome:string;reasonCode:string;scopeId:string}>;snapshot:{objects:unknown[];facts:unknown[];materials:unknown[];pendingMaterials?:unknown[];fieldReviews?:unknown[];automaticChecks?:Array<{status?:string}>;reviewedInputs?:unknown[]}}>(`${base()}/review/runs/${round.runId}`);
  const passed=result.results.filter(entry=>['pass','not_applicable'].includes(entry.outcome)).length;
  write('summary.jsonl',{step,phase:'result',roundNumber:round.roundNumber,results:result.results.length,resolved:passed,byOutcome:count(result.results,entry=>entry.outcome),byReason:count(result.results,entry=>`${entry.outcome}:${entry.reasonCode}`),
    unconfirmedScopes:result.results.filter(entry=>entry.scopeId.startsWith('unconfirmed:')).length,
    snapshot:{objects:result.snapshot.objects.length,facts:result.snapshot.facts.length,materials:result.snapshot.materials.length,pendingMaterials:result.snapshot.pendingMaterials?.length??0,fieldReviews:result.snapshot.fieldReviews?.length??0,
      automaticChecks:result.snapshot.automaticChecks?.length??0,automaticChecksByStatus:count(result.snapshot.automaticChecks??[],check=>check.status??'unknown'),reviewedInputs:result.snapshot.reviewedInputs?.length??0}});
  if(!result.snapshot.objects.length)finding('P0','results','the run knows its guarantor objects','the frozen snapshot has no object');
  if(result.results.length&&!passed)finding('P0','results','rule results reflect what was checked',`none of ${result.results.length} rule results is resolved`);
  else if(result.results.length&&passed/result.results.length<0.5)finding('P1','results','most rule results are resolved after a clean baseline',`${passed} of ${result.results.length} resolved`);
  if(round.allowedActions.includes('round:confirm')){
    await maker.request(`${base()}/review/rounds/${round.roundId}/confirm`,{expectedRevision:rounds.revision,idempotencyKey:key(),reason:'确认初审结果',runId:round.runId,snapshotHash:round.snapshotHash});
    rounds=await maker.request<Rounds>(`${base()}/review/rounds`);
  }
  const delivery=await maker.request<{revision:number}>(`${base()}/review-delivery`);
  await maker.request(`${base()}/review-delivery/mail`,{expectedRevision:delivery.revision,idempotencyKey:key(),runId:round.runId,format:'documents',replyIds:[]});
}
async function submitToChecker(){
  const state=await checkerState(maker);
  write('summary.jsonl',{step,phase:'submit',status:state.summary.status,blockers:state.blockers.map(blocker=>blocker.code),outstanding:state.outstandingFindings?.length??0,outstandingByCode:count(state.outstandingFindings??[],entry=>entry.code)});
  if(state.blockers.length){finding('P0','submit','nothing blocks handing the round to the Checker',state.blockers.map(blocker=>blocker.code).join(','));throw new Error(`submit_blocked:${state.blockers[0]!.code}`);}
  await maker.request(`${base()}/checker/submissions`,{expectedRevision:state.revision,idempotencyKey:key(),reason:'提交独立复核',roundId:state.roundId,runId:state.runId,previewHash:state.previewHash});
}
let checkerSignedIn=false;
async function ensureChecker(){if(!checkerSignedIn){await checker.login(access.checker.username,access.checker.password);checkerSignedIn=true;}}
async function checkerConfirm(){
  await ensureChecker();
  const state=await checkerState(checker),submission=pendingSubmission(state);
  if(state.blockers.length){finding('P0','checker','nothing blocks the Checker from confirming',state.blockers.map(blocker=>blocker.code).join(','));throw new Error(`confirm_blocked:${state.blockers[0]!.code}`);}
  await checker.request(`${base()}/checker/submissions/${submission.id}/confirm`,{expectedRevision:state.revision,idempotencyKey:key(),reason:'复核确认本轮预审结果',submissionVersion:submission.version});
  const after=await checkerState(checker);
  write('summary.jsonl',{step,phase:'confirm',status:after.summary.status,outstanding:after.outstandingFindings?.length??0});
  if(after.summary.status!=='confirmed')finding('P0','checker','the round is confirmed and stays confirmed',`summary=${after.summary.status}`);
}

let stopped:string|null=null;
for(const name of STEPS){
  if(name!=='preflight'&&STEPS.indexOf(name)<STEPS.indexOf(from))continue;
  step=name;role=['return','confirm','close'].includes(name)?'checker':'maker';
  const started=Date.now();
  try{await steps[name]();write('summary.jsonl',{step:name,state:'done',seconds:Math.round((Date.now()-started)/1000)});}
  catch(error){
    stopped=error instanceof HttpFailure?`${error.route}:${error.status}:${error.code}`:(error as Error).message;
    finding('P0','flow',`step ${name} completes`,`stopped at ${stopped}`);
    write('summary.jsonl',{step:name,state:'stopped',seconds:Math.round((Date.now()-started)/1000)});break;
  }
  if(name===until)break;
}
saveRun({finishedAt:new Date().toISOString(),stoppedAt:stopped?step:null,stopped,findings:count(findings,item=>item.severity)});
console.log(JSON.stringify({code:stopped?'closed_loop_stopped':'closed_loop_reached',step,stopped,caseId:run.caseId,findings:count(findings,item=>item.severity),reportDir}));
if(stopped)process.exitCode=1;
