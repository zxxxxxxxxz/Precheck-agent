import type {SignatureInformationState,SignatureInformationCheck,SignatureInformationEvaluation,SignatureEntry,ScopedSignatureRequirement,SignatureDateRecord} from '@hsbc/contracts/signature-information';
import type {SignatureRequirementExpression} from '@hsbc/contracts/signature-review';
import {evaluateSignatureRequirement} from './evaluator.js';
import {normalizeDate} from '../../review/normalization.js';

type Outcome=SignatureInformationCheck['status'];
type Result={status:Outcome;reasons:string[]};
const pending=(reason:string):Result=>({status:'needs_confirmation',reasons:[reason]});
const pass=():Result=>({status:'satisfied',reasons:[]});
const fail=(reason:string):Result=>({status:'not_satisfied',reasons:[reason]});
const roles=(entry:SignatureEntry)=>[entry.role,...(entry.additionalRoles??[])].filter((r):r is string=>!!r);
const active=(entry:SignatureEntry)=>entry.status!=='excluded'&&!entry.duplicateOf;
const decimal=(a:string,b:string)=>{const [ai,af='']=a.split('.'),[bi,bf='']=b.split('.'),n=Math.max(af.length,bf.length);return BigInt(ai!+af.padEnd(n,'0'))-BigInt(bi!+bf.padEnd(n,'0'));};

/** Date meaning and ownership are explicit. Never borrow a date from another owner. */
export function signatureDateValue(state:SignatureInformationState,selector:Pick<SignatureDateRecord,'kind'|'targetType'|'targetId'>):{status:'value'|'blank'|'unknown';value?:string}{
  if(!selector.targetId)return {status:'unknown'};
  const records=state.dates.filter(d=>d.status!=='excluded'&&d.kind===selector.kind&&d.targetType===selector.targetType&&d.targetId===selector.targetId);
  if(!records.length||records.some(d=>d.status!=='confirmed'||!d.evidence.length))return {status:'unknown'};
  if(records.every(d=>!d.rawValue.trim()))return {status:'blank'};
  if(records.some(d=>!d.rawValue.trim()))return {status:'unknown'};
  const values=records.map(d=>normalizeDate(d.rawValue,d.calendar).value);
  if(values.some(v=>v===null)||new Set(values).size!==1)return {status:'unknown'};
  return {status:'value',value:values[0]!};
}

function authorization(state:SignatureInformationState,entry:SignatureEntry,rule:ScopedSignatureRequirement,requiredRoles:string[]):Result{
  const conditions=rule.requirement.authorization;
  if(!Object.values(conditions).some(Boolean))return pass();
  const matches=state.authorizations.filter(a=>entry.authorizationIds.includes(a.id)&&a.status!=='excluded');
  if(!matches.length)return pending('authorization_missing');
  const results=matches.map(a=>{
    if(a.status!=='confirmed'||!a.evidence.length)return pending('authorization_unconfirmed');
    if(a.subjectId!==rule.subjectId||!a.logicalDocumentIds.includes(rule.logicalDocumentId))return fail('authorization_scope_mismatch');
    if(entry.kind!=='stamp'&&(!entry.personId||!a.personIds.includes(entry.personId)||a.roles.length&&!roles(entry).some(role=>a.roles.includes(role)&&(!requiredRoles.length||requiredRoles.includes(role)))))return fail('authorized_person_mismatch');
    if(conditions.checkDate){
      const signed=signatureDateValue(state,entry.kind==='stamp'?{kind:'location_signing',targetType:'location',targetId:entry.locationId}:{kind:'person_signing',targetType:'entry',targetId:entry.id});
      const from=signatureDateValue(state,{kind:'authorization_from',targetType:'authorization',targetId:a.id});
      const until=signatureDateValue(state,{kind:'authorization_until',targetType:'authorization',targetId:a.id});
      if(signed.status!=='value'||from.status!=='value'||until.status!=='value')return pending('authorization_date_unknown');
      if(from.value!>until.value!)return pending('authorization_dates_conflict');
      if(signed.value!<from.value!||signed.value!>until.value!)return fail('authorization_outside_period');
    }
    if(conditions.checkAmount){
      const t=rule.transaction;
      if(t.amount===null||!t.currency||a.maxAmount===null||!a.currency||!t.evidence.length)return pending('authorization_amount_unknown');
      if(t.currency!==a.currency)return pending('authorization_currency_mismatch');
      if(decimal(t.amount,a.maxAmount)>0n)return fail('authorization_amount_exceeded');
    }
    if(conditions.checkTransaction){
      if(!rule.transaction.type||!rule.transaction.evidence.length||!a.transactionTypes.length)return pending('authorization_transaction_unknown');
      if(!a.transactionTypes.includes(rule.transaction.type))return fail('authorization_transaction_outside_scope');
    }
    return pass();
  });
  if(new Set(results.map(r=>r.status+':'+r.reasons.join(','))).size>1)return pending('authorization_conflict');
  return results[0]!;
}

function evaluateScope(state:SignatureInformationState,rule:ScopedSignatureRequirement,locationIds:string[]):{result:Result;entryIds:string[]}{
  const locations=state.locations.filter(l=>locationIds.includes(l.id)&&l.logicalDocumentId===rule.logicalDocumentId);
  const entries=state.entries.filter(e=>active(e)&&rule.entryIds.includes(e.id)&&locations.some(l=>l.id===e.locationId));
  const overlap=new Set<string>();
  for(const entry of entries)if(entry.kind==='handwriting'&&!entry.box&&entries.filter(e=>e.locationId===entry.locationId&&e.kind==='handwriting').length>1)overlap.add(entry.id);
  for(const a of entries)for(const b of entries){if(a.id===b.id||a.kind!=='handwriting'||b.kind!=='handwriting'||!a.box||!b.box)continue;const x=locations.find(l=>l.id===a.locationId),y=locations.find(l=>l.id===b.locationId);if(x?.pageNumber!==y?.pageNumber)continue;const area=Math.max(0,Math.min(a.box.x+a.box.width,b.box.x+b.box.width)-Math.max(a.box.x,b.box.x))*Math.max(0,Math.min(a.box.y+a.box.height,b.box.y+b.box.height)-Math.max(a.box.y,b.box.y));if(area/Math.min(a.box.width*a.box.height,b.box.width*b.box.height)>=0.8){overlap.add(a.id);overlap.add(b.id);}}
  const confirmed=entries.filter(e=>!overlap.has(e.id)&&e.status==='confirmed'&&e.identityConfirmed&&(e.kind==='stamp'||e.capacity!=='unknown')&&e.subjectId===rule.subjectId);
  const complete=locations.length===locationIds.length&&locations.every(l=>l.coverage==='complete');
  if(rule.status==='excluded')return {result:{status:'not_applicable',reasons:[]},entryIds:[]};
  if(rule.status!=='confirmed')return {result:pending('requirement_unconfirmed'),entryIds:[]};
  if(!locations.length)return {result:pending('signing_location_unconfirmed'),entryIds:[]};
  let budget=0,limited=false;
  type NodeResult=Result&{assignments:Set<string>[]};
  const node=(expression:SignatureRequirementExpression):NodeResult=>{
    if(++budget>10000){limited=true;return {...pending('requirement_complexity_limit'),assignments:[]};}
    if(expression.kind!=='signers'){
      const children=expression.children.map(node);
      if(expression.kind==='anyOf'){
        const valid=children.filter(c=>c.status==='satisfied');
        if(valid.length){const assignments=valid.flatMap(c=>c.assignments);if(assignments.length>256)limited=true;return {...pass(),assignments:assignments.slice(0,256)};}
        return {...(children.some(c=>c.status==='needs_confirmation')?pending('combination_unconfirmed'):fail('signature_combination_not_satisfied')),assignments:[]};
      }
      const bad=children.filter(c=>c.status!=='satisfied');
      if(bad.length)return {status:bad.some(c=>c.status==='not_satisfied')?'not_satisfied':'needs_confirmation',reasons:[...new Set(bad.flatMap(c=>c.reasons))],assignments:[]};
      let combinations=[new Set<string>()];
      for(const child of children){const next:Set<string>[]=[];
        for(const prior of combinations)for(const added of child.assignments){
          if(++budget>10000||next.length>=256){limited=true;break;}
          if(rule.distinctPeople&&[...added].some(p=>prior.has(p)))continue;
          next.push(new Set([...prior,...added]));
        }
        combinations=next;
      }
      return combinations.length?{...pass(),assignments:combinations}:{...(limited?pending('requirement_complexity_limit'):fail('distinct_signers_required')),assignments:[]};
    }
    const needsSignature=expression.mark!=='stamp',needsStamp=expression.mark==='stamp'||expression.mark==='signature_and_stamp';
    const marks=confirmed.filter(e=>(e.kind==='handwriting'||e.kind==='stamp')&&(e.kind==='stamp'||!expression.roles.length||roles(e).some(role=>expression.roles.includes(role))));
    const evaluated=marks.map(entry=>({entry,result:authorization(state,entry,rule,expression.roles)}));
    const good=evaluated.filter(e=>e.result.status==='satisfied').map(e=>e.entry);
    const stamp=good.some(e=>e.kind==='stamp');
    if(expression.mark==='signature_or_stamp'&&stamp&&expression.minimum!==1)return {...pending('stamp_count_requires_explicit_rule'),assignments:[]};
    if(expression.mark==='signature_or_stamp'&&stamp)return {...pass(),assignments:[new Set()]};
    if(!needsSignature){
      if(expression.minimum!==1)return {...pending('stamp_count_requires_explicit_rule'),assignments:[]};
      if(stamp)return {...pass(),assignments:[new Set()]};
    }
    const people=[...new Set(good.filter(e=>e.kind==='handwriting'&&e.personId).map(e=>e.personId!))];
    // Reuse the existing deterministic headcount evaluator on this exact scope.
    const count=evaluateSignatureRequirement({...rule.requirement,expression:{...expression,mark:'signature'},authorization:{requireEvidence:false,checkDate:false,checkAmount:false,checkTransaction:false}},
      {signers:people.map(personId=>({personId,subjectId:rule.subjectId,subjectRole:rule.requirement.subjectRole,role:expression.roles[0]??'signatory',signature:true,stamp:false,authorization:null})),transactionFacts:{date:null,amount:null,currency:null,transactionType:null},coverageComplete:complete,classificationKnown:true,taxonomyIds:rule.requirement.taxonomyIds});
    if(needsSignature&&count.outcome==='pass'&&(!needsStamp||stamp)){
      const assignments:Set<string>[]=[];
      const choose=(start:number,picked:string[])=>{if(++budget>10000||assignments.length>=256){limited=true;return;}if(picked.length===expression.minimum){assignments.push(new Set(picked));return;}for(let i=start;i<people.length;i++)choose(i+1,[...picked,people[i]!]);};
      choose(0,[]);return {...pass(),assignments};
    }
    const uncertain=overlap.size>0||entries.some(e=>e.status!=='confirmed'||e.kind==='uncertain'||(e.kind==='handwriting'||e.kind==='stamp')&&(!e.identityConfirmed||e.kind==='handwriting'&&e.capacity==='unknown'));
    const errors=evaluated.filter(e=>e.result.status!=='satisfied');
    if(!complete||uncertain||errors.some(e=>e.result.status==='needs_confirmation'))return {...pending('evidence_or_coverage_incomplete'),assignments:[]};
    if(errors.length)return {status:'not_satisfied',reasons:[...new Set(errors.flatMap(e=>e.result.reasons))],assignments:[]};
    return {...fail(needsStamp&&!stamp?'required_stamp_not_found':'required_signers_not_found'),assignments:[]};
  };
  const result=node(rule.requirement.expression);
  return {result:{status:result.status,reasons:result.reasons},entryIds:entries.map(e=>e.id)};
}

/** Incompatible explicit rules are a configuration question, never a chosen winner. */
function conflictingDateRules(state:SignatureInformationState):Set<string>{
  const buckets=new Map<string,{allowed:Set<string>;ids:string[]}>(),conflicts=new Set<string>();
  const selector=(s:NonNullable<SignatureInformationState['dateRules'][number]['right']>)=>JSON.stringify([s.kind,s.targetType,s.targetId]);
  for(const r of state.dateRules.filter(r=>r.status==='confirmed'&&r.evidence.length)){
    let key:string,values:string[];
    if(r.operation==='required'||r.operation==='blank'){key='presence:'+selector(r.left);values=[r.operation];}
    else if(r.right){let a=selector(r.left),b=selector(r.right);values=({before:['lt'],not_after:['lt','eq'],equal:['eq'],after:['gt'],not_before:['eq','gt']} as const)[r.operation].slice();if(a>b){[a,b]=[b,a];values=values.map(v=>v==='lt'?'gt':v==='gt'?'lt':v);}key=JSON.stringify([a,b]);if(a===b)values=values.filter(v=>v==='eq');}
    else continue;
    const old=buckets.get(key),allowed=new Set(values.filter(v=>!old||old.allowed.has(v))),ids=[...(old?.ids??[]),r.id];buckets.set(key,{allowed,ids});
  }
  for(const bucket of buckets.values())if(!bucket.allowed.size)for(const id of bucket.ids)conflicts.add(id);
  return conflicts;
}

export function evaluateSignatureInformation(state:SignatureInformationState):SignatureInformationEvaluation{
  const checks:SignatureInformationCheck[]=[],dateConflicts=conflictingDateRules(state);
  for(const rule of state.requirements){
    const scopes=rule.scope==='each_location'&&rule.locationIds.length?rule.locationIds.map(id=>[id]):[rule.locationIds];
    for(const ids of scopes){const {result,entryIds}=evaluateScope(state,rule,ids);checks.push({id:`requirement:${rule.id}:${ids.join(':')}`,label:rule.requirement.label,requirementId:rule.id,locationId:ids.length===1?ids[0]!:null,entryIds,...result,mandatory:rule.mandatory,evidence:rule.evidence});}
  }
  for(const rule of state.dateRules){
    let result:Result;
    if(rule.status==='excluded')result={status:'not_applicable',reasons:[]};
    else if(dateConflicts.has(rule.id))result=pending('date_rules_conflict');
    else if(rule.status!=='confirmed'||!rule.evidence.length)result=pending('date_rule_unconfirmed');
    else {
      const a=signatureDateValue(state,rule.left),b=rule.right?signatureDateValue(state,rule.right):{status:'unknown' as const};
      if(a.status==='unknown')result=pending('date_missing_or_conflicting');
      else if(rule.operation==='required')result=a.status==='value'?pass():fail('required_date_blank');
      else if(rule.operation==='blank')result=a.status==='blank'?pass():fail('date_should_be_blank');
      else if(a.status!=='value'||b.status!=='value')result=pending('date_missing_or_conflicting');
      else {const x=a.value!,y=b.value!;const good=rule.operation==='before'?x<y:rule.operation==='not_after'?x<=y:rule.operation==='after'?x>y:rule.operation==='not_before'?x>=y:x===y;result=good?pass():fail('date_relation_not_satisfied');}
    }
    checks.push({id:`date:${rule.id}`,label:rule.label,requirementId:null,locationId:null,entryIds:[],...result,mandatory:true,evidence:rule.evidence});
  }
  for(const entry of state.entries.filter(active)){
    if(entry.status!=='confirmed'||entry.kind==='uncertain'||entry.kind==='blank_signing_slot'||(entry.kind==='handwriting'||entry.kind==='stamp')&&(!entry.identityConfirmed||entry.kind==='handwriting'&&entry.capacity==='unknown')){checks.push({id:`entry:${entry.id}`,label:'签署证据待核对',requirementId:null,locationId:entry.locationId,entryIds:[entry.id],...pending('entry_unconfirmed'),mandatory:false,evidence:entry.evidence});}
  }
  const dateKeys=new Set<string>();
  for(const date of state.dates.filter(d=>d.status!=='excluded')){
    const key=JSON.stringify([date.kind,date.targetType,date.targetId]);if(dateKeys.has(key))continue;dateKeys.add(key);
    if(signatureDateValue(state,date).status==='unknown')checks.push({id:`date-record:${date.id}`,label:'日期用途或值待核对',requirementId:null,locationId:date.targetType==='location'?date.targetId:null,entryIds:date.targetType==='entry'&&date.targetId?[date.targetId]:[],...pending('date_missing_or_conflicting'),mandatory:false,evidence:state.dates.filter(d=>d.kind===date.kind&&d.targetType===date.targetType&&d.targetId===date.targetId).flatMap(d=>d.evidence)});
  }
  const entries=state.entries.filter(e=>active(e)&&e.kind==='handwriting');
  const satisfied=state.requirements.filter(r=>{const scoped=checks.filter(c=>c.requirementId===r.id);return scoped.length>0&&scoped.every(c=>c.status==='satisfied');}).length+state.dateRules.filter(r=>checks.some(c=>c.id===`date:${r.id}`&&c.status==='satisfied')).length;
  return {checks,counts:{signatures:entries.length,people:new Set(entries.filter(e=>e.status==='confirmed'&&e.identityConfirmed&&e.capacity!=='unknown'&&e.personId).map(e=>e.personId)).size,satisfied,pending:checks.filter(c=>c.status==='needs_confirmation'||c.status==='not_satisfied').length},blocking:checks.some(c=>c.mandatory&&c.status!=='satisfied'&&c.status!=='not_applicable')};
}
