import { describe, expect, it } from 'vitest';
import { edgeVector } from '../../src/components/glass/refraction';

describe('localized glass bevel', () => {
  it('leaves the flat interior and exterior undistorted', () => {
    expect(edgeVector(150, 100, 300, 200, 24, 16)).toEqual([0, 0]);
    expect(edgeVector(-4, 100, 300, 200, 24, 16)).toEqual([0, 0]);
    expect(edgeVector(70, 70, 300, 200, 24, 16)).toEqual([0, 0]);
  });
  it('bends opposing sides equally towards the interior', () => {
    const left = edgeVector(8, 100, 300, 200, 24, 16);
    const right = edgeVector(292, 100, 300, 200, 24, 16);
    expect(left[0]).toBeGreaterThan(.9); expect(right[0]).toBeCloseTo(-left[0]);
    expect(left[1]).toBeCloseTo(0); expect(right[1]).toBeCloseTo(0);
  });
  it('uses curved normals at rounded corners with bounded displacement', () => {
    const v = edgeVector(14, 14, 300, 200, 24, 16);
    expect(v[0]).toBeGreaterThan(0); expect(v[1]).toBeCloseTo(v[0]);
    expect(Math.hypot(...v)).toBeLessThanOrEqual(1);
  });
  it('keeps bevel width constant as panels grow', () => {
    expect(edgeVector(8, 100, 300, 200, 24, 16)[0]).toBeCloseTo(edgeVector(8, 400, 1600, 800, 24, 16)[0]);
    expect(edgeVector(30, 400, 1600, 800, 24, 16)).toEqual([0, 0]);
  });
});
