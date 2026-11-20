import {REVIEW_EXTRACTION_RECIPES, type ReviewConfigManifest} from '@hsbc/contracts/review-config';

export type ConfigCollection = 'sources' | 'taxonomy' | 'materials' | 'fields' | 'rules';

/** Only field records need an extraction recipe. Persistent recipe IDs belong to the registry. */
export function configurationRecordInitialValues(kind: ConfigCollection, scope: ReviewConfigManifest['scope'], row?: object): Record<string, unknown> {
  if (row) return structuredClone(row) as Record<string, unknown>;
  switch (kind) {
    case 'sources': return {disposition: 'candidate', guaranteeType: 'mortgage'};
    case 'taxonomy': return {sourceIds: []};
    case 'materials': return {sourceIds: [], required: true};
    case 'rules': return {sourceIds: [], sourceDirectionConfirmed: false, operator: 'equal', tests: []};
    case 'fields': {
      const recipe = REVIEW_EXTRACTION_RECIPES.find(entry => entry.modes.length === 1 && entry.modes.includes('manual') && entry.scopes.includes(scope));
      return {
        sourceIds: [], requiredDetection: true, requiredValue: true, type: 'text', objectKind: 'party',
        // Missing metadata stays unselected so required form validation blocks saving instead of crashing.
        recipe: {mode: 'manual', version: recipe?.version, model: recipe?.model ?? null, promptSha256: recipe?.promptSha256},
      };
    }
  }
}
