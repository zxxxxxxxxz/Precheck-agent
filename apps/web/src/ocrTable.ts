import type {DocumentRegion} from '@hsbc/contracts/evidence';
import type {DocumentTableObservation} from '@hsbc/contracts/documents';

/** Display limits only: the stored OCR source and evidence conclusions are never changed. */
export const OCR_TABLE_LIMITS = Object.freeze({bytes: 128 * 1024, rows: 200, columns: 50, cells: 2000, fallbackCharacters: 16_000});
export interface OcrDisplayCell {text: string; header: boolean; rowSpan: number; colSpan: number}
export interface OcrDisplayTable {rows: OcrDisplayCell[][]; columns: number; source: 'observation' | 'ocr_markup'}
type RegionText = Pick<DocumentRegion, 'region_id' | 'document_version_id' | 'parse_revision' | 'raw_text' | 'raw_text_sha256' | 'kind'>;
export type OcrRegionPresentation = {kind: 'table'; table: OcrDisplayTable; rawText: string} | {kind: 'text'; text: string; truncated: boolean; tableFallback: boolean};
class InvalidTable extends Error {}
const invalid = (): never => {throw new InvalidTable();};

/** Never uses DOMParser/innerHTML, so even rejected resource tags cannot trigger requests. */
function decodeText(value: string): string {
  const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', yen: '¥', pound: '£', euro: '€', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®'};
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (original, entity: string) => {
    if (!entity.startsWith('#')) return Object.hasOwn(named, entity) ? named[entity]! : original;
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return invalid();
    return String.fromCodePoint(code);
  });
}

function cellSpans(attributes: string): Pick<OcrDisplayCell, 'rowSpan' | 'colSpan'> {
  const result = {rowSpan: 1, colSpan: 1}, seen = new Set<string>();
  let rest = attributes;
  while (rest.trim()) {
    const match = /^\s+(rowspan|colspan)\s*=\s*(?:"([0-9]+)"|'([0-9]+)'|([0-9]+))(?=\s|$)/iu.exec(rest);
    if (!match) return invalid();
    const name = match[1]!.toLowerCase(), value = Number(match[2] ?? match[3] ?? match[4]);
    if (seen.has(name) || !Number.isSafeInteger(value) || value < 1 || value > (name === 'rowspan' ? OCR_TABLE_LIMITS.rows : OCR_TABLE_LIMITS.columns)) return invalid();
    seen.add(name); result[name === 'rowspan' ? 'rowSpan' : 'colSpan'] = value;
    rest = rest.slice(match[0].length);
  }
  return result;
}

function validateGrid(rows: OcrDisplayCell[][]): number {
  if (!rows.length || rows.length > OCR_TABLE_LIMITS.rows) return invalid();
  const occupied = rows.map(() => new Set<number>());
  let width = 0, slots = 0, cells = 0;
  for (let r = 0; r < rows.length; r++) {
    let column = 0;
    for (const cell of rows[r]!) {
      if (++cells > OCR_TABLE_LIMITS.cells) return invalid();
      while (occupied[r]!.has(column)) column++;
      if (column + cell.colSpan > OCR_TABLE_LIMITS.columns || r + cell.rowSpan > rows.length) return invalid();
      for (let row = r; row < r + cell.rowSpan; row++) for (let col = column; col < column + cell.colSpan; col++) {
        if (occupied[row]!.has(col) || ++slots > OCR_TABLE_LIMITS.cells) return invalid();
        occupied[row]!.add(col);
      }
      column += cell.colSpan; width = Math.max(width, column);
    }
  }
  if (!width || occupied.some(row => row.size !== width)) return invalid();
  return width;
}

/** A small balanced table grammar; all accepted values later become React text nodes. */
export function parseOcrTable(raw: string): OcrDisplayTable | null {
  if (raw.length > OCR_TABLE_LIMITS.bytes || new TextEncoder().encode(raw).length > OCR_TABLE_LIMITS.bytes) return null;
  try {
    const tokens = raw.match(/<[^>]*>|[^<]+/gu) ?? [];
    if (tokens.join('') !== raw) return invalid();
    const stack: string[] = [], rows: OcrDisplayCell[][] = [];
    let row: OcrDisplayCell[] | undefined, cell: OcrDisplayCell | undefined, seenTable = false, count = 0;
    for (const token of tokens) {
      if (!token.startsWith('<')) {
        if (cell) cell.text += decodeText(token);
        else if (token.trim()) return invalid();
        continue;
      }
      const tag = /^<\s*(\/?)\s*([a-z]+)([^>]*)>$/iu.exec(token);
      if (!tag) return invalid();
      const closing = Boolean(tag[1]), name = tag[2]!.toLowerCase(), tail = tag[3]!;
      if (!['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'br'].includes(name)) return invalid();
      if (closing) {
        if (tail.trim() || stack.pop() !== name) return invalid();
        if (name === 'td' || name === 'th') {
          if (!cell || !row) return invalid();
          row.push({...cell, text: cell.text.trim()}); cell = undefined;
        } else if (name === 'tr') {
          if (!row) return invalid();
          rows.push(row); row = undefined;
        }
        continue;
      }
      if (name === 'br') {
        if (!cell || !['', '/'].includes(tail.trim())) return invalid();
        cell.text += '\n'; continue;
      }
      const parent = stack.at(-1);
      if (name === 'table') {
        if (seenTable || stack.length || tail.trim()) return invalid();
        seenTable = true;
      } else if (['thead', 'tbody', 'tfoot'].includes(name)) {
        if (parent !== 'table' || tail.trim()) return invalid();
      } else if (name === 'tr') {
        if (!['table', 'thead', 'tbody', 'tfoot'].includes(parent ?? '') || row || tail.trim() || rows.length >= OCR_TABLE_LIMITS.rows) return invalid();
        row = [];
      } else {
        if (parent !== 'tr' || !row || cell || ++count > OCR_TABLE_LIMITS.cells) return invalid();
        cell = {text: '', header: name === 'th', ...cellSpans(tail)};
      }
      stack.push(name);
    }
    if (!seenTable || stack.length || row || cell) return invalid();
    return {rows, columns: validateGrid(rows), source: 'ocr_markup'};
  } catch (error) {
    if (!(error instanceof InvalidTable)) throw error;
    return null;
  }
}

/** Reuse existing cell relationships only when bound to this exact source and parse. */
function observationTable(region: RegionText, observation?: DocumentTableObservation): OcrDisplayTable | null {
  if (!observation || observation.status === 'unavailable' || observation.regionId !== region.region_id || observation.documentVersionId !== region.document_version_id || observation.parseRevision !== region.parse_revision || observation.rawText !== region.raw_text || observation.rawTextSha256 !== region.raw_text_sha256) return null;
  if (observation.rows.length > OCR_TABLE_LIMITS.rows || observation.columns.length > OCR_TABLE_LIMITS.columns || observation.cells.length > OCR_TABLE_LIMITS.cells || !observation.columns.length) return null;
  if (observation.columns.some((column, index) => column.columnIndex !== index)) return null;
  const byId = new Map(observation.cells.map(cell => [cell.id, cell]));
  if (byId.size !== observation.cells.length) return null;
  const used = new Set<string>(), rows: OcrDisplayCell[][] = [];
  for (const [index, sourceRow] of observation.rows.entries()) {
    if (sourceRow.rowIndex !== index || sourceRow.cellIds.length !== observation.columns.length) return null;
    const row: OcrDisplayCell[] = [];
    for (const [column, id] of sourceRow.cellIds.entries()) {
      const cell = byId.get(id);
      if (!cell || used.has(id) || cell.rowIndex !== index || cell.columnIndex !== column) return null;
      used.add(id); row.push({text: cell.text, header: sourceRow.kind === 'header', rowSpan: 1, colSpan: 1});
    }
    rows.push(row);
  }
  if (used.size !== observation.cells.length || !rows.length || rows.reduce((length, row) => length + row.reduce((total, cell) => total + cell.text.length, 0), 0) > OCR_TABLE_LIMITS.bytes) return null;
  return {rows, columns: observation.columns.length, source: 'observation'};
}

export function presentOcrRegion(region: RegionText, observation?: DocumentTableObservation): OcrRegionPresentation {
  const raw = region.raw_text ?? '';
  const looksLikeTable = /^\s*<table(?:\s|>)/iu.test(raw);
  const table = observationTable(region, observation) ?? (looksLikeTable ? parseOcrTable(raw) : null);
  if (table) return {kind: 'table', table, rawText: raw};
  return {kind: 'text', text: raw.slice(0, OCR_TABLE_LIMITS.fallbackCharacters), truncated: raw.length > OCR_TABLE_LIMITS.fallbackCharacters, tableFallback: looksLikeTable || (region.kind === 'table' && /<\/?(?:table|tr|td|th)\b/iu.test(raw))};
}
