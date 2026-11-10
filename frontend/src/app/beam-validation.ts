export interface HandCheckMetric {
  label: string;
  unit: string;
  solverValue: number;
  referenceValue: number;
  differencePercent: number | null;
  solverBarPercent: number;
  referenceBarPercent: number;
}

export interface MidspanPointLoadHandCheck {
  metrics: HandCheckMetric[];
}

interface HandCheckBeam {
  length_m: number;
  youngs_modulus_gpa: number;
  inertia_cm4: number;
  extreme_fibre_mm: number;
  support_type: string;
  support_a_m: number;
  support_b_m: number;
}

interface HandCheckLoad {
  type: string;
  P?: number;
  x?: number;
}

interface HandCheckSummary {
  max_abs_moment_kNm: number;
  max_abs_deflection_mm: number;
  max_abs_bending_stress_MPa: number;
}

export function calculateMidspanPointLoadHandCheck(
  beam: HandCheckBeam,
  loads: HandCheckLoad[],
  summary: HandCheckSummary
): MidspanPointLoadHandCheck | null {
  const { length_m: length, support_a_m: supportA, support_b_m: supportB } = beam;
  const tolerance = Math.max(1, length) * 1e-9;
  const load = loads[0];
  if (
    !Number.isFinite(length)
    || length <= 0
    || beam.support_type !== 'simply-supported'
    || !Number.isFinite(supportA)
    || !Number.isFinite(supportB)
    || Math.abs(supportA) > tolerance
    || Math.abs(supportB - length) > tolerance
    || loads.length !== 1
    || load.type !== 'point'
    || !Number.isFinite(load.P)
    || !Number.isFinite(load.x)
    || Math.abs((load.x ?? 0) - length / 2) > tolerance
    || !Number.isFinite(beam.youngs_modulus_gpa)
    || beam.youngs_modulus_gpa <= 0
    || !Number.isFinite(beam.inertia_cm4)
    || beam.inertia_cm4 <= 0
    || !Number.isFinite(beam.extreme_fibre_mm)
    || beam.extreme_fibre_mm <= 0
    || !Number.isFinite(summary.max_abs_moment_kNm)
    || !Number.isFinite(summary.max_abs_bending_stress_MPa)
    || !Number.isFinite(summary.max_abs_deflection_mm)
    || summary.max_abs_moment_kNm < 0
    || summary.max_abs_bending_stress_MPa < 0
    || summary.max_abs_deflection_mm < 0
  ) {
    return null;
  }

  const force = Math.abs(load.P ?? 0);
  const moment = force * length / 4;
  const flexuralRigidityKNm2 = beam.youngs_modulus_gpa * beam.inertia_cm4 * 0.01;
  const deflectionMm = force * length ** 3 / (48 * flexuralRigidityKNm2) * 1000;
  const stressMpa = moment * 100 * beam.extreme_fibre_mm / beam.inertia_cm4;
  const values: Array<Omit<HandCheckMetric, 'differencePercent' | 'solverBarPercent' | 'referenceBarPercent'>> = [
    { label: 'Peak bending moment', unit: 'kN·m', solverValue: summary.max_abs_moment_kNm, referenceValue: moment },
    { label: 'Peak flexural stress', unit: 'MPa', solverValue: summary.max_abs_bending_stress_MPa, referenceValue: stressMpa },
    { label: 'Peak deflection', unit: 'mm', solverValue: summary.max_abs_deflection_mm, referenceValue: deflectionMm }
  ];

  return {
    metrics: values.map(metric => {
      const difference = Math.abs(metric.solverValue - metric.referenceValue);
      const scale = Math.max(metric.solverValue, metric.referenceValue);
      return {
        ...metric,
        differencePercent: metric.referenceValue > 1e-12
          ? difference / metric.referenceValue * 100
          : null,
        solverBarPercent: scale > 0 ? metric.solverValue / scale * 100 : 0,
        referenceBarPercent: scale > 0 ? metric.referenceValue / scale * 100 : 0
      };
    })
  };
}
