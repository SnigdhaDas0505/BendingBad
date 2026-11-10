import type { BeamPoint } from './failure-analysis';

export interface BeamProfileInputs {
  length_m: number;
  youngs_modulus_gpa: number;
  inertia_cm4: number;
  extreme_fibre_mm: number;
  support_type: string;
  support_a_m: number;
  support_b_m: number;
}

export type BeamProfileLoad =
  | { id: number; type: 'point'; P: number; x: number }
  | { id: number; type: 'udl'; w1: number; w2: number; x1: number; x2: number }
  | { id: number; type: 'moment'; M: number; x: number };

export interface BeamAnalysisContext {
  beam: BeamProfileInputs;
  loads: BeamProfileLoad[];
  yieldStrengthMpa: number;
  points: BeamPoint[];
}

export interface BeamSectionForces {
  shear_kN: number;
  moment_kNm: number;
}

export interface BeamProfileSample {
  x_ratio: number;
  point: BeamPoint;
}

export function calculateInternalForcesAtSection(
  beam: BeamProfileInputs,
  loads: BeamProfileLoad[],
  reactions: { RA_kN: number; RB_kN: number; MA_kNm: number; MB_kNm: number },
  x: number
): BeamSectionForces {
  const sectionX = Math.max(0, Math.min(beam.length_m, x));
  let shear = sectionX >= beam.support_a_m ? reactions.RA_kN : 0;
  let moment = sectionX >= beam.support_a_m
    ? reactions.RA_kN * (sectionX - beam.support_a_m)
    : 0;

  if (['cantilever-left', 'fixed-fixed', 'propped-cantilever'].includes(beam.support_type)) {
    moment -= reactions.MA_kNm;
  }
  if (sectionX >= beam.support_b_m) {
    shear += reactions.RB_kN;
    moment += reactions.RB_kN * (sectionX - beam.support_b_m);
  }

  for (const load of loads) {
    if (load.type === 'point') {
      if (load.x <= sectionX) {
        shear -= load.P;
        moment -= load.P * (sectionX - load.x);
      }
    } else if (load.type === 'moment') {
      if (load.x <= sectionX) moment -= load.M;
    } else if (sectionX > load.x1) {
      const length = Math.max(0, Math.min(sectionX, load.x2) - load.x1);
      if (length === 0) continue;
      const slope = (load.w2 - load.w1) / (load.x2 - load.x1);
      const force = load.w1 * length + 0.5 * slope * length ** 2;
      const arm = sectionX - load.x1;
      shear -= force;
      moment -= (
        load.w1 * arm * length
        - 0.5 * load.w1 * length ** 2
        + 0.5 * slope * arm * length ** 2
        - slope * length ** 3 / 3
      );
    }
  }

  return { shear_kN: shear, moment_kNm: moment };
}

export function interpolateBeamPoint(points: BeamPoint[], x: number): BeamPoint {
  if (points.length === 0) throw new Error('Beam analysis has no result points.');
  if (points.length === 1) return { ...points[0], x_m: x };

  const clampedX = Math.max(points[0].x_m, Math.min(points.at(-1)!.x_m, x));
  let low = 0;
  let high = points.length - 1;
  while (low < high - 1) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].x_m <= clampedX) low = middle;
    else high = middle;
  }

  const left = points[low];
  const right = points[high];
  const fraction = (clampedX - left.x_m) / Math.max(right.x_m - left.x_m, Number.EPSILON);
  const mix = (key: keyof BeamPoint): number =>
    Number(left[key]) + (Number(right[key]) - Number(left[key])) * fraction;

  return {
    node: Math.round(mix('node')),
    x_m: clampedX,
    shear_kN: mix('shear_kN'),
    moment_kNm: mix('moment_kNm'),
    slope_mrad: mix('slope_mrad'),
    deflection_mm: mix('deflection_mm'),
    curvature_per_m: mix('curvature_per_m'),
    stress_top_MPa: mix('stress_top_MPa'),
    stress_bottom_MPa: mix('stress_bottom_MPa'),
    strain_top_micro: mix('strain_top_micro'),
    strain_bottom_micro: mix('strain_bottom_micro')
  };
}

export function createBeamProfile(
  points: BeamPoint[],
  lengthM: number,
  positionCount = 5
): BeamProfileSample[] {
  if (!Number.isFinite(lengthM) || lengthM <= 0) {
    throw new Error('Beam length must be positive to create the stress profile.');
  }
  if (!Number.isInteger(positionCount) || positionCount < 2) {
    throw new Error('Beam profile requires at least two positions.');
  }

  return Array.from({ length: positionCount }, (_, index) => {
    const xRatio = index / (positionCount - 1);
    return {
      x_ratio: xRatio,
      point: interpolateBeamPoint(points, xRatio * lengthM)
    };
  });
}
