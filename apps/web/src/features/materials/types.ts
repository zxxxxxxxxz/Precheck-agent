import type {DraftSource} from '@hsbc/contracts/draft';

export interface Material {
  uploadedRoundNumber?:number|null; historySourceDocumentId?:string|null;
  source?: DraftSource;
  format?: 'pdf' | 'docx' | 'jpg' | 'png' | null; pageCount?: number | null;
  id: string; filename: string; size: number; sha256: string; ossVersionId: string;
  createdAt: string; uploadedBy: string; uploadedByName?: string | null; parseStatus: 'configuration_required' | 'capability_disabled' | 'parked' | 'pending' | 'queued' | 'running' | 'ready' | 'succeeded' | 'partial' | 'failed' | 'canceled' | 'stale'; allowed_actions: string[];
}
export interface UploadSession {
  source?: DraftSource;
  id: string; state: 'issued' | 'verifying' | 'registered' | 'rejected' | 'expired' | 'canceled';
  errorCode?: string; documentVersionId?: string;
}
export interface UploadTicket extends UploadSession {host: string; fields: Record<string, string>; expiresAt: string}
