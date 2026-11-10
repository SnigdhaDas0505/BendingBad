import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findFailureEstimate,
  getFailureStatusLabel,
  getLoadFactorToFirstYield,
  getYieldUtilizationPercent,
  isValidYieldStrength,
  isYieldLimitExceeded,
  type BeamPoint
} from '../src/app/failure-analysis.ts';

function beamPoint(
  node: number,
  topStress: number,
  bottomStress: number,
  x = node
): BeamPoint {
  return {
    node,
    x_m: x,
    shear_kN: 0,
    moment_kNm: 0,
    slope_mrad: 0,
    deflection_mm: 0,
    curvature_per_m: 0,
    stress_top_MPa: topStress,
    stress_bottom_MPa: bottomStress,
    strain_top_micro: 0,
    strain_bottom_micro: 0
  };
}

describe('yield-strength validation', () => {
  it('accepts only positive finite values', () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(isValidYieldStrength(value), false);
    }
    assert.equal(isValidYieldStrength(Number.MIN_VALUE), true);
    assert.equal(isValidYieldStrength(250), true);
  });
});

describe('first-yield estimate', () => {
  it('returns null when the analysis has no stations', () => {
    assert.equal(findFailureEstimate([]), null);
  });

  it('selects the station with the greatest absolute stress and preserves face directions', () => {
    const points = [
      beamPoint(0, -20, 20, 0),
      beamPoint(1, -60, 60, 3),
      beamPoint(2, 40, -40, 6)
    ];

    assert.deepEqual(findFailureEstimate(points), {
      point: points[1],
      stressMpa: 60,
      topState: 'compression',
      bottomState: 'tension'
    });
  });

  it('handles reverse bending with tension on the top face', () => {
    const point = beamPoint(2, 45, -45);
    assert.deepEqual(findFailureEstimate([point]), {
      point,
      stressMpa: 45,
      topState: 'tension',
      bottomState: 'compression'
    });
  });

  it('uses the greater extreme-fibre stress for an asymmetric station', () => {
    const point = beamPoint(1, -12, 31);
    const estimate = findFailureEstimate([point]);
    assert.equal(estimate?.stressMpa, 31);
    assert.equal(estimate?.topState, 'compression');
    assert.equal(estimate?.bottomState, 'tension');
  });

  it('keeps the first station when equal peak stresses tie', () => {
    const first = beamPoint(1, -50, 50, 1);
    const second = beamPoint(2, 50, -50, 2);
    assert.equal(findFailureEstimate([first, second])?.point, first);
  });

  it('reports zero bending as a valid estimate without a load factor', () => {
    const estimate = findFailureEstimate([beamPoint(0, 0, 0)]);
    assert.equal(estimate?.stressMpa, 0);
    assert.equal(getLoadFactorToFirstYield(estimate, 250), null);
    assert.equal(getFailureStatusLabel(estimate, 250), 'No bending stress');
  });
});

describe('yield-limit screening', () => {
  const estimate = findFailureEstimate([beamPoint(1, -60, 60)]);

  it('classifies stress below, at, and above the yield limit', () => {
    assert.equal(isYieldLimitExceeded(estimate, 60.01), false);
    assert.equal(isYieldLimitExceeded(estimate, 60), true);
    assert.equal(isYieldLimitExceeded(estimate, 59.99), true);
    assert.equal(getFailureStatusLabel(estimate, 60.01), 'Below first yield');
    assert.equal(getFailureStatusLabel(estimate, 60), 'First-yield limit exceeded');
    assert.equal(getFailureStatusLabel(estimate, 0), 'Enter a valid yield limit');
    assert.equal(getFailureStatusLabel(null, 250), 'Awaiting analysis');
  });

  it('calculates load factor and utilization, capping the meter at 100%', () => {
    assert.equal(getLoadFactorToFirstYield(estimate, 250), 250 / 60);
    assert.equal(getYieldUtilizationPercent(estimate, 250), 24);
    assert.equal(getYieldUtilizationPercent(estimate, 50), 100);
    assert.equal(getYieldUtilizationPercent(estimate, Number.NaN), 0);
    assert.equal(getYieldUtilizationPercent(null, 250), 0);
    assert.equal(getLoadFactorToFirstYield(estimate, 0), null);
  });
});
