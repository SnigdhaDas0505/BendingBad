export interface MohrResults {
  center: number;
  radius: number;
  principalMajor: number;
  principalMinor: number;
  maxShear: number;
  principalAngle: number;
  normalAtAngle: number;
  shearAtAngle: number;
}

const mohrResultsCache = new Map<string, MohrResults>();

/** Fills a reusable stress buffer instead of allocating one object per station. */
export function calculateBendingStressProfile(
  momentsKNm: ArrayLike<number>,
  extremeFibreMm: number,
  inertiaCm4: number,
  target: Float64Array = new Float64Array(momentsKNm.length)
): Float64Array {
  if (target.length < momentsKNm.length) {
    throw new Error('Stress buffer is smaller than the moment profile.');
  }
  const factor = 100 * extremeFibreMm / inertiaCm4;
  for (let i = 0; i < momentsKNm.length; i++) {
    target[i] = momentsKNm[i] * factor;
  }
  return target;
}

export function calculateMohrResults(
  sigmaX: number,
  sigmaY: number,
  tauXY: number,
  planeAngleDeg: number
): MohrResults {
  const key = `${sigmaX}|${sigmaY}|${tauXY}|${planeAngleDeg}`;
  const cached = mohrResultsCache.get(key);
  if (cached) return cached;
  const center = (sigmaX + sigmaY) / 2;
  const halfDifference = (sigmaX - sigmaY) / 2;
  const radius = Math.hypot(halfDifference, tauXY);
  const angle = planeAngleDeg * Math.PI / 180;
  const result: MohrResults = Object.freeze({
    center,
    radius,
    principalMajor: center + radius,
    principalMinor: center - radius,
    maxShear: radius,
    principalAngle: 0.5 * Math.atan2(2 * tauXY, sigmaX - sigmaY) * 180 / Math.PI,
    normalAtAngle: center + halfDifference * Math.cos(2 * angle) + tauXY * Math.sin(2 * angle),
    shearAtAngle: -halfDifference * Math.sin(2 * angle) + tauXY * Math.cos(2 * angle)
  });
  mohrResultsCache.set(key, result);
  if (mohrResultsCache.size > 128) mohrResultsCache.delete(mohrResultsCache.keys().next().value!);
  return result;
}
