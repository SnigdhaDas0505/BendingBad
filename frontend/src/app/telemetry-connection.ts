import type { TelemetrySettings } from './telemetry.service';

export function createTelemetryWebSocketUrl(
  location: Pick<Location, 'protocol' | 'host'>,
  settings: TelemetrySettings
): URL {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL(`${protocol}//${location.host}/ws/telemetry`);
  url.searchParams.set('youngs_modulus_gpa', String(settings.youngsModulusGpa));
  url.searchParams.set('poisson_ratio', String(settings.poissonRatio));
  url.searchParams.set('yield_strength_mpa', String(settings.yieldStrengthMpa));
  url.searchParams.set('warning_factor_of_safety', String(settings.warningFactorOfSafety));
  url.searchParams.set('load_scale', String(settings.loadScale));
  return url;
}

export function telemetryReconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 15000);
}
