import type { IntakeSourceBlock, IntakeAssistantOutput, IntakeReplyBlock } from '@hsbc/contracts/intake';
import type { ModelProfile, ModelResult } from '@hsbc/contracts/model';
import type { PreparedModelPayload, ModelEgressPermit, ModelGrant } from '../../model/gateway.js';
import type { IntakeConfig } from '../../modules/intake/config.js';
import type { TurnRow, ModelWork } from '../../modules/intake/service.js';
import type { PrivateIntakeProjection, PrivacyEntityProposalResult } from '../../modules/intake/privacy-projection.js';
import type { IntakeCloudReceipt } from '../../modules/intake/intake-v2-model.js';
import type { PrivacyOutputValidation } from '../../modules/intake/privacy-output-diagnostics.js';

/** The agent sequences model work; each domain operation retains its original transaction. */
export interface IntakeAssistantPorts {
  config:IntakeConfig;turn:TurnRow;work:ModelWork;call:any;signal:AbortSignal;fetcher:typeof fetch;
  version(profile:'local_intake'|'cloud_assistant'):string;
  available():boolean;
  emit(type:string,body:Record<string,unknown>):Promise<void>;
  proposeEntities(blocks:IntakeSourceBlock[],signal?:AbortSignal,trustedSourceContext?:readonly IntakeSourceBlock[]):Promise<PrivacyEntityProposalResult>;
  parseAttachments(ids:string[]):Promise<{blocks:Array<{id:string;text:string}>;coverageGaps:string[]}>;
  previousProjection():Promise<PrivateIntakeProjection|undefined>;
  completePreparation(projection:PrivateIntakeProjection,duration:()=>number):Promise<void>;
  projection():Promise<PrivateIntakeProjection|undefined>;
  authorize(profile:ModelProfile,allowed:()=>boolean):Promise<ModelGrant|null>;
  dispatchCloud(payload:PreparedModelPayload,permit:ModelEgressPermit,start:()=>Promise<Response>,allowed:()=>boolean):Promise<Response>;
  recordCloudReceipt(receipt:IntakeCloudReceipt):Promise<void>;
  recordOutputValidationFailure(observation:PrivacyOutputValidation):Promise<void>;
  approvePayload(payload:PreparedModelPayload,result:{payloadHash:string;dataClasses:string[]},allowed:()=>boolean):Promise<ModelEgressPermit>;
  publishChunk(block:IntakeReplyBlock,replyBlocks:IntakeReplyBlock[]):Promise<void>;
  complete(result:Extract<ModelResult,{status:'completed'}>,output:IntakeAssistantOutput,duration:()=>number):Promise<void>;
}
