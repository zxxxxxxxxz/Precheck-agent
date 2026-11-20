import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { type Actor } from '../../identity/types.js';
import { type AppConfig } from '../../../runtime/config.js';
import { ServiceError } from '../../../infrastructure/integrations/http.js';
import type { ObjectStore } from '../../../infrastructure/integrations/oss.js';
import { UploadService, type MaterialParseStatusProjection } from './service.js';
import {MaterialHistoryService} from '../history.js';

export interface UploadDependencies { pool:Pool; config:AppConfig; requireSession(request:FastifyRequest):Promise<Actor>; checkWrite(request:FastifyRequest):Promise<Actor>; objectStore?:ObjectStore;
  onRegistered?:(db:PoolClient,actor:Actor,caseRow:any,documentId:string)=>Promise<void>; materialParseStatus?:MaterialParseStatusProjection }
const id=(value:unknown)=>{const parsed=z.uuid().safeParse(value);if(!parsed.success)throw new AppError(400,'invalid_identifier');return parsed.data;};
async function translate<T>(fn:()=>Promise<T>):Promise<T>{
  try{return await fn();}catch(error){if(error instanceof ServiceError)throw new AppError(error.code==='range_not_satisfiable'?416:error.code==='oss_not_found'?409:error.retryable?503:400,error.code);throw error;}
}
export function registerUploadRoutes(app:FastifyInstance,deps:UploadDependencies) {
  const service=new UploadService(deps.pool,deps.config.upload,deps.objectStore,deps.onRegistered,deps.materialParseStatus);
  const history=new MaterialHistoryService(deps.pool,deps.onRegistered);
  app.get<{Params:{id:string}}>('/api/cases/:id/materials/history',async request=>history.list(await deps.requireSession(request),id(request.params.id),z.object({roundId:z.uuid()}).parse(request.query).roundId));
  app.post<{Params:{id:string}}>('/api/cases/:id/materials/history',async request=>history.add(await deps.checkWrite(request),id(request.params.id),request.body));
  app.post('/api/uploads',async request=>translate(async()=>service.issue(await deps.checkWrite(request),request.body)));
  app.get<{Params:{id:string}}>('/api/uploads/:id',async request=>translate(async()=>service.get(await deps.requireSession(request),id(request.params.id))));
  app.post<{Params:{id:string}}>('/api/uploads/:id/complete',async request=>translate(async()=>{
    const actor=await deps.checkWrite(request);
    const body=z.strictObject({versionId:z.string().min(1).max(1024).optional(),requestId:z.string().max(200).optional()}).safeParse(request.body??{});
    if(!body.success)throw new AppError(400,'invalid_upload_complete');return service.complete(actor,id(request.params.id),body.data.versionId);
  }));
  app.post<{Params:{id:string}}>('/api/uploads/:id/cancel',async request=>translate(async()=>service.cancel(await deps.checkWrite(request),id(request.params.id))));
  app.get<{Params:{id:string}}>('/api/cases/:id/materials',async request=>translate(async()=>service.materials(await deps.requireSession(request),id(request.params.id),z.object({roundId:z.union([z.uuid(),z.literal('legacy')]).optional()}).parse(request.query).roundId)));
  app.get<{Params:{caseId:string;id:string}}>('/api/cases/:caseId/materials/:id/content',async(request,reply)=>translate(async()=>{
    const query=z.object({download:z.literal('1').optional()}).safeParse(request.query);
    if(!query.success)throw new AppError(400,'invalid_download_query');
    const result=await service.content(await deps.requireSession(request),id(request.params.caseId),id(request.params.id),request.headers.range);
    reply.header('Content-Type',result.mimeType).header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Accept-Ranges','bytes');
    const extension=result.mimeType==='application/pdf'?'pdf':result.mimeType==='image/png'?'png':result.mimeType==='image/jpeg'?'jpg':'docx';
    reply.header('Content-Disposition',`${query.data.download==='1'?'attachment':result.mimeType==='application/pdf'?'inline':'attachment'}; filename="document.${extension}"; filename*=UTF-8''${encodeURIComponent(result.filename).replace(/'/g,'%27')}`);
    if(result.range)reply.code(206).header('Content-Range',`bytes ${result.range.start}-${result.range.end}/${result.size}`);
    reply.header('Content-Length',result.bytes.length);return reply.send(result.bytes);
  }));
  return service;
}
