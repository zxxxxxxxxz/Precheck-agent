import type { Polygon } from '@hsbc/contracts/evidence';

/** Connected visible ink outside known text boxes. Geometry comes only from original
 * page pixels. This detects graphic candidates, not signatures, authors or authenticity. */
export function discoverVisibleInk(input: { pixels: Uint8ClampedArray; width: number; height: number; textPolygons: Polygon[]; maximum?: number }): { boxes: Array<[number, number, number, number]>; truncated: boolean } {
  const { pixels, width, height } = input, maximum = input.maximum ?? 32, step = 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || pixels.length !== width * height * 4 || width * height > 20000000 || maximum < 1 || maximum > 128) throw new Error('p2_ink_input_budget_invalid');
  const columns = Math.ceil(width / step), rows = Math.ceil(height / step), count = columns * rows;
  const masked = new Uint8Array(count), ink = new Uint8Array(count);
  const minX = new Int32Array(count).fill(width), minY = new Int32Array(count).fill(height), maxX = new Int32Array(count).fill(-1), maxY = new Int32Array(count).fill(-1);
  for (const polygon of input.textPolygons) {
    if (polygon.length < 3 || polygon.some(point => !point.every(Number.isFinite))) continue;
    const l = Math.max(0, Math.floor((Math.min(...polygon.map(p => p[0])) - 2) / step)), t = Math.max(0, Math.floor((Math.min(...polygon.map(p => p[1])) - 2) / step));
    const r = Math.min(columns - 1, Math.floor((Math.max(...polygon.map(p => p[0])) + 2) / step)), b = Math.min(rows - 1, Math.floor((Math.max(...polygon.map(p => p[1])) + 2) / step));
    for (let y = t; y <= b; y++) for (let x = l; x <= r; x++) masked[y * columns + x] = 1;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const cell = Math.floor(y / step) * columns + Math.floor(x / step), offset = (y * width + x) * 4;
    if (masked[cell] || pixels[offset + 3]! < 100 || pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]! > 450) continue;
    ink[cell] = 1; minX[cell] = Math.min(minX[cell]!, x); minY[cell] = Math.min(minY[cell]!, y); maxX[cell] = Math.max(maxX[cell]!, x); maxY[cell] = Math.max(maxY[cell]!, y);
  }
  const boxes: Array<[number, number, number, number]> = [];
  for (let start = 0; start < count; start++) {
    if (!ink[start]) continue;
    const queue = [start]; ink[start] = 0;
    let l = width, t = height, r = -1, b = -1, cells = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const cell = queue[cursor]!, x = cell % columns, y = Math.floor(cell / columns); cells++;
      l = Math.min(l, minX[cell]!); t = Math.min(t, minY[cell]!); r = Math.max(r, maxX[cell]!); b = Math.max(b, maxY[cell]!);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nextX = x + dx, nextY = y + dy;
        if (nextX < 0 || nextX >= columns || nextY < 0 || nextY >= rows) continue;
        const next = nextY * columns + nextX; if (ink[next]) { ink[next] = 0; queue.push(next); }
      }
    }
    if (cells >= 2 && r - l >= 3 && b - t >= 2) boxes.push([l, t, r + 1, b + 1]);
  }
  // Merge nearby disconnected strokes but never merge through an arbitrary text match.
  boxes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const merged: Array<[number, number, number, number]> = [];
  for (const box of boxes) {
    const other = merged.find(candidate => Math.max(candidate[0], box[0]) - Math.min(candidate[2], box[2]) <= 20 && Math.max(candidate[1], box[1]) - Math.min(candidate[3], box[3]) <= 12);
    if (other) { other[0] = Math.min(other[0], box[0]); other[1] = Math.min(other[1], box[1]); other[2] = Math.max(other[2], box[2]); other[3] = Math.max(other[3], box[3]); }
    else merged.push(box);
  }
  const candidates = merged.filter(box => box[2] - box[0] >= 10 && box[3] - box[1] >= 3 && (box[2] - box[0]) * (box[3] - box[1]) <= width * height * 0.6);
  return { boxes: candidates.slice(0, maximum), truncated: candidates.length > maximum };
}
