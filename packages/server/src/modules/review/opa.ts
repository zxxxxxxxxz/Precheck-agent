import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import { OpaReceiptSchema, ReviewConfigManifestSchema, ReviewFactsSchema, type ReviewConfigManifest, type ReviewConfigRelease, type ReviewFacts, type OpaReceipt } from '@hsbc/contracts/review-config';
import { BoundedHttpClient, ServiceError, type ServiceConfig } from '../../infrastructure/integrations/http.js';

export const EXECUTOR_VERSION='p3-deterministic-v1' as const;
export function canonicalJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const configHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const byteHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export interface RulePackage {releaseId:string;packageHash:string;policySha256:string;source:string;manifest:{revision:string;roots:string[];rego_version:1}}
type ExecutableRelease=Pick<ReviewConfigRelease,'releaseId'|'manifest'|'packageHash'|'policySha256'>;
export interface RuleExecutor {
  evaluate(release:ExecutableRelease,facts:ReviewFacts,signal?:AbortSignal,ruleIds?:string[]):Promise<OpaReceipt>;
  evaluateBatch?(release:ExecutableRelease,fixtures:Array<{facts:ReviewFacts;ruleIds:string[]}>,signal?:AbortSignal):Promise<OpaReceipt[]>;
}

// Only this reviewed policy template becomes code. Draft content is JSON data;
// it cannot introduce builtins, imports, arbitrary paths, or Rego source.
const policy=String.raw`
import rego.v1

fact(key) := object.get(input.facts, key, {"value": null, "state": "missing", "evidenceIds": []})

applicable(rule) if { object.get(rule, "applicability", null) == null }
applicable(rule) if {
  condition := rule.applicability
  value := fact(condition.fieldId)
  value.state == "present"
  value.value == condition.equals
}
excluded(rule) if {
  condition := rule.applicability
  value := fact(condition.fieldId)
  value.state == "present"
  value.value != condition.equals
}
missing_parameter(rule) if {
  some key in rule.requiredParameters
  object.get(binding.parameters, key, null) == null
}
acceptable_state(_, value) if { value.state == "present"; value.value != null }
acceptable_state(rule, value) if { rule.operator == "present"; value.state in {"blank", "missing"} }
acceptable_state(rule, value) if { rule.operator == "blank"; value.state == "blank" }
bad_input(rule) if { some key in rule.inputs; not acceptable_state(rule, fact(key)) }
decimal(value) if { is_string(value); regex.match("^[+-]?[0-9]+([.][0-9]+)?$", value) }
numeric_input(rule) if { rule.operator == "minimum" }
numeric_input(rule) if { rule.operator == "range_covers"; field := binding.fields[rule.inputs[0]]; field.type == "amount" }
bad_number(rule) if { numeric_input(rule); some key in rule.inputs; not decimal(fact(key).value) }
comparable(rule, index) := to_number(fact(rule.inputs[index]).value) if { numeric_input(rule) }
comparable(rule, index) := fact(rule.inputs[index]).value if { not numeric_input(rule) }
string_set(value) := result if {
  is_string(value)
  parsed := json.unmarshal(value)
  is_array(parsed)
  count(parsed) > 0
  every item in parsed { is_string(item); item != "" }
  result := {item | some item in parsed}
  count(result) == count(parsed)
}
bad_set(rule) if { rule.operator == "set_covers"; some key in rule.inputs; not string_set(fact(key).value) }

satisfied(rule) if { rule.operator == "present"; fact(rule.inputs[0]).state == "present"; fact(rule.inputs[0]).value != null; fact(rule.inputs[0]).value != ""; fact(rule.inputs[0]).value != false }
satisfied(rule) if { rule.operator == "blank"; fact(rule.inputs[0]).state == "blank" }
satisfied(rule) if { rule.operator == "equal"; fact(rule.inputs[0]).value == fact(rule.inputs[1]).value }
satisfied(rule) if { rule.operator == "minimum"; comparable(rule, 0) >= comparable(rule, 1) }
satisfied(rule) if { rule.operator == "date_order"; comparable(rule, 0) <= comparable(rule, 1) }
satisfied(rule) if { rule.operator == "range_covers"; comparable(rule, 0) <= comparable(rule, 2); comparable(rule, 1) >= comparable(rule, 3) }
satisfied(rule) if { rule.operator == "set_covers"; actual := string_set(fact(rule.inputs[0]).value); required := string_set(fact(rule.inputs[1]).value); count(required - actual) == 0 }

outcome(rule) := {"outcome": "not_applicable", "reasonCode": "condition_not_met"} if { excluded(rule) }
else := {"outcome": "blocked", "reasonCode": "condition_unknown"} if { not applicable(rule) }
else := {"outcome": "blocked", "reasonCode": "parameter_missing"} if { missing_parameter(rule) }
else := {"outcome": "blocked", "reasonCode": "input_insufficient"} if { bad_input(rule) }
else := {"outcome": "blocked", "reasonCode": "input_invalid_number"} if { bad_number(rule) }
else := {"outcome": "blocked", "reasonCode": "input_invalid_set"} if { bad_set(rule) }
else := {"outcome": "pass", "reasonCode": "satisfied"} if { satisfied(rule) }
else := {"outcome": "fail", "reasonCode": "requirement_not_met"}

selected(rule) if { rule.id in input.requestedRuleIds }
valid_request if {
  input.schemaVersion == "review-facts.v1"
  input.releaseId == binding.releaseId
  input.packageHash == binding.packageHash
  is_object(input.facts)
  is_array(input.requestedRuleIds)
  count(input.requestedRuleIds) > 0
  count({id | some id in input.requestedRuleIds}) == count(input.requestedRuleIds)
  every id in input.requestedRuleIds { some rule in binding.rules; rule.id == id }
}
decision := {"releaseId": binding.releaseId, "packageHash": binding.packageHash, "executorVersion": "p3-deterministic-v1", "results": results} if {
  valid_request
  results := [object.union(outcome(rule), {"ruleId": rule.id, "evidenceIds": sort({ref | some key in rule.inputs; some ref in fact(key).evidenceIds})}) |
    some rule in binding.rules
    selected(rule)
  ]
}
`;

// The v1 bytes above are immutable. Additional semantics live only in the v2 dispatcher.
const policyV2=policy.replaceAll('review-facts.v1','review-facts.v2').replaceAll('p3-deterministic-v1','p3-deterministic-v2')
  .replace('bad_number(rule) if { numeric_input(rule); some key in rule.inputs; not decimal(fact(key).value) }','bad_number(rule) if { numeric_input(rule); rule.operator != "minimum_in_currency"; some key in rule.inputs; not decimal(fact(key).value) }')
  .replace('else := {"outcome": "pass", "reasonCode": "satisfied"}',`else := {"outcome": "blocked", "reasonCode": "identity_conflicting"} if { rule.operator == "same_entity"; identity_same(rule); identity_different(rule) }
else := {"outcome": "blocked", "reasonCode": "identity_confirmation_required"} if { rule.operator == "same_entity"; not identity_known(rule) }
else := {"outcome": "blocked", "reasonCode": "currency_outside_scope"} if { rule.operator == "minimum_in_currency"; some index in [2, 3]; fact(rule.inputs[index]).value != rule.currency }
else := {"outcome": "pass", "reasonCode": "satisfied"}`)+String.raw`
numeric_input(rule) if { rule.operator == "minimum_in_currency" }
bad_number(rule) if { rule.operator == "minimum_in_currency"; some index in [0, 1]; not decimal(fact(rule.inputs[index]).value) }
identity_same(rule) if {
  a := fact(rule.inputs[0]); b := fact(rule.inputs[1])
  object.get(a, "objectId", "") != ""; object.get(b, "objectId", "") != ""
  b.objectId in object.get(a, "sameEntityIds", [])
}
identity_same(rule) if {
  a := fact(rule.inputs[0]); b := fact(rule.inputs[1])
  object.get(a, "objectId", "") != ""; object.get(b, "objectId", "") != ""
  a.objectId in object.get(b, "sameEntityIds", [])
}
identity_different(rule) if {
  a := fact(rule.inputs[0]); b := fact(rule.inputs[1])
  object.get(a, "objectId", "") != ""; object.get(b, "objectId", "") != ""
  b.objectId in object.get(a, "differentEntityIds", [])
}
identity_different(rule) if {
  a := fact(rule.inputs[0]); b := fact(rule.inputs[1])
  object.get(a, "objectId", "") != ""; object.get(b, "objectId", "") != ""
  a.objectId in object.get(b, "differentEntityIds", [])
}
identity_known(rule) if { identity_same(rule) }
identity_known(rule) if { identity_different(rule) }
satisfied(rule) if { rule.operator == "same_entity"; identity_same(rule); not identity_different(rule) }
satisfied(rule) if { rule.operator == "currency_is"; every key in rule.inputs { fact(key).value == rule.currency } }
satisfied(rule) if { rule.operator == "minimum_in_currency"; comparable(rule, 0) >= comparable(rule, 1); fact(rule.inputs[2]).value == rule.currency; fact(rule.inputs[3]).value == rule.currency }
`;

// Preserve published v1/v2 policy bytes. Mortgage rules add explicit manual
// decisions and same-currency ratios; no floating-point or implicit FX in JS.
const policyV3=policyV2.replaceAll('p3-deterministic-v2','p3-deterministic-v3')
  .replace('else := {"outcome": "blocked", "reasonCode": "input_insufficient"}',`else := {"outcome": "blocked", "reasonCode": object.get(rule, "manualReason", "manual_review_required")} if { rule.operator == "manual_review" }
else := {"outcome": "blocked", "reasonCode": "input_insufficient"}`)
  .replace('else := {"outcome": "pass", "reasonCode": "satisfied"}',`else := {"outcome": "blocked", "reasonCode": "expires_today"} if { rule.operator == "date_after"; fact(rule.inputs[0]).value == fact(rule.inputs[1]).value }
else := {"outcome": "blocked", "reasonCode": "calendar_out_of_range"} if { rule.operator in {"calendar_year_minimum", "anniversary_notice"}; startswith(fact(rule.inputs[0]).value, "9999-") }
else := {"outcome": "pass", "reasonCode": "expiry_calculated", "details": {"expiryDate": anniversary(fact(rule.inputs[0]).value)}} if { rule.operator == "anniversary_notice" }
else := {"outcome": "blocked", "reasonCode": "input_invalid_number"} if { ratio_rule(rule); invalid_ratio(rule) }
else := {"outcome": "blocked", "reasonCode": "currency_mismatch"} if { ratio_rule(rule); fact(rule.inputs[2]).value != fact(rule.inputs[3]).value }
else := {"outcome": "pass", "reasonCode": "satisfied"}`)+String.raw`
anniversary(value) := sprintf("%04d-%s-%s", [to_number(parts[0]) + 1, parts[1], day]) if {
  parts := split(value, "-")
  day := anniversary_day(parts[1], parts[2])
}
anniversary_day(month, day) := "28" if { month == "02"; day == "29" }
else := day
satisfied(rule) if { rule.operator == "date_after"; fact(rule.inputs[0]).value > fact(rule.inputs[1]).value }
satisfied(rule) if { rule.operator == "calendar_year_minimum"; fact(rule.inputs[1]).value >= anniversary(fact(rule.inputs[0]).value) }
ratio_rule(rule) if { rule.operator in {"minimum_ratio", "ltv_maximum"} }
invalid_ratio(rule) if { some i in [0, 1]; not decimal(fact(rule.inputs[i]).value) }
invalid_ratio(rule) if { some i in [0, 1]; to_number(fact(rule.inputs[i]).value) < 0 }
invalid_ratio(rule) if { to_number(fact(rule.inputs[1]).value) == 0 }
invalid_ratio(rule) if { rule.operator == "ltv_maximum"; not decimal(fact(rule.inputs[4]).value) }
invalid_ratio(rule) if { rule.operator == "ltv_maximum"; to_number(fact(rule.inputs[4]).value) <= 0 }
decimal_scale(value) := 1 if { not contains(value, ".") }
decimal_scale(value) := product([10 | some _i in numbers.range(1, count(split(value, ".")[1]))]) if { contains(value, ".") }
decimal_integer(value) := to_number(concat("", split(value, ".")))
satisfied(rule) if {
  rule.operator == "minimum_ratio"
  a := fact(rule.inputs[0]).value; b := fact(rule.inputs[1]).value
  decimal_integer(a) * decimal_scale(b) * decimal_scale(rule.factor) >= decimal_integer(b) * decimal_scale(a) * decimal_integer(rule.factor)
}
satisfied(rule) if {
  rule.operator == "ltv_maximum"
  a := fact(rule.inputs[0]).value; b := fact(rule.inputs[1]).value; limit := fact(rule.inputs[4]).value
  decimal_integer(a) * decimal_scale(b) * decimal_scale(limit) * 100 <= decimal_integer(b) * decimal_integer(limit) * decimal_scale(a)
}
`;

export function createRulePackage(raw:ReviewConfigManifest):RulePackage {
  const manifest=ReviewConfigManifestSchema.parse(raw);
  const v3=manifest.compatibility.executorVersion==='p3-deterministic-v3';
  const v2=v3||manifest.compatibility.executorVersion==='p3-deterministic-v2';
  if(!v3&&manifest.rules.some(rule=>['manual_review','minimum_ratio','ltv_maximum','date_after','calendar_year_minimum','anniversary_notice'].includes(rule.operator)||rule.factor!==undefined||rule.manualReason!==undefined||rule.inputs.length>4))throw new ServiceError('opa_operator_version_unsupported');
  if(manifest.compatibility.factsSchema!==(v2?'review-facts.v2':'review-facts.v1')||!v2&&manifest.rules.some(rule=>['same_entity','currency_is','minimum_in_currency'].includes(rule.operator)||rule.currency))throw new ServiceError('opa_operator_version_unsupported');
  const rules=manifest.rules.map(({tests:_tests,...rule})=>rule);
  const fields=Object.fromEntries(manifest.fields.map(field=>[field.id,{type:field.type,objectKind:field.objectKind,...(field.objectRole?{objectRole:field.objectRole}:{}),unit:field.unit,currency:field.currency}]));
  const payload={releaseId:manifest.releaseId,executorVersion:manifest.compatibility.executorVersion,rules,fields,parameters:manifest.parameters,
    ...(manifest.compatibility.signatureExecutorVersion?{signatureExecutorVersion:manifest.compatibility.signatureExecutorVersion,...(manifest.signatureRequirements?{signatureRequirements:manifest.signatureRequirements}:{})}:{})},selectedPolicy=v3?policyV3:v2?policyV2:policy;
  const packageHash=configHash({policy:selectedPolicy,payload});
  const source=`package hsbc.releases.${manifest.releaseId}\n${selectedPolicy}\nbinding := ${canonicalJson({...payload,packageHash})}\n`;
  return {releaseId:manifest.releaseId,packageHash,policySha256:byteHash(source),source,
    manifest:{revision:manifest.releaseId,roots:[`hsbc/releases/${manifest.releaseId}`],rego_version:1}};
}
function inputFor(release:ExecutableRelease,facts:ReviewFacts,ruleIds?:string[]) {
  const built=createRulePackage(release.manifest);
  if(release.releaseId!==built.releaseId||release.packageHash!==built.packageHash||release.policySha256!==built.policySha256)throw new ServiceError('opa_package_mismatch');
  const ids=ruleIds??release.manifest.rules.map(rule=>rule.id);
  if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!release.manifest.rules.some(rule=>rule.id===id)))throw new ServiceError('opa_rule_scope_invalid');
  const parsed=ReviewFactsSchema.parse(facts);
  // Type/normalization validation is an input boundary, never a replacement for OPA decisions.
  for(const [key,fact] of Object.entries(parsed)){
    const field=release.manifest.fields.find(field=>field.id===key);
    if(!field&&!release.manifest.materials.some(material=>key===`material:${material.id}`))throw new ServiceError('opa_fact_unknown');
    if(fact.state!=='present')continue;
    if(!field){if(typeof fact.value!=='boolean')throw new ServiceError('opa_fact_type_invalid');continue;}
    if(typeof fact.value!=='string')throw new ServiceError('opa_fact_type_invalid');
    if(field.type==='amount'&&!/^[+-]?\d+(?:\.\d+)?$/.test(fact.value))throw new ServiceError('opa_fact_type_invalid');
    if(field.type==='currency'&&!/^[A-Z]{3}$/.test(fact.value))throw new ServiceError('opa_fact_type_invalid');
    if(field.type==='date'){
      const date=new Date(`${fact.value}T00:00:00.000Z`);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(fact.value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==fact.value)throw new ServiceError('opa_fact_type_invalid');
    }
  }
  return {schemaVersion:release.manifest.compatibility.factsSchema,releaseId:release.releaseId,packageHash:release.packageHash,facts:parsed,requestedRuleIds:ids};
}
function verifyReceipt(raw:unknown,release:ExecutableRelease,requested:string[]):OpaReceipt {
  const parsed=OpaReceiptSchema.safeParse(raw);
  if(!parsed.success)throw new ServiceError('opa_invalid_result');
  const receipt=parsed.data,ids=receipt.results.map(result=>result.ruleId);
  if(receipt.releaseId!==release.releaseId||receipt.packageHash!==release.packageHash||receipt.executorVersion!==release.manifest.compatibility.executorVersion||ids.length!==requested.length||new Set(ids).size!==ids.length||requested.some(id=>!ids.includes(id)))throw new ServiceError('opa_package_mismatch');
  return receipt;
}
/** Production adapter: only fixed immutable decision paths, never arbitrary OPA queries. */
export class HttpRuleExecutor implements RuleExecutor {
  private http:BoundedHttpClient;
  constructor(config:ServiceConfig){this.http=new BoundedHttpClient(config,'opa');}
  async evaluate(release:ExecutableRelease,facts:ReviewFacts,signal?:AbortSignal,ruleIds?:string[]) {
    const input=inputFor(release,facts,ruleIds);
    const response=await this.http.request(`/v1/data/hsbc/releases/${release.releaseId}/decision`,z.strictObject({result:z.unknown()}),{body:{input},signal,maxBytes:4*1024*1024});
    return verifyReceipt(response.result,release,input.requestedRuleIds);
  }
}
/** Explicit local test executor. It only executes generated policy and synthetic facts. */
export class LocalOpaExecutor implements RuleExecutor {
  private readonly bundles=new Map<string,Promise<Buffer>>();
  constructor(private binary:string){if(!isAbsolute(binary))throw new ServiceError('opa_binary_absolute_path_required');}
  async evaluate(release:ExecutableRelease,facts:ReviewFacts,signal?:AbortSignal,ruleIds?:string[]) {
    return (await this.evaluateBatch(release,[{facts,ruleIds:ruleIds??release.manifest.rules.map(r=>r.id)}],signal))[0]!;
  }
  async evaluateBatch(release:ExecutableRelease,fixtures:Array<{facts:ReviewFacts;ruleIds:string[]}>,signal?:AbortSignal):Promise<OpaReceipt[]> {
    if(release.manifest.scope!=='synthetic')throw new ServiceError('opa_local_synthetic_only');
    // The manifest allows 500 rules × 100 fixtures. Bound each engine request,
    // rather than rejecting otherwise valid configurations at an arbitrary total.
    if(!fixtures.length||fixtures.length>50000)throw new ServiceError('opa_trial_batch_invalid');
    const built=createRulePackage(release.manifest);
    const directory=await mkdtemp(join(tmpdir(),'hsbc-opa-trial-'));
    const invoke=async(args:string[])=>{
      try{return(await promisify(execFile)(this.binary,args,{cwd:directory,timeout:15_000,maxBuffer:4*1024*1024,signal,env:{PATH:process.env.PATH??'/usr/bin:/bin'}})).stdout;}
      catch{throw new ServiceError(signal?.aborted?'opa_canceled':'opa_execution_failed');}
    };
    try {
      // Trial fixtures share the exact signed policy. Compile it once, while still
      // executing every fixture in the real pinned engine with its own input.
      // Hash the executable too: replacing the binary invalidates the cache.
      const key=configHash({binary:byteHash(await readFile(this.binary)),source:built.source,manifest:built.manifest});
      let bundle=this.bundles.get(key);
      if(!bundle){
        bundle=(async()=>{
          if(!(await invoke(['version'])).startsWith('Version: 1.21.1\n'))throw new ServiceError('opa_engine_version_mismatch');
          await writeFile(join(directory,'policy.rego'),built.source,{mode:0o600});
          await writeFile(join(directory,'.manifest'),JSON.stringify(built.manifest),{mode:0o600});
          await invoke(['check','--strict','policy.rego']);
          await invoke(['build','--bundle','--ignore=input.json','--output=compiled.tar.gz','.']);
          const bytes=await readFile(join(directory,'compiled.tar.gz'));
          if(!bytes.length)throw new ServiceError('opa_bundle_missing');
          return bytes;
        })();
        if(this.bundles.size>=8)this.bundles.delete(this.bundles.keys().next().value!);
        this.bundles.set(key,bundle);
        void bundle.catch(()=>{if(this.bundles.get(key)===bundle)this.bundles.delete(key);});
      }
      await writeFile(join(directory,'bundle.tar.gz'),await bundle,{mode:0o600});
      const receipts:OpaReceipt[]=[];
      for(let start=0;start<fixtures.length;start+=256){
        const inputs=fixtures.slice(start,start+256).map(f=>inputFor(release,f.facts,f.ruleIds));
        await writeFile(join(directory,'input.json'),JSON.stringify({trials:inputs}),{mode:0o600});
        let decoded:any;
        try{decoded=JSON.parse(await invoke(['eval','--bundle','bundle.tar.gz','--format=json','--input','input.json',`[receipt | some trial in input.trials; receipt := data.hsbc.releases.${release.releaseId}.decision with input as trial]`]));}
        catch(error){if(error instanceof ServiceError)throw error;throw new ServiceError('opa_invalid_result');}
        const values=decoded.result?.[0]?.expressions?.[0]?.value;
        if(!Array.isArray(values)||values.length!==inputs.length)throw new ServiceError('opa_invalid_result');
        receipts.push(...values.map((value,index)=>verifyReceipt(value,release,inputs[index]!.requestedRuleIds)));
      }
      return receipts;
    } finally {await rm(directory,{recursive:true,force:true});}
  }
}
export class UnavailableRuleExecutor implements RuleExecutor {
  async evaluate():Promise<OpaReceipt>{throw new ServiceError('opa_not_configured');}
}
