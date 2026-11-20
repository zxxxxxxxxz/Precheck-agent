import {ReviewConfigManifestSchema,REVIEW_EXTRACTION_RECIPES,supportsContentClassification,type ReviewConfigManifest} from './review-config.js';

/** Clone the actual approved definitions, never rebuild them from a default factory.
 * The result is a new draft: no trial, approval or publication is inherited.
 */
export function upgradeGuaranteeClassification(input:ReviewConfigManifest,releaseId:string,label?:string):ReviewConfigManifest {
  const manifest=ReviewConfigManifestSchema.parse(input);
  if(!supportsContentClassification(manifest.guaranteeTypes))throw new Error('classification_scope_unsupported');
  if(releaseId===manifest.releaseId)throw new Error('classification_new_release_required');
  if(manifest.compatibility.executorVersion!=='p3-deterministic-v3'||
    !manifest.fields.some(f=>f.recipe.mode==='cloud_grounded_extract')||
    manifest.fields.some(f=>f.recipe.mode==='cloud_grounded_extract'&&f.recipe.version!=='azure-grounded-fields-v2'))throw new Error('classification_recipe_unsupported');
  manifest.releaseId=releaseId;
  if(label!==undefined)manifest.label=label;
  manifest.documentClassification='content-first-v1';
  if(!manifest.docxExtraction){
    const recipe=REVIEW_EXTRACTION_RECIPES.find(r=>r.version==='azure-grounded-docx-v1')!;
    manifest.docxExtraction={version:recipe.version,model:recipe.model,promptSha256:recipe.promptSha256,mode:'cloud_grounded_extract'};
  }
  return ReviewConfigManifestSchema.parse(manifest);
}
