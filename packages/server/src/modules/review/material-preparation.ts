import {currentRequirementPolicy,translationRequirementDisabled} from './requirement-policy.js';
import type {MaterialPreparationItem, ReviewObject} from '@hsbc/contracts/review';
import type {ReviewConfigRelease, ReviewFacts, ReviewRequirementPolicy} from '@hsbc/contracts/review-config';

/** Use the same scoped facts as rule execution; never infer coverage from file counts. */
export function materialPreparation(
  manifest: ReviewConfigRelease['manifest'], objects: ReviewObject[],
  instances: Array<{scopeId:string; facts:ReviewFacts}>,
  policy:ReviewRequirementPolicy=currentRequirementPolicy(),
): MaterialPreparationItem[] {
  return manifest.materials.flatMap(material => {
    if(translationRequirementDisabled(material.id,policy))return [];
    const matches = material.objectScope
      ? objects.filter(object => object.kind === material.objectScope!.kind && object.role === material.objectScope!.role)
      : [];
    const scopes = material.objectScope
      ? matches.length ? matches.map(object => ({id:object.objectId, label:object.label}))
        : [{id:`unconfirmed:${material.objectScope.role}`, label:null}]
      : [{id:'case', label:null}];
    return scopes.map(scope => {
      const facts = instances.find(instance => instance.scopeId === scope.id)?.facts
        ?? (!material.objectScope && !material.applicability ? instances[0]?.facts : undefined);
      const condition = material.applicability;
      const fact = condition ? facts?.[condition.fieldId] : undefined;
      const applicable = !condition ? true : fact?.state === 'present' && fact.value !== null
        ? fact.value === condition.equals : undefined;
      const requirement = applicable === false ? 'not_applicable' : applicable === undefined ? 'unknown'
        : material.required ? 'required' : 'optional';
      const evidence = facts?.[`material:${material.id}`];
      const provided = evidence?.state === 'present' && evidence.value === true;
      const status = requirement === 'not_applicable' ? 'not_applicable' : requirement === 'unknown' ? 'pending'
        : provided ? 'provided' : requirement === 'optional' ? 'optional'
          : evidence?.state === 'present' && evidence.value === false ? 'missing' : 'pending';
      return {materialId:material.id, scopeId:scope.id, objectLabel:scope.label, requirement, status,
        documentVersionIds:provided ? [...new Set(evidence.evidenceIds.filter(id => id.startsWith('document:')).map(id => id.slice(9)))] : []};
    });
  });
}
