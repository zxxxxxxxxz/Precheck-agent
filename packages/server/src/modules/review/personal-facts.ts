import type {ReviewFacts} from '@hsbc/contracts/review-config';
import type {ReviewFact} from '@hsbc/contracts/review';
import {PERSONAL_FACT_OPTIONS} from '@hsbc/contracts/personal-requirements';

/** Currency follows the exact confirmed amount, never an independently editable
 * guess. Source-state and definition checks have already built `facts`. */
export function derivePersonalFacts(facts:ReviewFacts,confirmed:ReviewFact[]):void {
 // Unknown legacy/API values must not turn conditional checks into not-applicable.
 for(const [id,options] of Object.entries(PERSONAL_FACT_OPTIONS)){
  const value=facts[id];
  if(value?.state==='present'&&!options.some(option=>option.value===value.value))facts[id]={...value,value:null,state:'uncertain'};
 }
 facts.pg_yes={value:'yes',state:'present',evidenceIds:[]};
 const identity=facts.pg_identity_number,confirmedIdentity=facts.pg_identity_confirmed;
 const verified=confirmedIdentity?.state==='present'&&confirmedIdentity.value==='yes'&&identity?.state==='present';
 facts.pg_verified_identity_number={value:verified?identity.value:null,state:verified?'present':'uncertain',evidenceIds:[...(identity?.evidenceIds??[]),...(confirmedIdentity?.evidenceIds??[])]};
 for(const [target,source] of [['pg_guarantee_currency','pg_field_7'],['pg_note_currency','pg_field_17'],['pg_required_currency','pg_required_amount']] as const){
  const values=confirmed.filter(f=>f.fieldId===source),value=values.length===1&&facts[source]?.state==='present'?values[0]!.normalization.currency:null;
  facts[target]={value:value??null,state:value?'present':'uncertain',evidenceIds:facts[source]?.evidenceIds??[]};
 }
}
