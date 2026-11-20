/** Explicit private quality run over independently annotated, immutable pages.
 * Outputs and model responses belong in a restricted operator directory. */
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,open,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {QwenClient,type QwenDispatch} from '@hsbc/server/infrastructure/integrations/inference';
import {PrivateSignatureVision,SIGNATURE_VISION_MODEL_REVISION,type SignatureVisionPage} from '@hsbc/server/infrastructure/integrations/signature-vision';
import {ServiceError} from '@hsbc/server/infrastructure/integrations/http';
import {evaluateSignatureObservations,signatureEvaluationAssessment,SIGNATURE_SCORING_VERSION} from './signature-evaluation-matching.js';

const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const argument=(name:string)=>{const index=process.argv.indexOf(name),value=process.argv[index+1];if(index<0||!value)throw new Error('evaluation_argument_missing');return value;};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{64}$/;
type Box=[number,number,number,number];
type Region={kind:string;box:{x:number;y:number;width:number;height:number}};
type Page={documentId:string;sourceSha256:string;parseRevision:string;pageNumber:number;imageSha256:string;width:number;height:number;regions:Region[];pageAssessment:string};
type Input={documentId:string;pageNumber:number;imageSha256:string;hintBoxes:Box[]};
const rectangle=(r:Region):Box=>[r.box.x,r.box.y,r.box.x+r.box.width,r.box.y+r.box.height];

async function main(){
  if(process.env.SIGNATURE_PAGE_EVAL_ALLOWED!=='true')throw new Error('evaluation_not_authorized');
  const goldBytes=await readFile(argument('--gold')),goldHash=argument('--expected-gold-sha');
  const inputBytes=await readFile(argument('--input')),inputHash=argument('--expected-input-sha');
  if(!sha.test(goldHash)||!sha.test(inputHash)||digest(goldBytes)!==goldHash||digest(inputBytes)!==inputHash)throw new Error('evaluation_manifest_mismatch');
  const gold=JSON.parse(goldBytes.toString()) as {schemaVersion?:string;caseId:string;pages:Page[]};
  const inputs=JSON.parse(inputBytes.toString()) as {schemaVersion:string;caseId:string;goldSha256:string;records:Input[]};
  if(!uuid.test(gold.caseId)||inputs.caseId!==gold.caseId||inputs.goldSha256!==goldHash||inputs.schemaVersion!=='signature-private-page-input.v1'||gold.pages.length!==69||inputs.records.length!==69||new Set(gold.pages.map(p=>p.documentId)).size!==6)throw new Error('evaluation_scope_invalid');
  const keys=new Set<string>();
  for(const p of gold.pages){
    const key=`${p.documentId}-${p.pageNumber}`;
    if(keys.has(key)||!uuid.test(p.documentId)||!uuid.test(p.parseRevision)||!sha.test(p.sourceSha256)||!sha.test(p.imageSha256)||!Number.isInteger(p.pageNumber)||p.pageNumber<1||!Number.isInteger(p.width)||!Number.isInteger(p.height)||p.width<1||p.height<1||p.width*p.height>16_000_000||!Array.isArray(p.regions))throw new Error('evaluation_page_invalid');
    keys.add(key);
    const matches=inputs.records.filter(i=>i.documentId===p.documentId&&i.pageNumber===p.pageNumber);
    if(matches.length!==1||matches[0]!.imageSha256!==p.imageSha256||matches[0]!.hintBoxes.length>12||matches[0]!.hintBoxes.some(box=>box.length!==4||box.some(n=>!Number.isFinite(n))||box[0]<0||box[1]<0||box[2]>p.width||box[3]>p.height||box[2]<=box[0]||box[3]<=box[1]))throw new Error('evaluation_input_invalid');
    if(p.regions.some(r=>!['handwriting','stamp','blank_signing_slot','printed_name','uncertain','negative_control'].includes(r.kind)||Object.values(r.box).some(n=>!Number.isFinite(n))||r.box.width<=0||r.box.height<=0))throw new Error('evaluation_annotation_invalid');
    signatureEvaluationAssessment('pages',p.pageAssessment);
    if(p.pageAssessment==='no_visible_handwriting_or_seal'&&p.regions.some(r=>r.kind==='handwriting'||r.kind==='stamp'))throw new Error('evaluation_assessment_conflict');
  }
  const root=resolve(argument('--image-root')),out=resolve(argument('--out'));await mkdir(resolve(out,'calls'),{recursive:true,mode:0o700});
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error('evaluation_service_unavailable');return value;};
  const pool=new pg.Pool({connectionString:required('P1_WORKER_DATABASE_URL'),max:3});let dispatched=0,reused=0;
  const dispatch:QwenDispatch=async<T>(body:unknown,start:()=>Promise<T>):Promise<T>=>{
    const requestHash=digest(JSON.stringify(body)),file=resolve(out,'calls',requestHash+'.json');
    try{const old=JSON.parse(await readFile(file,'utf8'));if(old.state==='completed'){reused++;return old.response as T;}throw new Error('evaluation_execution_unknown');}
    catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;}
    if(dispatched>=900)throw new Error('evaluation_call_budget');
    const claim=await open(file,'wx',0o600);await claim.writeFile(JSON.stringify({state:'unknown',requestHash,goldHash,inputHash}));await claim.sync();await claim.close();dispatched++;
    const response=await start(),temporary=file+'.completed';await writeFile(temporary,JSON.stringify({state:'completed',requestHash,goldHash,inputHash,response}),{mode:0o600});await rename(temporary,file);return response;
  };
  const client=new QwenClient({baseUrl:required('P1_QWEN_BASE_URL'),token:required('P1_QWEN_TOKEN'),timeoutMs:180_000,allowHttp:process.env.P1_QWEN_ALLOW_HTTP==='true'},required('P1_QWEN_MODEL'),pool);
  const vision=new PrivateSignatureVision(client,{enabled:true,modelRevision:SIGNATURE_VISION_MODEL_REVISION});
  const results:Array<Record<string,any>>=[],signal=AbortSignal.timeout(60*60_000);
  try{
    for(const page of gold.pages){
      signal.throwIfAborted();const id=`${page.documentId}-${page.pageNumber}`,bytes=await readFile(resolve(root,id+'.png'));
      if(digest(bytes)!==page.imageSha256)throw new Error('evaluation_image_hash_mismatch');
      const hints=inputs.records.find(i=>i.documentId===page.documentId&&i.pageNumber===page.pageNumber)!.hintBoxes;
      let result:SignatureVisionPage|undefined,errorCode:string|undefined;
      try{result=await vision.reviewPage({pageNumber:page.pageNumber,image:bytes,pageImageHash:page.imageSha256,width:page.width,height:page.height,hintBoxes:hints},{signal,dispatch});}
      catch(error){errorCode=error instanceof ServiceError?error.code:error instanceof Error&&/^evaluation_/.test(error.message)?error.message:'evaluation_execution_failed';}
      const observed=result?.observations??[],positives=page.regions.filter(r=>['handwriting','stamp'].includes(r.kind));
      const observedPositive=observed.filter(o=>['handwriting','stamp'].includes(o.kind));
      const blanks=page.regions.filter(r=>r.kind==='blank_signing_slot'),printed=page.regions.filter(r=>r.kind==='printed_name'),uncertain=page.regions.filter(r=>r.kind==='uncertain');
      const scored=evaluateSignatureObservations({assessment:signatureEvaluationAssessment('pages',page.pageAssessment),expected:page.regions.map(r=>({kind:r.kind,bbox:rectangle(r)})),observed,coverage:result?.coverage??'failed',executionFailed:Boolean(errorCode)});
      const {positiveMatch,blankMatch,printedMatch,uncertainMatch,passed}=scored;
      const summary={evaluationVersion:'signature-pages-one-to-one.v2',scoringVersion:SIGNATURE_SCORING_VERSION,pageAssessment:page.pageAssessment,assessmentStratum:scored.assessment,documentId:page.documentId,pageNumber:page.pageNumber,imageSha256:page.imageSha256,coverage:result?.coverage??'failed',expectedPositiveRegions:positives.length,matchedPositiveRegions:positiveMatch.matched,observedPositiveRegions:observedPositive.length,extraPositives:positiveMatch.extra,duplicatePositives:positiveMatch.duplicates,expectedBlankRegions:blanks.length,matchedBlankRegions:blankMatch.matched,extraBlanks:blankMatch.extra,duplicateBlanks:blankMatch.duplicates,expectedPrintedRegions:printed.length,matchedPrintedRegions:printedMatch.matched,extraPrinted:printedMatch.extra,duplicatePrinted:printedMatch.duplicates,expectedUncertainRegions:uncertain.length,locatedUncertainRegions:uncertainMatch.matched,extraUncertain:uncertainMatch.extra,duplicateUncertain:uncertainMatch.duplicates,observedUncertainRegions:observed.filter(o=>o.kind==='uncertain').length,unsupportedObservations:scored.unsupportedObservations,uncertaintyPass:scored.uncertaintyPass,...(errorCode?{errorCode}:{})};
      const record={...summary,passed};results.push(record);await writeFile(resolve(out,id+'.json'),JSON.stringify({goldHash,inputHash,summary:record,result},null,2)+'\n',{mode:0o600});console.log(JSON.stringify(record));
      if(errorCode==='evaluation_execution_unknown')break;
    }
  }finally{await pool.end();}
  const positiveTotal=results.reduce((n,r)=>n+r.expectedPositiveRegions,0);
  const receipt={schemaVersion:'signature-page-evaluation.v2',evaluationVersion:'signature-pages-one-to-one.v2',scoringVersion:SIGNATURE_SCORING_VERSION,inputAnnotationFormat:gold.schemaVersion??'legacy-unversioned-pages',legacyAnnotationFormat:true,goldHash,inputHash,promptVersion:vision.promptVersion,modelRevision:SIGNATURE_VISION_MODEL_REVISION,expectedPages:69,evaluatedPages:results.length,passed:results.length===69&&results.every(r=>r.passed),dispatched,reused,positiveRecall:positiveTotal?results.reduce((n,r)=>n+r.matchedPositiveRegions,0)/positiveTotal:null,positiveRecallMeasurable:positiveTotal>0,results,scope:'isolated_original_six_synthetic_pdfs',businessJobsChanged:false,imagesSentToCloud:false};
  await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});if(!receipt.passed)process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error&&/^evaluation_/.test(error.message)?error.message:'signature_page_evaluation_failed');process.exitCode=1;});
