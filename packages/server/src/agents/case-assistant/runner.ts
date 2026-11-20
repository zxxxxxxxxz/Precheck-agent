import {executeCaseAssistModel,localSourceRef,prepareCaseAssistProjection,restoreDeep} from '../../modules/case-assistant/model.js';
import type {CaseAssistantPorts} from './ports.js';

export async function runCaseAssistant(p:CaseAssistantPorts){
  const {privacy,projection,withheld}=await prepareCaseAssistProjection({job:p.job,blocks:p.blocks,config:p.config,ner:p.ner,signal:p.signal,isolatable:p.isolatable});
  const {output}=await executeCaseAssistModel({job:p.job,mode:p.mode,privacy,projection,config:p.config,hooks:p.hooks,signal:p.signal,fetcher:p.fetcher});
  await p.complete(restoreDeep(output,projection),ref=>localSourceRef(ref,projection),withheld);
}
