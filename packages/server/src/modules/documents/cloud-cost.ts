import {z} from 'zod';
import {ModelUsageSchema} from '@hsbc/contracts/model';
import type {DocumentResponseMetadata} from './cloud-response-metadata.js';

/** Published Azure rates, USD micros per million tokens. No context threshold is
 * assumed: the budget uses the higher context tier and the cache-write rate for
 * input whose billing category is unavailable. This is not an Azure invoice. */
export const DocumentCloudPricingSchema=z.strictObject({
  version:z.literal('azure-astra-2026-09-03.v1'),
  provider:z.literal('azure-openai'),
  deployment:z.string().min(1).max(100),
  actualModels:z.array(z.enum(['gpt-6-astra','gpt-6-astra-2026-09-03'])).min(1).max(2),
  sku:z.enum(['GlobalStandard','DataZoneStandard']),
  basis:z.literal('usage_upper_bound'),
});
export type DocumentCloudPricing=z.infer<typeof DocumentCloudPricingSchema>;
export const ASTRA_PRICES={
  GlobalStandard:{
    short:{input:10_000_000,cached:1_000_000,cacheWrite:12_500_000,output:50_000_000},
    long:{input:20_000_000,cached:2_000_000,cacheWrite:25_000_000,output:75_000_000},
  },
  DataZoneStandard:{
    short:{input:11_000_000,cached:1_100_000,cacheWrite:13_750_000,output:55_000_000},
    long:{input:22_000_000,cached:2_200_000,cacheWrite:27_500_000,output:82_500_000},
  },
} as const;
function integer(value:number):bigint {
  if(!Number.isSafeInteger(value)||value<0)throw new Error('document_cost_usage_invalid');
  return BigInt(value);
}
function micros(input:number,cached:number,output:number,pricing:DocumentCloudPricing):number {
  const rates=ASTRA_PRICES[DocumentCloudPricingSchema.parse(pricing).sku].long;
  const total=(integer(input)-integer(cached))*BigInt(rates.cacheWrite)+integer(cached)*BigInt(rates.cached)+integer(output)*BigInt(rates.output);
  if(cached>input)throw new Error('document_cost_usage_invalid');
  const rounded=(total+999999n)/1000000n;
  if(rounded>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('document_cost_overflow');
  return Number(rounded);
}
export function reserveDocumentCloudMicros(pricing:DocumentCloudPricing,inputBytes:number,maxOutputTokens:number):number {
  // UTF-8 bytes remain a conservative token ceiling, never bytes/4.
  return Math.max(1,micros(inputBytes,0,maxOutputTokens,pricing));
}
export function documentCloudUsageCost(pricing:DocumentCloudPricing,rawUsage:unknown,actualModel:string,metadata?:DocumentResponseMetadata) {
  const usage=ModelUsageSchema.parse(rawUsage);
  for(const value of Object.values(usage))integer(value);
  if(!pricing.actualModels.includes(actualModel as DocumentCloudPricing['actualModels'][number]))throw new Error('document_cost_model_mismatch');
  const cached=metadata?.cachedInputTokens??null;
  if(cached!==null&&(cached>usage.inputTokens||!Number.isSafeInteger(cached)||cached<0))throw new Error('document_cost_usage_invalid');
  if(metadata?.reasoningTokens!==null&&metadata?.reasoningTokens!==undefined&&metadata.reasoningTokens>usage.outputTokens)throw new Error('document_cost_usage_invalid');
  return {basis:'usage_upper_bound' as const,actualModel,usage,cachedInputTokens:cached,
    inputCategory:cached===null?'unreported':'cached_reported',contextTier:'long_upper_bound',
    // Reasoning is already included in outputTokens. Missing cache-write usage
    // is not zero; the unallocated input is priced at the higher cache-write rate.
    chargedMicros:micros(usage.inputTokens,cached??0,usage.outputTokens,pricing)};
}
