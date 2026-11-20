/** Bounded balanced HTML grammar. Offsets refer to the untouched source string;
 * no DOM, inferred column boundaries, OCR repair, or external evidence is used. */
export function documentHtmlCellSpans(raw: string, options: {allowImages?: boolean} = {}): Array<{ start: number; end: number }> {
  if (Buffer.byteLength(raw) > 128 * 1024) return [];
  const tokens = [...raw.matchAll(/<[^>]*>|[^<]+/gu)];
  if (tokens.map(token => token[0]).join('') !== raw) return [];
  const stack: string[] = [], cells: Array<{ start: number; end: number }> = [];
  let cellStart: number | undefined, tableSeen = false;
  for (const token of tokens) {
    if (!token[0].startsWith('<')) {
      if (cellStart === undefined && token[0].trim()) return [];
      continue;
    }
    const parsed = /^<\s*(\/?)\s*([a-z]+)([^>]*)>$/iu.exec(token[0]);
    if (!parsed) return [];
    const closing = !!parsed[1], name = parsed[2]!.toLowerCase(), attributes = parsed[3]!.trim();
    // Opt-in form readers ignore image markup inside a cell. No attributes
    // are executed, fetched, interpreted as text, or used to invent geometry.
    if (options.allowImages && name === 'img' && !closing && cellStart !== undefined) continue;
    if (!['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'br'].includes(name)) return [];
    if (name === 'br') {
      if (closing || cellStart === undefined || !['', '/'].includes(attributes)) return [];
      continue;
    }
    if (closing) {
      if (attributes || stack.pop() !== name) return [];
      if (name === 'td' || name === 'th') {
        if (cellStart === undefined || cells.length >= 2000) return [];
        cells.push({ start: cellStart, end: token.index }); cellStart = undefined;
      }
      continue;
    }
    const parent = stack.at(-1);
    if (name === 'table') { if (tableSeen || stack.length) return []; tableSeen = true; }
    else if (['thead', 'tbody', 'tfoot'].includes(name)) { if (parent !== 'table') return []; }
    else if (name === 'tr') { if (!['table', 'thead', 'tbody', 'tfoot'].includes(parent ?? '')) return []; }
    else {
      if (parent !== 'tr' || cellStart !== undefined) return [];
      cellStart = token.index + token[0].length;
    }
    stack.push(name);
  }
  return tableSeen && !stack.length && cellStart === undefined ? cells : [];
}
