import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BeamProfileComponent } from './beam-profile.component';
import {
  bendingStressMpa,
  formatEngineeringValue,
  getCachedSectionProperties,
  isWithinSmallDeflectionLimit
} from './beam-physics';
import { REAL_WORLD_BEAM_PRESETS, instantiateBeamPreset, resetState } from './beam-presets';
import { DigitalTwinComponent } from './digital-twin.component';
import { FailureVisualizationComponent } from './failure-visualization.component';
import { Object3DVisualizationComponent } from './object-3d-visualization.component';
import type { FailureMode } from './failure-renderer';
import type { ObjectSkin } from './object-skin-renderer';
import {
  calculateInternalForcesAtSection,
  interpolateBeamPoint,
  type BeamAnalysisContext
} from './beam-profile';
import { calculateMidspanPointLoadHandCheck, type MidspanPointLoadHandCheck } from './beam-validation';
import {
  findFailureEstimate,
  getLoadFactorToFirstYield,
  isValidYieldStrength,
  isYieldLimitExceeded as doesYieldLimitExceed,
  type BeamPoint,
  type FailureEstimate
} from './failure-analysis';
import { calculateMohrResults, type MohrResults } from './stress-analysis';

export interface BeamProperties {
  length_m: number;
  youngs_modulus_gpa: number;
  inertia_cm4: number;
  extreme_fibre_mm: number;
  support_type: SupportType;
  support_a_m: number;
  support_b_m: number;
  intervals: number;
}

type SupportType =
  | 'simply-supported'
  | 'cantilever-left'
  | 'cantilever-right'
  | 'fixed-fixed'
  | 'propped-cantilever'
  | 'overhang';

export type BeamLoad =
  | { id: number; type: 'point'; P: number; x: number }
  | { id: number; type: 'udl'; w1: number; w2: number; x1: number; x2: number }
  | { id: number; type: 'moment'; M: number; x: number };

export interface AnalysisResult {
  intervals: number;
  station_count: number;
  dx_m: number;
  EI_kNm2: number;
  reactions: { RA_kN: number; RB_kN: number; MA_kNm: number; MB_kNm: number };
  integration_constants: { C1_rad: number; C2_m: number };
  boundary_conditions: string;
  summary: {
    max_abs_shear_kN: number; max_shear_at_m: number;
    max_abs_moment_kNm: number; max_moment_at_m: number;
    max_abs_deflection_mm: number; max_deflection_at_m: number;
    max_abs_slope_mrad: number; max_slope_at_m: number;
    max_abs_bending_stress_MPa: number; max_stress_at_m: number;
    max_abs_bending_strain_micro: number; max_strain_at_m: number;
  };
  points: BeamPoint[];
}

type LoadKind = 'point' | 'udl' | 'moment';
type SectionShape = 'manual' | 'rectangle' | 'circle' | 'pipe';
type PlotKey = 'shear_kN' | 'moment_kNm' | 'stress_top_MPa' | 'deflection_mm';

interface PlotModel {
  path: string;
  zeroY: number;
  min: number;
  max: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, BeamProfileComponent, DigitalTwinComponent, FailureVisualizationComponent, Object3DVisualizationComponent],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly changeDetector = inject(ChangeDetectorRef);

  activeWorkspace: 'beam' | 'mohr' | 'twin' = 'beam';
  activeInputPanel: 'material' | 'supports' | 'loads' = 'material';
  sigmaX = 80;
  sigmaY = 20;
  tauXY = 30;
  planeAngleDeg = 25;

  beam: BeamProperties = {
    length_m: 6,
    youngs_modulus_gpa: 200,
    inertia_cm4: 5000,
    extreme_fibre_mm: 100,
    support_type: 'simply-supported',
    support_a_m: 0,
    support_b_m: 6,
    intervals: 1000
  };

  loads: BeamLoad[] = [{ id: 1, type: 'point', P: 20, x: 3 }];
  nextLoadId = 2;
  newLoadType: LoadKind = 'point';
  classicPresetChoice = '';
  activeObjectPresetId = '';
  readonly realWorldPresets = REAL_WORLD_BEAM_PRESETS;
  failureMode: FailureMode = 'ductile';
  objectSkin: ObjectSkin = 'beam';
  deflectionProfile: number[] = [];
  sectionShape: SectionShape = 'manual';
  materialPreset = '200';
  yieldStrengthMpa = 250;
  sectionWidthMm = 100;
  sectionHeightMm = 200;
  sectionDiameterMm = 150;
  pipeOuterDiameterMm = 160;
  pipeThicknessMm = 10;
  pointForce = 20;
  pointPosition = 3;
  udlStart = 0;
  udlEnd = 6;
  udlStartIntensity = 10;
  udlEndIntensity = 10;
  appliedMoment = 15;
  momentPosition = 3;
  activeX = 3;
  loading = false;
  private analysisGeneration = 0;
  private inspectIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private inspectingBeam = false;
  private readonly analysisCache = new Map<string, AnalysisResult>();
  private mohrCacheKey = '';
  private cachedMohrResults: MohrResults | null = null;
  errorMessage = '';
  result: AnalysisResult | null = null;
  beamAnalysisContext: BeamAnalysisContext | null = null;
  failureEstimate: FailureEstimate | null = null;
  activeTab: 'plots' | 'table' | 'theory' = 'plots';
  plots: Record<'shear' | 'moment' | 'stress' | 'deflection', PlotModel> = {
    shear: { path: '', zeroY: 70, min: 0, max: 0 },
    moment: { path: '', zeroY: 70, min: 0, max: 0 },
    stress: { path: '', zeroY: 70, min: 0, max: 0 },
    deflection: { path: '', zeroY: 70, min: 0, max: 0 }
  };
  readonly supportOptions: { value: SupportType; label: string }[] = [
    { value: 'simply-supported', label: 'Simply supported · pin + roller' },
    { value: 'cantilever-left', label: 'Cantilever · fixed left' },
    { value: 'cantilever-right', label: 'Cantilever · fixed right' },
    { value: 'fixed-fixed', label: 'Fixed at both ends' },
    { value: 'propped-cantilever', label: 'Propped cantilever' },
    { value: 'overhang', label: 'Overhanging · custom supports' }
  ];

  ngOnInit(): void {
    this.analyze();
  }

  ngOnDestroy(): void {
    if (this.inspectIdleTimer !== null) clearTimeout(this.inspectIdleTimer);
  }

  get inspectedPoint(): BeamPoint | null {
    if (!this.result) return null;
    const point = interpolateBeamPoint(this.result.points, this.activeX);
    const forces = calculateInternalForcesAtSection(
      this.beam,
      this.loads.map(load => ({ ...load })),
      this.result.reactions,
      this.activeX
    );
    const section = getCachedSectionProperties(
      this.beam.youngs_modulus_gpa,
      this.beam.inertia_cm4,
      this.beam.extreme_fibre_mm
    );
    const flexuralRigidity = section.flexuralRigidityKNm2;
    const stressTop = -bendingStressMpa(forces.moment_kNm, section.extremeFibreMm, section.inertiaCm4);
    const stressBottom = -stressTop;
    return {
      ...point,
      ...forces,
      curvature_per_m: forces.moment_kNm / flexuralRigidity,
      stress_top_MPa: stressTop,
      stress_bottom_MPa: stressBottom,
      strain_top_micro: stressTop / (this.beam.youngs_modulus_gpa * 1000) * 1e6,
      strain_bottom_micro: stressBottom / (this.beam.youngs_modulus_gpa * 1000) * 1e6
    };
  }

  get beamDeflectionPath(): string {
    if (!this.result) return '';
    const pts = this.result.points;
    const maxDeflection = Math.max(0.000001, this.result.summary.max_abs_deflection_mm);
    const scale = 56 / maxDeflection;
    const stride = this.inspectingBeam ? Math.max(1, Math.ceil((pts.length - 1) / 80)) : 1;
    const path: string[] = [];
    for (let i = 0; i < pts.length; i += stride) {
      const point = pts[i];
      path.push(`${path.length === 0 ? 'M' : 'L'} ${this.beamX(point.x_m).toFixed(2)} ${(158 - point.deflection_mm * scale).toFixed(2)}`);
    }
    const last = pts[pts.length - 1];
    if ((pts.length - 1) % stride !== 0) {
      path.push(`L ${this.beamX(last.x_m).toFixed(2)} ${(158 - last.deflection_mm * scale).toFixed(2)}`);
    }
    return path.join(' ');
  }

  get activeMarkerY(): number {
    const point = this.inspectedPoint;
    if (!point || !this.result) return 158;
    const maxDeflection = Math.max(0.000001, this.result.summary.max_abs_deflection_mm);
    const scale = 56 / maxDeflection;
    return 158 - point.deflection_mm * scale;
  }

  get isYieldStrengthValid(): boolean {
    return isValidYieldStrength(this.yieldStrengthMpa);
  }

  get isYieldLimitExceeded(): boolean {
    return doesYieldLimitExceed(this.failureEstimate, this.yieldStrengthMpa);
  }

  get loadFactorToFirstYield(): number | null {
    return getLoadFactorToFirstYield(this.failureEstimate, this.yieldStrengthMpa);
  }

  get beamSafetyFactor(): number | null {
    if (!this.isYieldStrengthValid || !this.result) return null;
    const stress = this.result.summary.max_abs_bending_stress_MPa;
    return stress > 1e-9 ? this.yieldStrengthMpa / stress : null;
  }

  get yieldUtilizationPercent(): number {
    if (!this.failureEstimate || !this.isYieldStrengthValid) return 0;
    return Math.max(0, Math.min(100, this.failureEstimate.stressMpa / this.yieldStrengthMpa * 100));
  }

  get beamSafetyState(): 'safe' | 'warning' | 'critical' | 'unavailable' {
    if (this.beamSafetyFactor === null) return this.isYieldStrengthValid ? 'safe' : 'unavailable';
    if (this.beamSafetyFactor <= 1) return 'critical';
    if (this.beamSafetyFactor < 1.3) return 'warning';
    return 'safe';
  }

  get failurePreviewAvailable(): boolean {
    return this.isYieldStrengthValid
      && !!this.failureEstimate
      && this.failureEstimate.stressMpa > 1e-9;
  }

  get failureStressRatio(): number {
    if (this.loading || !this.isYieldStrengthValid || !this.failureEstimate) return 0;
    return this.failureEstimate.stressMpa / this.yieldStrengthMpa;
  }

  get failureLocationRatio(): number {
    if (!this.failureEstimate || this.beam.length_m <= 0) return 0.5;
    return this.failureEstimate.point.x_m / this.beam.length_m;
  }

  get strengthLimitLabel(): string {
    return this.failureMode === 'brittle' ? 'Bending strength reference' : 'Yield strength';
  }

  get smallDeflectionLimitExceeded(): boolean {
    return !this.loading && !!this.result && !isWithinSmallDeflectionLimit(
      this.result.summary.max_abs_deflection_mm,
      this.beam.length_m
    );
  }

  get canPushPresetToFailure(): boolean {
    return !this.loading
      && this.objectSkin !== 'beam'
      && !this.isYieldLimitExceeded
      && this.loadFactorToFirstYield !== null
      && Number.isFinite(this.loadFactorToFirstYield);
  }

  get activeObjectPresetName(): string {
    return this.realWorldPresets.find(preset => preset.id === this.activeObjectPresetId)?.name ?? 'Object bend test';
  }

  formatValue(value: number, fractionDigits = 2): string {
    return formatEngineeringValue(value, fractionDigits);
  }

  pushPresetToFailure(): void {
    const factor = this.loadFactorToFirstYield;
    if (!this.canPushPresetToFailure || factor === null || factor <= 1) return;
    const failurePreviewFactor = factor * 1.05;
    this.loads = this.loads.map(load => {
      if (load.type === 'point') return { ...load, P: load.P * failurePreviewFactor };
      if (load.type === 'udl') return { ...load, w1: load.w1 * failurePreviewFactor, w2: load.w2 * failurePreviewFactor };
      return { ...load, M: load.M * failurePreviewFactor };
    });
    this.analyze();
  }

  get beamBaselinePath(): string {
    return `M ${this.beamX(0)} 158 L ${this.beamX(this.beam.length_m)} 158`;
  }

  get activeSvgX(): number {
    return this.beamX(this.activeX);
  }

  get activeNode(): number {
    return this.inspectedPoint?.node ?? 0;
  }

  get mohrInputsValid(): boolean {
    return [this.sigmaX, this.sigmaY, this.tauXY, this.planeAngleDeg].every(Number.isFinite);
  }

  get mohrResults(): MohrResults {
    const key = `${this.sigmaX}|${this.sigmaY}|${this.tauXY}|${this.planeAngleDeg}`;
    if (key !== this.mohrCacheKey || !this.cachedMohrResults) {
      this.mohrCacheKey = key;
      this.cachedMohrResults = calculateMohrResults(this.sigmaX, this.sigmaY, this.tauXY, this.planeAngleDeg);
    }
    return this.cachedMohrResults;
  }

  get handCheck(): MidspanPointLoadHandCheck | null {
    if (!this.result) return null;
    return calculateMidspanPointLoadHandCheck(this.beam, this.loads, this.result.summary);
  }

  get mohrScale(): number {
    const results = this.mohrResults;
    const maxNormal = Math.max(Math.abs(results.principalMajor), Math.abs(results.principalMinor), 1e-9);
    const maxShear = Math.max(results.radius, 1e-9);
    return Math.min(270 / maxNormal, 165 / maxShear);
  }

  mohrX(normalStress: number): number {
    return 360 + normalStress * this.mohrScale;
  }

  mohrY(shearStress: number): number {
    return 220 - shearStress * this.mohrScale;
  }

  useBeamInspectorStress(): void {
    const point = this.inspectedPoint;
    if (!point) return;
    this.sigmaX = point.stress_top_MPa;
    this.sigmaY = 0;
    this.tauXY = 0;
    this.planeAngleDeg = 0;
    this.activeWorkspace = 'mohr';
  }

  get hasCustomSupportPositions(): boolean {
    return this.beam.support_type === 'simply-supported' || this.beam.support_type === 'overhang';
  }

  analyze(): void {
    const generation = ++this.analysisGeneration;
    this.clampInputs();
    this.loading = true;
    this.errorMessage = '';
    this.result = null;
    this.failureEstimate = null;
    this.beamAnalysisContext = null;
    this.deflectionProfile = [];
    const payload = {
      ...this.beam,
      loads: this.loads.map(load => {
        if (load.type === 'point') return { type: 'point', P: load.P, x: load.x };
        if (load.type === 'udl') return { type: 'udl', w1: load.w1, w2: load.w2, x1: load.x1, x2: load.x2 };
        return { type: 'moment', M: load.M, x: load.x };
      })
    };
    const cacheKey = JSON.stringify(payload);
    const cached = this.analysisCache.get(cacheKey);
    if (cached) {
      this.result = cached;
      this.deflectionProfile = cached.points.map(point => point.deflection_mm);
      this.syncBeamAnalysisContext();
      this.failureEstimate = findFailureEstimate(cached.points);
      this.loading = false;
      this.activeX = Math.max(0, Math.min(this.beam.length_m, this.activeX));
      this.buildPlots();
      this.changeDetector.markForCheck();
      return;
    }
    this.http.post<AnalysisResult>('/api/analyze', payload).subscribe({
      next: response => {
        if (generation !== this.analysisGeneration) return;
        this.analysisCache.set(cacheKey, response);
        if (this.analysisCache.size > 8) this.analysisCache.delete(this.analysisCache.keys().next().value!);
        this.result = response;
        this.deflectionProfile = response.points.map(point => point.deflection_mm);
        this.syncBeamAnalysisContext();
        this.failureEstimate = findFailureEstimate(response.points);
        this.loading = false;
        this.activeX = Math.max(0, Math.min(this.beam.length_m, this.activeX));
        this.buildPlots();
        this.changeDetector.markForCheck();
      },
      error: error => {
        if (generation !== this.analysisGeneration) return;
        this.beamAnalysisContext = null;
        this.loading = false;
        const detail = error?.error?.detail;
        this.errorMessage = typeof detail === 'string'
          ? detail
          : Array.isArray(detail) && detail.length > 0
            ? String(detail[0]?.msg ?? 'Check the beam and load values.')
            : 'The analysis service could not be reached. Start the Python API on port 8000 and try again.';
        this.changeDetector.markForCheck();
      }
    });
  }

  private clampInputs(): void {
    this.beam.length_m = Math.max(0.1, Number(this.beam.length_m) || 6);
    this.beam.youngs_modulus_gpa = Math.max(0.001, Number(this.beam.youngs_modulus_gpa) || 200);
    this.beam.inertia_cm4 = Math.max(1e-12, Number(this.beam.inertia_cm4) || 5000);
    this.beam.extreme_fibre_mm = Math.max(0.001, Number(this.beam.extreme_fibre_mm) || 100);
    this.beam.support_a_m = Math.max(0, Math.min(this.beam.length_m, Number(this.beam.support_a_m) || 0));
    this.beam.support_b_m = Math.max(0, Math.min(this.beam.length_m, Number(this.beam.support_b_m) || this.beam.length_m));
    if (this.beam.support_b_m <= this.beam.support_a_m && this.hasCustomSupportPositions) {
      this.beam.support_a_m = 0;
      this.beam.support_b_m = this.beam.length_m;
    }
  }

  onLengthChange(): void {
    if (this.beam.support_type === 'simply-supported') {
      this.beam.support_a_m = 0;
      this.beam.support_b_m = this.beam.length_m;
    } else if (this.beam.support_type === 'overhang') {
      this.beam.support_a_m = Math.min(this.beam.support_a_m, this.beam.length_m - 0.1);
      this.beam.support_b_m = Math.min(this.beam.support_b_m, this.beam.length_m);
    }
    this.udlEnd = Math.min(this.udlEnd, this.beam.length_m);
    this.pointPosition = Math.min(this.pointPosition, this.beam.length_m);
    this.momentPosition = Math.min(this.momentPosition, this.beam.length_m);
    this.loads = this.loads.map(load => {
      if (load.type === 'point' || load.type === 'moment') return { ...load, x: Math.min(load.x, this.beam.length_m) };
      return { ...load, x1: Math.min(load.x1, this.beam.length_m - 0.01), x2: Math.min(load.x2, this.beam.length_m) };
    });
    this.activeX = Math.min(this.activeX, this.beam.length_m);
    this.analyze();
  }

  onMaterialPresetChange(): void {
    if (this.materialPreset === 'custom') return;
    this.beam.youngs_modulus_gpa = Number(this.materialPreset);
    this.failureMode = ['12', '30'].includes(this.materialPreset) ? 'brittle' : 'ductile';
    this.objectSkin = 'beam';
    this.activeObjectPresetId = '';
    this.analyze();
  }

  onYoungsModulusChange(): void {
    this.materialPreset = 'custom';
    this.analyze();
  }

  onYieldStrengthChange(): void {
    this.syncBeamAnalysisContext();
  }

  selectProfilePosition(positionM: number): void {
    this.activeX = Math.max(0, Math.min(this.beam.length_m, positionM));
  }

  private syncBeamAnalysisContext(): void {
    if (!this.result) {
      this.beamAnalysisContext = null;
      return;
    }
    this.beamAnalysisContext = {
      beam: { ...this.beam },
      loads: this.loads.map(load => ({ ...load })),
      yieldStrengthMpa: this.yieldStrengthMpa,
      points: this.result.points
    };
  }

  applySectionShape(): void {
    if (this.sectionShape === 'manual') return;
    let inertiaMm4 = 0;
    let extremeFibre = 0;
    if (this.sectionShape === 'rectangle') {
      const b = Math.max(0.1, Number(this.sectionWidthMm));
      const h = Math.max(0.1, Number(this.sectionHeightMm));
      inertiaMm4 = b * h ** 3 / 12;
      extremeFibre = h / 2;
    } else if (this.sectionShape === 'circle') {
      const d = Math.max(0.1, Number(this.sectionDiameterMm));
      inertiaMm4 = Math.PI * d ** 4 / 64;
      extremeFibre = d / 2;
    } else {
      const D = Math.max(0.2, Number(this.pipeOuterDiameterMm));
      const t = Math.max(0.1, Math.min(Number(this.pipeThicknessMm), D / 2));
      const d = Math.max(0, D - 2 * t);
      inertiaMm4 = Math.PI * (D ** 4 - d ** 4) / 64;
      extremeFibre = D / 2;
    }
    this.beam.inertia_cm4 = inertiaMm4 / 10000;
    this.beam.extreme_fibre_mm = extremeFibre;
    this.analyze();
  }

  onSupportChange(): void {
    if (this.beam.support_type === 'simply-supported') {
      this.beam.support_a_m = 0;
      this.beam.support_b_m = this.beam.length_m;
    } else if (this.beam.support_type === 'overhang') {
      this.beam.support_a_m = 0;
      this.beam.support_b_m = Number((this.beam.length_m * 0.75).toFixed(2));
    } else {
      this.beam.support_a_m = 0;
      this.beam.support_b_m = this.beam.length_m;
    }
    this.analyze();
  }

  addLoad(): void {
    const L = this.beam.length_m;
    if (this.newLoadType === 'point') {
      if (this.pointPosition < 0 || this.pointPosition > L) {
        this.errorMessage = 'Point-load position must lie within the beam span.';
        return;
      }
      this.loads = [...this.loads, { id: this.nextLoadId++, type: 'point', P: Number(this.pointForce), x: Number(this.pointPosition) }];
    } else if (this.newLoadType === 'udl') {
      const x1 = Math.min(Number(this.udlStart), Number(this.udlEnd));
      const x2 = Math.max(Number(this.udlStart), Number(this.udlEnd));
      if (x1 < 0 || x2 > L || x2 - x1 < 0.001) {
        this.errorMessage = 'A distributed load needs a positive interval inside the beam span.';
        return;
      }
      this.loads = [...this.loads, {
        id: this.nextLoadId++, type: 'udl',
        w1: Number(this.udlStart) <= Number(this.udlEnd) ? Number(this.udlStartIntensity) : Number(this.udlEndIntensity),
        w2: Number(this.udlStart) <= Number(this.udlEnd) ? Number(this.udlEndIntensity) : Number(this.udlStartIntensity),
        x1, x2
      }];
    } else {
      if (this.momentPosition < 0 || this.momentPosition > L) {
        this.errorMessage = 'Moment position must lie within the beam span.';
        return;
      }
      this.loads = [...this.loads, { id: this.nextLoadId++, type: 'moment', M: Number(this.appliedMoment), x: Number(this.momentPosition) }];
    }
    this.analyze();
  }

  removeLoad(id: number): void {
    this.loads = this.loads.filter(load => load.id !== id);
    this.analyze();
  }

  loadDescription(load: BeamLoad): string {
    if (load.type === 'point') return `${this.displayForceLoad(load.P)} at ${load.x.toFixed(2)} m`;
    if (load.type === 'udl') {
      return `${this.displayDistributedLoad(load.w1)} → ${this.displayDistributedLoad(load.w2)} · ${load.x1.toFixed(2)}–${load.x2.toFixed(2)} m`;
    }
    return `${this.displayMomentLoad(load.M)} at ${load.x.toFixed(2)} m`;
  }

  displayForceLoad(forceKN: number): string {
    const objectLoad = !!this.activeObjectPresetId;
    return `${this.formatLoadNumber(forceKN * (objectLoad ? 1000 : 1))} ${objectLoad ? 'N' : 'kN'}`;
  }

  displayDistributedLoad(loadKNPerM: number): string {
    const objectLoad = !!this.activeObjectPresetId;
    return `${this.formatLoadNumber(loadKNPerM * (objectLoad ? 1000 : 1))} ${objectLoad ? 'N/m' : 'kN/m'}`;
  }

  displayMomentLoad(momentKNm: number): string {
    const objectLoad = !!this.activeObjectPresetId;
    return `${this.formatLoadNumber(momentKNm * (objectLoad ? 1000 : 1))} ${objectLoad ? 'N·m' : 'kN·m'}`;
  }

  private formatLoadNumber(value: number): string {
    return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 }).format(value);
  }

  applyPreset(name: string): void {
    if (!name) {
      this.reset();
      return;
    }

    const realWorldPreset = this.realWorldPresets.find(preset => preset.id === name);
    resetState({ beam: this.beam, loads: this.loads });
    if (realWorldPreset) {
      const instance = instantiateBeamPreset(realWorldPreset);
      this.beam = instance.beam;
      this.loads = instance.loads;
      this.nextLoadId = Math.max(1, ...this.loads.map(load => load.id)) + 1;
      this.yieldStrengthMpa = realWorldPreset.yieldStrengthMpa;
      this.materialPreset = 'custom';
      this.sectionShape = 'manual';
      this.failureMode = realWorldPreset.failureMode;
      this.objectSkin = realWorldPreset.objectSkin;
      this.activeObjectPresetId = realWorldPreset.id;
      this.classicPresetChoice = '';
      this.activeX = this.beam.length_m / 2;
      this.syncLoadEditorFromActiveLoad();
      this.analyze();
      return;
    }

    this.classicPresetChoice = name;
    this.activeObjectPresetId = '';
    this.objectSkin = 'beam';
    this.failureMode = 'ductile';
    this.materialPreset = '200';
    this.yieldStrengthMpa = 250;
    this.sectionShape = 'manual';
    this.beam.youngs_modulus_gpa = 200;
    this.beam.inertia_cm4 = 5000;
    this.beam.extreme_fibre_mm = 100;
    const L = 6;
    this.beam.length_m = L;
    this.beam.support_a_m = 0;
    this.beam.support_b_m = L;
    if (name === 'centre') {
      this.beam.support_type = 'simply-supported';
      this.loads = [{ id: 1, type: 'point', P: 20, x: 3 }];
    } else if (name === 'udl') {
      this.beam.support_type = 'simply-supported';
      this.loads = [{ id: 1, type: 'udl', w1: 10, w2: 10, x1: 0, x2: 6 }];
    } else if (name === 'cantilever') {
      this.beam.length_m = 4;
      this.beam.support_b_m = 4;
      this.beam.support_type = 'cantilever-left';
      this.loads = [{ id: 1, type: 'point', P: 15, x: 4 }];
    } else if (name === 'fixed') {
      this.beam.support_type = 'fixed-fixed';
      this.loads = [{ id: 1, type: 'udl', w1: 12, w2: 12, x1: 0, x2: 6 }];
    } else if (name === 'overhang') {
      this.beam.length_m = 8;
      this.beam.support_type = 'overhang';
      this.beam.support_b_m = 6;
      this.loads = [{ id: 1, type: 'point', P: 10, x: 8 }];
    } else if (name === 'two-point') {
      this.beam.support_type = 'simply-supported';
      this.loads = [
        { id: 1, type: 'point', P: 15, x: 2 },
        { id: 2, type: 'point', P: 15, x: 4 }
      ];
    }
    this.nextLoadId = Math.max(1, ...this.loads.map(load => load.id)) + 1;
    this.activeX = this.beam.length_m / 2;
    this.syncLoadEditorFromActiveLoad();
    this.analyze();
  }

  reset(): void {
    this.classicPresetChoice = '';
    this.activeObjectPresetId = '';
    this.failureMode = 'ductile';
    this.objectSkin = 'beam';
    this.materialPreset = '200';
    this.sectionShape = 'manual';
    this.beam = {
      length_m: 6, youngs_modulus_gpa: 200, inertia_cm4: 5000,
      extreme_fibre_mm: 100, support_type: 'simply-supported',
      support_a_m: 0, support_b_m: 6, intervals: 1000
    };
    this.yieldStrengthMpa = 250;
    this.loads = [{ id: 1, type: 'point', P: 20, x: 3 }];
    this.nextLoadId = 2;
    this.activeX = 3;
    this.syncLoadEditorFromActiveLoad();
    this.analyze();
  }

  private syncLoadEditorFromActiveLoad(): void {
    const load = this.loads[0];
    if (!load) return;
    this.newLoadType = load.type;
    if (load.type === 'point') {
      this.pointForce = load.P;
      this.pointPosition = load.x;
    } else if (load.type === 'udl') {
      this.udlStart = load.x1;
      this.udlEnd = load.x2;
      this.udlStartIntensity = load.w1;
      this.udlEndIntensity = load.w2;
    } else {
      this.appliedMoment = load.M;
      this.momentPosition = load.x;
    }
  }

  onBeamPointerMove(event: PointerEvent): void {
    this.setInspecting(true);
    this.setSectionFromPointer(event);
  }

  onBeamPointerDown(event: PointerEvent): void {
    this.setInspecting(true);
    this.setSectionFromPointer(event);
  }

  onBeamKeydown(event: KeyboardEvent): void {
    const step = this.beam.length_m / 100;
    if (event.key === 'ArrowLeft') this.activeX -= step;
    else if (event.key === 'ArrowRight') this.activeX += step;
    else if (event.key === 'Home') this.activeX = 0;
    else if (event.key === 'End') this.activeX = this.beam.length_m;
    else return;
    this.activeX = Math.max(0, Math.min(this.beam.length_m, this.activeX));
    event.preventDefault();
  }

  private setSectionFromPointer(event: PointerEvent): void {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const viewX = (event.clientX - rect.left) / rect.width * 1000;
    const ratio = (viewX - 70) / 860;
    this.activeX = Math.max(0, Math.min(this.beam.length_m, ratio * this.beam.length_m));
  }

  private setInspecting(active: boolean): void {
    this.inspectingBeam = active;
    if (this.inspectIdleTimer !== null) clearTimeout(this.inspectIdleTimer);
    this.inspectIdleTimer = setTimeout(() => {
      this.inspectingBeam = false;
      this.inspectIdleTimer = null;
      this.changeDetector.markForCheck();
    }, 140);
  }

  private beamX(x: number): number {
    return 70 + (x / this.beam.length_m) * 860;
  }

  supportIsFixedAtLeft(): boolean {
    return this.beam.support_type === 'cantilever-left'
      || this.beam.support_type === 'fixed-fixed'
      || this.beam.support_type === 'propped-cantilever';
  }

  supportIsFixedAtRight(): boolean {
    return this.beam.support_type === 'cantilever-right' || this.beam.support_type === 'fixed-fixed';
  }

  supportIsPinRoller(): boolean {
    return this.beam.support_type === 'simply-supported' || this.beam.support_type === 'overhang';
  }

  getLoadKind(load: BeamLoad): string {
    return load.type === 'point' ? 'POINT' : load.type === 'udl' ? 'DISTRIBUTED' : 'MOMENT';
  }

  private buildPlots(): void {
    if (!this.result) return;
    this.plots = {
      shear: this.buildPlot('shear_kN'),
      moment: this.buildPlot('moment_kNm'),
      stress: this.buildPlot('stress_top_MPa'),
      deflection: this.buildPlot('deflection_mm')
    };
  }

  private buildPlot(key: PlotKey): PlotModel {
    const points = this.result?.points ?? [];
    const values = points.map(point => point[key]);
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (Math.abs(max - min) < 1e-9) { min = -1; max = 1; }
    const span = Math.max(1e-9, max - min);
    const xPad = 24;
    const yPad = 12;
    const width = 500;
    const height = 140;
    const plotHeight = height - 2 * yPad;
    const path = points.map((point, index) => {
      const px = xPad + (point.x_m / this.beam.length_m) * (width - 2 * xPad);
      const py = yPad + ((max - values[index]) / span) * plotHeight;
      return `${index === 0 ? 'M' : 'L'} ${px.toFixed(2)} ${py.toFixed(2)}`;
    }).join(' ');
    const zeroY = yPad + (max / span) * plotHeight;
    return { path, zeroY, min, max };
  }

  get activePlotX(): number {
    return 24 + (this.activeX / this.beam.length_m) * 452;
  }

  exportCsv(): void {
    if (!this.result) return;
    const headers = [
      'node', 'x_m', 'shear_kN', 'moment_kNm', 'slope_mrad', 'deflection_mm',
      'curvature_per_m', 'stress_top_MPa', 'stress_bottom_MPa',
      'strain_top_micro', 'strain_bottom_micro'
    ];
    const lines = this.result.points.map(point => headers.map(header => {
      const value = point[header as keyof BeamPoint];
      return typeof value === 'number' ? value.toFixed(8) : value;
    }).join(','));
    const csv = [headers.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `beamlab-${this.beam.support_type}-${this.beam.length_m}m.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
  }

  trackByLoad(_index: number, load: BeamLoad): number {
    return load.id;
  }
}
