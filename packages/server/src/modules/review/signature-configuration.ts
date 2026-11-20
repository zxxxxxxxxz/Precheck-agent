import type { ConfigValidation, ReviewConfigManifest, ReviewConfigView } from '@hsbc/contracts/review-config';
import { evaluateSignatureRequirement } from '../documents/signatures/evaluator.js';

export function validateSignatureConfiguration(manifest: ReviewConfigManifest): ConfigValidation['issues'] {
  const issues: ConfigValidation['issues'] = [];
  const add = (code: string, path: string) => issues.push({code, path});
  const requirements = manifest.signatureRequirements ?? [];
  const tests = manifest.signatureTests ?? [];
  if (!requirements.length) {
    if (manifest.signatureTests) add('signature_requirements_missing', 'signatureRequirements');
    return issues;
  }
  if (manifest.compatibility.signatureExecutorVersion !== 'signature-requirements-v1') add('signature_executor_required', 'compatibility.signatureExecutorVersion');
  const seen = new Set<string>();
  for (const requirement of requirements) {
    const path = `signatureRequirements.${requirement.id}`;
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(requirement.id)) add('signature_requirement_id_invalid', path);
    if (seen.has(requirement.id)) add('duplicate_id', path);
    seen.add(requirement.id);
    if (manifest.rules.some(rule => rule.id === `signature:${requirement.id}`)) add('duplicate_id', path);
    if (new Set(requirement.taxonomyIds).size !== requirement.taxonomyIds.length || requirement.taxonomyIds.some(id => !manifest.taxonomy.some(type => type.id === id))) add('signature_taxonomy_invalid', path);
    for (const id of requirement.sourceIds) {
      const source = manifest.sources.find(source => source.id === id);
      if (!source) add('source_reference_missing', path);
      else if (source.disposition === 'excluded' || source.disposition === 'manual') add('source_not_executable', path);
      else if (manifest.scope === 'bank' && (source.disposition !== 'confirmed' || !source.approvalRef || source.sha256 === '0'.repeat(64))) add('bank_source_unconfirmed', path);
    }
    const own = tests.filter(test => test.requirementId === requirement.id);
    for (const kind of ['normal', 'abnormal', 'boundary', 'missing_input']) if (!own.some(test => test.kind === kind)) add('rule_test_kind_missing', `${path}.tests.${kind}`);
  }
  const testIds = new Set<string>();
  for (const test of tests) {
    const path = `signatureTests.${test.id}`;
    if (testIds.has(test.id)) add('duplicate_id', path);
    testIds.add(test.id);
    if (!seen.has(test.requirementId)) add('signature_requirement_reference_missing', path);
    if (test.kind === 'normal' && test.expected !== 'pass' || test.kind === 'abnormal' && test.expected !== 'fail' || test.kind === 'missing_input' && test.expected !== 'blocked') add('rule_test_expectation_invalid', path);
    if (test.input.taxonomyIds.some(id => !manifest.taxonomy.some(type => type.id === id))) add('signature_taxonomy_invalid', path);
  }
  return issues;
}

export function runSignatureTrials(manifest: ReviewConfigManifest) {
  const results: NonNullable<ReviewConfigView['trial']>['results'] = [];
  const receipts = [];
  for (const test of manifest.signatureTests ?? []) {
    const requirement = manifest.signatureRequirements?.find(item => item.id === test.requirementId);
    if (!requirement) throw new Error('signature_requirement_reference_missing');
    const evaluated = evaluateSignatureRequirement(requirement, test.input);
    results.push({ruleId: `signature:${requirement.id}`, testId: test.id, expected: test.expected, actual: evaluated.outcome, passed: evaluated.outcome === test.expected});
    receipts.push({executorVersion: 'signature-requirements-v1', requirementId: requirement.id, testId: test.id, ...evaluated});
  }
  return {results, receipts};
}
