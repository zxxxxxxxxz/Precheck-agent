import {candidateAdoptionValue, candidateRequiredEvidenceGroups, type DocumentFieldObservation} from './documents.js';

export interface FieldQuality {state:'usable'|'review'|'processing'|'missing'; reasons:string[]; reasonCodes:string[];
  /** Present when `valueGrounded` was asked for: caveats that stay with the value without withholding it. */
  advisoryCodes?:string[]}
type QualityField = Pick<DocumentFieldObservation,'status'|'candidates'|'semanticFilter'|'extractionCoverage'|'valueMultiplicity'> & {coverageGaps?:readonly string[]};
/** These receipts describe provenance or checks already resolved, not doubts.
 * Unknown codes remain blocking. File-level visual checks do not invalidate a
 * grounded text field; signature/execution decisions have their own workflow. */
const information = new Set(['non_text_visual_content_unverified',
  'non_text_visible_ink_unclassified','logical_directory_requires_confirmation',
  'nar1-source-fields-v1','nd2a-source-fields-v1','guarantee-source-fields-v1','rm-source-fields-v2',
  'party_name_boundary_corroborated','ocr_table_cell_conflict_corroborated']);
/** Legacy extraction copies bundle/page diagnostics into every coverageGaps
 * array. An explicit field-local receipt supersedes these inherited warnings,
 * but never the same code explicitly attached to this field or its candidates. */
const inheritedDocumentWarnings = new Set([
  'source_text_conflict','classification_call_budget_reached',
  'image_semantics_or_handwriting_unverified','native_text_visibility_or_geometry_unverified',
  'source_word_parent_unverified','text_layer_trust_not_established',
  'visible_ink_is_signature_candidate_only','table_column_headers_unavailable',
  'table_cross_page_association_unverified','table_html_element_unsupported',
  'geometry_degenerate_or_not_clockwise',
]);
/** These say the reading may be incomplete, never that a value which was read is doubtful. A follow-up pass that failed
 * or whose outcome is unknown is not among them: the extraction itself is then unsettled. */
const completeness = new Set(['cloud_field_coverage_incomplete','cloud_field_model_coverage_incomplete','cloud_field_pages_unreviewed',
  'cloud_field_material_scope_unknown','cloud_field_capacity_incomplete','docx_source_coverage_incomplete',
  // A doubtful reading elsewhere on the page, which the value's own evidence does not touch.
  'cloud_field_source_assembly_elsewhere']);
/** Format caveats of a Word file as a whole. The Word extractor copies them onto every field read from that file;
 * a doubt about one value arrives separately, on the candidate itself. */
const wordFileCaveats = new Set(['alternate_content_branches_unresolved','content_control_state_requires_verification',
  'default_hidden_style_conservatively_excluded','dynamic_fields_not_evaluated','font_substitution_or_coverage_unverified',
  'legacy_horizontal_merge_unresolved','merged_cell_layout_requires_preview_verification','note_reference_unresolved',
  'source_note_reference_unresolved','numbering_label_requires_preview_verification','ocr_marks_preview_visibility_unverified',
  'preview_fidelity_requires_verification','source_mapping_incomplete','source_to_preview_mapping_not_established',
  'source_visibility_is_markup_only','symbol_glyph_requires_render_verification','symbol_requires_visual_verification',
  'docx_nontext_requires_review','external_relationship_not_loaded','relationship_target_missing','embedded_fonts_not_executed',
  'equation_layout_not_reconstructed','image_source_unavailable','unreferenced_story_not_visible_fact','unreferenced_note_not_visible_fact',
  // Parts of the Word package beside the document body, and how its preview was rendered.
  'unparsed_package_xml_part','style_inheritance_cycle','development_converter_not_release_validated','validation_only_unsandboxed_runtime']);
/** Caveats about a scanned file's tables, page classification and marks as a whole. They are still reported with the
 * value; they are never silently dropped. */
const scannedFileCaveats = new Set(['table_merged_cells_unsupported','classification_provider_failed','ocr_mark_is_unconfirmed_clue']);
/** The file words the passage differently from the labels configured for the field, so the value was placed by what the
 * passage says. A label of another field in front of a value is not among these: such a value is not kept at all. */
const placedByMeaning = new Set(['docx_field_label_not_located']);
const advisoryWhenGrounded = (code:string) => completeness.has(code) || wordFileCaveats.has(code) || scannedFileCaveats.has(code) || placedByMeaning.has(code) || /^[a-z]+_content_excluded$/.test(code);
const labels:Record<string,string> = {
  source_text_conflict:'文件中不同识别来源的文字存在冲突，需核对本项原文',
  classification_call_budget_reached:'文件分类达到本次处理上限，需核对材料目录及页码范围',
  classification_provider_failed:'文件部分页面分类失败，需核对材料类型及页码范围',
  geometry_degenerate_or_not_clockwise:'文件部分原文定位框无效，需核对本字段的来源位置及覆盖范围',
  image_semantics_or_handwriting_unverified:'文件中的图像或手写内容尚未核实',
  native_text_visibility_or_geometry_unverified:'文件文字层的可见性或位置尚未核实',
  source_word_parent_unverified:'部分文字与所属原文段落的对应关系尚未核实',
  text_layer_trust_not_established:'文件文字层的可靠性尚未核实',
  visible_ink_is_signature_candidate_only:'文件中的笔迹仅为签署线索，尚未核实签署情况',
  table_column_headers_unavailable:'文件部分表格缺少可识别的列标题',
  table_cross_page_association_unverified:'文件跨页表格的对应关系尚未核实',
  table_html_element_unsupported:'文件部分表格结构尚不能完整读取',
  table_merged_cells_unsupported:'文件部分表格含尚不能完整读取的合并单元格，需核对相关行列',
  overlapping_source_quote:'提取引用的原文片段存在重叠，需核对是否重复',
  bilingual_name_evidence_insufficient:'中英文名称之间缺少足够的对应依据',
  semantic_filter_pending:'字段筛选尚未完成', semantic_filter_failed:'字段筛选失败，无法确定取值',
  semantic_filter_unsupported:'字段筛选暂不支持', semantic_filter_uncertain_candidates:'仍有无法确定的候选值',
  source_missing:'提取值缺少完整原文依据', multiple_field_candidates:'同一字段存在不同取值，尚未消除冲突',
  cloud_field_pages_unreviewed:'部分相关页面尚未核查', cloud_field_model_coverage_incomplete:'尚不能确定是否提取完整',
  cloud_field_material_scope_unknown:'相关材料范围尚不明确',cloud_field_capacity_incomplete:'提取范围超出本次处理容量',
  cloud_field_state_inconsistent:'提取状态与返回值不一致，请核对本字段原文',
  cloud_field_source_unverified:'部分取值的原文依据未通过校验',field_role_requires_confirmation:'无法确定取值对应的业务角色',
  cloud_field_source_assembly_uncertain:'原文识别或段落拼接存在疑问',cloud_field_source_assembly_elsewhere:'本页别处的文字识别存在疑问，不涉及本取值的依据；是否另有取值请对照原文',cloud_field_coverage_incomplete:'本字段提取范围尚未核查完整',
  cloud_completion_incomplete:'补充提取未完成，结果尚不完整',normalization_requires_confirmation:'金额、日期或单位尚不能明确转换',
  insurance_name_source_disagreement:'险种名称与原文识别结果不一致',
  entity_candidate_requires_confirmation:'识别或来源定位存在疑问',repeated_value_object_association_unconfirmed:'重复取值的对象归属尚不明确',
  extraction_uncertain:'现有记录不足以证明提取结果可靠',
  docx_source_coverage_incomplete:'Word 文件未能确认已读取完整',docx_nontext_requires_review:'Word 文件含图片或符号内容，未作为文字读取',
  hidden_content_excluded:'Word 文件的隐藏内容未纳入读取',dynamic_fields_not_evaluated:'Word 文件的自动域（如页码、日期）未计算',
  merged_cell_layout_requires_preview_verification:'Word 文件含合并单元格，版式需对照预览',numbering_label_requires_preview_verification:'Word 文件的自动编号需对照预览',
  alternate_content_branches_unresolved:'Word 文件含替代内容，仅读取了可见文字',source_to_preview_mapping_not_established:'Word 原文与预览页面尚未建立对应',
  source_visibility_is_markup_only:'Word 文字的可见性依据文档标记判断',
  unparsed_package_xml_part:'Word 文件含未读取的附属部件（正文已读取）',
  docx_field_label_not_located:'取值附近没有本字段的标签，系统按文意认定，请对照原文',
  docx_blank_requires_confirmation:'模型认为本字段在文件中留空，请对照原文确认',
  docx_candidate_rejected:'模型给出的部分取值未通过校验，未予保留',docx_candidate_not_a_name:'给出的取值不是完整的主体名称',
  docx_candidate_position_ambiguous:'给出的取值在所引原文中出现多次，无法确定位置',docx_candidate_value_unusable:'给出的取值为空、过长或格式不符',
  docx_candidate_role_unsupported:'所引原文不支持该取值属于本字段的业务角色',docx_candidate_other_label:'取值前的标签属于其他字段',
  docx_candidate_other_section:'取值位于其他栏目之下',
};
export function fieldQualityReason(code:string):string {return labels[code]??'本字段仍有未解决的来源或完整性疑问，请核对原文';}

/** A pure, shared interpretation of immutable extraction receipts. It grants no
 * object attribution or business approval. Server adoption additionally checks
 * anchor existence, scope, normalization and current source versions.
 *
 * `valueGrounded` separates two kinds of receipts. A value that was read with complete source evidence stays usable when
 * the only remaining receipts say the reading may be incomplete or describe format caveats of the file; those are
 * returned as `advisoryCodes`. Receipts that doubt the value itself (unverified or stitched source, conflicting values,
 * unresolved role, failed filter) keep withholding it, and so does any code this function does not know. */
export function assessFieldQuality(field:QualityField, options:{requireSemanticFilter?:boolean; multiple?:boolean; valueGrounded?:boolean}={}):FieldQuality {
  const codes=new Set<string>(), advisory=new Set<string>(), filter=field.semanticFilter;
  const result=(state:FieldQuality['state']):FieldQuality=>{const ordered=[...codes].sort((a,b)=>Number(a==='cloud_field_coverage_incomplete')-Number(b==='cloud_field_coverage_incomplete'));return {state,reasonCodes:ordered,reasons:[...new Set(ordered.map(fieldQualityReason))],...(options.valueGrounded?{advisoryCodes:[...advisory].sort()}:{})};};
  if(filter?.state==='pending'||options.requireSemanticFilter&&!filter){codes.add('semantic_filter_pending');return result('processing');}
  if(filter&&filter.state!=='completed'){codes.add(`semantic_filter_${filter.state}`);return result('review');}
  if(filter?.decisions.some(d=>d.decision==='uncertain'))codes.add('semantic_filter_uncertain_candidates');
  const coverage=field.extractionCoverage;
  const scopedFieldReceipt=filter?.state==='completed'&&coverage!==undefined&&coverage.state!=='unknown'&&
    !['failed','unknown'].includes(coverage.completion)&&field.candidates.length>0;
  const fieldCodes=new Set([...(coverage?.reasonCodes??[]),...(filter?.reasonCodes??[])]);
  const multiple=options.multiple??(field.valueMultiplicity==='entities'||field.valueMultiplicity==='clauses');
  const values=new Set(field.candidates.map(c=>candidateAdoptionValue(c).trim()));
  const grounded=options.valueGrounded===true&&field.candidates.length>0&&(!filter||filter.state==='completed')&&(multiple||values.size===1)&&
    field.candidates.every(c=>!!candidateAdoptionValue(c).trim()&&candidateRequiredEvidenceGroups(c).length>0&&candidateRequiredEvidenceGroups(c).every(group=>group.length>0));
  const add=(code:string)=>{if(grounded&&advisoryWhenGrounded(code))advisory.add(code);else codes.add(code);};
  if(coverage?.completion==='failed'||coverage?.completion==='unknown')add('cloud_completion_incomplete');
  if(coverage&&coverage.state!=='complete')add('cloud_field_coverage_incomplete');
  if(!multiple&&values.size>1)codes.add('multiple_field_candidates');
  for(const c of field.candidates){
    if(!candidateAdoptionValue(c).trim()||candidateRequiredEvidenceGroups(c).some(group=>!group.length))codes.add('source_missing');
    for(const code of c.sourceReviewCodes??[])codes.add(code);
  }
  for(const code of new Set([...(field.coverageGaps??[]),...(coverage?.reasonCodes??[]),...(filter?.reasonCodes??[])])){
    if(information.has(code))continue;
    if(scopedFieldReceipt&&inheritedDocumentWarnings.has(code)&&!fieldCodes.has(code))continue;
    // rejectSourceOverlaps records successful removal, not an unresolved
    // conflict. The final coverage check still validates the retained values.
    if(code==='overlapping_source_quote'&&scopedFieldReceipt)continue;
    if(code==='private_authorization_source_candidate'&&field.candidates.every(c=>!!c.authorizationEvidence))continue;
    if(code==='private_independent_line_source_correction'&&field.candidates.every(c=>!!c.sourceCorrectionEvidence))continue;
    if(code==='private_table_party_source'&&field.candidates.every(c=>!!c.tablePartyEvidence))continue;
    if(code==='private_explicit_role_candidate'&&field.candidates.every(c=>!!c.roleEvidence))continue;
    // Grounded extractors attach this to *every* candidate, irrespective of
    // quality. Preserve it as a warning for unfiltered legacy NER results.
    if(code==='entity_candidate_requires_confirmation'&&filter?.state==='completed')continue;
    if(code==='multiple_field_candidates'&&(multiple||values.size<=1))continue;
    if(code==='field_not_found_in_processed_scope'&&!field.candidates.length)continue;
    add(code);
  }
  if(!field.candidates.length)return result(codes.size?'review':'missing');
  if(!filter&&field.status==='uncertain'&&!codes.size)codes.add('extraction_uncertain');
  return result(codes.size?'review':'usable');
}
