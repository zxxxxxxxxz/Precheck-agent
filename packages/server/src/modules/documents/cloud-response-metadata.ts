import {z} from 'zod';

const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const DocumentResponseMetadataSchema=z.strictObject({
  version:z.literal('document-response-metadata.v1'),
  status:z.enum(['completed','incomplete','failed','cancelled','in_progress','queued']).nullable(),
  incompleteReason:z.enum(['max_output_tokens','content_filter']).nullable(),
  reasoningTokens:count,cachedInputTokens:count,
  finalTextItems:count,finalTextBytes:count,
});
export type DocumentResponseMetadata=z.infer<typeof DocumentResponseMetadataSchema>;
const numberOrNull=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Only fixed status enums and counts survive; no text, provider IDs or errors. */
export function documentResponseMetadata(raw:unknown):DocumentResponseMetadata {
  const data=object(raw),usage=object(data.usage),incomplete=object(data.incomplete_details);
  const status=DocumentResponseMetadataSchema.shape.status.safeParse(data.status);
  const reason=DocumentResponseMetadataSchema.shape.incompleteReason.safeParse(incomplete.reason);
  let finalTextItems:number|null=null,finalTextBytes:number|null=null;
  if(Array.isArray(data.output)){
    finalTextItems=0;finalTextBytes=0;
    for(const item of data.output){
      const message=object(item);if(message.type!=='message')continue;
      if(!Array.isArray(message.content)){finalTextItems=null;finalTextBytes=null;break;}
      for(const content of message.content){
        const part=object(content);if(part.type!=='output_text')continue;
        if(typeof part.text!=='string'){finalTextItems=null;finalTextBytes=null;break;}
        finalTextItems++;finalTextBytes=(finalTextBytes??0)+Buffer.byteLength(part.text,'utf8');
      }
      if(finalTextItems===null)break;
    }
  }
  return DocumentResponseMetadataSchema.parse({version:'document-response-metadata.v1',
    status:status.success?status.data:null,incompleteReason:reason.success?reason.data:null,
    reasoningTokens:numberOrNull(object(usage.output_tokens_details).reasoning_tokens),
    cachedInputTokens:numberOrNull(object(usage.input_tokens_details).cached_tokens),
    finalTextItems,finalTextBytes});
}
