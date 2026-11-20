import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,open,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {QwenClient,type QwenDispatch} from '@hsbc/server/infrastructure/integrations/inference';
import {PrivateSignatureVision,SIGNATURE_VISION_MODEL_REVISION,type SignatureVisionPage} from '@hsbc/server/infrastructure/integrations/signature-vision';
import {ServiceError} from '@hsbc/server/infrastructure/integrations/http';
import {evaluateSignatureObservations,matchSignatureRegions,signatureEvaluationAssessment,SIGNATURE_SCORING_VERSION} from './signature-evaluation-matching.js';
const evaluationVersion='signature-controls-one-to-one.v3';
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const arg=(name:string)=>{const value=process.argv[process.argv.indexOf(name)+1];if(!process.argv.includes(name)||!value)throw new Error('missing_evaluation_argument');return value;};
type Gold={id:string;imageSha256:string;width:number;height:number;assessment:string;regions:Array<{kind:string;box:{x:number;y:number;width:number;height:number}}>};
async function main(){
  if(process.env.SIGNATURE_CONTROL_EVAL_ALLOWED!=='true')throw new Error('evaluation_not_authorized');
  const manifestBytes=await readFile(arg('--manifest')),manifestHash=arg('--expected-manifest-sha');
  if(!/^[a-f0-9]{64}$/.test(manifestHash)||digest(manifestBytes)!==manifestHash)throw new Error('independent_manifest_mismatch');
  const gold=JSON.parse(manifestBytes.toString()) as {schemaVersion:string;modelOutputsReadBeforeAnnotation:boolean;records:Gold[]};
  if(gold.schemaVersion!=='signature-independent-controls.v1'||gold.modelOutputsReadBeforeAnnotation!==false||gold.records.length!==9||gold.records.some(r=>!/^\w+$/.test(r.id)||!/^[a-f0-9]{64}$/.test(r.imageSha256)))throw new Error('invalid_independent_manifest');
  for(const item of gold.records){
    signatureEvaluationAssessment('controls',item.assessment);
    if(!Array.isArray(item.regions)||item.regions.some(r=>!['handwriting','stamp','blank_signing_slot','printed_name','uncertain','negative_control'].includes(r.kind)))throw new Error('invalid_independent_manifest');
    const positives=item.regions.filter(r=>r.kind==='handwriting'||r.kind==='stamp').length;
    if(item.assessment==='positive_synthetic_mark'&&!positives||item.assessment==='negative_for_handwriting_and_stamp'&&positives)throw new Error('evaluation_assessment_conflict');
  }
  const imageRoot=resolve(arg('--image-root')),out=resolve(arg('--out'));await mkdir(out,{recursive:true,mode:0o700});await mkdir(resolve(out,'calls'),{recursive:true,mode:0o700});
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error('evaluation_service_unavailable');return value;};
  const pool=new pg.Pool({connectionString:required('P1_WORKER_DATABASE_URL'),max:3});let dispatched=0,reused=0;
  const dispatch:QwenDispatch=async<T>(body:unknown,start:()=>Promise<T>):Promise<T>=>{
    const requestHash=digest(JSON.stringify(body)),file=resolve(out,'calls',requestHash+'.json');
    try{const previous=JSON.parse(await readFile(file,'utf8'));if(previous.state==='completed'){reused++;return previous.response as T;}throw new Error('evaluation_execution_unknown');}
    catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error;}
    if(dispatched>=100)throw new Error('evaluation_call_budget');
    const claim=await open(file,'wx',0o600);await claim.writeFile(JSON.stringify({state:'unknown',requestHash,manifestHash}));await claim.sync();await claim.close();dispatched++;
    const response=await start(),temporary=file+'.completed';await writeFile(temporary,JSON.stringify({state:'completed',requestHash,manifestHash,response}),{mode:0o600});await rename(temporary,file);return response;
  };
  const client=new QwenClient({baseUrl:required('P1_QWEN_BASE_URL'),token:required('P1_QWEN_TOKEN'),timeoutMs:180_000,allowHttp:process.env.P1_QWEN_ALLOW_HTTP==='true'},required('P1_QWEN_MODEL'),pool);
  const vision=new PrivateSignatureVision(client,{enabled:true,modelRevision:SIGNATURE_VISION_MODEL_REVISION});
  const results:Array<Record<string,unknown>>=[];
  try{
    for(const item of gold.records){
      const image=await readFile(resolve(imageRoot,item.id+'.png'));if(digest(image)!==item.imageSha256)throw new Error('control_image_hash_mismatch');
      let result:SignatureVisionPage|undefined,errorCode:string|undefined;
      try{result=await vision.reviewPage({pageNumber:1,image,pageImageHash:item.imageSha256,width:item.width,height:item.height},{dispatch});}
      catch(error){errorCode=error instanceof ServiceError?error.code:error instanceof Error&&/^evaluation_/.test(error.message)?error.message:'evaluation_execution_failed';}
      const positives=item.regions.filter(r=>r.kind==='handwriting'||r.kind==='stamp'),observed=result?.observations.filter(r=>r.kind==='handwriting'||r.kind==='stamp')??[];
      const regionBox=(region:Gold['regions'][number])=>({kind:region.kind,bbox:[region.box.x,region.box.y,region.box.x+region.box.width,region.box.y+region.box.height] as [number,number,number,number]});
      const scored=evaluateSignatureObservations({assessment:signatureEvaluationAssessment('controls',item.assessment),expected:item.regions.map(regionBox),observed:result?.observations??[],coverage:result?.coverage??'failed',executionFailed:Boolean(errorCode)});
      const positiveMatch=scored.positiveMatch;
      const matched=positiveMatch.matched,extraPositives=positiveMatch.extra,duplicatePositives=positiveMatch.duplicates;
      const falsePositive=extraPositives>0;
      const expectedNonPositive=item.regions.filter(region=>region.kind==='blank_signing_slot'||region.kind==='printed_name');
      const observedNonPositive=result?.observations.filter(mark=>mark.kind==='blank_signing_slot'||mark.kind==='printed_name')??[];
      const nonPositiveMatch=matchSignatureRegions(expectedNonPositive.map(regionBox),observedNonPositive);
      const nonPositivePass=nonPositiveMatch.missing===0&&nonPositiveMatch.extra===0&&nonPositiveMatch.duplicates===0;
      const {uncertaintyPass,passed}=scored;
      const summary={evaluationVersion,scoringVersion:SIGNATURE_SCORING_VERSION,assessment:item.assessment,assessmentStratum:scored.assessment,coverage:result?.coverage??'failed',id:item.id,imageSha256:item.imageSha256,expectedPositiveRegions:positives.length,matchedPositiveRegions:matched,observedPositiveRegions:observed.length,falsePositive,extraPositives,duplicatePositives,missingPositiveRegions:positiveMatch.missing,nonPositiveMatch,uncertainMatch:scored.uncertainMatch,unsupportedObservations:scored.unsupportedObservations,uncertaintyPass,nonPositivePass,passed,...(errorCode?{errorCode}:{})};
      results.push(summary);await writeFile(resolve(out,item.id+'.json'),JSON.stringify({evaluationVersion,manifestHash,summary,result},null,2)+'\n',{mode:0o600});
      console.log(JSON.stringify(summary));
    }
  }finally{await pool.end();}
  const receipt={schemaVersion:'signature-control-evaluation.v3',evaluationVersion,scoringVersion:SIGNATURE_SCORING_VERSION,inputAnnotationFormat:gold.schemaVersion,legacyAnnotationFormat:true,manifestHash,promptVersion:vision.promptVersion,modelRevision:SIGNATURE_VISION_MODEL_REVISION,passed:results.every(r=>r.passed),dispatched,reused,results,genuineHandwriting:false,identityClaim:false,scope:'isolated_synthetic_controls'};
  await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});if(!receipt.passed)process.exitCode=1;
}
main().catch(error=>{console.error(error instanceof Error&&/^evaluation_|^independent_|^invalid_independent_|^control_image_/.test(error.message)?error.message:'signature_control_evaluation_failed');process.exitCode=1;});
