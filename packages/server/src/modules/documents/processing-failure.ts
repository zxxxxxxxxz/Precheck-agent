import {DatabaseError} from 'pg';
import {ServiceError} from '../../infrastructure/integrations/http.js';

/** Only known PostgreSQL contention is retryable. Provider errors and unknown
 * model dispatches retain their original handling and durable ledger fences. */
export function documentProcessingError(error:unknown):unknown {
  if(error instanceof DatabaseError&&['57014','55P03','40P01'].includes(error.code??'')){
    return new ServiceError(error.code==='57014'?'document_database_timeout':'document_database_contention',true);
  }
  return error;
}
