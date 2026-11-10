import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { FailureVisualizationComponent } from './failure-visualization.component';
import { StructuralAudioFX } from './structural-audio-fx';
import type { FailureMode } from './failure-renderer';
import {
  StressTelemetryFrame,
  TelemetryConnectionState,
  TelemetryService
} from './telemetry.service';
import {
  calculateMaterialStress,
  type MaterialPreset
} from './material-analysis';

interface TelemetryAlert {
  level: StressTelemetryFrame['alert']['level'];
  message: string;
  timestamp: number;
}

@Component({
  selector: 'app-digital-twin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, FailureVisualizationComponent],
  templateUrl: './digital-twin.component.html'
})
export class DigitalTwinComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly telemetry = inject(TelemetryService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly subscriptions = new Subscription();
  private readonly audioFx = new StructuralAudioFX();

  materialPresets: MaterialPreset[] = [];
  selectedMaterialId = 'steel_a36';
  materialCatalogError = '';
  private customStrengthKind: MaterialPreset['strength_kind'] = 'yield';
  youngsModulusGpa = 200;
  poissonRatio = 0.26;
  yieldStrengthMpa = 250;
  warningFactorOfSafety = 1.3;
  loadScale = 1;
  connectionState: TelemetryConnectionState = 'disconnected';
  connectionError = '';
  historyError = '';
  currentFrame: StressTelemetryFrame | null = null;
  frames: StressTelemetryFrame[] = [];
  recentAlerts: TelemetryAlert[] = [];
  soundEnabled = false;
  soundError = '';

  ngOnInit(): void {
    this.subscriptions.add(this.telemetry.frames$.subscribe(frame => this.onFrame(frame)));
    this.subscriptions.add(this.telemetry.state$.subscribe(state => {
      this.connectionState = state;
      this.changeDetector.markForCheck();
    }));
    this.subscriptions.add(this.telemetry.error$.subscribe(error => {
      this.connectionError = error ?? '';
      this.changeDetector.markForCheck();
    }));

    this.connect();
    this.loadTelemetryHistory();
    this.subscriptions.add(this.http.get<MaterialPreset[]>('/api/materials').subscribe({
      next: presets => {
        this.materialPresets = presets;
        this.materialCatalogError = '';
        this.onMaterialPresetChange(this.selectedMaterialId);
      },
      error: () => {
        this.materialCatalogError = 'Could not load material presets. You can still enter material properties manually.';
        this.changeDetector.markForCheck();
      }
    }));
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.telemetry.disconnect();
    this.audioFx.dispose();
  }

  get liveStressRatio(): number {
    const frame = this.currentFrame;
    const yieldStrength = frame?.material.yield_strength_mpa;
    if (!frame || yieldStrength === null || yieldStrength === undefined || yieldStrength <= 0) return 0;
    return frame.material.von_mises_mpa / yieldStrength;
  }

  get liveFailureMode(): FailureMode {
    const materialId = this.selectedMaterialId.toLowerCase();
    return ['timber', 'wood', 'glass', 'cast_iron', 'brittle'].some(term => materialId.includes(term))
      ? 'brittle'
      : 'ductile';
  }

  async toggleSound(): Promise<void> {
    if (this.soundEnabled) {
      this.audioFx.disable();
      this.soundEnabled = false;
      this.soundError = '';
      return;
    }

    try {
      await this.audioFx.enable(this.liveStressRatio);
      this.soundEnabled = true;
      this.soundError = '';
      this.audioFx.updateStressRatio(this.liveStressRatio);
    } catch (error: unknown) {
      this.soundError = error instanceof Error ? error.message : 'Sound could not be enabled.';
    }
  }

  get hasValidSettings(): boolean {
    return Number.isFinite(this.youngsModulusGpa) && this.youngsModulusGpa > 0 && this.youngsModulusGpa <= 2000
      && Number.isFinite(this.poissonRatio) && this.poissonRatio > -1 && this.poissonRatio < 0.5
      && Number.isFinite(this.yieldStrengthMpa) && this.yieldStrengthMpa > 0 && this.yieldStrengthMpa <= 10000
      && Number.isFinite(this.warningFactorOfSafety) && this.warningFactorOfSafety > 1 && this.warningFactorOfSafety <= 10
      && Number.isFinite(this.loadScale) && this.loadScale >= 0 && this.loadScale <= 3;
  }

  get selectedMaterial(): MaterialPreset | null {
    return this.materialPresets.find(material => material.id === this.selectedMaterialId) ?? null;
  }

  get selectedMaterialName(): string {
    return this.selectedMaterial?.name ?? 'Custom material';
  }

  get strengthLabel(): string {
    return this.activeStrengthKind === 'bending-reference'
      ? 'Bending-strength reference'
      : 'Yield strength';
  }

  get activeStrengthKind(): MaterialPreset['strength_kind'] {
    return this.selectedMaterial?.strength_kind ?? this.customStrengthKind;
  }

  get safetyPath(): string {
    return this.trendPath(frame => Math.min(frame.material.factor_of_safety ?? 4, 4), 4);
  }

  get safetyThresholdY(): number {
    const threshold = this.currentFrame?.material.warning_factor_of_safety ?? this.warningFactorOfSafety;
    return 205 - (Math.min(threshold, 4) / 4) * 170;
  }

  get circleScale(): number {
    if (!this.currentFrame) return 1;
    const circle = this.currentFrame.mohrs_circle;
    return Math.min(
      225 / Math.max(Math.abs(circle.sigma_1_mpa), Math.abs(circle.sigma_2_mpa), 1e-9),
      120 / Math.max(circle.radius_mpa, 1e-9)
    );
  }

  circleX(normalStress: number): number {
    return 300 + normalStress * this.circleScale;
  }

  circleY(shearStress: number): number {
    return 165 - shearStress * this.circleScale;
  }

  connect(): void {
    if (!this.hasValidSettings) {
      this.connectionError = 'Check E, Poisson ratio, yield strength, and warning factor before connecting.';
      return;
    }
    this.telemetry.connect({
      youngsModulusGpa: this.youngsModulusGpa,
      poissonRatio: this.poissonRatio,
      yieldStrengthMpa: this.yieldStrengthMpa,
      warningFactorOfSafety: this.warningFactorOfSafety,
      loadScale: this.loadScale
    });
  }

  onMaterialPresetChange(materialId: string): void {
    this.selectedMaterialId = materialId;
    if (materialId === 'custom') {
      this.recalculateFrames();
      return;
    }
    const material = this.materialPresets.find(preset => preset.id === materialId);
    if (!material) {
      this.materialCatalogError = 'The selected material preset is not available.';
      return;
    }

    this.youngsModulusGpa = material.youngs_modulus_gpa;
    this.poissonRatio = material.poisson_ratio;
    this.yieldStrengthMpa = material.yield_strength_mpa;
    this.customStrengthKind = material.strength_kind;
    this.materialCatalogError = '';
    this.recalculateFrames();
  }

  onCustomMaterialChange(): void {
    this.selectedMaterialId = 'custom';
    this.recalculateFrames();
  }

  onCustomStrengthChange(): void {
    this.customStrengthKind = 'yield';
    this.onCustomMaterialChange();
  }

  recalculateFrames(): void {
    if (!this.hasValidSettings) return;
    this.frames = this.frames.map(frame => this.evaluateFrame(frame));
    this.currentFrame = this.frames.at(-1) ?? null;
    this.recentAlerts = this.alertTransitions(this.frames);
    this.changeDetector.markForCheck();
  }

  pause(): void {
    this.telemetry.disconnect();
  }

  exportHistory(): void {
    if (this.frames.length === 0) return;
    const headers = [
      'timestamp_ms', 'sequence', 'source', 'ex_micro', 'ey_micro', 'gamma_xy_micro',
      'sigma_x_mpa', 'sigma_y_mpa', 'tau_xy_mpa', 'sigma_1_mpa', 'sigma_2_mpa',
      'von_mises_mpa', 'factor_of_safety', 'alert_level'
    ];
    const lines = this.frames.map(frame => [
      frame.timestamp,
      frame.sequence,
      frame.source,
      frame.strain_input.ex_micro,
      frame.strain_input.ey_micro,
      frame.strain_input.gamma_xy_micro,
      frame.stress_tensor.sigma_x_mpa,
      frame.stress_tensor.sigma_y_mpa,
      frame.stress_tensor.tau_xy_mpa,
      frame.mohrs_circle.sigma_1_mpa,
      frame.mohrs_circle.sigma_2_mpa,
      frame.material.von_mises_mpa,
      frame.material.factor_of_safety ?? 'unbounded',
      frame.alert.level
    ].join(','));
    const blob = new Blob([[headers.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'beamlab-telemetry.csv';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 250);
  }

  private onFrame(frame: StressTelemetryFrame): void {
    const evaluatedFrame = this.evaluateFrame(frame);
    this.currentFrame = evaluatedFrame;
    this.frames = [...this.frames, evaluatedFrame].slice(-60);
    this.recentAlerts = this.alertTransitions(this.frames);
    if (this.soundEnabled) this.audioFx.updateStressRatio(this.liveStressRatio);
    this.changeDetector.markForCheck();
  }

  private loadTelemetryHistory(): void {
    this.http.get<{ frames: StressTelemetryFrame[] }>('/api/telemetry/history?limit=60').subscribe({
      next: response => {
        const merged = new Map<number, StressTelemetryFrame>();
        for (const frame of [...response.frames, ...this.frames]) {
          merged.set(frame.timestamp, this.evaluateFrame(frame));
        }
        this.frames = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-60);
        this.currentFrame = this.frames.at(-1) ?? this.currentFrame;
        this.recentAlerts = this.alertTransitions(this.frames);
        this.historyError = '';
        this.changeDetector.markForCheck();
      },
      error: () => {
        this.historyError = 'Saved samples could not be loaded.';
        this.changeDetector.markForCheck();
      }
    });
  }

  private evaluateFrame(frame: StressTelemetryFrame): StressTelemetryFrame {
    return {
      ...frame,
      ...calculateMaterialStress(
        frame.strain_input,
        {
          youngs_modulus_gpa: this.youngsModulusGpa,
          poisson_ratio: this.poissonRatio,
          yield_strength_mpa: this.yieldStrengthMpa,
          strength_kind: this.activeStrengthKind
        },
        this.warningFactorOfSafety
      )
    };
  }

  private trendPath(
    value: (frame: StressTelemetryFrame) => number,
    max: number,
    frames: StressTelemetryFrame[] = this.frames
  ): string {
    if (frames.length === 0) return '';
    const left = 44;
    const right = 696;
    const top = 35;
    const bottom = 205;
    return frames.map((frame, index) => {
      const x = left + index / Math.max(1, frames.length - 1) * (right - left);
      const y = bottom - Math.min(value(frame), max) / max * (bottom - top);
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
  }

  private alertTransitions(frames: StressTelemetryFrame[]): TelemetryAlert[] {
    let previousLevel: StressTelemetryFrame['alert']['level'] = 'NORMAL';
    const transitions: TelemetryAlert[] = [];
    for (const frame of frames) {
      if (frame.alert.level !== 'NORMAL' && frame.alert.level !== previousLevel) {
        transitions.push({
          level: frame.alert.level,
          message: frame.alert.message,
          timestamp: frame.timestamp
        });
      }
      previousLevel = frame.alert.level;
    }
    return transitions.reverse().slice(0, 5);
  }
}
