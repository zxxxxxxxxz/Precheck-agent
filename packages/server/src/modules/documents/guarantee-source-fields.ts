import type {DocumentBundle, DocumentFieldObservation, DocumentPageArtifact} from '@hsbc/contracts/documents';
import type {DocumentRegion, EvidenceAnchor} from '@hsbc/contracts/evidence';
import type {ReviewFieldDefinition} from '@hsbc/contracts/review-config';
import {anchorsForText, sha256, validateAnchorSource} from '../../document/evidence.js';
import {documentHtmlCellSpans} from '../../document/html-cells.js';
import {directorFormLines, formBox, bottom} from './director-notice-source.js';
import {normalizeExtractedValue} from './field-values.js';
import {guaranteeNativeLineAgreement} from './guarantee-source-evidence.js';

type Candidate = DocumentFieldObservation['candidates'][number];
type Input = {fields: DocumentFieldObservation[]; definitions: ReviewFieldDefinition[]; pages: DocumentPageArtifact[];
  logicalDocuments: DocumentBundle['logicalDocuments']; anchors: EvidenceAnchor[]};
const version = 'guarantee-source-fields-v1';
const unique = <T>(items: T[]) => [...new Set(items)];
const compact = (text: string) => text.replace(/\s+/gu, ' ').trim();
const unspaced = (text: string) => text.replace(/\s/gu, '');
const money = '((?:[A-Z]{3}|US\\$|HK\\$|€|£)\\s+(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?)(?=\\s|$|[.(])';
const nameLabel = /^(?:Full\s+)?Name(?:\s*\(in Block Letters\))?(?:\s+of Guarantor)?\s*[:：]?\s*(?:\\n|\n|<br\s*\/?>)\s*(.+)$/iu;

/** Literal, explicitly labelled guarantee forms only. Source roles/columns
 * establish ownership, not matching an expected answer or guessing a person.
 * Missing/unsupported sections keep their original candidates and coverage. */
export function recoverGuaranteeSourceFields(input: Input) {
  const definitions = new Map(input.definitions.filter(d => d.taxonomyIds?.includes('cgt_guarantee') && d.recipe.mode === 'cloud_grounded_extract').map(d => [d.id, d]));
  const scope = input.fields.find(field => definitions.has(field.fieldId));
  if (!scope || !input.pages.length || new Set(input.pages.map(p => p.scope.sourceSha256)).size !== 1 ||
    input.pages.some(p => p.scope.documentVersionId !== scope.documentVersionId || p.scope.parseRevision !== scope.parseRevision)) return {fields: input.fields, anchors: input.anchors};
  const anchors = [...input.anchors], recovered = new Map<string, Candidate[]>(), handled = new Map<string, Set<number>>();
  const addressReplacementRegions = new Set<string>();
  const facilityDefinitions = new Set<string>();
  const correctedNames = new Map<string, Array<{before:string;after:string;regionId:string}>>();
  const nameSections=new Map<string,{seen:number;resolved:number}>();
  for (const page of input.pages) {
    if (page.status === 'failed' || page.scope.sourceFormat === 'docx') continue;
    const owners = input.logicalDocuments.filter(m => m.pageNumbers.includes(page.page.page_number));
    if (owners.length !== 1 || owners[0]!.labelId !== 'cgt_guarantee' || !['candidate', 'confirmed'].includes(owners[0]!.status)) continue;
    const lines = directorFormLines(page), n = page.page.page_number;
    const add = (id: string, rawValue: string, region: DocumentRegion, context: DocumentRegion[], record?: string, span?: {start:number;end:number}, cellContexts: Array<{regionId:string;start:number;end:number}>=[]): boolean => {
      const definition = definitions.get(id), value = rawValue.trim();
      if (id === 'cgt_field_12' && definition?.valueKind !== 'amount') return false;
      if (!definition || !value || value.length > 2000 || !region.raw_text?.includes(value) || /<[^>]*>/u.test(value)) return false;
      const contextValues=(r:DocumentRegion)=>{
        const cells=cellContexts.filter(cell=>cell.regionId===r.region_id);
        return cells.length?cells.map(cell=>({text:r.raw_text!.slice(cell.start,cell.end),offset:[...r.raw_text!.slice(0,cell.start)].length})):[{text:r.raw_text!,offset:0}];
      };
      const contextText = unique([...context, region]).flatMap(r=>contextValues(r).map(value=>value.text)).join('\n');
      if (contextText.length > 8000) return false;
      let own: EvidenceAnchor[], ctx: EvidenceAnchor[];
      try {
        own = anchorsForText(page.page, [region], value);
        if (span) own = own.filter(a => a.text_span_refs.every(s => s.offset >= [...region.raw_text!.slice(0,span.start)].length && s.offset+s.length <= [...region.raw_text!.slice(0,span.end)].length));
        ctx = unique([...context, region]).flatMap(r => contextValues(r).flatMap(value=>anchorsForText(page.page, [r], value.text)
          .filter(a=>a.text_span_refs.every(s=>s.offset===value.offset))));
        for (const a of [...own, ...ctx]) validateAnchorSource(a, page.page, page.regions);
      } catch { return false; }
      if (!own.length || !ctx.length) return false;
      const normalizedValue = id === 'cgt_limited' ? (/unlimited|无限|無限/iu.test(value) ? 'unlimited' : 'limited') : normalizeExtractedValue(value, definition.type);
      if (normalizedValue === null) return false;
      const candidate: Candidate = {rawValue: value, normalizedValue, displayValue: value, anchorIds: own.map(a => a.anchor_id),
        contextAnchorIds: unique(ctx.map(a => a.anchor_id)), pageNumbers: [n], contextText,
        ...(record ? {entityKey: sha256(JSON.stringify([version, id, region.region_id, record]))} : {})};
      const values = recovered.get(id) ?? [];
      const duplicate = values.find(c => c.rawValue === value && c.pageNumbers[0] === n && c.entityKey === candidate.entityKey);
      if (!duplicate) values.push(candidate);
      else {
        duplicate.anchorIds = unique([...duplicate.anchorIds,...candidate.anchorIds]);
        duplicate.contextAnchorIds = unique([...(duplicate.contextAnchorIds??[]),...(candidate.contextAnchorIds??[])]);
      }
      recovered.set(id, values); anchors.push(...own, ...ctx);
      const pages = handled.get(id) ?? new Set<number>(); pages.add(n); handled.set(id, pages);
      return true;
    };
    // Exact type headings can come from either OCR source; layout deduplication
    // may retain the line OCR version of a title.
    for(const line of lines){
      // Classification requires an explicit guarantee type, never missing money.
      if (/^(?:GUARANTEE\s*\(\s*(?:Un)?limited Amount\s*\)|(?:Un)?limited Guarantee|(?:无限额|有限额)(?:责任)?担保|(?:無限額|有限額)(?:責任)?擔保)$/iu.test(line.text))
        add('cgt_limited',line.text,line.region,[]);
    }
    // Definition sentence, not a free Bank word occurring inside another name.
    for (const line of lines.filter(l => l.region.source === 'vl_ocr')) {
      const bank = /^Bank\s+means\s+(.+?)\.\s+(?:Customer|Guarantor)\s+means\b/iu.exec(line.text);
      if (bank && bank[1]!.length <= 300) add('cgt_field_4', bank[1]!, line.region, []);
      if (/^Facility Letter\s+means\b/u.test(line.text)) facilityDefinitions.add(line.text);
      const sum = new RegExp('\\bSpecified Sum\\s+means\\s+'+money,'u').exec(line.text);
      if (sum) {
        add('cgt_amount',sum[1]!,line.region,[]);
        add('cgt_field_12',sum[1]!,line.region,[]);
        add('cgt_currency',/^(?:[A-Z]{3}|US\$|HK\$|€|£)/u.exec(sum[1]!)![0],line.region,[]);
      }
    }
    const headings = lines.filter(l => /^(?:Details of (?:Customer|Guarantor)|Specified Sum(?:\s*\(.*\))?|Address of Bank['’]s Office(?:\s*\(.*\))?)$/iu.test(l.text));
    const distinct = headings.filter((l, i) => !headings.slice(0, i).some(p => compact(p.text).toLowerCase() === compact(l.text).toLowerCase() && Math.abs(p.box.y-l.box.y) < Math.max(p.box.height,l.box.height)));
    for (const [index, heading] of distinct.entries()) {
      const end = distinct[index+1]?.box.y ?? page.page.height * .92;
      const own = lines.filter(l => l.box.y >= bottom(heading.box)-2 && bottom(l.box) < end && l.box.x >= heading.box.x-20);
      const customer = /^Details of Customer$/iu.test(heading.text), guarantor = /^Details of Guarantor$/iu.test(heading.text);
      if (customer || guarantor) {
        const nameId=customer?'cgt_field_7':'cgt_field_9',proof=nameSections.get(nameId)??{seen:0,resolved:0};
        proof.seen++;nameSections.set(nameId,proof);
        const names=unique(own.flatMap(l=>{const m=/^Name\s*\(in Block Letters\)\s*:\s*(.+)$/iu.exec(l.text);return m?[compact(m[1]!)]:[];}));
        if(names.length!==1)continue;
        const read = (id: string, pattern: RegExp) => {
          const found = own.flatMap(l => {const m = pattern.exec(l.text); return m ? [{line:l, value:m[1]!.trim()}] : [];});
          const texts = unique(found.map(x => compact(x.value)));
          if (texts.length !== 1) return;
          const selected = found.find(x => x.line.region.source === 'vl_ocr') ?? found[0]!;
          return add(id, selected.value, selected.line.region, [heading.region]);
        };
        if(read(nameId, /^Name\s*\(in Block Letters\)\s*:\s*(.+)$/iu))proof.resolved++;
        read(customer ? 'cgt_field_8' : 'cgt_field_10', /^(?:[\s$^{}*]+)?Address\s*:\s*(.+)$/iu);
        if (guarantor) read('cgt_field_11', /^Identification Document Type and Number\s*:\s*(.+)$/iu);
      }
      if (/^Specified Sum/iu.test(heading.text)) {
        // Currency must be printed immediately next to the numeric amount in
        // this bounded section. A bare $ or another facility is insufficient.
        const values = own.flatMap(line => {
          const m = new RegExp('^Amount:\\s*'+money,'u').exec(line.text);
          const currency = m && /^(?:[A-Z]{3}|US\$|HK\$|€|£)/u.exec(m[1]!);
          return m && currency ? [{line, amount:m[1]!, currency:currency[0]}] : [];
        });
        if (unique(values.map(v => unspaced(v.amount))).length === 1) {
          const value = values.find(v => v.line.region.source === 'vl_ocr') ?? values[0]!;
          add('cgt_currency', value.currency, value.line.region, [heading.region]);
          add('cgt_amount', value.amount, value.line.region, [heading.region]);
          add('cgt_field_12', value.amount, value.line.region, [heading.region]);
        }
      }
      if (/^Address of Bank['’]s Office/iu.test(heading.text)) {
        const blocks = own.filter(l => l.region.source === 'vl_ocr' && l.text.split('\n').length === 2);
        // A standalone OCR address can preserve a word omitted by a multiline
        // model block. Require exact agreement with an independently positioned
        // native line; this does not promote the PDF text layer's global trust.
        const separate = own.filter(l => l.region.source === 'pp_ocr' && !l.text.includes('\n'));
        const banks = separate.filter(l => /\bBank\b.*\bBranch\b/iu.test(l.text));
        if (banks.length === 1) {
          const bank = banks[0]!, next = separate.filter(l => l.box.y > bank.box.y && l.box.y-bottom(bank.box)<bank.box.height*2);
          const address = next.length === 1 ? next[0] : undefined;
          const bankNative = guaranteeNativeLineAgreement(page,bank), addressNative = address ? guaranteeNativeLineAgreement(page,address) : [];
          if (address && bankNative.length && addressNative.length &&
            add('cgt_field_13',address.text,address.region,[heading.region,bank.region,...bankNative,...addressNative])) {
            add('cgt_field_4',bank.text,bank.region,[heading.region,...bankNative]);
            for (const r of [bank.region,address.region,...bankNative,...addressNative,...blocks.filter(b=>b.text.split('\n')[0]===bank.text).map(b=>b.region)]) addressReplacementRegions.add(r.region_id);
            continue;
          }
        }
        if (blocks.length === 1) {
          const [bank, address] = blocks[0]!.text.split('\n');
          if (bank && address && /\b(?:Bank|Branch)\b/iu.test(bank)) {
            add('cgt_field_4', bank, blocks[0]!.region, [heading.region]);
            add('cgt_field_13', address, blocks[0]!.region, [heading.region]);
          }
        }
      }
    }
    // Signing-company name is one explicitly labelled source value. Keep the
    // original bilingual spelling together; no translation or inferred alias.
    const execution = lines.filter(l => /^Execution by Limited Company$/iu.test(l.text));
    if (execution.length) for (const line of lines.filter(l => l.region.source === 'vl_ocr')) {
      const m = /^Name of Guarantor:\s*(.+)$/iu.exec(line.text);
      if (m && line.box.y > execution[0]!.box.y && line.box.y-execution[0]!.box.y < page.page.height*.15) add('cgt_field_14', m[1]!, line.region, [execution[0]!.region]);
    }
    const tables = page.regions.filter(r => r.source === 'vl_ocr' && r.kind === 'table' && page.canonicalRegionIds.includes(r.region_id));
    for (const table of tables) {
      const box = formBox(table), raw = table.raw_text;
      if (!box || !raw || table.processing_status !== 'ready' || table.raw_text_sha256 !== sha256(raw) ||
        table.document_version_id !== page.scope.documentVersionId || table.parse_revision !== page.scope.parseRevision || table.page_asset_id !== page.page.page_asset_id ||
        page.conflicts.some(c => c.region_ids.includes(table.region_id)) || /\b(?:rowspan|colspan)\s*=\s*["']?(?!1(?:["'\s>]))/iu.test(raw)) continue;
      const spans = documentHtmlCellSpans(raw, {allowImages:true});
      const rows = [...raw.matchAll(/<tr\s*>[\s\S]*?<\/tr\s*>/giu)].map(row => spans.filter(s => s.start > row.index! && s.end < row.index!+row[0].length));
      if (!rows.length || rows.some(row => row.length !== rows[0]!.length) || rows[0]!.length > 10 || spans.length !== rows.flat().length) continue;
      const before = lines.filter(l => bottom(l.box) <= box.y+2 && box.y-bottom(l.box) < page.page.height*.3 &&
        /^(?:Witnessed by:|Signature of Director(?:\s*_*)?|Execution by Limited Company)$/iu.test(l.text)).sort((a,b) => b.box.y-a.box.y);
      const heading = before[0];
      const mapped = rows.map(row => row.map(span => ({span, text:raw.slice(span.start,span.end)})));
      const signatureRows=mapped.filter(row=>row.some(cell=>/^Signature of (?:Witness|Director)/iu.test(cell.text)));
      if(signatureRows.some(row=>!row.every(cell=>/^Signature of Witness/iu.test(cell.text))) && signatureRows.some(row=>row.some(cell=>/^Signature of Witness/iu.test(cell.text))))continue;
      const witness = signatureRows.some(row=>row.every(cell=>/^Signature of Witness/iu.test(cell.text))) || heading && /^Witnessed by:/iu.test(heading.text);
      const director = !witness && heading && /Signature of Director|Execution by Limited Company/iu.test(heading.text);
      if (!witness && !director) continue;
      const labelRows = [
        {id:witness?'cgt_field_21':'cgt_field_16', pattern:nameLabel},
        {id:witness?'cgt_field_22':'cgt_field_17', pattern:witness?/^Office\s*(?:\\n|\n|<br\s*\/?>)\s*(.+)$/iu:/^Address\s*(?:\\n|\n|<br\s*\/?>)\s*(.+)$/iu},
        {id:witness?'cgt_field_23':'cgt_field_18', pattern:/^Identification Document Type and Number\s*(?:\\n|\n|<br\s*\/?>)\s*(.+)$/iu},
      ];
      for (const {id, pattern} of labelRows) {
        const matches = mapped.filter(row => row.every(cell => pattern.test(cell.text)));
        if (matches.length !== 1) continue;
        // Every column must be independently readable before replacing a model
        // candidate that joined the same row's different people together.
        const values = matches[0]!.map(cell => pattern.exec(cell.text)![1]!.trim());
        if (values.some(value => !value || /<|\\n|\n/u.test(value))) continue;
        values.forEach((value,column) => {
          // Keep the actual cell and the printed role label for this column,
          // not the other people's values or handwriting elsewhere in the table.
          const cellContexts=[{regionId:table.region_id,...matches[0]![column]!.span},...signatureRows.flatMap(row=>{
            const cell=row[column]!,role=/^Signature of (?:Witness|Director)/iu.exec(cell.text);
            return role?[{regionId:table.region_id,start:cell.span.start,end:cell.span.start+role[0].length}]:[];
          })];
          const name = /^(.*?)\s*\/\s*([\p{Script=Han}·]+)$/u.exec(value);
          if (name && ['cgt_field_16','cgt_field_21'].includes(id) && values.filter(v=>v.split('/')[0]!.trim()===name[1]!.trim()).length===1) {
            const source = lines.filter(l=>l.region.source==='pp_ocr' && l.box.x>=box.x && l.box.x+l.box.width<=box.x+box.width &&
              l.box.y>=box.y && bottom(l.box)<=bottom(box) && l.text.split('/')[0]!.trim()===name[1]!.trim() &&
              /\/\s*[\p{Script=Han}·]+$/u.test(l.text));
            const native = source.length===1 ? guaranteeNativeLineAgreement(page,source[0]!) : [];
            if (source.length===1 && native.length && add(id,source[0]!.text,source[0]!.region,[table,...native,...(heading?[heading.region]:[])],`table:${table.region_id}:column:${column}`,undefined,
              cellContexts)) {
              const list=correctedNames.get(id)??[];list.push({before:value,after:source[0]!.text,regionId:table.region_id});correctedNames.set(id,list);
              return;
            }
          }
          add(id, value, table, heading?[heading.region]:[], `column:${column}`, matches[0]![column]!.span,
            cellContexts);
        });
      }
    }
  }
  const fields = input.fields.map((field): DocumentFieldObservation => {
    const pages = handled.get(field.fieldId), selected = recovered.get(field.fieldId);
    if (field.humanRevisionId || !pages || !selected || field.documentVersionId !== scope.documentVersionId || field.parseRevision !== scope.parseRevision) return field;
    const byAnchor = new Map(anchors.map(a=>[a.anchor_id,a]));
    const superseded = (candidate: Candidate) => {
      if (!candidate.pageNumbers.length || candidate.pageNumbers.some(n=>!pages.has(n)) || !candidate.anchorIds.length) return false;
      const relevant = selected.filter(c=>c.pageNumbers.some(n=>candidate.pageNumbers.includes(n)));
      // A facility-definition-only quote is not the guaranteed amount or its
      // liability definition. Keep the original quote in the decision history.
      if (field.fieldId==='cgt_field_12' && facilityDefinitions.has(candidate.rawValue) &&
        candidate.anchorIds.every(id=>{const a=byAnchor.get(id);return a && input.pages.some(p=>{
          try{validateAnchorSource(a,p.page,p.regions);return true;}catch{return false;}
        });})) return true;
      const text = compact(candidate.rawValue), parts = unique(relevant.map(c=>compact(c.rawValue)));
      let remainder=text, consumed=0;
      for (const value of parts.sort((a,b)=>b.length-a.length)) if(remainder.includes(value)){remainder=remainder.replaceAll(value,' ');consumed++;}
      const provedAddress = field.fieldId === 'cgt_field_13' && candidate.anchorIds.every(id => {
        const a = byAnchor.get(id); return a && a.block_ids.length > 0 && a.block_ids.every(id=>addressReplacementRegions.has(id));
      });
      if (provedAddress) return true;
      if ((correctedNames.get(field.fieldId)??[]).some(proof=>candidate.rawValue===proof.before &&
        candidate.anchorIds.every(id=>byAnchor.get(id)?.block_ids.every(block=>block===proof.regionId)))) return true;
      const sameValue=parts.some(value=>value===text || ['cgt_field_18','cgt_field_23'].includes(field.fieldId) && unspaced(value)===unspaced(text) ||
        ['cgt_amount','cgt_field_12'].includes(field.fieldId) && text.startsWith(value) && /^\s*(?:\([A-Za-z\s]+Only\)|[—–-]\s*[A-Za-z\s]+Only)\s*$/u.test(text.slice(value.length)) ||
        definitions.get(field.fieldId)?.valueKind==='party_name' && value.includes(text)) || consumed>=2 && /^[\s,;/]*$/u.test(remainder);
      if (!sameValue) return false;
      // Every old occurrence must point at the proven replacement's location.
      // An unseen/unsupported table or another occurrence is never erased.
      return candidate.anchorIds.every(id=>{
        const a=byAnchor.get(id);if(!a)return false;
        return relevant.some(c=>c.anchorIds.some(other=>{
          const b=byAnchor.get(other);if(!b||a.page_number!==b.page_number||a.page_asset_id!==b.page_asset_id)return false;
          if(a.block_ids.some(block=>b.block_ids.includes(block)))return true;
          const bounds=(anchor:EvidenceAnchor)=>{const p=anchor.polygons.flat();return [Math.min(...p.map(x=>x[0])),Math.min(...p.map(x=>x[1])),Math.max(...p.map(x=>x[0])),Math.max(...p.map(x=>x[1]))];};
          const x=bounds(a),y=bounds(b),area=(x[2]!-x[0]!)*(x[3]!-x[1]!);
          return area>0 && Math.max(0,Math.min(x[2]!,y[2]!)-Math.max(x[0]!,y[0]!))*Math.max(0,Math.min(x[3]!,y[3]!)-Math.max(x[1]!,y[1]!))/area>=.85;
        }));
      });
    };
    const retained = field.candidates.filter(c => !superseded(c));
    // Repeated definitions are one literal value with all source locations.
    const replacement = ['cgt_field_4','cgt_field_12','cgt_amount','cgt_currency','cgt_limited'].includes(field.fieldId) ? selected.reduce<Candidate[]>((all,c)=>{
      const old=all.find(p=>p.rawValue===c.rawValue);
      if(old){old.anchorIds=unique([...old.anchorIds,...c.anchorIds]);old.contextAnchorIds=unique([...(old.contextAnchorIds??[]),...(c.contextAnchorIds??[])]);old.pageNumbers=unique([...old.pageNumbers,...c.pageNumbers]);}
      else all.push({...c});return all;
    },[]) : selected;
    // An already retained cross-page party may include the exact recovered
    // occurrence plus other valid occurrences. Merge its evidence instead of
    // adding a duplicate or dropping the other page's source.
    const candidates = [...retained];
    for (const candidate of replacement) {
      const existing = !candidate.entityKey && candidates.find(c=>!c.entityKey && c.rawValue===candidate.rawValue &&
        c.anchorIds.some(id=>candidate.anchorIds.includes(id)));
      if (!existing) candidates.push(candidate);
      else candidates[candidates.indexOf(existing)]={...existing,anchorIds:unique([...existing.anchorIds,...candidate.anchorIds]),
        contextAnchorIds:unique([...(existing.contextAnchorIds??[]),...(candidate.contextAnchorIds??[])]),pageNumbers:unique([...existing.pageNumbers,...candidate.pageNumbers])};
    }
    const prior = field.semanticFilter?.originalCandidates ?? field.candidates.map((c,i) => ({...c,candidateId:`guarantee-prior:${field.id}:${i}`}));
    const additions = replacement.map(c => ({...c,candidateId:`guarantee:${sha256(JSON.stringify([field.fieldId,c])).slice(0,32)}`}));
    const originals = [...prior.filter(c => !additions.some(s => s.candidateId === c.candidateId)), ...additions];
    const proof=nameSections.get(field.fieldId),coverage=field.extractionCoverage;
    const materialPages=input.logicalDocuments.filter(material=>material.labelId==='cgt_guarantee').flatMap(material=>material.pageNumbers);
    // A unique, explicit party-name section can resolve an earlier rejected
    // model quote. This concerns the current grounded value; immutable model
    // responses and original candidate decisions remain in their own history.
    const retainedSameValue=retained.every(candidate=>candidate.rawValue===replacement[0]?.rawValue&&candidate.anchorIds.length>0&&
      candidate.pageNumbers.every(n=>coverage?.reviewedPageNumbers.includes(n))&&candidate.anchorIds.every(id=>{
        const anchor=byAnchor.get(id),page=anchor&&input.pages.find(page=>page.page.page_asset_id===anchor.page_asset_id);
        if(!anchor||!page)return false;try{validateAnchorSource(anchor,page.page,page.regions);return true;}catch{return false;}
      }));
    const resolvedSource=proof?.seen===1&&proof.resolved===1&&retainedSameValue&&replacement.length===1&&
      coverage?.reasonCodes.includes('cloud_field_source_unverified')&&!['failed','unknown'].includes(coverage.completion)&&
      !input.logicalDocuments.some(material=>!material.labelId)&&materialPages.every(n=>coverage.reviewedPageNumbers.includes(n)&&
        input.pages.some(page=>page.page.page_number===n&&page.status!=='failed'));
    const remaining=coverage?.reasonCodes.filter(code=>code!=='cloud_field_source_unverified'&&code!=='cloud_field_coverage_incomplete')??[];
    const complete=resolvedSource&&remaining.every(code=>['party_name_boundary_corroborated','ocr_table_cell_conflict_corroborated','overlapping_source_quote'].includes(code));
    const currentReasons=(codes:string[])=>codes.filter(code=>!resolvedSource||code!=='cloud_field_source_unverified'&&(!complete||code!=='cloud_field_coverage_incomplete'));
    return {...field, status:'uncertain' as const, rawValue:candidates.length===1?candidates[0]!.rawValue:null,
      normalizedValue:candidates.length===1?candidates[0]!.normalizedValue:null, candidates,
      anchorIds:unique(candidates.flatMap(c=>c.anchorIds)),pageNumbers:unique(candidates.flatMap(c=>c.pageNumbers)),
      coverageGaps:unique([...currentReasons(field.coverageGaps).filter(g=>g!=='field_not_found_in_processed_scope'),'entity_candidate_requires_confirmation']),
      ...(resolvedSource?{extractionCoverage:{...coverage!,state:complete?'complete' as const:coverage!.state,reasonCodes:currentReasons(coverage!.reasonCodes)}}:{}),
      semanticFilter:{version:field.semanticFilter?.version??'azure-grounded-fields-v2',model:field.semanticFilter?.model??'source-layout',state:'completed' as const,originalCandidates:originals,
        decisions:originals.map(c=>({candidateId:c.candidateId,decision:additions.some(s=>s.candidateId===c.candidateId)?'selected' as const:superseded(c)?'rejected' as const:field.semanticFilter?.decisions.find(d=>d.candidateId===c.candidateId)?.decision??'uncertain' as const,anchorIds:c.anchorIds,pageNumbers:c.pageNumbers})),
        reasonCodes:unique([...currentReasons(field.semanticFilter?.reasonCodes??[]),version])}};
  });
  return {fields, anchors:[...new Map(anchors.map(a=>[a.anchor_id,a])).values()]};
}
