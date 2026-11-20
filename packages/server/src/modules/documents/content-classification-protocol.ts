import {z} from 'zod';
import {ModelExecutionError} from '../../model/gateway.js';
import type {PrivateIntakeProjection} from '../intake/privacy-projection.js';
import {intakeCloudReferences} from '../intake/intake-source-references.js';
import type {DocumentCloudInput} from './cloud-extraction-contract.js';
import {DOCUMENT_CLOUD_V2_VERSION,DOCUMENT_CLOUD_V2_SCHEMA,DocumentCloudV2OutputSchema} from './cloud-extraction-v2-contract.js';
import {DOCUMENT_DOCX_VERSION,DOCUMENT_DOCX_SCHEMA,DocumentDocxOutputSchema,type DocumentDocxInput} from './docx-extraction-contract.js';
import type {DocumentCloudProtocol} from './cloud-extraction-model.js';
import {CONTENT_CLASSIFICATION_INSTRUCTIONS} from './content-classification.js';

/** Keep privacy/source ordinals intact. Reference metadata is never a material
 * source, even if a model proposes it as unknown. Domain citation and complete
 * coverage checks still run after this wire-level boundary.
 */
export function contentClassificationProtocol(input:DocumentCloudInput|DocumentDocxInput,projection:PrivateIntakeProjection):DocumentCloudProtocol {
  const native='units' in input;
  const ids=(native?input.units:input.pages).map(unit=>unit.id),sources=new Set(ids);
  if(!ids.length||ids.length>255||sources.size!==ids.length||sources.has('dictionary')||input.fields.length||
    input.blocks.length!==ids.length+1||input.blocks.filter(b=>b.id==='dictionary').length!==1||
    input.blocks.some(b=>b.id!=='dictionary'&&!sources.has(b.id))||projection.withheldSources?.length||
    JSON.stringify(input.blocks.map(b=>b.id))!==JSON.stringify(projection.blocks.map(b=>b.id)))throw new ModelExecutionError('invalid_output');
  const wire=intakeCloudReferences(projection.blocks).blocks;
  const refs=wire.filter((_,i)=>sources.has(projection.blocks[i]!.id)).map(b=>b.id);
  const dictionaryRef=wire[projection.blocks.findIndex(b=>b.id==='dictionary')]!.id;
  const ref=z.enum(refs as [string,...string[]]),base=native?DocumentDocxOutputSchema:DocumentCloudV2OutputSchema;
  const material=base.shape.materials.element;
  const outputSchema=base.extend({
    materials:z.array(material.extend({
      sourceRefs:z.array(ref).min(1).max(refs.length),
      evidence:z.array(material.shape.evidence.element.extend({sourceRef:ref})).max(native?20:10),
    })).min(1).max(refs.length),
    fields:base.shape.fields.max(0),
  });
  return {version:native?DOCUMENT_DOCX_VERSION:DOCUMENT_CLOUD_V2_VERSION,schema:native?DOCUMENT_DOCX_SCHEMA:DOCUMENT_CLOUD_V2_SCHEMA,
    instructions:CONTENT_CLASSIFICATION_INSTRUCTIONS+'\nReference-only dictionary: '+dictionaryRef+'. Document sourceRefs to classify: '+JSON.stringify(refs)+'.',
    outputSchema};
}
