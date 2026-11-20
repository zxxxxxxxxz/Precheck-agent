import {DocxSourceDocumentSchema} from '@hsbc/contracts/docx';
import type {DocxConversionManifest, DocxNode, DocxSourceDocument} from '@hsbc/contracts/docx';
import {ApiError} from './api.ts';
import type {SystemCapabilities} from './capabilities.ts';
export type {DocxNode};
export interface SourceMapping {sourceNodeId: string; anchorIds: string[]; pageNumbers: number[]; status: string; reason?: string | null}
export interface SourceDocumentResponse {
  schemaVersion: 'p2.docx.v1'; parseRevision: string; source: DocxSourceDocument;
  preview: {id: string | null; status: string; errorCode?: string | null; manifest: DocxConversionManifest | null; coverageGaps: string[]; pageCount: number | null} | null;
  mappings: SourceMapping[];
}
export const sourceKindLabels: Record<DocxNode['kind'], string> = {section:'节', paragraph:'段落', run:'文字片段', table:'表格', row:'表格行', cell:'单元格', symbol:'符号', footnote:'脚注', endnote:'尾注', textbox:'文本框', image:'图像', comment:'批注'};
export const visibilityLabels: Record<DocxNode['visibility'], string> = {visible:'可见内容', hidden:'隐藏文字', deleted:'删除修订', inserted:'插入修订', comment:'批注内容', unknown:'可见性待确认'};
export function sourceNodeLabel(node: DocxNode) {
  const cell = node.cell;
  const kind = node.kind === 'run' && node.reference ? `${node.reference.kind === 'footnote' ? '脚注' : node.reference.kind === 'endnote' ? '尾注' : node.reference.kind === 'comment' ? '批注' : '图像'}引用` : sourceKindLabels[node.kind];
  return `${kind}${cell ? ` · 第 ${cell.rowIndex + 1} 行，第 ${cell.columnIndex + 1} 列` : ''}`;
}
/** Reject a stale response before displaying any source text. The original bytes remain the identity. */
export function validateSourceResponse(value: SourceDocumentResponse, parseRevision: string, sourceSha256: string): SourceDocumentResponse {
  if (value?.schemaVersion !== 'p2.docx.v1' || value.parseRevision !== parseRevision || value.source?.sourceSha256 !== sourceSha256) throw new ApiError(409, 'source_version_mismatch', '源结构版本与当前材料不一致，请重新查询。');
  const parsed = DocxSourceDocumentSchema.safeParse(value.source);
  if (!parsed.success || !Array.isArray(value.mappings)) throw new ApiError(502, 'invalid_source_response', '源结构返回不完整，请重新查询。');
  const nodeIds = new Set(parsed.data.nodes.map(node => node.id));
  return {...value, source: parsed.data, mappings: value.mappings.filter(mapping => nodeIds.has(mapping.sourceNodeId) && Array.isArray(mapping.anchorIds) && Array.isArray(mapping.pageNumbers)).map(mapping => ({...mapping, anchorIds: mapping.anchorIds.filter(id => typeof id === 'string'), pageNumbers: mapping.pageNumbers.filter(page => Number.isSafeInteger(page) && page > 0)}))};
}
export function readableSourceNodes(nodes: readonly DocxNode[]) {
  return nodes.filter(node => (node.kind !== 'run' || !!node.reference || node.visibility !== 'visible') && node.kind !== 'row' && node.kind !== 'section' && (node.text || node.visibleText || node.kind === 'symbol' || node.kind === 'image' || node.kind === 'cell' || !!node.reference)).toSorted((a,b) => a.order - b.order);
}
export function sourceTextPresentation(node: DocxNode) {const excluded = node.excludedFromVisibleFacts || node.visibility !== 'visible'; return {text: excluded ? node.text : node.visibleText, excluded, hasExcludedText: !excluded && node.text !== node.visibleText};}
export function sourceNodeTrail(node: DocxNode, nodes: readonly DocxNode[]) {
  const byId = new Map(nodes.map(value => [value.id,value])); const seen = new Set([node.id]); const result: DocxNode[] = [];
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  while (parent && !seen.has(parent.id) && result.length < 30) {result.unshift(parent); seen.add(parent.id); parent = parent.parentId ? byId.get(parent.parentId) : undefined;}
  return result;
}
export function previewAvailable(data: SourceDocumentResponse) {return ['ready','partial','succeeded'].includes(data.preview?.status ?? '') && !!data.preview?.pageCount;}
/** Processing switches never hide persisted evidence; absent read capabilities fail closed. */
export function documentViewAvailability(docx:boolean, data:SourceDocumentResponse|undefined, capabilities:Pick<SystemCapabilities,'documentReader'|'mockReader'>|undefined) {
  return {preview:capabilities?.documentReader === true && (!docx || (!!data && previewAvailable(data))), mock:capabilities?.documentReader === true && capabilities.mockReader === true};
}
export function resolveDocumentView(requested:string|null, docx:boolean, availability:ReturnType<typeof documentViewAvailability>) {
  return requested === 'mock' && availability.mock ? 'mock' : docx && (requested === 'source' || !availability.preview) ? 'source' : 'preview';
}
export function sourceGapLabel(code: string) {
  const labels: Record<string,string> = {docx_preview_unavailable:'页面预览暂不可用，可继续核对源结构', docx_conversion_failed:'页面转换失败，可继续核对源结构', docx_font_substitution:'部分字体已替代，页面排版可能变化', docx_font_unresolved:'部分字体不可用，需核对原件', docx_symbol_unresolved:'符号含义尚未确认', docx_hidden_text:'包含隐藏文字', docx_tracked_changes:'包含修订内容', docx_external_relationship:'包含外部引用，未读取外部内容', docx_page_mapping_unavailable:'源结构尚不能精确映射到页面'};
  const extras: Record<string,string> = {
    preview_revision_or_visibility_review_required:'原文件含修订或不可见内容，预览仅供核对；候选字段暂不生成',
    preview_unavailable_source_review_required:'页面预览不可用，暂不生成候选字段；请核对源结构',
    source_visibility_is_markup_only:'源结构按文件标记区分可见性，尚未核对实际页面显示',
    source_visibility_not_visually_verified:'此源结构内容尚未与页面显示核对',
    unreferenced_note_not_visible_fact:'未被可见正文引用的脚注或尾注未作为可见事实使用',
    source_mapping_incomplete:'部分源结构尚无可靠页面映射',
    source_mapping_budget_exceeded:'页面定位达到当前处理容量，未定位内容仍保留在源结构',
    source_note_reference_unresolved:'脚注或尾注尚无完整来源，需核对原件',
    merged_cell_layout_requires_preview_verification:'合并单元格的布局需结合预览核对',
    default_hidden_style_conservatively_excluded:'默认隐藏样式下的文字未作为可见事实使用',hidden_content_excluded:'隐藏文字未作为可见事实使用',deleted_content_excluded:'删除修订未作为可见事实使用',inserted_content_excluded:'插入修订待确认，未作为可见事实使用',comment_content_excluded:'批注未作为可见事实使用',unknown_content_excluded:'部分内容可见性尚未确认',
    external_relationship_not_loaded:'外部引用未读取',relationship_target_missing:'引用目标缺失',embedded_fonts_not_executed:'内嵌字体未加载，需核对排版',unreferenced_story_not_visible_fact:'未被正文使用的页眉、页脚等附属内容未作为可见事实使用',style_inheritance_cycle:'文字样式存在循环依赖',dynamic_fields_not_evaluated:'动态域值尚未求值',numbering_label_requires_preview_verification:'自动编号需结合预览核对',content_control_state_requires_verification:'内容控件状态需核对',equation_layout_not_reconstructed:'公式排版未完整还原',alternate_content_branches_unresolved:'兼容内容分支尚未确认',symbol_glyph_requires_render_verification:'特殊字体符号需查看原件确认含义',legacy_horizontal_merge_unresolved:'旧格式横向合并单元格需核对',image_source_unavailable:'图像来源不可用',note_reference_unresolved:'脚注或尾注引用未定位',unparsed_package_xml_part:'部分附属内容未解析',source_body_empty:'未找到可读正文',source_to_preview_mapping_not_established:'部分源结构尚无可靠页面映射',preview_fidelity_requires_verification:'预览排版需与原件核对',font_substitution_or_coverage_unverified:'字体替代或字符覆盖尚未确认',validation_only_unsandboxed_runtime:'此预览来自隔离验证，不能作为正式产物使用',docx_preview_disabled:'页面预览暂未开放',docx_runtime_unconfigured:'页面转换服务尚未就绪',
  };
  return labels[code] ?? extras[code] ?? '部分内容未完整处理，请结合原件核对。';
}
