import type {PrivateIntakeProjection} from './privacy-projection.js';
import {intakeCloudReferences} from './intake-source-references.js';
import {ModelExecutionError} from '../../model/gateway.js';

export const IDENTIFIER_MARKER_VERSION='source_identifier_markers_v1' as const;
type Marker='code'|'number'|'reference';
export interface PrivacyIdentifierMarkers {
  version:typeof IDENTIFIER_MARKER_VERSION;
  items:Array<{sourceRef:string;placeholder:string;marker:Marker}>;
}
const markerTokens:Readonly<Record<string,Marker>>={code:'code',number:'number',no:'number',reference:'reference',ref:'reference'};

/** Preserve a public lexical marker hidden inside an opaque identifier, never
 * its bytes, length, a guessed field role or a model-generated relationship.
 * These hints live outside the source inventory and are not evidence quotes. */
export function privacyIdentifierMarkers(projection:PrivateIntakeProjection):PrivacyIdentifierMarkers|undefined {
  const wire=intakeCloudReferences(projection.blocks).blocks,items:PrivacyIdentifierMarkers['items']=[];
  for(const replacement of projection.replacements){
    if(!['identity','reference'].includes(replacement.kind))continue;
    const value=replacement.original.normalize('NFKC');
    if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,1999}$/u.test(value)||!/[0-9]/u.test(value))continue;
    const markers=[...new Set(value.toLowerCase().split(/[._/-]/u).flatMap(token=>markerTokens[token]?[markerTokens[token]!]:[]))];
    if(markers.length!==1)continue;
    for(const source of wire){
      if(!source.text.includes(replacement.placeholder))continue;
      items.push({sourceRef:source.id,placeholder:replacement.placeholder,marker:markers[0]!});
      if(items.length>4096)throw new ModelExecutionError('input_budget_exhausted');
    }
  }
  return items.length?{version:IDENTIFIER_MARKER_VERSION,items}:undefined;
}
