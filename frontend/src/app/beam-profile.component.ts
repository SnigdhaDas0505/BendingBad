import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import {
  createBeamProfile,
  interpolateBeamPoint,
  type BeamAnalysisContext,
  type BeamProfileSample
} from './beam-profile';
import { isValidYieldStrength } from './failure-analysis';
import { factorOfSafetyColor } from './material-analysis';

interface BeamStressSample extends BeamProfileSample {
  stressMpa: number;
  factorOfSafety: number | null;
  color: string;
}

@Component({
  selector: 'app-beam-profile',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './beam-profile.component.html'
})
export class BeamProfileComponent implements OnChanges {
  @Input() analysis: BeamAnalysisContext | null = null;
  @Input() selectedX = 0;
  @Output() selectedXChange = new EventEmitter<number>();

  heatmapSamples: BeamStressSample[] = [];

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['analysis']) this.rebuildProfile();
  }

  get hasValidStrengthLimit(): boolean {
    return !!this.analysis && isValidYieldStrength(this.analysis.yieldStrengthMpa);
  }

  get minimumFactorOfSafety(): number | null {
    if (!this.analysis || !this.hasValidStrengthLimit) return null;
    const maximumStress = this.analysis.points.reduce(
      (maximum, point) => Math.max(maximum, Math.abs(point.stress_top_MPa), Math.abs(point.stress_bottom_MPa)),
      0
    );
    return maximumStress <= 1e-9 ? null : this.analysis.yieldStrengthMpa / maximumStress;
  }

  get minimumFactorLabel(): string {
    if (!this.hasValidStrengthLimit) return '—';
    const factor = this.minimumFactorOfSafety;
    return factor === null ? '∞' : factor.toFixed(2);
  }

  get selectedSample(): BeamStressSample | null {
    const analysis = this.analysis;
    if (!analysis || analysis.points.length === 0) return null;
    return this.evaluateSample(
      { x_ratio: this.selectedX / analysis.beam.length_m, point: interpolateBeamPoint(analysis.points, this.selectedX) },
      analysis
    );
  }

  get tooltipPositionPercent(): number {
    return this.analysis
      ? Math.max(12, Math.min(88, this.selectedX / this.analysis.beam.length_m * 100))
      : 50;
  }

  onHeatmapPointerMove(event: PointerEvent): void {
    if (!this.analysis) return;
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const viewX = (event.clientX - rect.left) / rect.width * 900;
    const ratio = Math.max(0, Math.min(1, (viewX - 60) / 780));
    this.selectedXChange.emit(ratio * this.analysis.beam.length_m);
  }

  onHeatmapKeydown(event: KeyboardEvent): void {
    if (!this.analysis) return;
    const step = this.analysis.beam.length_m / 100;
    let nextX: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        nextX = Math.max(0, this.selectedX - step);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        nextX = Math.min(this.analysis.beam.length_m, this.selectedX + step);
        break;
      case 'Home':
        nextX = 0;
        break;
      case 'End':
        nextX = this.analysis.beam.length_m;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selectedXChange.emit(nextX);
  }

  private rebuildProfile(): void {
    const analysis = this.analysis;
    if (!analysis || analysis.points.length === 0 || analysis.beam.length_m <= 0) {
      this.heatmapSamples = [];
      return;
    }

    this.heatmapSamples = createBeamProfile(analysis.points, analysis.beam.length_m, 101)
      .map(sample => this.evaluateSample(sample, analysis));
  }

  private evaluateSample(sample: BeamProfileSample, analysis: BeamAnalysisContext): BeamStressSample {
    const stressMpa = Math.max(
      Math.abs(sample.point.stress_top_MPa),
      Math.abs(sample.point.stress_bottom_MPa)
    );
    const hasValidStrength = isValidYieldStrength(analysis.yieldStrengthMpa);
    const factorOfSafety = !hasValidStrength || stressMpa <= 1e-9 ? null : analysis.yieldStrengthMpa / stressMpa;
    return {
      ...sample,
      stressMpa,
      factorOfSafety,
      color: hasValidStrength ? factorOfSafetyColor(factorOfSafety, 1.3) : '#9ba6b2'
    };
  }
}
