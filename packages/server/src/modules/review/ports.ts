import type {DB} from '../../infrastructure/database/client.js';
import type { Actor } from '../identity/types.js';

export interface DocumentExtractionPort {
  reviewOriginalPdf?(db:DB,actor:Actor,caseId:string,documentId:string,parseRevision:string):Promise<Uint8Array|undefined>;
  extract(actor: Actor, caseId: string, documentId: string, input: unknown): Promise<{ jobId: string }>;
}
