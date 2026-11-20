import { ModelExecutionError } from '../../model/gateway.js';
import { indexedPrivacySource, completePrivacyMatch } from '../intake/privacy-source.js';
import type {PrivateIntakeProjection} from '../intake/privacy-projection.js';

const fail = (): never => { throw new ModelExecutionError('invalid_output'); };
const canonical = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en-US');
type Run = { start: number; end: number; originalStart: number; originalEnd: number; opaque: boolean };

/** Privacy can legitimately mask a protocol identifier in the dictionary.
 * Restore only an exact typeRef at the same immutable dictionary position.
 * No source text, arbitrary placeholder or guessed identifier is accepted. */
export function documentTypeReference(ref:string,blocks:ReadonlyArray<{id:string;text:string}>,projection:PrivateIntakeProjection,known:readonly string[]):string {
  if(known.includes(ref))return ref;
  if(!/^\[\[P_[A-Z]+_[a-f0-9]{20}\]\]$/u.test(ref))return fail();
  const original=blocks.find(b=>b.id==='dictionary')?.text,redacted=projection.blocks.find(b=>b.id==='dictionary')?.text;
  if(!original||!redacted)return fail();
  const replacements=new Map(projection.replacements.map(r=>[r.placeholder,r.original]));
  documentSourceQuotes(original,redacted,replacements);
  let before:any,after:any;try{before=JSON.parse(original);after=JSON.parse(redacted);}catch{return fail();}
  if(!Array.isArray(before.taxonomy)||!Array.isArray(after.taxonomy)||before.taxonomy.length!==after.taxonomy.length)return fail();
  const matches=after.taxonomy.flatMap((item:any,i:number)=>item?.typeRef===ref?[before.taxonomy[i]?.typeRef]:[]);
  if(matches.length!==1||!known.includes(matches[0])||replacements.get(ref)!==matches[0])return fail();
  return matches[0];
}

/** Verify the entire projection against this exact page before restoring any
 * quotation. Aliases may share a canonical identity, but evidence always uses
 * the bytes of the cited occurrence, including case and full-width characters. */
export function documentSourceQuotes(original: string, redacted: string, replacements: ReadonlyMap<string, string>) {
  const indexed = indexedPrivacySource(original, false, { removeWhitespace: false });
  if (indexed.normalized !== canonical(original)) fail();
  const normalizedOffsets = new Map<number, number>();
  indexed.starts.forEach((start, index) => { if (!normalizedOffsets.has(start)) normalizedOffsets.set(start, index); });
  const runs: Run[] = [];
  let cursor = 0, originalCursor = 0;
  const literal = (end: number) => {
    const text = redacted.slice(cursor, end);
    if (!original.startsWith(text, originalCursor)) fail();
    if (text.length) runs.push({ start: cursor, end, originalStart: originalCursor, originalEnd: originalCursor + text.length, opaque: false });
    originalCursor += text.length; cursor = end;
  };
  for (const match of redacted.matchAll(/\[\[P_[A-Z]+_[a-f0-9]{20}\]\]/gu)) {
    literal(match.index);
    const registered = replacements.get(match[0]) ?? fail(), needle = canonical(registered);
    const at = normalizedOffsets.get(originalCursor) ?? fail();
    if (!indexed.normalized.startsWith(needle, at) || !completePrivacyMatch(indexed, at, needle.length)) fail();
    const originalEnd = indexed.ends[at + needle.length - 1]!;
    if (canonical(original.slice(originalCursor, originalEnd)) !== needle) fail();
    runs.push({ start: cursor, end: cursor + match[0].length, originalStart: originalCursor, originalEnd, opaque: true });
    cursor += match[0].length; originalCursor = originalEnd;
  }
  literal(redacted.length);
  if (originalCursor !== original.length) fail();
  const offset = (position: number) => {
    if (position === redacted.length) return original.length;
    const run = runs.find(run => run.start <= position && position < run.end) ?? fail();
    if (run.opaque && position !== run.start) fail();
    return run.opaque ? run.originalStart : run.originalStart + position - run.start;
  };
  return (text: string) => {
    if (!text || /\[\[P_/u.test(text.replace(/\[\[P_[A-Z]+_[a-f0-9]{20}\]\]/gu, ''))) fail();
    const matches: Array<{ text: string; start: number; end: number; renderedStart: number; renderedEnd: number }> = [];
    for (let at = redacted.indexOf(text); at !== -1; at = redacted.indexOf(text, at + 1)) {
      if (matches.length >= 1000) fail();
      const start = offset(at), end = offset(at + text.length);
      matches.push({ text: original.slice(start, end), start, end, renderedStart: at, renderedEnd: at + text.length });
    }
    if (!matches.length && text.length <= 4000 && /\s/u.test(text.trim())) {
      // A quote is often returned with its line breaks and spacing re-flowed. One that differs from the source only in
      // whitespace is accepted when it identifies exactly one place; several places, or any other difference, stay rejected.
      const pattern = new RegExp(text.trim().split(/\s+/u).map(token => token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'gu');
      const found = [...redacted.matchAll(pattern)];
      if (found.length === 1) {
        const at = found[0]!.index!, length = found[0]![0].length, start = offset(at), end = offset(at + length);
        matches.push({ text: original.slice(start, end), start, end, renderedStart: at, renderedEnd: at + length });
      }
    }
    if (!matches.length) fail();
    return matches;
  };
}
