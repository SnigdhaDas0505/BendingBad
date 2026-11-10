import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateInternalForcesAtSection,
  createBeamProfile,
  interpolateBeamPoint
} from '../src/app/beam-profile.ts';
import { calculateMidspanPointLoadHandCheck } from '../src/app/beam-validation.ts';
import type { BeamPoint } from '../src/app/failure-analysis.ts';
import {
  calculateMaterialStress,
  deriveSpatialStrainNodes,
  factorOfSafetyColor
} from '../src/app/material-analysis.ts';
import { calculateMohrResults } from '../src/app/stress-analysis.ts';
import { createTelemetryWebSocketUrl, telemetryReconnectDelay } from '../src/app/telemetry-connection.ts';

describe('solver-derived beam profile', () => {
  const points: BeamPoint[] = [
    {
      node: 0, x_m: 0, shear_kN: 6, moment_kNm: 0, slope_mrad: 0, deflection_mm: 0,
      curvature_per_m: 0, stress_top_MPa: 0, stress_bottom_MPa: 0,
      strain_top_micro: 0, strain_bottom_micro: 0
    },
    {
      node: 10, x_m: 2, shear_kN: -4, moment_kNm: 8, slope_mrad: 5, deflection_mm: -3,
      curvature_per_m: 0.02, stress_top_MPa: -40, stress_bottom_MPa: 40,
      strain_top_micro: -200, strain_bottom_micro: 200
    }
  ];

  it('interpolates the solver values at an arbitrary beam position', () => {
    const point = interpolateBeamPoint(points, 1);

    assert.equal(point.x_m, 1);
    assert.equal(point.shear_kN, 1);
    assert.equal(point.moment_kNm, 4);
    assert.equal(point.deflection_mm, -1.5);
    assert.equal(point.stress_top_MPa, -20);
    assert.equal(point.strain_bottom_micro, 100);
  });

  it('creates five evenly spaced normalized samples from the solver response', () => {
    const profile = createBeamProfile(points, 2);

    assert.deepEqual(profile.map(sample => sample.x_ratio), [0, 0.25, 0.5, 0.75, 1]);
    assert.deepEqual(profile.map(sample => sample.point.x_m), [0, 0.5, 1, 1.5, 2]);
    assert.deepEqual(profile.map(sample => sample.point.moment_kNm), [0, 2, 4, 6, 8]);
  });

  it('clamps interpolation to the solved span and rejects invalid profiles', () => {
    assert.equal(interpolateBeamPoint(points, -1).x_m, 0);
    assert.equal(interpolateBeamPoint(points, 3).x_m, 2);
    assert.throws(() => createBeamProfile([], 2), /no result points/);
    assert.throws(() => createBeamProfile(points, 0), /length must be positive/);
  });

  it('evaluates section forces on the right side of point-force and couple jumps', () => {
    const beam = {
      length_m: 6,
      youngs_modulus_gpa: 200,
      inertia_cm4: 5000,
      extreme_fibre_mm: 100,
      support_type: 'simply-supported',
      support_a_m: 0,
      support_b_m: 6
    };
    const reactions = { RA_kN: 10, RB_kN: 10, MA_kNm: 0, MB_kNm: 0 };
    const loads = [
      { id: 1, type: 'point' as const, P: 20, x: 3 },
      { id: 2, type: 'moment' as const, M: 5, x: 4 }
    ];

    const justBeforePointLoad = calculateInternalForcesAtSection(beam, loads, reactions, 2.99);
    assert.equal(justBeforePointLoad.shear_kN, 10);
    assert.ok(Math.abs(justBeforePointLoad.moment_kNm - 29.9) < 1e-10);

    assert.deepEqual(calculateInternalForcesAtSection(beam, loads, reactions, 3), {
      shear_kN: -10,
      moment_kNm: 30
    });
    assert.deepEqual(calculateInternalForcesAtSection(beam, loads, reactions, 4), {
      shear_kN: -10,
      moment_kNm: 15
    });
  });

  it('integrates linearly varying distributed load up to the inspected section', () => {
    const beam = {
      length_m: 4,
      youngs_modulus_gpa: 200,
      inertia_cm4: 5000,
      extreme_fibre_mm: 100,
      support_type: 'cantilever-left',
      support_a_m: 0,
      support_b_m: 4
    };
    const loads = [{ id: 1, type: 'udl' as const, w1: 2, w2: 6, x1: 0, x2: 4 }];
    const forces = calculateInternalForcesAtSection(
      beam,
      loads,
      { RA_kN: 16, RB_kN: 0, MA_kNm: 32 / 3, MB_kNm: 0 },
      2
    );

    assert.equal(forces.shear_kN, 10);
    assert.equal(forces.moment_kNm, 16);
  });
});

describe('closed-form beam hand check', () => {
  const beam = {
    length_m: 6,
    youngs_modulus_gpa: 200,
    inertia_cm4: 5000,
    extreme_fibre_mm: 100,
    support_type: 'simply-supported',
    support_a_m: 0,
    support_b_m: 6
  };
  const summary = {
    max_abs_moment_kNm: 30,
    max_abs_deflection_mm: 9.01,
    max_abs_bending_stress_MPa: 60
  };

  it('compares matching centered-point-load solver values with closed-form values', () => {
    const check = calculateMidspanPointLoadHandCheck(
      beam,
      [{ type: 'point', P: 20, x: 3 }],
      summary
    );

    assert.ok(check);
    assert.deepEqual(check.metrics.map(metric => metric.referenceValue), [30, 60, 9]);
    assert.equal(check.metrics[0].differencePercent, 0);
    assert.ok(Math.abs(check.metrics[2].differencePercent! - (0.01 / 9 * 100)) < 1e-12);
  });

  it('does not present the hand check for unsupported load cases', () => {
    assert.equal(
      calculateMidspanPointLoadHandCheck(beam, [{ type: 'point', P: 20, x: 2 }], summary),
      null
    );
    assert.equal(
      calculateMidspanPointLoadHandCheck(
        beam,
        [{ type: 'point', P: 20, x: 3 }, { type: 'point', P: 5, x: 1 }],
        summary
      ),
      null
    );
  });
});

describe('instant material stress comparison', () => {
  const strain = { ex_micro: 900, ey_micro: -260, gamma_xy_micro: 180 };
  const steel = {
    youngs_modulus_gpa: 200,
    poisson_ratio: 0.26,
    yield_strength_mpa: 250,
    strength_kind: 'yield' as const
  };

  it('recalculates the same strain sample using the selected material properties', () => {
    const aluminum = calculateMaterialStress(strain, {
      youngs_modulus_gpa: 68.9,
      poisson_ratio: 0.33,
      yield_strength_mpa: 276,
      strength_kind: 'yield'
    }, 1.3);
    const titanium = calculateMaterialStress(strain, {
      youngs_modulus_gpa: 113.8,
      poisson_ratio: 0.34,
      yield_strength_mpa: 880,
      strength_kind: 'yield'
    }, 1.3);

    assert.ok(aluminum.material.von_mises_mpa < calculateMaterialStress(strain, steel, 1.3).material.von_mises_mpa);
    assert.ok(titanium.material.factor_of_safety! > aluminum.material.factor_of_safety!);
    assert.equal(aluminum.material.youngs_modulus_gpa, 68.9);
    assert.equal(aluminum.mohrs_circle.sigma_1_mpa >= aluminum.mohrs_circle.sigma_2_mpa, true);
  });

  it('uses the same source strain and threshold setting while changing material', () => {
    const lowStrength = calculateMaterialStress(strain, {
      ...steel,
      yield_strength_mpa: 10
    }, 1.3);
    const highStrength = calculateMaterialStress(strain, {
      ...steel,
      yield_strength_mpa: 10000
    }, 1.3);

    assert.equal(lowStrength.material.von_mises_mpa, highStrength.material.von_mises_mpa);
    assert.equal(lowStrength.alert.level, 'CRITICAL');
    assert.equal(highStrength.alert.level, 'NORMAL');
  });

  it('labels timber screening strength as a bending reference, not yield', () => {
    const result = calculateMaterialStress(strain, {
      youngs_modulus_gpa: 11,
      poisson_ratio: 0.29,
      yield_strength_mpa: 1,
      strength_kind: 'bending-reference'
    }, 1.3);

    assert.match(result.alert.message, /Bending-strength reference exceeded/);
  });

  it('returns an unbounded factor of safety for a zero-strain frame', () => {
    const result = calculateMaterialStress(
      { ex_micro: 0, ey_micro: 0, gamma_xy_micro: 0 },
      steel,
      1.3
    );

    assert.equal(result.material.factor_of_safety, null);
    assert.equal(result.alert.level, 'NORMAL');
  });

  it('matches the tensor invariant for von Mises stress', () => {
    const result = calculateMaterialStress(strain, steel, 1.3);
    const { sigma_x_mpa: sigmaX, sigma_y_mpa: sigmaY, tau_xy_mpa: tauXY } = result.stress_tensor;
    const expected = Math.sqrt(sigmaX ** 2 - sigmaX * sigmaY + sigmaY ** 2 + 3 * tauXY ** 2);

    assert.ok(Math.abs(result.material.von_mises_mpa - expected) < 1e-10);
  });
});

describe('telemetry connection settings', () => {
  const settings = {
    youngsModulusGpa: 200,
    poissonRatio: 0.26,
    yieldStrengthMpa: 250,
    warningFactorOfSafety: 1.3,
    loadScale: 1.5
  };

  it('builds a same-origin WebSocket URL with all active material and load settings', () => {
    const url = createTelemetryWebSocketUrl({ protocol: 'http:', host: 'localhost:4200' }, settings);

    assert.equal(url.href, 'ws://localhost:4200/ws/telemetry?youngs_modulus_gpa=200&poisson_ratio=0.26&yield_strength_mpa=250&warning_factor_of_safety=1.3&load_scale=1.5');
  });

  it('uses a secure WebSocket URL for HTTPS pages', () => {
    const url = createTelemetryWebSocketUrl({ protocol: 'https:', host: 'localhost' }, settings);

    assert.equal(url.protocol, 'wss:');
    assert.equal(url.host, 'localhost');
  });

  it('preserves same-origin routing for non-local hosts', () => {
    const url = createTelemetryWebSocketUrl({ protocol: 'https:', host: 'beamlab.example' }, settings);

    assert.equal(url.href, 'wss://beamlab.example/ws/telemetry?youngs_modulus_gpa=200&poisson_ratio=0.26&yield_strength_mpa=250&warning_factor_of_safety=1.3&load_scale=1.5');
  });

  it('backs off reconnect attempts up to a 15-second cap', () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 8].map(telemetryReconnectDelay),
      [1000, 2000, 4000, 8000, 15000, 15000]
    );
  });
});

describe('spatial strain profile', () => {
  it('creates five normalized locations with bending at midspan and shear at the ends', () => {
    const nodes = deriveSpatialStrainNodes({
      ex_micro: 1000,
      ey_micro: -290,
      gamma_xy_micro: 450
    });

    assert.deepEqual(nodes.map(node => node.x_ratio), [0, 0.25, 0.5, 0.75, 1]);
    assert.equal(nodes[2].strain_input.ex_micro, 1000);
    assert.ok(Math.abs(nodes[0].strain_input.ex_micro) < 1e-10);
    assert.ok(Math.abs(nodes[4].strain_input.ex_micro) < 1e-10);
    assert.equal(nodes[0].strain_input.gamma_xy_micro, 450);
    assert.ok(Math.abs(nodes[2].strain_input.gamma_xy_micro) < 1e-10);
    assert.equal(nodes[4].strain_input.gamma_xy_micro, -450);
  });

  it('maps FoS to semantic critical, warning, and safe colors', () => {
    assert.equal(factorOfSafetyColor(0.9, 1.3), '#991b1b');
    assert.equal(factorOfSafetyColor(1.2, 1.3), '#b45309');
    assert.equal(factorOfSafetyColor(1.3, 1.3), '#166534');
    assert.equal(factorOfSafetyColor(null, 1.3), '#166534');
  });
});

describe('Mohr-circle stress analysis', () => {
  it('calculates principal stresses for uniaxial stress', () => {
    const result = calculateMohrResults(100, 0, 0, 0);

    assert.equal(result.center, 50);
    assert.equal(result.radius, 50);
    assert.equal(result.principalMajor, 100);
    assert.equal(result.principalMinor, 0);
    assert.equal(result.maxShear, 50);
    assert.equal(result.principalAngle, 0);
    assert.equal(result.normalAtAngle, 100);
    assert.equal(result.shearAtAngle, 0);
  });

  it('returns the original stress components at zero rotation', () => {
    const result = calculateMohrResults(80, 20, 30, 0);

    assert.equal(result.normalAtAngle, 80);
    assert.equal(result.shearAtAngle, 30);
  });

  it('exchanges normal stresses and reverses shear at a 90-degree rotation', () => {
    const result = calculateMohrResults(80, 20, 30, 90);

    assert.ok(Math.abs(result.normalAtAngle - 20) < 1e-12);
    assert.ok(Math.abs(result.shearAtAngle + 30) < 1e-12);
  });

  it('returns zero shear on a principal plane', () => {
    const result = calculateMohrResults(80, 20, 30, 0);
    const principal = calculateMohrResults(80, 20, 30, result.principalAngle);

    assert.ok(Math.abs(principal.shearAtAngle) < 1e-12);
    assert.ok(Math.abs(principal.normalAtAngle - result.principalMajor) < 1e-12);
  });

  it('handles pure shear with symmetric principal stresses', () => {
    const result = calculateMohrResults(0, 0, 40, 0);

    assert.equal(result.center, 0);
    assert.equal(result.radius, 40);
    assert.equal(result.principalMajor, 40);
    assert.equal(result.principalMinor, -40);
    assert.equal(result.maxShear, 40);
  });

  it('handles equal biaxial stress with zero circle radius', () => {
    const result = calculateMohrResults(75, 75, 0, 37);

    assert.equal(result.center, 75);
    assert.equal(result.radius, 0);
    assert.equal(result.principalMajor, 75);
    assert.equal(result.principalMinor, 75);
  });

  it('preserves the first and second stress invariants', () => {
    const sigmaX = 88;
    const sigmaY = -16;
    const tauXY = 27;
    const result = calculateMohrResults(sigmaX, sigmaY, tauXY, 23);

    assert.ok(Math.abs(result.principalMajor + result.principalMinor - (sigmaX + sigmaY)) < 1e-12);
    assert.ok(Math.abs(
      result.principalMajor * result.principalMinor - (sigmaX * sigmaY - tauXY ** 2)
    ) < 1e-12);
    assert.ok(result.principalMajor >= result.principalMinor);
    assert.equal(result.radius, result.maxShear);
  });
});
