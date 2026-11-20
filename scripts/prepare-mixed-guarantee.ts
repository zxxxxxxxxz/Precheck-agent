/** Offline preparation only. Publication still uses ReviewConfigService and independent approval. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {combineGuaranteeManifests} from '@hsbc/contracts/mixed-guarantee';
import {ReviewConfigManifestSchema} from '@hsbc/contracts/review-config';
import {validateReviewConfig} from '@hsbc/server/modules/review/configuration';
import {configHash,createRulePackage,LocalOpaExecutor} from '@hsbc/server/modules/review/opa';

// Inputs are two exported immutable manifests, not a database connection or environment file.
const [input,releaseId,output]=process.argv.slice(2);
if(!input||!releaseId||!output||!process.env.P3_OPA_BINARY)throw new Error('usage: prepare-mixed-guarantee.ts INPUT_JSON RELEASE_ID NEW_OUTPUT_DIRECTORY (P3_OPA_BINARY required)');
const raw:unknown=JSON.parse(await readFile(input,'utf8'));
if(!Array.isArray(raw)||raw.length!==2)throw new Error('exactly_two_manifests_required');
const inputs=raw.map(m=>ReviewConfigManifestSchema.parse(m));
const company=inputs.find(m=>m.guaranteeTypes.join()==='corporate_guarantee');
const person=inputs.find(m=>m.guaranteeTypes.join()==='personal_guarantee');
if(!company||!person)throw new Error('company_and_personal_inputs_required');
const manifest=combineGuaranteeManifests(releaseId,company,person);
manifest.label='公司＋个人担保测试配置';
const validation=validateReviewConfig(manifest);
if(!validation.valid)throw new Error('mixed_configuration_invalid:'+validation.issues.map(i=>i.code+':'+i.path).join(','));
const built=createRulePackage(manifest),executor=new LocalOpaExecutor(process.env.P3_OPA_BINARY);
const fixtures=manifest.rules.flatMap(rule=>rule.tests.map(test=>({rule,test})));
const receipts=await executor.evaluateBatch({...built,manifest},fixtures.map(({rule,test})=>({facts:test.facts,ruleIds:[rule.id]})));
if(receipts.length!==fixtures.length||fixtures.some(({test},i)=>receipts[i]?.results[0]?.outcome!==test.expected))throw new Error('mixed_rule_trial_failed');
const report={status:'prepared-not-published',releaseId,scope:manifest.scope,inputs:inputs.map(m=>({releaseId:m.releaseId,manifestHash:configHash(m)})),
  manifestHash:configHash(manifest),packageHash:built.packageHash,fields:manifest.fields.length,rules:manifest.rules.length,
  materials:manifest.materials.length,ruleTests:fixtures.length,ruleTestsPassed:receipts.length};
await mkdir(resolve(output));
await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(output,'package.json'),JSON.stringify({...built,configuration:manifest,manifestHash:report.manifestHash},null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(output,'preparation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
