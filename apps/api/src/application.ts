import {CaseSupplementService,registerCaseSupplementRoutes} from '@hsbc/server/modules/case-supplement/service';
import {FormalReviewService,registerFormalReviewRoutes} from '@hsbc/server/modules/formal-review/service';
import {assertReleaseWrite} from '@hsbc/server/runtime/release-mode';
import {loadFormalConfig,type FormalConfig} from '@hsbc/server/modules/formal-review/config';
import {CaseAssistantService,registerCaseAssistantRoutes} from '@hsbc/server/modules/case-assistant/service';
import {loadCaseAssistConfig,type CaseAssistConfig} from '@hsbc/server/modules/case-assistant/config';
import {CheckerService,registerCheckerRoutes} from '@hsbc/server/modules/review-checker/service';
import {ReviewAnalysisService,registerReviewAnalysisRoutes} from '@hsbc/server/modules/review-delivery/analysis-service';
import {loadReviewAssistConfig,type ReviewAssistConfig} from '@hsbc/server/modules/review-delivery/model';
import {ReviewDeliveryService,registerReviewDeliveryRoutes} from '@hsbc/server/modules/review-delivery/service';
import {CaseClosureService,registerCaseClosureRoutes} from '@hsbc/server/modules/cases/closure';
import {ReviewRoundService,registerReviewRoundRoutes} from '@hsbc/server/modules/review/rounds';
import { documentReviewPort } from '@hsbc/server/runtime/document-review';
import { adoptDraftAttachments } from '@hsbc/server/modules/materials/draft-attachments/service';
import { cancelDraftAttachments } from '@hsbc/server/modules/materials/draft-attachments/service';
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter,type NestFastifyApplication } from '@nestjs/platform-fastify';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { AppError } from '@hsbc/server/shared/errors';
import { loadConfig, type AppConfig } from '@hsbc/server/runtime/config';
import { logEvent } from '@hsbc/server/runtime/logging';
import { verifyDatabase } from '@hsbc/server/infrastructure/database/client';
import { registerAuth,registerAdministration } from '@hsbc/server/modules/identity/auth';
import { registerCases } from '@hsbc/server/modules/cases/routes';
import { registerWorkbench } from '@hsbc/server/modules/cases/workbench';
import { registerUploadRoutes } from '@hsbc/server/modules/materials/uploads/routes';
import type { ObjectStore } from '@hsbc/server/infrastructure/integrations/oss';
import { OssObjectStore } from '@hsbc/server/infrastructure/integrations/oss';
import { DocumentService } from '@hsbc/server/modules/documents/service';
import { loadDocumentRuntimeConfig,type DocumentRuntimeConfig } from '@hsbc/server/modules/documents/config';
import { registerDocumentRoutes } from '@hsbc/server/modules/documents/routes';
import { registerDocumentMcp } from '@hsbc/server/protocols/mcp/document-tools';
import { MockValidationService } from '@hsbc/server/modules/documents/validation/service';
import { loadMockFont } from '@hsbc/server/modules/documents/validation/image';
import { registerCaseDrafts } from '@hsbc/server/modules/cases/drafts';
import { cancelDraftTurns, loadApplicableCandidate, registerIntakeRoutes } from '@hsbc/server/modules/intake/service';
import {DraftAttachmentService,registerDraftAttachmentRoutes} from '@hsbc/server/modules/materials/draft-attachments/service';
import {assistantCapability} from '@hsbc/server/modules/intake/assistant';
import {loadRuntimeIntakeConfig,type IntakeConfig} from '@hsbc/server/modules/intake/config';
import { ReviewConfigService, registerReviewConfigRoutes, caseConfigurationOptions, initializeCaseConfiguration } from '@hsbc/server/modules/review/configuration';
import { ReviewService, registerReviewRoutes,subjectConfirmationEnabled} from '@hsbc/server/modules/review/service';
import { loadReviewRuntime, type ReviewRuntime } from '@hsbc/server/modules/review/runtime';
import { loadCompanyIdentityConfig } from '@hsbc/server/modules/company-identity/config';
import { CompanyIdentityService, registerCompanyIdentityRoutes } from '@hsbc/server/modules/company-identity/service';

class ApplicationModule{} Module({})(ApplicationModule);
export async function createApplicationApi(config:AppConfig=loadConfig(),options:{listen?:boolean;objectStore?:ObjectStore;documentConfig?:DocumentRuntimeConfig;reviewRuntime?:ReviewRuntime;intakeConfig?:IntakeConfig;reviewAssistConfig?:ReviewAssistConfig;caseAssistConfig?:CaseAssistConfig;formalConfig?:FormalConfig}={}){
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:12,connectionTimeoutMillis:5000,statement_timeout:15000});
  await verifyDatabase(pool,config.instanceId);
  const app=await NestFactory.create<NestFastifyApplication>(ApplicationModule,new FastifyAdapter({logger:false,bodyLimit:128*1024,trustProxy:config.trustProxy.length?config.trustProxy:false,requestTimeout:30000}),{logger:false});
  const http=app.getHttpAdapter().getInstance();
  http.addHook('onRequest',async(request:any)=>{
    assertReleaseWrite(request.method,request.url);
    if(config.mode==='production'&&request.url.startsWith('/api/')&&!request.url.startsWith('/api/health/')&&request.protocol!=='https')throw new AppError(403,'https_required');
  });
  const errorHandler=(error:any,request:any,reply:any)=>{
    const status=error instanceof AppError?error.status:error instanceof z.ZodError?422:error?.code==='23505'?409:
      error?.statusCode>=400&&error?.statusCode<500?error.statusCode:500;
    const code=error instanceof AppError?error.code:error instanceof z.ZodError?'invalid_request':status===409?'conflict':status<500?'invalid_request':'request_failed';
    logEvent('p1_request_error',{requestId:request.id,state:code});
    reply.code(status).send({error:{code,message:code,requestId:request.id}});
  };
  http.addHook('onSend',async(_request:any,reply:any)=>{
    reply.header('cache-control','no-store').header('x-content-type-options','nosniff').header('referrer-policy','no-referrer');
  });
  const ready=async()=>{await verifyDatabase(pool,config.instanceId);return {status:'ready',version:'p1'};};
  http.get('/health/live',async()=>({status:'alive',version:'p1'}));http.get('/health/ready',ready);http.get('/api/health/ready',ready);
  const auth=await registerAuth(http,pool,config);
  const objectStore=options.objectStore??new OssObjectStore(config.upload),documentConfig=options.documentConfig??loadDocumentRuntimeConfig();
  const intakeConfig=options.intakeConfig??loadRuntimeIntakeConfig();
  const draftAttachments=new DraftAttachmentService(pool,config.upload,objectStore,{ocr:documentConfig.ocr});
  const reviewRuntime=options.reviewRuntime??loadReviewRuntime();
  const documents=new DocumentService(pool,objectStore,config.upload,documentConfig,{},documentReviewPort);
  let analyses:ReviewAnalysisService|undefined;
  const reviewConfigs=new ReviewConfigService(pool,reviewRuntime.executor),reviews=new ReviewService(pool,reviewRuntime.executor,{subjectConfirmation:subjectConfirmationEnabled(),documents,crossFileAnalysis:(...args)=>analyses?analyses.projectCrossFile(...args):Promise.resolve(args[4])});
  if(reviewRuntime.configuration)registerReviewConfigRoutes(http,pool,auth,reviewConfigs);
  if(reviewRuntime.review){analyses=new ReviewAnalysisService(pool,documents,options.reviewAssistConfig??loadReviewAssistConfig(),undefined,reviews);registerReviewAnalysisRoutes(http,auth,analyses);}
  registerCaseSupplementRoutes(http,auth,new CaseSupplementService(pool,documents,options.reviewAssistConfig??loadReviewAssistConfig()));
  if(reviewRuntime.review)registerReviewDeliveryRoutes(http,auth,new ReviewDeliveryService(pool));
  const formal=new FormalReviewService(pool,documents,reviews,options.formalConfig??loadFormalConfig());
  if(reviewRuntime.review)registerFormalReviewRoutes(http,auth,formal);
  const checker=new CheckerService(pool,reviews,formal);
  if(reviewRuntime.review)registerCheckerRoutes(http,auth,checker);
  if(reviewRuntime.review)registerCaseClosureRoutes(http,auth,new CaseClosureService(pool,checker));
  if(reviewRuntime.review)registerReviewRoundRoutes(http,auth,new ReviewRoundService(pool),reviews);
  if(reviewRuntime.configuration)registerReviewRoutes(http,pool,auth,reviews,{reviewEnabled:reviewRuntime.review});
  // Default off; turns are processed by the Worker. Rule confirmation still uses the review command.
  const assistant=new CaseAssistantService(pool,reviews,options.caseAssistConfig??loadCaseAssistConfig(),{documents});
  if(reviewRuntime.review)registerCaseAssistantRoutes(http,auth,assistant);
  const companyIdentities=new CompanyIdentityService(pool,loadCompanyIdentityConfig());
  registerCompanyIdentityRoutes(http,auth,companyIdentities);
  http.get('/api/capabilities',async(request:any)=>{await auth.requireSession(request);return {intake:assistantCapability(intakeConfig),caseAssistant:reviewRuntime.review?assistant.capability():{available:false,reason:'review_disabled',model:null},draftAttachments:config.upload.enabled,registration:config.upload.enabled,parsing:documentConfig.enabled,automaticPreparse:documentConfig.enabled&&documentConfig.automatic,documentReader:documentConfig.reader,logicalDirectory:documentConfig.directory,evidenceSearch:documentConfig.search,versionComparison:documentConfig.comparison,docxUpload:Boolean(config.upload.docxEnabled),docxPreview:Boolean(documentConfig.docxPreview),mockValidation:Boolean(documentConfig.mockValidation),mockReader:documentConfig.reader,reviewConfiguration:reviewRuntime.configuration,reviewLoop:reviewRuntime.review,documentTranslation:Boolean(documentConfig.translation&&documentConfig.reader),cloudReview:Boolean(formal.config),cloudTranslation:false};});
  await registerAdministration(http,pool,auth);await registerCases(http,pool,auth,config,documentConfig.enabled,{documentReader:documentConfig.reader,logicalDirectory:documentConfig.directory,evidenceSearch:documentConfig.search,versionComparison:documentConfig.comparison},{adoptAttachments:(db,actor,draftId,caseId)=>adoptDraftAttachments(db,actor,draftId,caseId,(...args)=>documents.registered(...args)),cancelTurns:cancelDraftTurns,
    reviewedFields:(db,actor,caseId)=>reviews.reviewedFields(db,actor,caseId),
    ...(reviewRuntime.configuration?{configurations:{
      list:async(db,actor)=>({...await caseConfigurationOptions(db,actor),processingPolicy:documents.processingAccess.policySummary()}),
      initialize:initializeCaseConfiguration,
    }}:{})});
  await registerWorkbench(http,pool,auth);
  await registerCaseDrafts(http,pool,auth,loadApplicableCandidate,cancelDraftTurns,cancelDraftAttachments);
  const intake=await registerIntakeRoutes(http,pool,auth,intakeConfig,draftAttachments);
  registerDraftAttachmentRoutes(http,draftAttachments,auth,cancelDraftTurns);
  const uploads=registerUploadRoutes(http,{pool,config,...auth,objectStore,onRegistered:(...args)=>documents.registered(...args),materialParseStatus:(caseRow,document)=>documents.materialParseStatus(caseRow,document)});
  registerDocumentRoutes(http,auth,documents);
  const mockValidation=new MockValidationService(pool,objectStore,config.upload,{...documentConfig,enabled:Boolean(documentConfig.mockValidation),reader:documentConfig.reader,font:loadMockFont(process.env)});
  const mockBase='/api/cases/:caseId/documents/:documentId/mock-runs';
  const mockPath=(request:any)=>z.object({caseId:z.uuid(),documentId:z.uuid(),runId:z.uuid().optional()}).parse(request.params);
  http.get(mockBase,async(request:any)=>{const p=mockPath(request);return mockValidation.list(await auth.requireSession(request),p.caseId,p.documentId);});
  http.get(`${mockBase}/:runId`,async(request:any)=>{const p=mockPath(request);return mockValidation.get(await auth.requireSession(request),p.caseId,p.documentId,p.runId!);});
  http.get(`${mockBase}/:runId/images/:kind`,async(request:any,reply:any)=>{const p=mockPath(request),kind=z.enum(['original','mock']).parse(request.params.kind);
    const bytes=await mockValidation.image(await auth.requireSession(request),p.caseId,p.documentId,p.runId!,kind);
    return reply.header('Content-Type','image/png').header('Cache-Control','private, no-store').send(bytes);});
  if(documentConfig.mcp)await registerDocumentMcp(http,documents,documentConfig.mcp);
  await app.init();http.setErrorHandler(errorHandler);await http.ready();
  if(options.listen!==false){await app.listen(config.port,config.host);logEvent('p1_api_ready',{port:config.port});}
  return {app,http,pool,uploads,documents,mockValidation,intake,reviewConfigs,reviews,checker,formal,assistant,close:async()=>{assistant.stop();formal.stop();reviews.stop();await app.close();await pool.end();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const runtime=await createApplicationApi();let closing=false;
  for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(closing)return;closing=true;void runtime.close().then(()=>process.exit(0));});
}
