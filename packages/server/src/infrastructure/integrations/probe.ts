/** Explicit synthetic integration probe; never runs on import or on upload. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { NerClient, OpaClient, OcrInferenceClient, QwenClient } from './inference.js';
import { ServiceError, type ServiceConfig } from './http.js';

export async function probeServices(services:string[],env:NodeJS.ProcessEnv=process.env) {
  if(!services.length||services.some(service=>!['ocr','ner','opa','qwen'].includes(service)))throw new Error('explicit_valid_services_required');
  const results: {service:string;state:'passed'|'failed';code?:string;durationMs:number;metadata?:Record<string,string|number|boolean>}[]=[];
  const required=(key:string)=>{const value=env[key];if(!value)throw new ServiceError('probe_configuration_missing');return value;};
  const config=(service:string,timeoutMs:number):ServiceConfig=>({baseUrl:required(`P1_${service}_BASE_URL`),token:required(`P1_${service}_TOKEN`),timeoutMs,
    allowHttp:env[`P1_${service}_ALLOW_HTTP`]==='true'});
  for(const service of services){const start=Date.now();try{
    let metadata:Record<string,string|number|boolean>={synthetic:true};
    if(service==='ocr'){
      const fixture=await readFile(new URL('../../../../../testdata/synthetic/table-and-signature.png',import.meta.url));
      const result=await new OcrInferenceClient(config('OCR',180000)).parse(fixture,{returnWordBox:true});
      metadata={...metadata,pages:result.pages.length,wordResults:result.pages.filter(page=>page.word_ocr).length,fixtureSha256:createHash('sha256').update(fixture).digest('hex')};
    }else if(service==='ner'){
      const result=await new NerClient(config('NER',60000)).entities('Alice works at Example Ltd in London.',['person','company','location']);
      const count=Object.values(result.entities).reduce((sum,entities)=>sum+entities.length,0);
      if(!count)throw new ServiceError('ner_synthetic_entities_missing');metadata={...metadata,entities:count};
    }else if(service==='opa'){
      const schema=z.object({release_id:z.literal('demo_v1'),schema:z.literal('hsbc-demo-v1'),demo_only:z.literal(true),outcome:z.enum(['satisfied','not_satisfied','insufficient_evidence'])});
      const client=new OpaClient(config('OPA',10000),new Map([['demo_v1','/v1/data/hsbc/releases/demo_v1/decision']]));
      for(const [input,outcome] of [[{schema:'hsbc-demo-v1',amount:1},'satisfied'],[{schema:'hsbc-demo-v1',amount:0},'not_satisfied'],[{schema:'hsbc-demo-v1'},'insufficient_evidence']] as const){
        if((await client.evaluate('demo_v1',input,schema)).outcome!==outcome)throw new ServiceError('opa_probe_mismatch');
      }
      metadata={...metadata,release:'demo_v1',cases:3};
    }else{
      const pool=new pg.Pool({connectionString:required('P1_WORKER_DATABASE_URL'),max:1,connectionTimeoutMillis:5000});
      try{const result=await new QwenClient(config('QWEN',120000),required('P1_QWEN_MODEL'),pool).chat([{role:'user',content:'Synthetic connectivity test: reply with the word READY.'}]);
        metadata={...metadata,model:result.model,simulated:result.simulated,outputTokens:result.usage.completion_tokens};
      }finally{await pool.end();}
    }
    results.push({service,state:'passed',durationMs:Date.now()-start,metadata});
  }catch(error){results.push({service,state:'failed',durationMs:Date.now()-start,code:error instanceof ServiceError?error.code:'probe_failed'});}}
  return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.argv.includes('--synthetic-only'))throw new Error('explicit_synthetic_only_flag_required');
  const argument=process.argv.find(value=>value.startsWith('--services='));
  const result=await probeServices(argument?.slice('--services='.length).split(',')??[]);
  console.log(JSON.stringify({scope:'synthetic_service_contracts',results:result},null,2));
  if(result.some(item=>item.state==='failed'))process.exitCode=1;
}
