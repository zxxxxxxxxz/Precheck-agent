/** Offline preparation from a pinned manifest. Never connects, approves or publishes. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {upgradeGuaranteeClassification} from '@hsbc/contracts/guarantee-classification-upgrade';
import {validateReviewConfig} from '@hsbc/server/modules/review/configuration';
import {configHash,createRulePackage,LocalOpaExecutor} from '@hsbc/server/modules/review/opa';

const [input,releaseId,output,label]=process.argv.slice(2);
if(!input||!releaseId||!output||!process.env.P3_OPA_BINARY)throw new Error('usage: prepare-guarantee-classification.ts MANIFEST_JSON NEW_RELEASE_ID NEW_OUTPUT_DIRECTORY [LABEL] (P3_OPA_BINARY required)');
const original=JSON.parse(await readFile(input,'utf8'));
const manifest=upgradeGuaranteeClassification(original,releaseId,label);
const validation=validateReviewConfig(manifest);
if(!validation.valid)throw new Error('classification_configuration_invalid:'+validation.issues.map(i=>i.code+':'+i.path).join(','));
const allowed=new Set(['releaseId','label','documentClassification','docxExtraction']);
const changed=Object.keys(manifest).filter(key=>configHash(original[key]??null)!==configHash(manifest[key as keyof typeof manifest]??null));
if(changed.some(key=>!allowed.has(key)))throw new Error('classification_definitions_changed');
const built=createRulePackage(manifest),executor=new LocalOpaExecutor(process.env.P3_OPA_BINARY);
const fixtures=manifest.rules.flatMap(rule=>rule.tests.map(test=>({rule,test})));
const receipts=await executor.evaluateBatch({...built,manifest},fixtures.map(({rule,test})=>({facts:test.facts,ruleIds:[rule.id]})));
if(receipts.length!==fixtures.length||fixtures.some(({rule,test},i)=>{
  const receipt=receipts[i];
  return !receipt||receipt.releaseId!==releaseId||receipt.packageHash!==built.packageHash||
    receipt.executorVersion!==manifest.compatibility.executorVersion||receipt.results.length!==1||
    receipt.results[0]?.ruleId!==rule.id||receipt.results[0]?.outcome!==test.expected;
}))throw new Error('classification_rule_trial_failed');
const report={status:'prepared-not-published',inputReleaseId:original.releaseId,inputHash:configHash(original),
  releaseId,manifestHash:configHash(manifest),changed,fields:manifest.fields.length,rules:manifest.rules.length,
  ruleTests:fixtures.length,ruleTestsPassed:receipts.length,modelAccuracyTested:false};
await mkdir(resolve(output));
await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(output,'preparation.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(report));
