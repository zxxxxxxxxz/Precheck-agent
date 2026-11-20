import {CaseSupplementService} from '@hsbc/server/modules/case-supplement/service';
import {FormalReviewService} from '@hsbc/server/modules/formal-review/service';
import {RELEASE_READ_ONLY} from '@hsbc/server/runtime/release-mode';
import {loadFormalConfig} from '@hsbc/server/modules/formal-review/config';
import {CaseAssistantService} from '@hsbc/server/modules/case-assistant/service';
import {loadCaseAssistConfig} from '@hsbc/server/modules/case-assistant/config';
import {ReviewAnalysisService} from '@hsbc/server/modules/review-delivery/analysis-service';
import {loadReviewAssistConfig} from '@hsbc/server/modules/review-delivery/model';
import { documentReviewPort } from '@hsbc/server/runtime/document-review';
import {DraftAttachmentService} from '@hsbc/server/modules/materials/draft-attachments/service';
import {loadRuntimeIntakeConfig} from '@hsbc/server/modules/intake/config';
import { IntakeService } from '@hsbc/server/modules/intake/service';
import { ReviewService,subjectConfirmationEnabled} from '@hsbc/server/modules/review/service';
import { loadReviewRuntime } from '@hsbc/server/modules/review/runtime';
import { executeReviewGraph } from '@hsbc/workflows/review/graph';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadConfig } from '@hsbc/server/runtime/config';
import { logEvent } from '@hsbc/server/runtime/logging';
import { verifyDatabase } from '@hsbc/server/infrastructure/database/client';
import { UploadService } from '@hsbc/server/modules/materials/uploads/service';
import { ApplicationWorker } from '@hsbc/workflows/runtime/worker';
import { OssObjectStore } from '@hsbc/server/infrastructure/integrations/oss';
import { DocumentService } from '@hsbc/server/modules/documents/service';
import { loadDocumentRuntimeConfig } from '@hsbc/server/modules/documents/config';
import { MockValidationService } from '@hsbc/server/modules/documents/validation/service';
import { loadMockFont } from '@hsbc/server/modules/documents/validation/image';
import { probeDocxRuntime } from '@hsbc/server/document/docx-convert';

export async function createApplicationWorker(){
  const config=loadConfig(process.env,'worker'),pool=new pg.Pool({connectionString:config.databaseUrl,max:8,connectionTimeoutMillis:5000,statement_timeout:15000});
  await verifyDatabase(pool,config.instanceId);
  const documentConfig=loadDocumentRuntimeConfig(),store=new OssObjectStore(config.upload),documents=new DocumentService(pool,store,config.upload,documentConfig,{},documentReviewPort);
  if(documentConfig.docxPreview)await probeDocxRuntime();
  const mockValidation=new MockValidationService(pool,store,config.upload,{...documentConfig,enabled:Boolean(documentConfig.mockValidation),reader:documentConfig.reader,font:loadMockFont(process.env)});
  const draftAttachments=new DraftAttachmentService(pool,config.upload,store,{ocr:documentConfig.ocr});
  const intake=new IntakeService(pool,loadRuntimeIntakeConfig(),fetch,draftAttachments);
  const reviewRuntime=loadReviewRuntime();
  let analyses:ReviewAnalysisService|undefined;
  const reviews:ReviewService|undefined=reviewRuntime.review?new ReviewService(pool,reviewRuntime.executor,{subjectConfirmation:subjectConfirmationEnabled(),documents,crossFileAnalysis:(...args)=>analyses?analyses.projectCrossFile(...args):Promise.resolve(args[4]),execute:(invoke,snapshot,work)=>executeReviewGraph(invoke,snapshot,work,()=>reviews!.verifyWorkSnapshot(work,snapshot))}):undefined;
  analyses=reviewRuntime.review?new ReviewAnalysisService(pool,documents,loadReviewAssistConfig(),undefined,reviews):undefined;
  const formal=reviews?new FormalReviewService(pool,documents,reviews,loadFormalConfig()):undefined;
  const supplements=new CaseSupplementService(pool,documents,loadReviewAssistConfig());
  const assistantConfig=loadCaseAssistConfig(),assistant=reviews&&assistantConfig?new CaseAssistantService(pool,reviews,assistantConfig,{documents}):undefined;
  const uploads=new UploadService(pool,config.upload,store,(...args)=>documents.registered(...args)),worker=new ApplicationWorker(pool,uploads,{redisUrl:config.redisUrl,queuePrefix:config.queuePrefix,documents,mockValidation,intake,reviews,analyses,formal,assistant,supplements,readOnly:RELEASE_READ_ONLY});
  await worker.start();
  return {close:async()=>{await worker.close();await pool.end();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const runtime=await createApplicationWorker();let closing=false;
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;void runtime.close().then(()=>process.exit(0));});
  logEvent('p1_worker_ready');
}
