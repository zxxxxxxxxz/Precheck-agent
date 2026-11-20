import {visibleProcessingGap} from './features/documents/diagnostic-visibility.ts';
export interface ProcessingNoteDescription {
  category: 'processing' | 'review';
  title: string;
  explanation: string;
  action: string;
}

export interface ProcessingNote extends ProcessingNoteDescription {
  /** A presentation key; never includes source excerpts or provider output. */
  key: string;
  /** Internal provenance only. Render the description, never these raw values. */
  codes: string[];
  pageNumbers: number[];
}

const processing = (title: string, explanation: string, action: string): ProcessingNoteDescription => ({category: 'processing', title, explanation, action});
const review = (title: string, explanation: string, action: string): ProcessingNoteDescription => ({category: 'review', title, explanation, action});
const locationAction = '打开相关原页核对文字及所在位置；需要精确定位时，重新解析或联系维护人员。';
const tableAction = '对照原页逐行核对表头、单元格和对应数值。';
const unknownNote = processing('解析提示暂无法解释', '系统返回的提示尚未归类，无法据此判断文件内容或字段是否缺失。', '联系维护人员核实提示含义，并人工核对相关原页。');

// These describe processing evidence, not the bank’s document requirements.
// Keep different limitations separate even when they have the same next action.
const descriptions: Record<string, ProcessingNoteDescription> = {
  private_independent_line_source_correction: review('已按原文整理', '原识别内容与更正依据分别保留。', '展开原文依据核对。'),
  private_authorization_source_candidate: review('已补充授权依据', '授权条款与定义范围分别列出。', '核对原文后采用。'),
  private_table_party_source: review('已关联表格主体', '按同一行的主体与正式名称核对。', '核对原文后采用。'),
  insurance_name_source_disagreement: review('险名待核', '部分险名的文字来源不一致，已保留原文及金额。', '打开标记行的原文核对险名。'),
  cloud_completion_incomplete: processing('补查未完成', '已保留已提取内容，剩余内容需核对。', '对照原文核对尚未完成的内容。'),
  authorization_signing_source_unresolved: review('签署条件待核对', '部分签署条件尚未确定。', '核对授权条款。'),
  authorization_definition_source_unresolved: review('定义范围待核对', '相关定义或排除条件尚未确定。', '核对原文定义。'),
  page_render_downscaled_pixel_budget: processing('页面已按像素上限降低渲染比例，请核对细小文字', '为完成页面处理，本次预览降低了渲染比例，细小文字可能不够清晰。', '放大原文件核对细小文字及关键数值。'),
  p2_page_pixel_budget_exceeded: processing('页面尺寸超过安全处理范围，请核对原件', '该页尺寸超过当前处理范围，本次无法完成页面解析。', '打开原文件核对该页；需要解析时，联系维护人员。'),
  p2_page_content_budget_exceeded: processing('页面内容超过当前处理容量', '该页文字或区域数量超过处理上限，本次页面解析未完成。', '人工核对该页，或联系维护人员调整处理范围后重新解析。'),
  preview_revision_or_visibility_review_required: review('原文件的修订或可见内容待核对', '原文件包含修订或可见性信息，当前预览不能作为候选字段生成的充分依据。', '在原文件中核对修订状态及实际显示内容，再确认字段。'),
  preview_unavailable_source_review_required: processing('页面预览不可用', '当前无法核对源结构在页面上的实际显示，因此暂未生成候选字段。', '打开原文件核对源结构内容，或联系维护人员恢复预览。'),
  source_visibility_is_markup_only: review('源结构可见性尚未与页面核对', '目前仅根据文件标记判断内容可见性，尚未确认实际页面显示。', '打开原文件核对相应内容是否实际显示。'),
  source_visibility_not_visually_verified: review('源结构内容尚未与页面显示核对', '已读取源结构文字，但尚未核对这段文字在实际页面上的显示。', '对照原页确认文字是否可见及其上下文。'),
  unreferenced_note_not_visible_fact: review('脚注或尾注的正文引用尚待核对', '未被可见正文引用的脚注或尾注未作为可见事实使用。', '核对原文件中正文与脚注、尾注的引用关系。'),
  unreferenced_story_not_visible_fact: review('附属内容是否被正文使用尚待核对', '未被正文使用的页眉、页脚等附属内容未作为可见事实使用。', '核对原文件中这些附属内容的实际显示及使用范围。'),
  source_mapping_incomplete: processing('部分源结构尚无可靠页面映射', '部分源结构已读取，但无法可靠对应到页面位置。', locationAction),
  source_mapping_budget_exceeded: processing('部分源结构尚未完成页面定位', '页面定位达到当前处理容量，尚未定位的内容仍保留在源结构中。', '对照源结构及原文件核对相关内容；需要完整定位时联系维护人员。'),
  source_note_reference_unresolved: review('脚注或尾注的引用关系尚未解析完整', '尚未找到完整的脚注或尾注来源关系，当前关联结果不足以确认引用内容。', '对照原文件检查正文引用及对应脚注、尾注。'),
  preview_geometry_unavailable: processing('源结构对应的预览位置不可用', '源结构已匹配到预览内容，但预览没有可用的原页定位。', locationAction),

  entity_unaligned_to_source: processing('字段候选尚未定位到原文', '识别到字段候选文字，但未能将该候选可靠对齐到原页证据。', '在相关原页查找候选文字并核实上下文，再确认字段。'),
  entity_input_truncated_byte_bound: processing('部分文字未纳入字段识别', '部分文字超过单次识别容量，本次字段识别只处理了其中一部分。', '人工核对相关页的全部文字，尤其是尚未找到的字段；按需重新解析。'),
  entity_call_budget_reached: processing('部分文字尚未完成字段识别', '字段识别达到本次调用上限，剩余文字未继续送入字段识别。', '核对相关页中尚未提取的字段；需要补充识别时联系维护人员。'),
  entity_provider_failed: processing('字段识别未完成', '字段识别服务未完成部分处理，当前字段结果可能不完整。', '核对相关原页，稍后重新解析；持续失败时联系维护人员。'),
  classification_input_truncated_byte_bound: processing('部分文字未纳入材料分类', '部分文字超过单次分类容量，本次材料分类只使用了其中一部分。', '对照原页的标题和正文确认材料类型及边界。'),
  classification_provider_failed: processing('材料分类未完成', '材料分类服务未完成部分处理，当前目录类型需要进一步核对。', '对照原页确认材料类型，或稍后重新解析。'),
  classification_call_budget_reached: processing('材料分类达到本次处理上限', '材料分类调用已达到本次上限；如有后续待分类区域，本次未再调用分类服务。', '对照原页核对材料目录及页码边界。'),

  geometry_out_of_bounds: processing('原文定位超出页面范围', '部分识别区域的位置落在页面范围之外，无法可靠显示原文定位。', locationAction),
  geometry_degenerate_or_not_clockwise: processing('原文定位区域形状无效', '部分识别区域的边界形状未通过校验，无法作为可靠的原文位置。', locationAction),
  geometry_self_intersection: processing('原文定位区域边界交叉', '部分识别区域的边界相互交叉，无法可靠标记原文位置。', locationAction),
  geometry_invalid_bbox: processing('原文定位区域边界顺序异常', '部分识别区域的上下或左右边界顺序异常，当前无法定位。', locationAction),
  geometry_unavailable: processing('原文定位区域不可用', '部分内容未能获得有效的页面区域，无法精确定位。', locationAction),
  invalid_geometry: processing('原文定位数据无效', '页面尺寸或区域边界数据未通过校验，无法可靠定位。', locationAction),
  inverse_mapping_unavailable: processing('识别区域无法映射回原页', '当前缺少有效的坐标映射，识别区域无法可靠对应到原页。', locationAction),
  vertical_text_geometry_unverified: processing('竖排文字的位置尚未验证', '已读取竖排文字，但当前尚未建立可靠的原页定位。', locationAction),
  vl_response_shape_unsupported: processing('页面布局识别结果暂无法读取', '页面布局识别的返回格式尚不支持，当前无法完整使用布局结果。', '核对原页的段落及表格；持续出现时联系维护人员。'),
  vl_page_dimensions_mismatch: processing('布局识别尺寸与原页不一致', '页面布局识别结果的尺寸与原页不一致，当前无法可靠映射位置。', locationAction),
  pp_page_dimensions_mismatch: processing('文字定位尺寸与原页不一致', '文字定位结果的尺寸与原页不一致，当前无法可靠映射位置。', locationAction),
  vl_coordinate_mapping_unverified: processing('页面布局的坐标映射尚未验证', '布局识别可能经过页面预处理，尚未确认结果位置与原页一致。', locationAction),
  word_ocr_not_requested_or_unavailable: processing('逐字文字定位不可用', '本次未获得逐字文字识别结果，可能只能定位到较大区域。', '对照原页核对相关文字，避免仅依据高亮边界判断内容。'),
  text_layer_trust_not_established: review('文字层可靠性尚未确认', '文件中的文字层尚未通过可见性与位置核验，不能仅据此确认原页文字。', '对照可见原页核对文字及位置；必要时重新进行文字识别。'),
  native_text_untrusted: review('文件文字层尚未确认可靠', '已有文字层尚未确认与可见原页一致。', '对照可见原页核对文字，必要时重新进行文字识别。'),
  hidden_text_layer_requires_ocr: processing('隐藏文字层需要重新识别', '文件包含隐藏文字层，需要通过可见页面的文字识别核对内容。', '对照可见原页核对识别结果；尚未完成识别时重新解析。'),
  native_text_visibility_or_geometry_unverified: review('文字层与可见原页尚未验证一致', '文件文字层的可见性或位置尚未通过验证。', '对照原页核对文字是否显示、位置是否正确。'),
  native_text_unavailable: processing('未获得文件原生文字层', '本次无法从文件原生文字层取得文字，需要依赖图像识别或人工阅读。', '核对图像识别是否完成，并对照原页确认文字。'),
  visible_layout_not_established: processing('可见页面布局尚未完整识别', '当前尚未获得可用的页面布局结果，段落和表格关系可能未完整保留。', '对照原页核对段落顺序及表格结构。'),
  ocr_processing_failed: processing('页面文字识别失败', '本次页面文字识别未完成，不能据此判断页面没有相关文字。', '打开原页核对文字，稍后重新解析；持续失败时联系维护人员。'),
  ocr_failed: processing('文字识别失败', '本次文字识别未完成，不能据此判断原页没有相关文字。', '打开原页核对文字，稍后重新解析；持续失败时联系维护人员。'),
  ocr_adapter_unavailable: processing('文字识别服务不可用', '需要图像文字识别的页面未能使用识别服务。', '先核对原页，待服务可用后重新解析。'),
  ocr_unavailable: processing('文字识别暂不可用', '本次无法使用文字识别结果，相关文字尚需人工读取。', '先核对原页，待识别可用后重新解析。'),
  ocr_image_byte_budget_exceeded: processing('页面图像超过当前文字识别容量', '页面图像大小超过本次识别上限，未送入文字识别。', '打开原页核对文字；需要自动识别时联系维护人员。'),
  visible_region_requires_ocr: processing('可见区域尚未完成文字识别', '可见页面图像仍需要文字识别，当前解析结果尚不能覆盖其中的全部文字。', '人工核对原页文字，按需重新解析。'),
  image_content_requires_ocr: processing('图像内容需要文字识别', '文件包含图像内容，原生文字层不足以读取其中的文字。', '核对图像中的文字是否已识别，并与原页比对。'),
  image_content_unparsed: processing('图像内容尚未解析', '当前保留了图像，但尚未解析其中的内容。', '打开原页查看图像，人工核对其中的信息。'),
  image_only: processing('此区域仅保留图像', '当前区域没有可用的已解析文字，需要查看图像确认内容。', '打开原页查看该区域并人工读取。'),
  source_text_conflict: review('不同文字来源存在冲突', '不同识别来源对同一区域给出了不一致的文字。', '对照原页逐字核对冲突内容，确认采用的值。'),

  non_text_visible_ink_unclassified: review('文字区域外的可见图形痕迹待归类', '页面检测到文字区域之外的可见图形痕迹，尚未确定其属于图形、印章、手写内容或其他内容。', '查看相关原页，确认这些痕迹的实际内容；不能仅凭该提示认定存在签名。'),
  non_text_visual_content_unverified: review('非文字图像内容尚未核实', '文字识别完成后，图形、印章等非文字图像的含义仍未核实；该提示不表示文件缺少内容。', '查看相关原页的图像内容，确认是否影响本次字段或签署核对。'),
  image_semantics_or_handwriting_unverified: review('图像含义与手写内容尚未核实', '已保留图像区域，但尚未确认其中图形或手写内容的含义。', '打开图像区域核对实际内容，涉及签署时另行核实签署人及授权。'),
  image_evidence_content_unverified: review('图像证据内容尚未核实', '已定位图像区域，但尚未对其中内容作人工核实。', '打开该图像区域，确认其文字、图形及业务含义。'),
  visible_ink_candidate_budget_exhausted: processing('部分可见图形痕迹尚未检测', '可见痕迹检测达到本次处理容量，后续痕迹可能尚未形成候选区域。', '查看相关原页的全部图形及手写区域，补充人工核对。'),
  visible_ink_is_signature_candidate_only: review('可见痕迹仅作为签署候选', '根据附近签署文字发现了可见痕迹，尚不能据此确认签名存在或有效。', '核对该区域是否实际为签署，并确认签署人身份及授权。'),
  signature_existence_identity_and_authority_require_human_confirmation: review('签署存在性、身份及授权待人工确认', '签署候选尚不能证明实际签署、所载身份或签署授权。', '对照原件及授权材料，分别核实是否签署、由谁签署及其权限。'),
  signature_presence_unknown: review('是否存在签署尚未确定', '现有证据不足以确认签署区域中是否存在实际签署。', '查看原件的签署区域并人工确认。'),
  signature_context_multiple_values_unassigned: review('签署上下文中存在多个候选值', '签署附近出现多个姓名、职务或日期，尚未确定各值与签署人的对应关系。', '逐一核对签署区域、姓名、职务和日期，确认各自对应的签署人。'),
  no_trusted_signature_reference: review('没有可用的可信签名留样', '当前没有可用于签名比对的可信留样，不能据此完成签名一致性判断。', '核实是否有适用的可信留样，并按实际材料进行人工比对。'),
  handwriting_not_assessed: review('笔迹尚未比对', '当前结果未对笔迹一致性作出判断。', '如需确认笔迹一致性，对照适用留样进行人工核对。'),

  repeated_value_object_association_unconfirmed: review('重复值 · 对象待确认', '相同值出现在多个位置，尚未确认各自对应的主体或业务对象。', '结合每处原文上下文确认该值对应的对象。'),
  entity_candidate_requires_confirmation: review('候选待确认', '当前值为识别候选，尚未经过人工确认。', '核对候选值的原文、业务对象和字段含义后确认。'),
  bilingual_name_evidence_insufficient: review('名称对应关系待核对', '现有原文证据不足或存在冲突，尚不能将中英文名称归为同一组。', '分别核对各名称的原文、主体角色和标识；原始候选仍保留。'),
  semantic_filter_pending: processing('字段候选尚未筛选', '当前候选尚未按原文中的角色与上下文核对，暂不作为字段值展示。', '点击“筛选字段”完成筛选，或直接核对原文。'),
  semantic_filter_failed: processing('字段筛选未完成', '本次筛选没有完成有效结果校验，原始候选仍保留在筛选记录中。', '重试筛选；持续失败时结合原文人工核对。'),
  field_filter_job_failed: processing('字段筛选任务未完成', '本次字段筛选任务没有完成，不能据此确认候选值。', '重试筛选，或结合原文人工核对。'),
  semantic_filter_unsupported_field: processing('该字段尚不支持语义筛选', '当前没有可用于该字段的语义筛选定义，原始候选尚未核实。', '根据字段含义人工核对原文，或联系维护人员补充字段定义。'),
  semantic_filter_source_review_required: processing('字段来源尚需与原件核对', 'DOCX 尚无可信页面预览，或修订、隐藏内容尚未核实，当前预览候选不能作为原件可见内容使用，因此暂未筛选。', '结合具体预览提示对照原文件核对内容；恢复可靠预览后重新解析，或人工确认字段。'),
  semantic_filter_no_raw_candidates: review('本次解析未生成字段候选', '没有可供筛选的原始候选，不能据此认定文件缺少该信息。', '结合文件类型核对原文；必要时重新解析。'),
  semantic_filter_context_budget_exceeded: processing('候选上下文超过筛选容量', '当前上下文无法在一次完整筛选中可靠处理，暂不展示筛选值。', '人工核对相关原文；需要自动处理时联系维护人员。'),
  semantic_filter_call_budget_exceeded: processing('字段筛选达到处理上限', '本次筛选达到调用上限，相关候选尚未完成核对。', '重试筛选，或人工核对候选对应的原文。'),
  semantic_filter_invalid_source: processing('候选的原文依据未通过校验', '部分候选无法对应到有效原文，本次筛选未采纳这些结果。', '查看原页确认候选来源；必要时重新解析。'),
  semantic_filter_unlocated_candidates: review('部分原始候选尚未定位到原文', '部分原始候选尚无可核验的原文位置，只保留为待人工核对的候选，不作为有依据的字段值展示。', '对照原件人工核对字段；必要时重新解析以补充定位。'),
  cloud_field_source_unverified: review('原始候选待核', '部分原始候选尚无可靠来源，已保留筛选记录。', '对照原文核对字段；必要时重新解析。'),
  cloud_field_coverage_incomplete: review('提取完整性待核对', '已保留取得的值，但尚不能确认相关内容已完整覆盖；此标记本身不表示任务仍在运行或已失败。', '对照原件核对字段完整性，不能仅凭此标记判断漏提。'),
  cloud_field_source_assembly_elsewhere: review('本页别处识别待核对', '本页其他位置存在文字来源差异，本字段取值的依据不在其中；只表示本页可能另有未读出的内容。', '对照原页确认本字段是否另有取值。'),
  cloud_field_source_assembly_uncertain: review('原文识别待核对', '相关材料页面存在文字来源差异或片段归属疑问，完整性仍需核对；不表示当前字段一定漏提。', '对照原页核对识别差异及其是否影响本字段。'),
  field_role_requires_confirmation: review('角色依据待核对', '现有原文不足以可靠确认部分值属于本字段要求的角色。', '核对原文中的主体、栏目和角色关系。'),
  cloud_field_capacity_incomplete: processing('提取范围不完整', '部分候选或结构内容超出本次处理容量，不能确认已保留全部内容。', '对照原文检查额外的对象、行或条款。'),
  cloud_field_pages_unreviewed: review('部分页面未核查', '提取回执没有覆盖该字段对应材料的全部页面。', '核对尚未覆盖的页面，检查是否遗漏取值或条款。'),
  cloud_field_model_coverage_incomplete: review('提取完整性未获确认', '提取结果明确保留了完整性疑问，不能仅凭已有值认定已经提全。', '对照原件检查相关行、对象、条款及备选条件。'),
  cloud_field_material_scope_unknown: review('材料范围待核对', '部分页面的材料类型尚未确定，不能确认该字段的完整适用范围。', '先核对材料类型及页面归属，再检查字段覆盖范围。'),
  semantic_filter_invalid_response: processing('字段筛选结果未通过校验', '返回结果无法可靠对应到候选或原文证据，暂不展示为字段值。', '重试筛选；持续失败时人工核对原文。'),
  semantic_filter_provider_failed: processing('字段筛选服务未完成处理', '筛选服务未能完成本次处理，不能据此判断候选是否适用。', '稍后重试筛选，或直接核对原文。'),
  semantic_filter_model_mismatch: processing('字段筛选服务配置待核查', '实际筛选服务与要求的配置不一致，本次结果未被采纳。', '联系维护人员核查服务配置后重试。'),
  semantic_filter_uncertain_candidates: review('部分候选仍需人工核对', '原文证据不足以确定部分候选是否属于该字段，这些候选未作为有效值展示。', '结合原文人工核对字段，确认候选是否适用。'),
  semantic_filter_no_supported_candidate: review('未找到原文支持的字段值', '本次候选筛选未找到符合该字段含义且有原文依据的值。', '结合文件类型确认字段适用性，并按需人工核对原文。'),
  semantic_filter_source_scope_partial: review('字段筛选所依据的解析内容不完整', '筛选仅覆盖已成功解析的内容，未处理部分仍可能含有相关信息。', '查看解析提示与原页，补充核对尚未完整处理的内容。'),
  field_not_found_in_processed_scope: review('已处理范围内尚未找到字段', '本次已处理的内容中未找到该字段，尚不能据此认定原文件缺失银行要求的信息。', '先核对该文件类型是否要求此字段及其适用条件，再检查相关原页。'),
  cloud_value_boundary_rejected: review('已排除不匹配的值', '部分值不符合字段范围。', '查看原文核对。'),
  multiple_field_candidates: review('多个候选 · 待确认', '尚未确定采用哪个值。', '查看原文，确认对应对象。'),
  normalization_requires_confirmation: review('格式待确认', '原文已提取，格式尚未确认。', '核对日期、金额等格式。'),
  docx_source_coverage_incomplete: review('Word 提取范围不完整', '部分文字结构或非文字内容尚未完成核对，未检测到不等于原件为空。', '结合源结构和原件补充确认。'),
  docx_nontext_requires_review: review('Word 非文字内容待核', '图片、符号或签署内容不能仅由文字结构确认。', '查看原件并人工确认。'),
  docx_candidate_rejected: review('部分 Word 候选未采纳', '候选含义、边界或重复位置尚不能可靠确定。', '查看对应段落或单元格，确认字段和主体。'),
  docx_blank_requires_confirmation: review('疑似空白待确认', '提取返回了空白线索，尚未由人工核对原件。', '核对原件后区分应留空和应填但缺失。'),
  docx_redacted_requires_confirmation: review('遮挡内容待确认', '提取报告了遮挡，未推测被遮挡的值。', '补充获准的可读材料或保留待确认。'),
  docx_unreadable_requires_confirmation: review('不可读内容待确认', '当前提取无法读出相关内容。', '结合原件核对可读性；必要时补件。'),
  logical_directory_requires_confirmation: review('材料目录待人工确认', '当前材料类型及边界为待确认的目录结果。', '对照文件标题及页码，确认材料类型和起止范围。'),
  no_match: review('尚未找到匹配证据', '在本次检索或匹配范围内未找到可用证据，不能推断原文件没有相关内容。', '核对检索范围及原页，必要时调整查询条件。'),

  table_empty_structure: processing('未识别到有效表格内容', '识别到的表格结构未形成有效单元格内容。', tableAction),
  table_structure_budget_exceeded: processing('表格结构超过当前处理容量', '表格行列或单元格数量超过处理上限，结构解析未完整完成。', tableAction),
  table_column_count_mismatch: review('表格各行列数不一致', '当前识别结果中各行列数不一致，需要核对原表是否存在合并或错列。', tableAction),
  table_markdown_code_span_unsupported: processing('表格内的特殊文本格式尚不支持', '表格内的代码式文本格式未被当前解析器完整支持。', tableAction),
  table_format_unsupported: processing('此表格格式尚不支持', '当前解析器未能完整读取该表格格式。', tableAction),
  table_markdown_blank_row_unsupported: review('表格空行结构待核对', '当前解析结果无法可靠解释表格中的空行结构。', tableAction),
  table_markdown_header_separator_missing: processing('表头与正文分界未解析清楚', '表格解析结果未形成可靠的表头与正文分界。', tableAction),
  table_html_entity_unsupported: processing('表格中的部分特殊字符尚不支持', '当前解析器未能处理表格中的部分字符表示。', tableAction),
  table_html_entity_invalid: processing('表格中的部分字符无法读取', '表格中部分字符的表示格式异常，未能完整解析。', tableAction),
  table_html_truncated_or_malformed: processing('表格结构解析结果不完整', '收到的表格结构被截断或格式异常，无法完整还原行列。', tableAction),
  table_html_text_outside_cell: processing('部分表格文字无法归入单元格', '表格解析结果中的部分文字没有可靠的单元格归属。', tableAction),
  table_html_format_unsupported: processing('此表格格式尚不支持', '当前解析器未能完整读取表格的结构格式。', tableAction),
  table_html_element_unsupported: processing('表格中的部分内容格式尚不支持', '表格包含当前解析器不支持的结构元素。', tableAction),
  table_merged_cells_unsupported: processing('合并单元格尚未可靠解析', '当前解析器未能完整支持合并单元格，行列关系需要核对。', tableAction),
  table_html_attributes_unsupported: processing('表格中的部分格式设置尚不支持', '表格包含当前解析器未支持的格式设置，结构可能无法完整保留。', tableAction),
  table_html_nested_or_multiple_tables: review('嵌套或并列表格待区分', '当前结果包含嵌套或多个表格，尚未可靠区分各表范围。', '对照原页区分每个表格，再核对各自的表头及数值。'),
  table_html_row_headers_unsupported: processing('行标题结构尚未可靠解析', '当前解析器未完整支持该表格的行标题结构。', tableAction),
  table_html_mixed_header_cells_unsupported: review('表头与正文混排待核对', '当前表格结果包含表头与正文单元格混排，关系尚需人工确认。', tableAction),
  table_structure_owner_unconfirmed: review('表格所属材料待确认', '尚未确认该表格属于哪一份逻辑材料。', '对照原页及材料目录，确认表格归属。'),
  table_source_anchor_unavailable: processing('表格尚无法定位到原页区域', '当前表格内容未获得可用的原页区域定位。', '打开相关原页找到该表格，并核对其内容及位置。'),
  table_text_unavailable_requires_human: processing('表格文字尚未识别', '当前未获得可用的表格文字，需要通过原页阅读内容。', tableAction),
  table_parse_byte_budget_exceeded: processing('表格内容超过当前处理容量', '表格内容超过本次解析容量，尚未完成解析。', tableAction),
  table_column_headers_unavailable: review('表格列标题尚未识别', '当前结果没有可用的列标题，无法仅依据列位置确认数值含义。', '查看原页表头，确认各列含义后再使用数值。'),
  table_cross_page_association_unverified: review('表格跨页关系待确认', '尚未确认不同页面上的表格内容是否属于同一表格。', '查看相邻原页，确认续表关系、重复表头和跨页行。'),

  evidence_context_budget_exhausted: processing('部分关联证据尚未展开', '关联证据超过本次展开容量，当前结果未纳入全部关联内容。', '沿原文引用核对尚未展开的关联材料。'),
  dependency_depth_budget_exhausted: processing('深层引用尚未展开', '引用层级超过本次展开深度，部分关联内容尚未纳入。', '逐层核对原文引用及其对应内容。'),
  dependency_budget_exhausted: processing('引用展开尚未完成', '本次引用展开达到处理容量，尚有引用未纳入当前结果。', '对照原文继续核对相关引用。'),
  required_dependency_missing: review('必要关联证据尚未找到', '当前结果未取得必要的关联证据，尚不能确认相关内容是否完整。', '核对原文引用及配套材料，确认关联证据的位置。'),
  required_reference_unresolved: review('必要引用尚未找到对应原文', '必要引用尚未可靠对应到原文中的目标内容。', '对照引用标记查找对应条款、附件或其他材料。'),
  missing_reference: review('引用尚未找到对应内容', '当前解析结果未能找到该引用的目标，不代表原文件一定没有该内容。', '在原文件中核对引用标记及其对应条款或附件。'),
  ambiguous_reference: review('引用存在多个可能目标', '当前解析结果中该引用可以对应多个目标，尚未确认正确关联。', '对照原文上下文，确认该引用指向的条款或附件。'),
};

function identify(raw: string): {group: string; description: ProcessingNoteDescription; targetPage?: number} {
  if (Object.hasOwn(descriptions, raw)) return {group: raw, description: descriptions[raw]};
  const pageMatch = /^page_not_processed:([1-9]\d*)$/.exec(raw);
  if (pageMatch && Number.isSafeInteger(Number(pageMatch[1]))) {
    const page = Number(pageMatch[1]);
    return {group: raw, targetPage: page, description: processing(`第 ${page} 页尚未处理`, '本次解析没有包含该页，无法依据现有结果确认该页内容。', '打开该页核对原文，按需补充解析。')};
  }
  for (const code of ['missing_reference', 'ambiguous_reference']) {
    // Reference labels may contain source text. Preserve them only as internal
    // provenance and keep distinct references distinct without displaying them.
    if (raw.startsWith(`${code}:`) && raw.length > code.length + 1) return {group: raw, description: descriptions[code]};
  }
  return {group: 'unclassified', description: unknownNote};
}

export function describeProcessingNote(raw: string): ProcessingNoteDescription {
  return {...identify(raw).description};
}

/** Each entry is a processing/review topic, never a count of missing business fields. */
export function processingNotes(
  pages: readonly {pageNumber: number; coverageGaps: readonly string[]}[],
  additional: readonly string[] = [],
): ProcessingNote[] {
  const grouped = new Map<string, ProcessingNote>();
  const add = (raw: string, pageNumber?: number) => {
    if (!visibleProcessingGap(raw)) return;
    const {group, description, targetPage} = identify(raw);
    let item = grouped.get(group);
    if (!item) {
      item = {...description, key: `processing-note-${grouped.size + 1}`, codes: [], pageNumbers: []};
      grouped.set(group, item);
    }
    if (!item.codes.includes(raw)) item.codes.push(raw);
    const page = targetPage ?? pageNumber;
    if (page !== undefined && Number.isSafeInteger(page) && page > 0 && !item.pageNumbers.includes(page)) item.pageNumbers.push(page);
  };
  for (const page of pages) for (const code of page.coverageGaps) add(code, page.pageNumber);
  for (const code of additional) add(code);
  return [...grouped.values()].map(item => ({...item, pageNumbers: item.pageNumbers.sort((a, b) => a - b)}));
}
