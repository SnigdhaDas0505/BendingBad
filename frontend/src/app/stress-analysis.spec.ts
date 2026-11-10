import { bendingStressMpa } from './beam-physics';
import { findFailureEstimate, isYieldLimitExceeded } from './failure-analysis';
import { calculateBendingStressProfile, calculateMohrResults } from './stress-analysis';
import type { BeamPoint } from './failure-analysis';

describe('stress analysis', () => {
  it('calculates flexural stress as σ = M·c/I in solver units', () => {
    const momentKNm = 45;
    const extremeFibreMm = 100;
    const inertiaCm4 = 5_000;

    expect(bendingStressMpa(momentKNm, extremeFibreMm, inertiaCm4)).toBeCloseTo(90, 12);
    expect(calculateBendingStressProfile(
      new Float64Array([0, momentKNm]),
      extremeFibreMm,
      inertiaCm4
    )).toEqual(new Float64Array([0, 90]));
  });

  it('calculates FoS = σy/σmax and flags FoS ≤ 1', () => {
    const yieldStrengthMpa = 250;
    const maximumStressMpa = 250;
    const factorOfSafety = yieldStrengthMpa / maximumStressMpa;
    const point = makePoint(maximumStressMpa);
    const estimate = findFailureEstimate([point]);

    expect(factorOfSafety).toBeCloseTo(1, 12);
    expect(isYieldLimitExceeded(estimate, yieldStrengthMpa)).toBeTrue();
  });

  it('does not flag a stress state whose FoS is greater than one', () => {
    const estimate = findFailureEstimate([makePoint(100)]);
    expect(250 / estimate!.stressMpa).toBeGreaterThan(1);
    expect(isYieldLimitExceeded(estimate, 250)).toBeFalse();
  });

  it('retains the Mohr-circle principal-stress invariant', () => {
    const result = calculateMohrResults(80, 20, 30, 25);
    expect(result.principalMajor + result.principalMinor).toBeCloseTo(100, 12);
    expect(result.maxShear).toBeCloseTo(Math.hypot(30, 30), 12);
  });
});

function makePoint(stressMpa: number): BeamPoint {
  return {
    node: 0,
    x_m: 3,
    shear_kN: 0,
    moment_kNm: 0,
    slope_mrad: 0,
    deflection_mm: 0,
    curvature_per_m: 0,
    stress_top_MPa: stressMpa,
    stress_bottom_MPa: -stressMpa,
    strain_top_micro: 0,
    strain_bottom_micro: 0
  };
}
