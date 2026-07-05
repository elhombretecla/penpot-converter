/**
 * 2x3 affine matrices in Figma's row layout:
 *   | m00 m01 m02 |   point' = (m00·x + m01·y + m02,
 *   | m10 m11 m12 |             m10·x + m11·y + m12)
 */
export interface FigMatrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export interface Point {
  x: number;
  y: number;
}

export const IDENTITY: FigMatrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

const EPSILON = 1e-6;

export function compose(p: FigMatrix, l: FigMatrix): FigMatrix {
  return {
    m00: p.m00 * l.m00 + p.m01 * l.m10,
    m01: p.m00 * l.m01 + p.m01 * l.m11,
    m02: p.m00 * l.m02 + p.m01 * l.m12 + p.m02,
    m10: p.m10 * l.m00 + p.m11 * l.m10,
    m11: p.m10 * l.m01 + p.m11 * l.m11,
    m12: p.m10 * l.m02 + p.m11 * l.m12 + p.m12,
  };
}

export function apply(m: FigMatrix, p: Point): Point {
  return {
    x: m.m00 * p.x + m.m01 * p.y + m.m02,
    y: m.m10 * p.x + m.m11 * p.y + m.m12,
  };
}

/** True when the linear part is (numerically) the identity: no rotation/flip/skew. */
export function isAxisAligned(m: FigMatrix): boolean {
  return (
    Math.abs(m.m00 - 1) < EPSILON &&
    Math.abs(m.m01) < EPSILON &&
    Math.abs(m.m10) < EPSILON &&
    Math.abs(m.m11 - 1) < EPSILON
  );
}

/** Inverts a full 3x3 affine (2x3 + implicit [0,0,1] row). Returns undefined if singular. */
export function invertFull(m: FigMatrix): FigMatrix | undefined {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (Math.abs(det) < 1e-12) return undefined;
  const a = m.m11 / det;
  const b = -m.m01 / det;
  const c = -m.m10 / det;
  const d = m.m00 / det;
  return {
    m00: a,
    m01: b,
    m02: -(a * m.m02 + b * m.m12),
    m10: c,
    m11: d,
    m12: -(c * m.m02 + d * m.m12),
  };
}
