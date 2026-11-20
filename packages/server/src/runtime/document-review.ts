import { getPublished } from '../modules/review/configuration.js';
import { invalidateReviewDependencies,signatureInformationChanged } from '../modules/review/service.js';
import type { DocumentReviewPort } from '../modules/documents/ports.js';

/** Composition shared by application entrypoints and isolated regression fixtures. */
export const documentReviewPort: DocumentReviewPort = {
  getPublished,
  getManifestForDocumentConfiguration:async(db,id)=>{
    const row=(await db.query('SELECT release_id FROM business.review_config_releases WHERE document_configuration_id=$1',[id])).rows[0];
    return row?(await getPublished(db,row.release_id)).manifest:undefined;
  },
  invalidateDependencies: invalidateReviewDependencies,
  signatureInformationChanged,
};
