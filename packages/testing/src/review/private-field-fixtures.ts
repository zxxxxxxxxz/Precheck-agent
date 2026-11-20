import { buildDocumentFieldFilterFixture } from '../document/field-filter-fixtures.js';

/** Fixed public synthetic gold before real model calls. These are not bank samples or requirements. */
export const p3PrivateFieldGold = [
  {id:'mortgage-current-secured-principal',fieldId:'secured_amount',blocks:[
    'Synthetic facility FAC-203 has a principal limit of USD 1000000. The arrangement fee is USD 9000.',
    'The earlier mortgage secured principal was USD 1200000. A signed, effective mortgage amendment expressly replaces that figure.',
    'The current mortgage secured principal amount after the effective amendment is USD 1500000. The amount excludes fees and premiums.'
  ],candidates:['USD 1000000','USD 9000','USD 1200000','USD 1500000'],expectedSelectedValues:['USD 1500000']},
  {id:'insurance-current-coverage-not-premium',fieldId:'insured_amount',blocks:[
    'Synthetic policy POL-005 originally insured the linked mortgaged building for USD 1200000. Its annual premium is USD 1000.',
    'A signed, effective endorsement replaces the original coverage amount. The current insured coverage amount for that building is USD 1300000.',
    'The related facility principal limit is USD 1000000; it is a loan amount, not the policy coverage amount.'
  ],candidates:['USD 1000','USD 1000000','USD 1200000','USD 1300000'],expectedSelectedValues:['USD 1300000']},
  {id:'insurance-current-end-date',fieldId:'policy_end',blocks:[
    'Synthetic policy POL-005 coverage begins on 2026-01-01. The original policy coverage end date was 2030-12-31.',
    'A signed, effective extension endorsement changes the policy coverage end date to 2031-01-01, replacing the original end date.',
    'The linked facility final repayment date is 2030-06-30. This is not the insurance coverage end date.'
  ],candidates:['2026-01-01','2030-06-30','2030-12-31','2031-01-01'],expectedSelectedValues:['2031-01-01']},
  {id:'mortgage-current-secured-facility-reference',fieldId:'mortgage_facility_reference',blocks:[
    'Synthetic mortgage instrument MORT-007 has the policy reference POL-005. These identify the mortgage and insurance policy, respectively.',
    'The previous secured facility FAC-102 was released. The current mortgage expressly secures facility FAC-203 only.',
    'The signed mortgage schedule names FAC-203 as the current secured facility reference.'
  ],candidates:['MORT-007','POL-005','FAC-102','FAC-203'],expectedSelectedValues:['FAC-203']},
  {id:'insurance-no-stated-coverage-amount',fieldId:'insured_amount',blocks:[
    'Synthetic insurance invoice POL-006 states an annual premium of USD 1000 and a tax of USD 100.',
    'An accompanying facility summary states a principal limit of USD 1000000. No policy or endorsement in this supplied scope states an insured coverage amount.'
  ],candidates:['USD 100','USD 1000','USD 1000000'],expectedSelectedValues:[]},
] as const;

export function p3PrivateFieldFixtures(){return p3PrivateFieldGold.map(input=>buildDocumentFieldFilterFixture({...input,blocks:[...input.blocks],candidates:[...input.candidates],expectedSelectedValues:[...input.expectedSelectedValues]}));}
