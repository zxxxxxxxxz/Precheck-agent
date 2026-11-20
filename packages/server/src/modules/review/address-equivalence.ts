/** A bounded bilingual address grammar, not fuzzy address or identity matching.
 * Every component must be consumed; floors, towers and street numbers retain
 * their roles. Unknown place aliases or additional units remain unresolved.
 * Public place aliases: HSBC's zh/en branch lists under
 * https://www.hsbc.com.cn/en-cn/help/contact/branch-finder/lists/
 * This dictionary proves translation only, never a bank's current occupancy.
 */
export function addressMeaningKey(value:string):string|undefined {
 const s=value.normalize('NFKC').trim().replace(/\s+/gu,' ').replace(/[。.]$/u,'');
 const chinese=/^中国广东省广州市天河区天河路(\d+)号太古汇([一二三四五六七八九]|\d+)座(\d+)(?:楼|层)$/u.exec(s.replace(/\s/gu,''));
 const english=/^(\d+)\s*\/\s*F,\s*Tower\s+(\d+),\s*Taikoo\s+Hui,\s*(\d+)\s+Tianhe\s+Road,\s*Tianhe\s+District,\s*Guangzhou,\s*Guangdong,\s*China$/iu.exec(s);
 const key=(street:string,tower:string,floor:string)=>JSON.stringify(['address-v1','CN','Guangdong','Guangzhou','Tianhe','Tianhe Road',Number(street),'Taikoo Hui',Number(tower),Number(floor)]);
 if(chinese){const tower=String('一二三四五六七八九'.indexOf(chinese[2]!)+1);return key(chinese[1]!,tower==='0'?chinese[2]!:tower,chinese[3]!);}
 if(english)return key(english[3]!,english[2]!,english[1]!);
}
