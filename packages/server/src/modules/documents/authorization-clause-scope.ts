interface SourcePage { pageNumber: number; text: string }
interface SourceSpan { pageNumber: number; start: number; end: number }
interface Heading { offset: number; scope: string; family: 'number' | 'roman' }

function headings(text: string): Heading[] {
  // Only explicit parent headings. Parenthesized (a)/(i)/(1) alternatives,
  // section references inside sentences, dates and bare numbers are not scopes.
  const pattern = /^[ \t]*(?:(?:Clause|Section|Resolution|Signing|条款|决议|签署)[ \t]*[:：][ \t]*)?([1-9]\d{0,2}(?:\.\d{1,3})*|[IVXLCDM]{1,8})[.．][ \t]*(?:\r?\n[ \t]*)?(?=\p{L})/gmu;
  return [...text.matchAll(pattern)].map(match => ({
    offset: match.index, scope: match[1]!.split('.')[0]!,
    family: /^[0-9]/u.test(match[1]!) ? 'number' : 'roman',
  }));
}

/** A literal quote can still combine incompatible numbered authorizations.
 * This bounded check only rejects explicit different parent scopes in the same
 * material. It does not infer a relationship when no parent heading is present.
 * The material's first heading establishes the parent numbering family, so
 * differently numbered subclauses do not silently replace that parent.
 */
export function crossesAuthorizationClauseBoundary(pages: readonly SourcePage[], spans: readonly SourceSpan[]): boolean {
  const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const indexed = ordered.map(page => ({ ...page, headings: headings(page.text) }));
  const family = indexed.flatMap(page => page.headings)[0]?.family;
  if (!family) return false;
  const byPage = new Map<number, { inherited?: string; headings: Heading[] }>();
  let current: string | undefined;
  for (const page of indexed) {
    const parents = page.headings.filter(heading => heading.family === family);
    byPage.set(page.pageNumber, { inherited: current, headings: parents });
    current = parents.at(-1)?.scope ?? current;
  }
  const scopes = new Set<string>();
  for (const span of spans) {
    const page = byPage.get(span.pageNumber);
    if (!page) continue;
    let atStart = page.inherited;
    for (const heading of page.headings) {
      if (heading.offset <= span.start) atStart = heading.scope;
      else if (heading.offset < span.end) scopes.add(heading.scope);
    }
    if (atStart) scopes.add(atStart);
    if (scopes.size > 1) return true;
  }
  return false;
}
