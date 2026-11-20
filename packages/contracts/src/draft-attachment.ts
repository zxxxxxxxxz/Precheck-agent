import {z} from 'zod';
import {DraftSourceSchema} from './draft.js';

export const DRAFT_ATTACHMENT_LIMITS = {count:20,totalBytes:100*1024*1024,pdfBytes:50*1024*1024,docxBytes:25*1024*1024,imageBytes:10*1024*1024,imagePixels:16_000_000,imageSide:10_000,extractedCharacters:500_000} as const;
export const DraftAttachmentMimeSchema=z.enum(['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png']);
export const DraftAttachmentSourceSchema=z.strictObject({attachmentId:z.uuid(),sha256:z.string().regex(/^[a-f0-9]{64}$/),pageNumber:z.number().int().positive().optional(),nodeId:z.string().max(500).optional()});
export const DraftAttachmentBlockSchema=z.strictObject({id:z.string().min(1).max(600),text:z.string().min(1).max(20_000),source:DraftAttachmentSourceSchema});
export type DraftAttachmentBlock=z.infer<typeof DraftAttachmentBlockSchema>;
export const DraftAttachmentSchema=z.strictObject({
  id:z.uuid(),uploadId:z.uuid(),draftId:z.uuid(),filename:z.string(),size:z.number().int().positive(),mimeType:DraftAttachmentMimeSchema,
  state:z.enum(['issued','verifying','registered','rejected','expired','canceled','removed','adopted']),
  parseState:z.enum(['idle','running','ready','failed']),errorCode:z.string().nullable(),parseErrorCode:z.string().nullable(),
  sha256:z.string().nullable(),pageCount:z.number().int().positive().nullable(),createdCaseMaterialId:z.uuid().nullable(),
  source:DraftSourceSchema,createdAt:z.iso.datetime(),
});
export type DraftAttachment=z.infer<typeof DraftAttachmentSchema>;
