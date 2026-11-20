import {ApiError} from '../../api.ts';

/** An unfinished artifact is still loading between polls, not an empty panel. */
export function waitingForDocumentArtifact(query: {isPending: boolean; data?: unknown; error: unknown}, isProcessing: boolean) {
  return query.isPending || (query.data === undefined && isProcessing &&
    query.error instanceof ApiError && query.error.status === 409 && query.error.code === 'index_not_ready');
}
