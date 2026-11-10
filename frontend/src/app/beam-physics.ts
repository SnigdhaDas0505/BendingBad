const SMALL_DEFLECTION_LIMIT = 0.35;

export const DEFAULT_BEAM_INTERVALS = 1000;

/** Reusable numeric storage for the beam response at every station. */
export interface BeamStationBuffers {
  x: Float64Array;
  shear: Float64Array;
  moment: Float64Array;
  slope: Float64Array;
  deflection: Float64Array;
}

const stationBufferCache = new Map<number, BeamStationBuffers>();

export function createBeamStationBuffers(intervals = DEFAULT_BEAM_INTERVALS): BeamStationBuffers {
  if (!Number.isInteger(intervals) || intervals < 1) {
    throw new Error('Beam intervals must be a positive integer.');
  }
  const stationCount = intervals + 1;
  return {
    x: new Float64Array(stationCount),
    shear: new Float64Array(stationCount),
    moment: new Float64Array(stationCount),
    slope: new Float64Array(stationCount),
    deflection: new Float64Array(stationCount)
  };
}

/** Gets stable, reusable storage for a given mesh size. Values are overwritten by callers. */
export function getBeamStationBuffers(intervals = DEFAULT_BEAM_INTERVALS): BeamStationBuffers {
  let buffers = stationBufferCache.get(intervals);
  if (!buffers) {
    buffers = createBeamStationBuffers(intervals);
    stationBufferCache.set(intervals, buffers);
  }
  return buffers;
}

export function clearBeamStationBufferCache(): void {
  stationBufferCache.clear();
}

export interface SectionProperties {
  inertiaCm4: number;
  extremeFibreMm: number;
  flexuralRigidityKNm2: number;
}

const sectionPropertyCache = new Map<string, SectionProperties>();

/** Memoized static section values; the key changes whenever a dimension/material input changes. */
export function getCachedSectionProperties(
  youngsModulusGpa: number,
  inertiaCm4: number,
  extremeFibreMm: number
): SectionProperties {
  const key = `${youngsModulusGpa}|${inertiaCm4}|${extremeFibreMm}`;
  const cached = sectionPropertyCache.get(key);
  if (cached) return cached;
  const properties = Object.freeze({
    inertiaCm4,
    extremeFibreMm,
    flexuralRigidityKNm2: flexuralRigidityKNm2(youngsModulusGpa, inertiaCm4)
  });
  sectionPropertyCache.set(key, properties);
  return properties;
}

export function clearSectionPropertyCache(): void {
  sectionPropertyCache.clear();
}

export function flexuralRigidityKNm2(youngsModulusGpa: number, inertiaCm4: number): number {
  return youngsModulusGpa * inertiaCm4 * 0.01;
}

export function bendingStressMpa(momentKNm: number, extremeFibreMm: number, inertiaCm4: number): number {
  return momentKNm * 100 * extremeFibreMm / inertiaCm4;
}

export function isWithinSmallDeflectionLimit(maxDeflectionMm: number, lengthM: number): boolean {
  const maximumDeflectionM = Math.abs(maxDeflectionMm) / 1000;
  const allowedDeflectionM = SMALL_DEFLECTION_LIMIT * lengthM;
  return Number.isFinite(maxDeflectionMm)
    && Number.isFinite(lengthM)
    && lengthM > 0
    && maximumDeflectionM <= allowedDeflectionM + Math.max(1e-12, allowedDeflectionM * 1e-12);
}

export function capVisualDeflections(
  deflectionsMm: readonly number[],
  maxPixels: number
): number[] {
  const maximum = Math.max(0, ...deflectionsMm.map(value => Math.abs(value)).filter(Number.isFinite));
  if (maximum === 0 || !Number.isFinite(maximum) || !Number.isFinite(maxPixels) || maxPixels <= 0) {
    return deflectionsMm.map(() => 0);
  }
  const pixelScale = Math.min(1, maxPixels / maximum);
  return deflectionsMm.map(value => Number.isFinite(value) ? value * pixelScale : 0);
}

export function formatEngineeringValue(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude > 0 && (magnitude < 0.01 || magnitude >= 1_000_000)) {
    return value.toExponential(fractionDigits);
  }
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: Math.min(1, fractionDigits)
  }).format(value);
}
