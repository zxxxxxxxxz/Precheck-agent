import type {ReviewConfigManifest,ReviewRule} from '@hsbc/contracts/review-config';

const only=(values:string[])=>{const unique=[...new Set(values)];return unique.length===1?unique[0]:undefined;};

/** A report section names the document being checked, not every evidence document.
 * Use explicit configuration anchors; unresolved cross-file ownership stays unassigned. */
export function mailDocumentGroup(manifest:ReviewConfigManifest|undefined,rule:ReviewRule|undefined):string|undefined {
  if(!manifest||!rule)return undefined;
  const label=(id:string)=>manifest.taxonomy.find(type=>type.id===id)?.label;
  const material=(id:string)=>manifest.materials.find(item=>`material:${item.id}`===id);
  const anchored=(entry:ReviewRule):string|undefined=>{
    const named=only(manifest.taxonomy.filter(type=>entry.label.startsWith(type.label+'：')||entry.label.startsWith(type.label+':')).map(type=>type.label));
    if(named)return named;
    const target=entry.applicability?.equals===true?material(entry.applicability.fieldId):undefined;
    if(target)return label(target.taxonomyId);
    return only(entry.inputs.flatMap(id=>{const item=material(id);return item?[label(item.taxonomyId)??item.label]:[];}));
  };
  const explicit=anchored(rule);
  if(explicit)return explicit;
  // A shared, document-scoped requirement can also own an automated subcheck.
  // Broad sources covering several document types provide no section assignment.
  const peers=rule.sourceIds.flatMap(source=>{
    const groups=manifest.rules.filter(other=>other.id!==rule.id&&other.sourceIds.includes(source)&&other.objectScope?.kind===rule.objectScope?.kind&&other.objectScope?.role===rule.objectScope?.role)
      .flatMap(other=>{const group=anchored(other);return group?[group]:[];});
    const group=only(groups);return group?[group]:[];
  });
  if(only(peers))return only(peers);
  const fieldTypes=rule.inputs.flatMap(id=>manifest.fields.find(field=>field.id===id)?.taxonomyIds??[]);
  const type=only(fieldTypes);
  return type?label(type):undefined;
}

export function mailRuleLabel(ruleLabel:string,group:string|undefined):string {
  if(group&&(ruleLabel.startsWith(group+'：')||ruleLabel.startsWith(group+':')))return ruleLabel.slice(group.length+1);
  return ruleLabel;
}
