import { documentToolSchemas, type DocumentToolName } from './document-schemas.js';
import { createDocumentToolAuthorization } from './authorization.js';
import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import type { DocumentRuntimeConfig } from '../../modules/documents/config.js';
import type { DocumentService } from '../../modules/documents/service.js';

/** A short-lived credential identifies a server-owned delegation, never a model-supplied actor. */
export async function registerDocumentMcp(app:FastifyInstance,documents:DocumentService,config:NonNullable<DocumentRuntimeConfig['mcp']>){
  const authorization=await createDocumentToolAuthorization(documents,config);
  await app.register(async scoped=>{
    scoped.addHook('onRequest',hostHeaderValidation(['127.0.0.1','localhost','[::1]']));
    scoped.addHook('onRequest',async request=>{if(request.headers.origin)throw new AppError(403,'browser_origin_not_allowed');});
    scoped.post('/internal/mcp',async(request,reply)=>{
      const identity=await authorization.authenticate(request.headers.authorization);
      // Authenticate discovery and initialization as well as individual calls.
      // A valid signature alone cannot keep a revoked delegation alive.
      const delegatedActions=await authorization.delegatedActions(identity);
      const server=new McpServer({name:'crossborder-document-tools',version:'2.0.0'});
      for(const name of Object.keys(documentToolSchemas) as DocumentToolName[]){
        const enabled=name==='parse_document'||name==='extract_fields'?documents.config.enabled:name==='search_evidence'?documents.config.search:name==='compare_document_versions'?documents.config.comparison:documents.config.reader;
        if(!enabled||!delegatedActions.includes(name))continue;
        server.registerTool(name,{description:`Authorized document evidence: ${name}`,inputSchema:documentToolSchemas[name]},async(raw:unknown)=>{
          try{
            const input=documentToolSchemas[name].parse(raw);
            const authorized=await authorization.authorize(identity,name,input);
            const {actor}=authorized;
            const {caseId,revision,...body}=input;let result:unknown;
            if(name==='parse_document'){const {documentId,...command}=body as z.infer<typeof documentToolSchemas.parse_document>;result=await documents.parse(actor,caseId,documentId,command);}
            else if(name==='extract_fields'){const {documentId,...command}=body as z.infer<typeof documentToolSchemas.extract_fields>;result=await documents.extract(actor,caseId,documentId,command);}
            else if(name==='search_evidence')result=await documents.search(actor,caseId,{...body,expectedRevision:revision});
            else if(name==='compare_document_versions')result=await documents.compare(actor,caseId,body);
            else if(name==='get_tool_job')result=await documents.job(actor,(body as any).jobId);
            else{
              const b=body as z.infer<typeof documentToolSchemas.get_evidence>;
              if(b.sourceNodeId){result=await documents.sourceNode(actor,caseId,b.documentId,b.sourceNodeId,b.parseRevision);}
              else result=await documents.evidence(actor,caseId,b.documentId,b.pageNumber!,b.anchorId!,b.parseRevision);
            }
            await documents.recheckToolAuthority(actor,caseId,authorized.documentIds);
            const output=result as Record<string,unknown>;
            return {content:[{type:'text' as const,text:JSON.stringify(output)}],structuredContent:output};
          }catch(error){return {isError:true,content:[{type:'text' as const,text:error instanceof AppError?error.code:error instanceof z.ZodError?'invalid_request':'tool_failed'}]};}
        });
      }
      const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      await server.connect(transport);reply.hijack();
      reply.raw.once('close',()=>{void transport.close();void server.close();});
      await transport.handleRequest(request.raw,reply.raw,request.body);
    });
  });
}
