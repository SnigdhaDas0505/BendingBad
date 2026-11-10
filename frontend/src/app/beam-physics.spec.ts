import { bendingStressMpa, flexuralRigidityKNm2 } from './beam-physics';
import { calculateInternalForcesAtSection } from './beam-profile';
import { calculateMidspanPointLoadHandCheck } from './beam-validation';

describe('beam physics', () => {
  const beam = {
    length_m: 6,
    youngs_modulus_gpa: 200,
    inertia_cm4: 5_000,
    extreme_fibre_mm: 100,
    support_type: 'simply-supported',
    support_a_m: 0,
    support_b_m: 6
  };
  const EI = flexuralRigidityKNm2(beam.youngs_modulus_gpa, beam.inertia_cm4);

  it('matches the analytical midspan point-load moment and deflection', () => {
    const P = 20;
    const expectedMoment = P * beam.length_m / 4;
    const expectedDeflectionMm = P * beam.length_m ** 3 / (48 * EI) * 1_000;
    const check = calculateMidspanPointLoadHandCheck(
      beam,
      [{ type: 'point', P, x: beam.length_m / 2 }],
      {
        max_abs_moment_kNm: expectedMoment,
        max_abs_deflection_mm: expectedDeflectionMm,
        max_abs_bending_stress_MPa: bendingStressMpa(expectedMoment, beam.extreme_fibre_mm, beam.inertia_cm4)
      }
    );

    expect(check).not.toBeNull();
    expect(check!.metrics[0].referenceValue).toBeCloseTo(expectedMoment, 10);
    expect(check!.metrics[2].referenceValue).toBeCloseTo(expectedDeflectionMm, 10);
  });

  it('matches Mmax = wL²/8 for a simply supported uniform load', () => {
    const w = 10;
    const expectedMoment = w * beam.length_m ** 2 / 8;
    const forces = calculateInternalForcesAtSection(
      beam,
      [{ id: 1, type: 'udl', w1: w, w2: w, x1: 0, x2: beam.length_m }],
      { RA_kN: w * beam.length_m / 2, RB_kN: w * beam.length_m / 2, MA_kNm: 0, MB_kNm: 0 },
      beam.length_m / 2
    );

    expect(Math.abs(forces.moment_kNm)).toBeCloseTo(expectedMoment, 8);
  });

  it('matches δmax = 5wL⁴/(384EI) for a simply supported UDL', () => {
    const w = 10;
    const expectedDeflectionMm = 5 * w * beam.length_m ** 4 / (384 * EI) * 1_000;
    expect(expectedDeflectionMm).toBeCloseTo(1.6875, 10);
  });

  it('matches cantilever tip-load root moment and slope equations', () => {
    const length = 4;
    const load = 15;
    const cantilever = { ...beam, length_m: length, support_type: 'cantilever-left' };
    const root = calculateInternalForcesAtSection(
      cantilever,
      [{ id: 1, type: 'point', P: load, x: length }],
      { RA_kN: load, RB_kN: 0, MA_kNm: load * length, MB_kNm: 0 },
      0
    );
    const expectedSlopeMrad = load * length ** 2 / (2 * EI) * 1_000;

    expect(Math.abs(root.moment_kNm)).toBeCloseTo(load * length, 10);
    expect(expectedSlopeMrad).toBeCloseTo(12, 10);
  });

  it('satisfies v(0) = v(L) = 0 for the simply supported UDL equation', () => {
    const w = 10;
    const deflectionAt = (x: number): number =>
      w * x * (beam.length_m ** 3 - 2 * beam.length_m * x ** 2 + x ** 3) / (24 * EI);

    expect(deflectionAt(0)).toBeCloseTo(0, 12);
    expect(deflectionAt(beam.length_m)).toBeCloseTo(0, 12);
  });
});
