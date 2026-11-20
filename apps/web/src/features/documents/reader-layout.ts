/** Versioned proportions deliberately ignore the former pixel-width preference. */
export const readerLayoutKey = 'ui.review.layout.v2';
export interface ReaderLayout {version: 2; directory: number; canvasRatio: number}
export const defaultReaderLayout: ReaderLayout = {version: 2, directory: 220, canvasRatio: 0.5};
export function readerLayout(value: unknown): ReaderLayout {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 2) return {...defaultReaderLayout};
  const candidate = value as Partial<ReaderLayout>;
  return {version: 2,
    directory: Number.isFinite(candidate.directory) ? Math.max(180, Math.min(360, candidate.directory!)) : 220,
    canvasRatio: Number.isFinite(candidate.canvasRatio) ? Math.max(0.3, Math.min(0.7, candidate.canvasRatio!)) : 0.5};
}
export function readerRatio(sizes: readonly number[]): number {
  const total = sizes[0] + sizes[1];
  return sizes.length === 2 && sizes.every(value => Number.isFinite(value) && value > 0) && total > 0
    ? readerLayout({version: 2, canvasRatio: sizes[0] / total}).canvasRatio : 0.5;
}
export function readerRatioKey(ratio: number, key: string): number | undefined {
  if (key === 'Enter' || key === 'Home') return 0.5;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  return readerLayout({version: 2, canvasRatio: ratio + (key === 'ArrowLeft' ? -0.02 : 0.02)}).canvasRatio;
}
