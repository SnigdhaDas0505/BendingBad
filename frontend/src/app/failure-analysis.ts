export interface BeamPoint {
  node: number;
  x_m: number;
  shear_kN: number;
  moment_kNm: number;
  slope_mrad: number;
  deflection_mm: number;
  curvature_per_m: number;
  stress_top_MPa: number;
  stress_bottom_MPa: number;
  strain_top_micro: number;
  strain_bottom_micro: number;
}

export interface FailureEstimate {
  point: BeamPoint;
  stressMpa: number;
  topState: 'tension' | 'compression';
  bottomState: 'tension' | 'compression';
}

export function isValidYieldStrength(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function findFailureEstimate(points: BeamPoint[]): FailureEstimate | null {
  let estimate: FailureEstimate | null = null;
  for (const point of points) {
    const stress = Math.max(Math.abs(point.stress_top_MPa), Math.abs(point.stress_bottom_MPa));
    if (!estimate || stress > estimate.stressMpa) {
      estimate = {
        point,
        stressMpa: stress,
        topState: point.stress_top_MPa >= 0 ? 'tension' : 'compression',
        bottomState: point.stress_bottom_MPa >= 0 ? 'tension' : 'compression'
      };
    }
  }
  return estimate;
}

export function isYieldLimitExceeded(estimate: FailureEstimate | null, yieldStrengthMpa: number): boolean {
  return isValidYieldStrength(yieldStrengthMpa)
    && !!estimate
    && estimate.stressMpa >= yieldStrengthMpa;
}

export function getYieldUtilizationPercent(
  estimate: FailureEstimate | null,
  yieldStrengthMpa: number
): number {
  if (!isValidYieldStrength(yieldStrengthMpa) || !estimate) return 0;
  return Math.min(100, estimate.stressMpa / yieldStrengthMpa * 100);
}

export function getLoadFactorToFirstYield(
  estimate: FailureEstimate | null,
  yieldStrengthMpa: number
): number | null {
  if (!isValidYieldStrength(yieldStrengthMpa) || !estimate || estimate.stressMpa <= 1e-9) {
    return null;
  }
  return yieldStrengthMpa / estimate.stressMpa;
}

export function getFailureStatusLabel(
  estimate: FailureEstimate | null,
  yieldStrengthMpa: number
): string {
  if (!isValidYieldStrength(yieldStrengthMpa)) return 'Enter a valid yield limit';
  if (!estimate) return 'Awaiting analysis';
  if (estimate.stressMpa <= 1e-9) return 'No bending stress';
  return isYieldLimitExceeded(estimate, yieldStrengthMpa) ? 'First-yield limit exceeded' : 'Below first yield';
}
