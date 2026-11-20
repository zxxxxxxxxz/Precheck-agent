import type { DB } from '../../infrastructure/database/client.js';
import type { ReviewConfigRelease,ReviewConfigManifest } from '@hsbc/contracts/review-config';
import type {Actor} from '../identity/types.js';

/** Calls stay inside the caller's existing transaction and lock order. */
export interface DocumentReviewPort {
  getPublished(db: DB, releaseId: string): Promise<ReviewConfigRelease>;
  getManifestForDocumentConfiguration(db:DB, configurationId:string):Promise<ReviewConfigManifest|undefined>;
  invalidateDependencies(db: DB, caseId: string, input: { documentVersionId?: string; parseRevision?: string; reason: string }): Promise<void>;
  signatureInformationChanged?(db:DB,c:any,actor:Actor,input:{documentId:string;recordId:string;version:number;reason:string}):Promise<void>;
}
