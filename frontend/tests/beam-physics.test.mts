import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bendingStressMpa,
  capVisualDeflections,
  flexuralRigidityKNm2,
  formatEngineeringValue,
  isWithinSmallDeflectionLimit
} from '../src/app/beam-physics.ts';

describe('beam unit conversions', () => {
  it('converts E and I to kN·m² without a factor-of-1000 error', () => {
    assert.ok(Math.abs(flexuralRigidityKNm2(200, 0.0000785) - 0.000157) < 1e-12);
  });

  it('calculates bending stress from kN·m, mm and cm⁴', () => {
    assert.ok(Math.abs(bendingStressMpa(45, 1, 0.0000785) - 57_324_840.764331214) < 1e-6);
  });

  it('flags deflections beyond 35% of span without clamping the calculated result', () => {
    assert.equal(isWithinSmallDeflectionLimit(2100, 6), true);
    assert.equal(isWithinSmallDeflectionLimit(2101, 6), false);
    assert.equal(isWithinSmallDeflectionLimit(Number.NaN, 6), false);
  });

  it('caps only drawn offsets and keeps their signs and relative shape', () => {
    assert.deepEqual(capVisualDeflections([0, -50, -100, -50], 35), [0, -17.5, -35, -17.5]);
    assert.deepEqual(capVisualDeflections([0, 2], 0), [0, 0]);
  });

  it('uses scientific notation for very small flexural rigidity and extreme results', () => {
    assert.equal(formatEngineeringValue(0.000157), '1.57e-4');
    assert.equal(formatEngineeringValue(61_388_236_971.25), '6.14e+10');
    assert.equal(formatEngineeringValue(Number.NaN), '—');
  });
});
