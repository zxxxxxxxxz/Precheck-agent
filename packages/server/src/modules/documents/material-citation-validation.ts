import {createHash} from 'node:crypto';
import type {PrivateIntakeProjection} from '../intake/privacy-projection.js';
import {intakeCloudReferences} from '../intake/intake-source-references.js';
import {ModelExecutionError} from '../../model/gateway.js';
import type {DocumentCloudInput} from './cloud-extraction-contract.js';
import {documentSourceQuotes} from './cloud-extraction-source.js';

type Material={typeRef:string|null;sourceRefs:string[];evidence:Array<{sourceRef:string;quote:string}>};
export type MaterialCitationCheck={materialIndex:number;sourceRef:string;pageNumber:number;quoteSha256:string;reason:'citation_not_in_source'};

/** V2 citations are independent evidence proposals. A rejected quotation never
 * supports classification; a known type still requires another exact citation.
 * Structural errors and invalid privacy projections remain fatal. */
export function validateMaterialCitations(materials:Material[],input:DocumentCloudInput,projection:PrivateIntakeProjection){
  const wire=intakeCloudReferences(projection.blocks);
  const replacements=new Map(projection.replacements.map(item=>[item.placeholder,item.original]));
  const sources=new Map(input.pages.map(({id})=>{
    const original=input.blocks.find(block=>block.id===id),index=projection.blocks.findIndex(block=>block.id===id);
    if(!original||index<0)throw new ModelExecutionError('invalid_output');
    // Construct outside the per-citation catch: projection corruption must not
    // be mistaken for a single invalid model citation.
    return [wire.blocks[index]!.id,{restore:documentSourceQuotes(original.text,projection.blocks[index]!.text,replacements),
      pageNumber:input.pages.find(page=>page.id===id)!.page.page.page_number}] as const;
  }));
  const checks:MaterialCitationCheck[]=[];
  const validated=materials.map((material,materialIndex)=>({...material,evidence:material.evidence.filter(citation=>{
    const source=sources.get(citation.sourceRef);
    if(!source||!material.sourceRefs.includes(citation.sourceRef))throw new ModelExecutionError('invalid_output');
    try{
      if(source.restore(citation.quote).every(value=>value.text.trim()))return true;
    }catch(error){if(!(error instanceof ModelExecutionError)||error.code!=='invalid_output')throw error;}
    checks.push({materialIndex,sourceRef:citation.sourceRef,pageNumber:source.pageNumber,
      quoteSha256:createHash('sha256').update(citation.quote).digest('hex'),reason:'citation_not_in_source'});
    return false;
  })}));
  if(validated.some(material=>material.typeRef!==null&&!material.evidence.length))throw new ModelExecutionError('invalid_output');
  return {materials:validated,checks};
}
