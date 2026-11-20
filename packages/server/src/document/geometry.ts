import type { AffineTransform, PageAsset, Point, Polygon } from '@hsbc/contracts/evidence';

const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export function polygonArea(polygon: Polygon): number {
  return polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]!; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
}
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const within = (p: Point, q: Point, r: Point) => r[0] >= Math.min(p[0], q[0]) && r[0] <= Math.max(p[0], q[0]) && r[1] >= Math.min(p[1], q[1]) && r[1] <= Math.max(p[1], q[1]);
  const ac = cross(a, b, c), ad = cross(a, b, d), ca = cross(c, d, a), cb = cross(c, d, b);
  return ac * ad < 0 && ca * cb < 0 || ac === 0 && within(a, b, c) || ad === 0 && within(a, b, d) || ca === 0 && within(c, d, a) || cb === 0 && within(c, d, b);
}
export function validatePolygon(polygon: Polygon, width: number, height: number): Polygon {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || polygon.length < 3)
    throw new Error('invalid_geometry');
  if (polygon.some(p => !p.every(Number.isFinite) || p[0] < 0 || p[1] < 0 || p[0] > width || p[1] > height))
    throw new Error('geometry_out_of_bounds');
  if (new Set(polygon.map(p => p.join(','))).size !== polygon.length || polygonArea(polygon) <= 1e-8)
    throw new Error('geometry_degenerate_or_not_clockwise');
  for (let i = 0; i < polygon.length; i++) for (let j = i + 1; j < polygon.length; j++) {
    if (j === i + 1 || i === 0 && j === polygon.length - 1) continue;
    if (intersects(polygon[i]!, polygon[(i + 1) % polygon.length]!, polygon[j]!, polygon[(j + 1) % polygon.length]!))
      throw new Error('geometry_self_intersection');
  }
  return polygon;
}
export function transformPoint(point: Point, matrix: AffineTransform): Point {
  const [a, b, c, d, e, f] = matrix;
  return [a * point[0] + c * point[1] + e, b * point[0] + d * point[1] + f];
}
export function mapCropPolygonToPage(polygon: Polygon, transform: AffineTransform | null, page: Pick<PageAsset, 'width' | 'height'>): Polygon {
  if (!transform || !transform.every(Number.isFinite) || Math.abs(transform[0] * transform[3] - transform[1] * transform[2]) < 1e-10)
    throw new Error('inverse_mapping_unavailable');
  const mapped = polygon.map(p => transformPoint(p, transform));
  if (polygonArea(mapped) < 0) mapped.reverse();
  return validatePolygon(mapped, page.width, page.height);
}
export function codePointSlice(text: string, offset: number, length: number): string {
  const points = Array.from(text);
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > points.length)
    throw new Error('invalid_text_span');
  return points.slice(offset, offset + length).join('');
}
export function codePointMatches(text: string, target: string): Array<{ offset: number; length: number }> {
  if (!target) throw new Error('empty_target');
  const result = []; let from = 0;
  for (let at = text.indexOf(target, from); at !== -1; at = text.indexOf(target, from)) {
    result.push({ offset: Array.from(text.slice(0, at)).length, length: Array.from(target).length });
    from = at + target.length;
  }
  return result;
}
