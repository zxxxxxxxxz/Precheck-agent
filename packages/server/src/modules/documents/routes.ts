import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Auth } from '../identity/auth.js';
import { DocumentService } from './service.js';

export function registerDocumentRoutes(app:FastifyInstance,auth:Auth,documents:DocumentService){
  app.post<{Params:{caseId:string}}>('/api/cases/:caseId/materials/ensure-processing',async request=>
    documents.ensureMaterialProcessing(await auth.checkWrite(request),z.uuid().parse(request.params.caseId),request.body));
  const path=(request:any)=>z.object({caseId:z.uuid(),documentId:z.uuid()}).parse(request.params);
  const revision=(request:any)=>z.object({parseRevision:z.uuid().optional()}).parse(request.query).parseRevision;
  const base='/api/cases/:caseId/documents/:documentId';
  const caseId=(request:any)=>z.uuid().parse(request.params.caseId);
  app.get('/api/processing-approvals',async request=>documents.processingAccess.inbox(await auth.requireSession(request),request.query));
  app.post('/api/processing-approvals/:caseId/decision',async request=>documents.processingAccess.decide(await auth.checkWrite(request),caseId(request),request.body,true));
  app.get('/api/cases/:caseId/processing-access',async request=>documents.processingAccess.state(await auth.requireSession(request),caseId(request)));
  app.post('/api/cases/:caseId/processing-access/request',async request=>documents.processingAccess.request(await auth.checkWrite(request),caseId(request),request.body));
  app.post('/api/cases/:caseId/processing-access/withdraw',async request=>documents.processingAccess.withdraw(await auth.checkWrite(request),caseId(request),request.body));
  app.post('/api/cases/:caseId/processing-access/decision',async request=>documents.processingAccess.decide(await auth.checkWrite(request),caseId(request),request.body));
  app.post('/api/cases/:caseId/processing-access/resume',async(request,reply)=>reply.code(202).send(await documents.resumeProcessing(await auth.checkWrite(request),caseId(request),request.body)));

  app.get(`${base}/translations/targets`,async request=>{const p=path(request);return documents.translationTargets(await auth.requireSession(request),p.caseId,p.documentId,request.query);});
  // Read-only POST keeps original quotations out of request URLs/access logs.
  app.post(`${base}/translations/field-targets`,async request=>{const p=path(request);return documents.fieldTranslationTargets(await auth.requireSession(request),p.caseId,p.documentId,request.body);});
  app.get(`${base}/translations`,async request=>{const p=path(request);return documents.translationList(await auth.requireSession(request),p.caseId,p.documentId,request.query);});
  app.post(`${base}/translations`,async(request,reply)=>{const p=path(request);return reply.code(202).send(await documents.translate(await auth.checkWrite(request),p.caseId,p.documentId,request.body));});
  app.post(`${base}/translations/full-text`,async(request,reply)=>{const p=path(request);return reply.code(202).send(await documents.translateFullText(await auth.checkWrite(request),p.caseId,p.documentId,request.body));});
  app.get(`${base}/translations/:translationId`,async request=>{const p=path(request);return documents.translation(await auth.requireSession(request),p.caseId,p.documentId,z.uuid().parse((request.params as any).translationId));});
  app.get(`${base}/source`,async request=>{const p=path(request);return documents.source(await auth.requireSession(request),p.caseId,p.documentId,revision(request));});
  app.get(`${base}/source/nodes/:nodeId`,async request=>{const p=path(request);return documents.sourceNode(await auth.requireSession(request),p.caseId,p.documentId,z.string().min(1).max(200).parse((request.params as any).nodeId),revision(request));});
  app.get(`${base}/processing`,async request=>{const p=path(request);return documents.processing(await auth.requireSession(request),p.caseId,p.documentId);});
  app.post(`${base}/recover`,async(request,reply)=>{const p=path(request);return reply.code(202).send(await documents.recover(await auth.checkWrite(request),p.caseId,p.documentId,request.body));});
  app.post(`${base}/parse`,async(request,reply)=>{const p=path(request);return reply.code(202).send(await documents.parse(await auth.checkWrite(request),p.caseId,p.documentId,request.body));});
  app.post(`${base}/extract`,async(request,reply)=>{const p=path(request);return reply.code(202).send(await documents.extract(await auth.checkWrite(request),p.caseId,p.documentId,request.body));});
  app.get(`${base}/pages`,async request=>{const p=path(request);return documents.pages(await auth.requireSession(request),p.caseId,p.documentId,revision(request));});
  app.get(`${base}/pages/:pageNumber`,async request=>{const p=path(request),page=z.coerce.number().int().positive().parse((request.params as any).pageNumber);return documents.page(await auth.requireSession(request),p.caseId,p.documentId,page,revision(request));});
  app.get(`${base}/pages/:pageNumber/image`,async(request,reply)=>{const p=path(request),page=z.coerce.number().int().positive().parse((request.params as any).pageNumber);
    const bytes=await documents.image(await auth.requireSession(request),p.caseId,p.documentId,page,revision(request));
    return reply.header('Content-Type','image/png').header('Cache-Control','private, no-store').send(bytes);
  });
  for(const kind of ['directory','fields','signatures'] as const)app.get(`${base}/${kind}`,async request=>{const p=path(request);return documents.artifact(await auth.requireSession(request),p.caseId,p.documentId,kind,revision(request),kind==='signatures'?z.object({reviewId:z.uuid().optional()}).parse(request.query).reviewId:undefined);});
  app.post(`${base}/signatures/check`,async(request,reply)=>{const p=path(request);return reply.code(202).send(await documents.checkSignatures(await auth.checkWrite(request),p.caseId,p.documentId,request.body));});
  app.post(`${base}/signatures/confirm`,async request=>{const p=path(request);return documents.confirmSignature(await auth.checkWrite(request),p.caseId,p.documentId,request.body);});
  app.get(`${base}/signatures/information`,async request=>{const p=path(request),q=z.object({parseRevision:z.uuid().optional(),recordId:z.uuid().optional()}).parse(request.query);return documents.signatureInformation(await auth.requireSession(request),p.caseId,p.documentId,q.parseRevision,q.recordId);});
  app.post(`${base}/signatures/information`,{bodyLimit:4*1024*1024},async request=>{const p=path(request);return documents.saveSignatureInformation(await auth.checkWrite(request),p.caseId,p.documentId,request.body);});
  app.post(`${base}/directory`,{bodyLimit:4*1024*1024},async request=>{const p=path(request);return documents.reviseDirectory(await auth.checkWrite(request),p.caseId,p.documentId,request.body);});
  app.post('/api/cases/:caseId/evidence/search',async request=>documents.search(await auth.checkWrite(request),z.uuid().parse((request.params as any).caseId),request.body));
  app.post('/api/cases/:caseId/documents/compare',async(request,reply)=>reply.code(202).send(await documents.compare(await auth.checkWrite(request),z.uuid().parse((request.params as any).caseId),request.body)));
  app.get('/api/tool-jobs/:jobId',async request=>documents.job(await auth.requireSession(request),z.uuid().parse((request.params as any).jobId)));
  app.post('/api/tool-jobs/:jobId/cancel',async request=>documents.cancel(await auth.checkWrite(request),z.uuid().parse((request.params as any).jobId)));
}
