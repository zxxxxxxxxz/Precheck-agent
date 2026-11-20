import type {DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText} from '../../document/evidence.js';
import {labelledDates,normalizeExtractedValue} from './field-values.js';

/** Local label/value alignment uses page geometry, never global date proximity. */
export function pageLabelledDates(page:DocumentPageArtifact,definition:ReviewFieldDefinition){
  if(definition.type!=='date')return[];
  const regions=page.regions.filter(r=>page.canonicalRegionIds.includes(r.region_id)&&r.raw_text);
  const fold=(s:string)=>s.normalize('NFKC').replace(/[\s:：]/gu,'').toLowerCase();
  const box=(r:typeof regions[number])=>{const pts=r.polygons.flat();return pts.length?{left:Math.min(...pts.map(p=>p[0])),right:Math.max(...pts.map(p=>p[0])),top:Math.min(...pts.map(p=>p[1])),bottom:Math.max(...pts.map(p=>p[1]))}:null;};
  const found=[];
  for(const region of regions){
    for(const date of labelledDates(region.raw_text!,definition))found.push({value:date.value,context:date.context,anchors:anchorsForText(page.page,[region],date.value),contextAnchors:anchorsForText(page.page,[region],date.context)});
  }
  const labels=regions.filter(r=>definition.aliases.some(alias=>fold(r.raw_text!)===fold(alias))).map(r=>({region:r,box:box(r)})).filter(r=>r.box);
  for(const region of regions){
    const value=region.raw_text!.trim();if(!normalizeExtractedValue(value,'date'))continue;
    const b=box(region);if(!b)continue;
    const matched=labels.filter(({box:l})=>{const h=Math.max(b.bottom-b.top,l!.bottom-l!.top);return b.left>=l!.right-h*0.25&&b.left-l!.right<h*12&&Math.abs((b.top+b.bottom-l!.top-l!.bottom)/2)<=h*0.8;});
    if(!matched.length)continue;
    const nearest=matched.sort((a,c)=>Math.abs(b.left-a.box!.right)-Math.abs(b.left-c.box!.right))[0]!;
    found.push({value,context:nearest.region.raw_text!+' '+value,anchors:anchorsForText(page.page,[region],value),contextAnchors:[...anchorsForText(page.page,[nearest.region],nearest.region.raw_text!),...anchorsForText(page.page,[region],value)]});
  }
  return found;
}
