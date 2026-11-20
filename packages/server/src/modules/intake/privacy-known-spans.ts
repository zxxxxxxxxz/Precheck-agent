import {completePrivacyMatch} from './privacy-source.js';

const graphemes=new Intl.Segmenter('und',{granularity:'grapheme'});
const words=new Intl.Segmenter('und',{granularity:'word'});
const fold=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{White_Space}\uFEFF\u200B]/gu,'');
/** Formatting-only lookup. Punctuation and separate original blocks remain
 * barriers; every returned range is an exact, complete-grapheme source slice. */
export function knownPrivacySource(text:string){
  let normalized='';const starts:number[]=[],ends:number[]=[];
  for(const part of graphemes.segment(text)){
    const value=fold(part.segment);normalized+=value;
    for(let i=0;i<value.length;i++){starts.push(part.index);ends.push(part.index+part.segment.length);}
  }
  const wordRanges=[...words.segment(text)].filter(part=>part.isWordLike)
    .map(part=>({start:part.index,end:part.index+part.segment.length}));
  const completeWords=(start:number,end:number)=>start>=0&&end>start&&end<=text.length&&
    wordRanges.some(word=>word.start<end&&word.end>start)&&
    !wordRanges.some(word=>word.start<start&&word.end>start||word.start<end&&word.end>end);
  const index={normalized,starts,ends};
  return {text,completeWords,*matches(value:string,expandOriginalWords=false){
    const needle=fold(value);if(!needle)return;
    let at=0;
    while((at=normalized.indexOf(needle,at))!==-1){
      const start=starts[at]!,end=ends[at+needle.length-1]!;
      if(completePrivacyMatch(index,at,needle.length)){
        const original=text.slice(start,end);
        if(original.length<=2000&&fold(original)===needle){
          if(completeWords(start,end))yield{start,end,original,expanded:false};
          else if(expandOriginalWords){
            // More masking, never an exception to the final source check. The
            // minimum original word cover remains an opaque identity, with
            // explicit bounds and formatting-only gaps between adjacent words.
            const cover=wordRanges.filter(word=>word.start<end&&word.end>start);
            const first=cover[0],last=cover.at(-1);
            if(first&&last&&cover.length<=8&&first.start<=start&&last.end>=end&&last.end-first.start<=256&&
              cover.slice(1).every((word,index)=>/^[\p{White_Space}\uFEFF\u200B]*$/u.test(text.slice(cover[index]!.end,word.start))))
              yield{start:first.start,end:last.end,original:text.slice(first.start,last.end),expanded:true};
          }
        }
      }
      at++;
    }
  }};
}
