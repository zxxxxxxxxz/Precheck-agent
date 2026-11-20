export type AdoptionFilter = 'all' | 'pending' | 'adopt' | 'excluded';
/** Groups for the materials list filter: no decision yet, adopted, or rejected/superseded. */
export function adoptionGroup(operation?: 'adopt' | 'reject' | 'superseded'): Exclude<AdoptionFilter, 'all'> {return !operation ? 'pending' : operation === 'adopt' ? 'adopt' : 'excluded';}
export function shortVersion(value: string, versions: string[]) {
  let length = 8;
  const shorten = (version: string) => version.length > length * 2 + 1 ? `${version.slice(0, length)}…${version.slice(-length)}` : version;
  while (versions.some(version => version !== value && shorten(version) === shorten(value))) length += 4;
  return shorten(value);
}
