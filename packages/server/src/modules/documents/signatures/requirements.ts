import { createHash } from 'node:crypto';
import type { DocumentBundle } from '@hsbc/contracts/documents';
import type { SignatureRequirement, SignatureRequirementExpression, SignatureRequirementRecord } from '@hsbc/contracts/signature-review';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Grounded clauses remain proposals. OCR instructions are never executed. */
export function signatureRequirements(bundle:DocumentBundle,published:SignatureRequirement[]):SignatureRequirementRecord[]{
  return signatureRequirementProjection(bundle,published).requirements;
}
export function signatureRequirementProjection(bundle:DocumentBundle,published:SignatureRequirement[]):{requirements:SignatureRequirementRecord[];truncated:boolean}{
  const result:SignatureRequirementRecord[]=published.slice(0,500).map(requirement=>({requirement,source:'published_configuration',status:'authoritative',anchorIds:[],pageNumbers:[],clauseText:null}));
  let truncated=published.length>500;
  for(const chunk of bundle.chunks){
    if(!chunk.anchorIds.length||chunk.text.length>8000||!/(?:签字|签署|盖章|签章|signed?\s+by|signature|executed\s+by|seal)/i.test(chunk.text))continue;
    const text=chunk.text;
    // A clause is a requirement proposal only when normative wording exists.
    if(!/(?:须|应当|应由|需由|必须|shall|must|required|signed\s+by|signature\s+of)/i.test(text))continue;
    if(result.length>=500){truncated=true;break;}
    const director=/(?:董事|director)/i.test(text),secretary=/(?:秘书|secretary)/i.test(text),two=/(?:两名|二名|两位|two\s+directors|2\s+directors)/i.test(text);
    const signature=/(?:签字|签署|signed|signature)/i.test(text),stamp=/(?:盖章|印章|seal|stamp)/i.test(text),either=/(?:或|\bor\b)/i.test(text);
    const mark=signature&&stamp?(either?'signature_or_stamp':'signature_and_stamp'):stamp?'stamp':'signature';
    const expression:SignatureRequirementExpression=director&&secretary?{kind:either?'anyOf':'allOf',children:[{kind:'signers',roles:['director'],minimum:1,mark},{kind:'signers',roles:['secretary'],minimum:1,mark}]}:{kind:'signers',roles:director?['director']:secretary?['secretary']:[],minimum:two?2:1,mark};
    const logical=bundle.logicalDocuments.find(d=>d.id===chunk.logicalDocumentId),taxonomyIds=logical?.labelId?[logical.labelId]:['unknown'];
    result.push({requirement:{id:`clause:${digest(chunk.id+text).slice(0,32)}`,label:'原文签署要求',subjectRole:'unassigned',taxonomyIds,sourceIds:[`anchor:${chunk.anchorIds[0]}`],expression,authorization:{requireEvidence:true,checkDate:false,checkAmount:false,checkTransaction:false}},source:'document_clause',status:'candidate',anchorIds:chunk.anchorIds,pageNumbers:chunk.pageNumbers,clauseText:text});
  }
  return {requirements:result,truncated};
}
