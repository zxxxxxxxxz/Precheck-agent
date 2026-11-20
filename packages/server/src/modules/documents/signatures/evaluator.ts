import type { SignatureRequirement, SignatureRequirementExpression, SignatureEvaluationInput, SignatureConfirmation, SignatureObservation, SignatureCheck, SignatureRequirementRecord } from '@hsbc/contracts/signature-review';

type Outcome='pass'|'fail'|'blocked'|'not_applicable';
type Evaluation={outcome:Outcome;reasonCodes:string[]};
function decimalCompare(a:string,b:string){const [ai,af='']=a.split('.'),[bi,bf='']=b.split('.'),n=Math.max(af.length,bf.length);const x=BigInt(ai!+af.padEnd(n,'0')),y=BigInt(bi!+bf.padEnd(n,'0'));return x<y?-1:x>y?1:0;}
function validDate(value:string){const parsed=new Date(value);return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;}
function authorization(requirement:SignatureRequirement,signer:SignatureEvaluationInput['signers'][number],input:SignatureEvaluationInput):Evaluation{
  const c=requirement.authorization,a=signer.authorization,f=input.transactionFacts;
  if(!Object.values(c).some(Boolean))return {outcome:'pass',reasonCodes:[]};
  if(!a||!a.sourceAnchorIds.length)return {outcome:'blocked',reasonCodes:['authorization_missing']};
  if(c.checkDate){if(!f.date||!a.validFrom||!a.validUntil||![f.date,a.validFrom,a.validUntil].every(validDate))return {outcome:'blocked',reasonCodes:['authorization_date_unknown']};if(f.date<a.validFrom||f.date>a.validUntil)return {outcome:'fail',reasonCodes:['authorization_expired']};}
  if(c.checkAmount){if(!f.amount||!f.currency||!a.maxAmount||!a.currency)return {outcome:'blocked',reasonCodes:['authorization_amount_unknown']};if(f.currency!==a.currency)return {outcome:'blocked',reasonCodes:['authorization_currency_mismatch']};if(decimalCompare(f.amount,a.maxAmount)>0)return {outcome:'fail',reasonCodes:['authorization_amount_exceeded']};}
  if(c.checkTransaction){if(!f.transactionType||!a.transactionTypes.length)return {outcome:'blocked',reasonCodes:['authorization_transaction_unknown']};if(!a.transactionTypes.includes(f.transactionType))return {outcome:'fail',reasonCodes:['authorization_transaction_outside_scope']};}
  return {outcome:'pass',reasonCodes:[]};
}
/** Deterministic evaluation uses manually linked persons only, never model names. */
export function evaluateSignatureRequirement(requirement:SignatureRequirement,input:SignatureEvaluationInput):Evaluation{
  if(!input.classificationKnown)return {outcome:'blocked',reasonCodes:['classification_unknown']};
  if(!requirement.taxonomyIds.some(id=>input.taxonomyIds.includes(id)))return {outcome:'not_applicable',reasonCodes:[]};
  const subjects=[...new Set(input.signers.filter(s=>s.subjectRole===requirement.subjectRole).map(s=>s.subjectId))];
  if(!subjects.length)return {outcome:'blocked',reasonCodes:['signatory_identity_unconfirmed']};
  const evalNode=(node:SignatureRequirementExpression,subject:string,depth=0):Evaluation=>{
    if(depth>8)return {outcome:'blocked',reasonCodes:['requirement_depth_exceeded']};
    if(node.kind!=='signers'){
      const children=node.children.map(child=>evalNode(child,subject,depth+1));
      const result=node.kind==='allOf'?(children.some(c=>c.outcome==='fail')?'fail':children.some(c=>c.outcome==='blocked')?'blocked':'pass'):(children.some(c=>c.outcome==='pass')?'pass':children.some(c=>c.outcome==='blocked')?'blocked':'fail');
      return {outcome:result,reasonCodes:result==='pass'?[]:[...new Set(children.filter(c=>c.outcome!=='pass').flatMap(c=>c.reasonCodes))]};
    }
    const matching=input.signers.filter(s=>s.subjectId===subject&&s.subjectRole===requirement.subjectRole&&(!node.roles.length||node.roles.includes(s.role)));
    const people=new Map<string,SignatureEvaluationInput['signers'][number]>();
    for(const s of matching){const old=people.get(s.personId);people.set(s.personId,{...s,signature:s.signature||Boolean(old?.signature),stamp:s.stamp||Boolean(old?.stamp)});}
    const marks=(s:SignatureEvaluationInput['signers'][number])=>node.mark==='signature'?s.signature:node.mark==='stamp'?s.stamp:node.mark==='signature_and_stamp'?s.signature&&s.stamp:s.signature||s.stamp;
    const marked=[...people.values()].filter(marks),checks=marked.map(s=>authorization(requirement,s,input));
    if(checks.filter(c=>c.outcome==='pass').length>=node.minimum)return {outcome:'pass',reasonCodes:[]};
    if(checks.some(c=>c.outcome==='fail'))return {outcome:'fail',reasonCodes:[...new Set(checks.flatMap(c=>c.reasonCodes))]};
    if(checks.some(c=>c.outcome==='blocked'))return {outcome:'blocked',reasonCodes:[...new Set(checks.flatMap(c=>c.reasonCodes))]};
    if(!input.coverageComplete)return {outcome:'blocked',reasonCodes:['visual_coverage_incomplete']};
    return {outcome:'fail',reasonCodes:[node.mark==='stamp'?'missing_stamp':node.mark==='signature_and_stamp'&&[...people.values()].filter(s=>s.signature).length>=node.minimum?'missing_stamp':'missing_signature']};
  };
  let assignmentBudget=0,assignmentLimited=false;
  const assignments=(node:SignatureRequirementExpression,subject:string):Set<string>[]=>{
    if(++assignmentBudget>10000){assignmentLimited=true;return [];}
    if(node.kind==='signers'){
      const people=new Map<string,SignatureEvaluationInput['signers'][number]>();
      for(const s of input.signers.filter(s=>s.subjectId===subject&&s.subjectRole===requirement.subjectRole&&(!node.roles.length||node.roles.includes(s.role)))){const old=people.get(s.personId);people.set(s.personId,{...s,signature:s.signature||Boolean(old?.signature),stamp:s.stamp||Boolean(old?.stamp)});}
      const ids=[...people.values()].filter(s=>(node.mark==='signature'?s.signature:node.mark==='stamp'?s.stamp:node.mark==='signature_and_stamp'?s.signature&&s.stamp:s.signature||s.stamp)&&authorization(requirement,s,input).outcome==='pass').map(s=>s.personId);
      const results:Set<string>[]=[];const choose=(start:number,picked:string[])=>{
        if(++assignmentBudget>10000){assignmentLimited=true;return;}
        if(picked.length===node.minimum){results.push(new Set(picked));return;}
        const remaining=node.minimum-picked.length;
        for(let i=start;i<=ids.length-remaining;i++){
          if(results.length>=256||assignmentBudget>=10000){assignmentLimited=true;return;}
          choose(i+1,[...picked,ids[i]!]);
        }
      };choose(0,[]);return results;
    }
    if(node.kind==='anyOf'){
      const result=node.children.flatMap(child=>assignments(child,subject));
      if(result.length>256)assignmentLimited=true;
      return result.slice(0,256);
    }
    let result=[new Set<string>()];
    for(const child of node.children){
      const next=assignments(child,subject),combined:Set<string>[]=[];
      pairs:for(const previous of result)for(const added of next){
        if(++assignmentBudget>10000){assignmentLimited=true;break pairs;}
        if([...added].some(id=>previous.has(id)))continue;
        if(combined.length>=256){assignmentLimited=true;break pairs;}
        combined.push(new Set([...previous,...added]));
      }
      result=combined;if(!result.length)break;
    }
    return result;
  };
  const evaluations=subjects.map(subject=>{const result=evalNode(requirement.expression,subject);assignmentLimited=false;if(result.outcome==='pass'&&!assignments(requirement.expression,subject).length)return {outcome:assignmentLimited?'blocked' as const:'fail' as const,reasonCodes:[assignmentLimited?'requirement_complexity_limit':'distinct_signers_required']};return result;});
  return {outcome:evaluations.some(e=>e.outcome==='fail')?'fail':evaluations.some(e=>e.outcome==='blocked')?'blocked':'pass',reasonCodes:[...new Set(evaluations.flatMap(e=>e.reasonCodes))]};
}

export function evaluateSignatureRequirements(input:{requirements:SignatureRequirementRecord[];observations:SignatureObservation[];confirmations:SignatureConfirmation[];coverageComplete:boolean;classificationKnown:boolean;taxonomyIds:string[]}):SignatureCheck[]{
  const latest=new Map<string,SignatureConfirmation>();for(const c of input.confirmations){if(c.observationId)latest.set(c.observationId,c);if(c.requirementId)latest.set(c.requirementId,c);}
  const facts=[...input.confirmations].reverse().find(c=>c.action==='set_transaction')?.transactionFacts??{date:null,amount:null,currency:null,transactionType:null};
  const accepted=input.observations.flatMap(o=>{const c=latest.get(o.id);return c?.action==='accept'&&c.identity?[{...c.identity,signature:(c.observedKind??o.kind)==='handwriting',stamp:(c.observedKind??o.kind)==='stamp'}]:[];});
  const checks:SignatureCheck[]=input.requirements.map(record=>{
    const override=latest.get(record.requirement.id),requirement=override?.action==='adopt_requirement'&&override.requirement?override.requirement:record.requirement;
    const adopted=record.source==='published_configuration'||override?.action==='adopt_requirement';
    const result=override?.action==='exclude_requirement'?{outcome:'not_applicable' as const,reasonCodes:[]}:!adopted?{outcome:'blocked' as const,reasonCodes:['requirement_unconfirmed']}:evaluateSignatureRequirement(requirement,{signers:accepted,transactionFacts:facts,coverageComplete:input.coverageComplete,classificationKnown:input.classificationKnown,taxonomyIds:input.taxonomyIds});
    const status:SignatureCheck['status']=result.outcome==='pass'?'satisfied':result.outcome==='not_applicable'?'not_applicable':result.outcome==='blocked'?'needs_confirmation':result.reasonCodes.includes('missing_stamp')?'suspected_missing_stamp':result.reasonCodes.includes('missing_signature')?'suspected_missing_signature':'authorization_failed';
    return {id:`check:${requirement.id}`,requirementId:requirement.id,subjectRole:requirement.subjectRole,subjectId:null,label:requirement.label,status,reasonCodes:result.reasonCodes,observationIds:[],anchorIds:record.anchorIds,pageNumbers:record.pageNumbers};
  });
  for(const o of input.observations){const confirmation=latest.get(o.id),kind=confirmation?.observedKind??o.kind;if(confirmation?.action==='exclude'||kind==='printed_name')continue;
    if(kind==='blank_signing_slot'||kind==='uncertain'||!confirmation){checks.push({id:`observation:${o.id}`,requirementId:null,subjectRole:'unassigned',subjectId:null,label:kind==='blank_signing_slot'?'空白签署栏':kind==='stamp'?'疑似印章':kind==='handwriting'?'疑似签字':'签署区域待核对',status:'needs_confirmation',reasonCodes:[kind==='blank_signing_slot'?'blank_slot_requirement_unconfirmed':'observation_unconfirmed'],observationIds:[o.id],anchorIds:o.anchorIds,pageNumbers:[o.pageNumber]});}
  }
  return checks;
}
