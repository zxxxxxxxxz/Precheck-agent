const entities: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

/** Parsed passages can carry table and layout markup. Readers see the words only: cells are spaced, rows break lines. */
export function quoteText(raw: string): string {
  return raw
    .replace(/<\s*(?:br|\/tr|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\s*\/(?:td|th)\b[^>]*>/gi, '  ')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => code[0] === '#'
      ? String.fromCodePoint(code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : entities[code.toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').replace(/[ \t]{3,}/g, '  ').trim();
}
