import type { PoolClient } from 'pg';
import type { DocumentBundle } from '@hsbc/contracts/documents';
import { searchTerms } from './engine/search.js';

/** Called in the same fenced transaction as the immutable evidence artifact. */
export async function persistDocumentIndex(db: PoolClient, bundle: DocumentBundle, revision: number): Promise<void> {
  // A JSON recordset avoids one round trip per chunk and has no SQL interpolation.
  await db.query(`INSERT INTO business.document_chunks
    (job_id,directory_revision,chunk_id,case_id,document_version_id,configuration_release_id,logical_document_id,page_numbers,content,text_sha256)
    SELECT $1,$2,c.id,$3,$4,$5,c."logicalDocumentId",c."pageNumbers",c.text,c."textSha256"
    FROM jsonb_to_recordset($6::jsonb) AS c(id text,"logicalDocumentId" text,"pageNumbers" integer[],text text,"textSha256" text)
    ON CONFLICT (job_id,directory_revision,chunk_id) DO NOTHING`,
  [bundle.scope.parseRevision,revision,bundle.scope.caseId,bundle.scope.documentVersionId,bundle.scope.configurationReleaseId,JSON.stringify(bundle.chunks)]);
}

export interface DocumentSearchFilter { logicalDocumentId?: string; pageNumbers?: number[] }
/** Authorization is performed by DocumentService before invoking this query.
 * The WHERE scope applies before ranking/limit; Unicode substring fallback also
 * handles CJK and clause numbering without an external tokenizer extension. */
export async function documentIndexCandidates(db: PoolClient,bundle:DocumentBundle,revision:number,query:string,filter:DocumentSearchFilter={}):Promise<string[]> {
  const terms=searchTerms(query).slice(0,32);
  const rows=await db.query(`SELECT chunk_id,
      ts_rank_cd(terms,websearch_to_tsquery('simple',$6)) +
      (SELECT count(*)::real FROM unnest($7::text[]) AS q(term) WHERE strpos(lower(normalize(content,NFKC)),q.term)>0) AS score
    FROM business.document_chunks
    WHERE case_id=$1 AND document_version_id=$2 AND job_id=$3 AND directory_revision=$4
      AND configuration_release_id=$5
      AND ($8::text IS NULL OR logical_document_id=$8)
      AND ($9::integer[] IS NULL OR page_numbers && $9)
      AND (terms @@ websearch_to_tsquery('simple',$6)
        OR EXISTS (SELECT 1 FROM unnest($7::text[]) AS q(term) WHERE strpos(lower(normalize(content,NFKC)),q.term)>0))
    ORDER BY score DESC,chunk_id LIMIT 100`,
  [bundle.scope.caseId,bundle.scope.documentVersionId,bundle.scope.parseRevision,revision,bundle.scope.configurationReleaseId,query.normalize('NFKC'),terms,filter.logicalDocumentId??null,filter.pageNumbers??null]);
  return rows.rows.map(row=>row.chunk_id as string);
}
