import { DocumentTableObservationSchema, type DocumentPageArtifact, type DocumentStructureNode, type DocumentTableObservation } from '@hsbc/contracts/documents';
import { sha256, validateAnchorSource } from '../../../document/evidence.js';

/** Parsing limits do not truncate the immutable original text retained in the observation. */
export const TABLE_PARSE_LIMITS = Object.freeze({ maxTextBytes: 128 * 1024, maxRows: 200, maxColumns: 50, maxCells: 2000 });
type Row = { kind: 'header' | 'body'; values: string[] };
class UnsupportedTable extends Error { constructor(readonly code: string) { super(code); } }
const reject = (code: string): never => { throw new UnsupportedTable(code); };
function validateRows(rows: Row[]): Row[] {
  if (!rows.length || !rows[0]!.values.length) return reject('table_empty_structure');
  const columns = rows[0]!.values.length;
  if (rows.length > TABLE_PARSE_LIMITS.maxRows || columns > TABLE_PARSE_LIMITS.maxColumns || rows.length * columns > TABLE_PARSE_LIMITS.maxCells) return reject('table_structure_budget_exceeded');
  if (rows.some(row => row.values.length !== columns)) return reject('table_column_count_mismatch');
  return rows;
}
function markdownCells(line: string): string[] {
  const text = line.trim();
  if (text.includes('`')) return reject('table_markdown_code_span_unsupported');
  const cells: string[] = []; let cell = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '\\' && ['|', '\\'].includes(text[i + 1] ?? '')) { cell += text[++i]; continue; }
    if (char === '|') { cells.push(cell.trim()); cell = ''; } else cell += char;
  }
  cells.push(cell.trim());
  if (text.startsWith('|')) cells.shift();
  // An escaped trailing pipe belongs to a cell, rather than an outer delimiter.
  if (text.endsWith('|') && /(?:^|[^\\])(?:\\\\)*\|$/u.test(text)) cells.pop();
  return cells;
}
function markdown(raw: string): Row[] {
  const lines = raw.trim().split(/\r?\n/u);
  if (lines.length < 2 || !lines[0]!.includes('|')) return reject('table_format_unsupported');
  if (lines.some(line => !line.trim())) return reject('table_markdown_blank_row_unsupported');
  if (lines.length > TABLE_PARSE_LIMITS.maxRows + 1) return reject('table_structure_budget_exceeded');
  const header = markdownCells(lines[0]!), separator = markdownCells(lines[1]!);
  if (separator.length !== header.length || separator.some(value => !/^:?-{3,}:?$/u.test(value))) return reject('table_markdown_header_separator_missing');
  return validateRows([{ kind: 'header', values: header }, ...lines.slice(2).map(line => ({ kind: 'body' as const, values: markdownCells(line) }))]);
}
function decodeEntities(raw: string): string {
  return raw.replace(/&([^;\s]+);/gu, (_match, entity: string) => {
    const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
    if (known[entity] !== undefined) return known[entity]!;
    const match = /^#(x[\da-f]+|\d+)$/iu.exec(entity);
    if (!match) return reject('table_html_entity_unsupported');
    const value = match[1]!.toLowerCase(), code = value.startsWith('x') ? Number.parseInt(value.slice(1), 16) : Number(value);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return reject('table_html_entity_invalid');
    return String.fromCodePoint(code);
  });
}
/** Deliberately accepts a small balanced table grammar; HTML is never executed or rendered. */
function html(raw: string, signatureImages = false): Row[] {
  const tokens = raw.match(/<[^>]*>|[^<]+/gu) ?? [];
  if (tokens.join('') !== raw) return reject('table_html_truncated_or_malformed');
  const stack: string[] = [], rows: Row[] = []; let row: Row | null = null, cell: string | null = null, cellCount = 0, tableSeen = false;
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (cell !== null) cell += decodeEntities(token);
      else if (token.trim()) return reject('table_html_text_outside_cell');
      continue;
    }
    const tag = /^<\s*(\/?)\s*([a-z]+)([^>]*)>$/iu.exec(token);
    if (!tag) return reject('table_html_format_unsupported');
    const closing = Boolean(tag[1]), name = tag[2]!.toLowerCase(), tail = tag[3]!.trim();
    // Signature projection retains only the existence of an embedded graphic.
    // Its URL/attributes never become geometry, text, HTML or a network request.
    if (signatureImages && name === 'img' && !closing && cell !== null) { cell += '[signature graphic]'; continue; }
    if (!['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'br'].includes(name)) return reject('table_html_element_unsupported');
    if (closing) {
      if (tail || stack.pop() !== name) return reject('table_html_truncated_or_malformed');
      if (name === 'td' || name === 'th') { if (cell === null || !row) return reject('table_html_truncated_or_malformed'); row.values.push(cell.trim()); cell = null; }
      if (name === 'tr') { if (!row) return reject('table_html_truncated_or_malformed'); rows.push(row); row = null; }
      continue;
    }
    let attributes = tail;
    if (name === 'br') {
      if (cell === null || !['', '/'].includes(attributes)) return reject('table_html_format_unsupported');
      cell += '\n'; continue;
    }
    if (name === 'th' || name === 'td') {
      attributes = attributes.replace(/\b(rowspan|colspan)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu, (_match, _attribute: string, quoted: string | undefined, single: string | undefined, bare: string | undefined) => {
        if ((quoted ?? single ?? bare) !== '1') return reject('table_merged_cells_unsupported');
        return '';
      }).trim();
    }
    if (attributes) return reject('table_html_attributes_unsupported');
    const parent = stack.at(-1);
    if (name === 'table') { if (tableSeen || stack.length) return reject('table_html_nested_or_multiple_tables'); tableSeen = true; }
    else if (['thead', 'tbody', 'tfoot'].includes(name)) { if (parent !== 'table') return reject('table_html_truncated_or_malformed'); }
    else if (name === 'tr') {
      if (!['table', 'thead', 'tbody', 'tfoot'].includes(parent ?? '') || row) return reject('table_html_truncated_or_malformed');
      if (rows.length >= TABLE_PARSE_LIMITS.maxRows) return reject('table_structure_budget_exceeded');
      row = { kind: parent === 'thead' ? 'header' : 'body', values: [] };
    } else {
      if (parent !== 'tr' || !row || cell !== null) return reject('table_html_truncated_or_malformed');
      if (++cellCount > TABLE_PARSE_LIMITS.maxCells || row.values.length >= TABLE_PARSE_LIMITS.maxColumns) return reject('table_structure_budget_exceeded');
      if (name === 'th') {
        // Row headers need a separate relation model; do not mistake them for column headings.
        if (rows.some(value => value.kind === 'body') || (row.kind === 'body' && row.values.length)) return reject('table_html_row_headers_unsupported');
        row.kind = 'header';
      } else if (row.kind === 'header') return reject('table_html_mixed_header_cells_unsupported');
      cell = '';
    }
    stack.push(name);
  }
  if (!tableSeen || stack.length || row || cell !== null) return reject('table_html_truncated_or_malformed');
  return validateRows(rows);
}

/** Bounded source cell relations for signature blocks; no invented cell geometry. */
export function signatureTableRows(raw: string): string[][] {
  if (Buffer.byteLength(raw) > TABLE_PARSE_LIMITS.maxTextBytes) return [];
  try { return (/^\s*<table\b/iu.test(raw) ? html(raw, true) : markdown(raw)).map(row => row.values); }
  catch (error) { if (error instanceof UnsupportedTable) return []; throw error; }
}

export function deriveTables(pages: DocumentPageArtifact[], structures: DocumentStructureNode[]): { tables: DocumentTableObservation[]; coverageGaps: string[] } {
  const tables: DocumentTableObservation[] = [];
  for (const page of pages) for (const region of page.regions.filter(value => value.kind === 'table' && page.canonicalRegionIds.includes(value.region_id))) {
    if (region.document_version_id !== page.scope.documentVersionId || region.parse_revision !== page.scope.parseRevision || region.page_asset_id !== page.page.page_asset_id) throw new Error('p2_table_source_scope_mismatch');
    const rawText = region.raw_text, rawTextSha256 = rawText === null ? null : sha256(rawText);
    if (rawTextSha256 !== region.raw_text_sha256) throw new Error('p2_table_source_hash_mismatch');
    const anchors = page.anchors.filter(anchor => anchor.block_ids.includes(region.region_id));
    for (const anchor of anchors) validateAnchorSource(anchor, page.page, page.regions);
    const anchorIds = [...new Set(anchors.map(anchor => anchor.anchor_id))];
    const owners = structures.filter(node => node.kind === 'table' && node.regionIds.includes(region.region_id) && node.pageNumbers.includes(page.page.page_number));
    const owner = owners.length === 1 ? owners[0]! : null;
    const gaps = [...region.coverage_gaps];
    if (!owner) gaps.push('table_structure_owner_unconfirmed');
    if (!anchorIds.length) gaps.push('table_source_anchor_unavailable');
    let format: DocumentTableObservation['format'] = !rawText?.trim() ? 'image_only' : /^\s*</u.test(rawText) ? 'html' : 'markdown';
    let parsed: Row[] = [];
    if (!rawText?.trim()) gaps.push('table_text_unavailable_requires_human');
    else if (Buffer.byteLength(rawText) > TABLE_PARSE_LIMITS.maxTextBytes) gaps.push('table_parse_byte_budget_exceeded');
    else {
      try { parsed = format === 'html' ? html(rawText) : markdown(rawText); }
      catch (error) { if (!(error instanceof UnsupportedTable)) throw error; gaps.push(error.code); if (error.code === 'table_format_unsupported') format = 'unsupported'; }
    }
    if (parsed.length && !parsed.some(row => row.kind === 'header')) gaps.push('table_column_headers_unavailable');
    const tableId = `table:${sha256(JSON.stringify([page.scope, region.region_id, rawTextSha256]))}`;
    const cells = parsed.flatMap((row, rowIndex) => row.values.map((text, columnIndex) => ({ id: `cell:${sha256(JSON.stringify([tableId, rowIndex, columnIndex]))}`, rowIndex, columnIndex, text, anchorIds, granularity: 'region' as const })));
    tables.push(DocumentTableObservationSchema.parse({ id: tableId, documentVersionId: page.scope.documentVersionId, parseRevision: page.scope.parseRevision, pageNumber: page.page.page_number, regionId: region.region_id,
      logicalDocumentId: owner?.logicalDocumentId ?? null, structureNodeId: owner?.id ?? null, anchorIds, rawText, rawTextSha256, format,
      status: !parsed.length ? 'unavailable' : gaps.length ? 'partial' : 'structured',
      rows: parsed.map((row, rowIndex) => ({ rowIndex, kind: row.kind, cellIds: cells.filter(cell => cell.rowIndex === rowIndex).map(cell => cell.id) })),
      columns: Array.from({ length: parsed[0]?.values.length ?? 0 }, (_, columnIndex) => ({ columnIndex, headerCellIds: cells.filter(cell => cell.columnIndex === columnIndex && parsed[cell.rowIndex]!.kind === 'header').map(cell => cell.id) })),
      cells, crossPageAssociation: 'not_established', coverageGaps: [...new Set(gaps)] }));
  }
  // Adjacent-page tables may be continuations or unrelated tables. Preserve both without joining.
  for (const table of tables) if (tables.some(other => other.id !== table.id && other.documentVersionId === table.documentVersionId && other.parseRevision === table.parseRevision && Math.abs(other.pageNumber - table.pageNumber) === 1 && (!table.logicalDocumentId || !other.logicalDocumentId || other.logicalDocumentId === table.logicalDocumentId))) {
    table.coverageGaps.push('table_cross_page_association_unverified'); if (table.status === 'structured') table.status = 'partial';
  }
  return { tables, coverageGaps: [...new Set(tables.flatMap(table => table.coverageGaps))] };
}
