import {setTimeout as wait} from 'node:timers/promises';
import type {NerClient} from '../../infrastructure/integrations/inference.js';
import {ServiceError} from '../../infrastructure/integrations/http.js';

/** One document shares a bounded wait budget across preparation and final scan.
 * Only explicit capacity rejection is retried; no partial scan can pass. */
export function documentNerWithCapacity(client:Pick<NerClient,'entities'>,budgetMs=60_000):Pick<NerClient,'entities'> {
  if(!Number.isInteger(budgetMs)||budgetMs<0||budgetMs>60_000)throw new Error('document_ner_budget_invalid');
  let waitedMs=0;
  return {async entities(text,labels,options={}){
    while(true){
      options.signal?.throwIfAborted();
      const started=performance.now();
      try{return await client.entities(text,labels,options);}
      catch(error){
        if(options.signal?.aborted||!(error instanceof ServiceError)||error.code!=='ner_busy'||!error.retryable)throw error;
        waitedMs+=performance.now()-started;
        const remaining=budgetMs-waitedMs;
        if(remaining<=0)throw error;
        const delay=Math.min(remaining,Math.max(1,error.retryAfterMs??2000)),waitStarted=performance.now();
        await wait(delay,undefined,{signal:options.signal});
        waitedMs+=Math.max(delay,performance.now()-waitStarted);
        if(waitedMs>=budgetMs)throw error;
      }
    }
  }};
}
