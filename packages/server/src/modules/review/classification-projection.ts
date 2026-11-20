/** SQL arguments for classification-only reads of a document_artifacts body.
 * Source-node IDs prove Word coverage; source text and chunk payloads never
 * leave PostgreSQL on these list/checklist paths. The fragment is code-owned. */
export const DOCUMENT_CLASSIFICATION_PROJECTION=`
  'classificationMode',body->'classificationMode',
  'logicalDocuments',body->'logicalDocuments',
  'pageCount',body->'pageCount',
  'scope',jsonb_build_object('sourceFormat',body->'scope'->'sourceFormat'),
  'chunks',CASE WHEN body->>'classificationMode'='content-first-v1' AND body->'scope'->>'sourceFormat'='docx'
    THEN coalesce((SELECT jsonb_agg(jsonb_build_object('sourceNodeIds',chunk->'sourceNodeIds'))
      FROM jsonb_array_elements(body->'chunks') chunk),'[]'::jsonb)
    ELSE '[]'::jsonb END`;
