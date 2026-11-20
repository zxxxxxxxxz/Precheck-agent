import {z} from 'zod';

export const AddHistoricalMaterialsSchema=z.strictObject({
  roundId:z.uuid(), expectedRevision:z.number().int().positive(), idempotencyKey:z.string().min(8).max(200),
  documentVersionIds:z.array(z.uuid()).min(1).max(100).refine(ids=>new Set(ids).size===ids.length),
});
export interface HistoricalMaterial {
  id:string; filename:string; size:number; format:string; pageCount:number|null;
  uploadedRoundNumber:number; sourceRoundId:string; sourceDocumentVersionId:string;
  taxonomyIds:string[]; alreadyInCurrent:boolean;
}
export interface HistoricalMaterials {items:HistoricalMaterial[]}
export interface AddedHistoricalMaterials {documentVersionIds:string[]; revision:number}
