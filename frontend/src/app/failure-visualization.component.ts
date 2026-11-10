import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, Input, OnChanges, OnDestroy, SimpleChanges, ViewChild } from '@angular/core';
import { FailureRenderer, type FailureMode } from './failure-renderer';
import type { ObjectSkin } from './object-skin-renderer';

@Component({
  selector: 'app-failure-visualization',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<canvas #canvas aria-hidden="true"></canvas>',
  host: {
    '[class.compact]': 'compact'
  }
})
export class FailureVisualizationComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() mode: FailureMode = 'ductile';
  @Input() objectSkin: ObjectSkin = 'beam';
  @Input() stressRatio = 0;
  @Input() failureXRatio = 0.5;
  @Input() deflectionProfile: readonly number[] = [];
  @Input() active = false;
  @Input() compact = false;
  @Input() showBeam = false;

  @ViewChild('canvas') private canvas?: ElementRef<HTMLCanvasElement>;
  private readonly renderer = new FailureRenderer();
  private resizeObserver?: ResizeObserver;

  ngAfterViewInit(): void {
    const canvas = this.canvas?.nativeElement ?? null;
    this.renderer.attach(canvas);
    if (canvas && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.updateRenderer());
      this.resizeObserver.observe(canvas);
    }
    this.updateRenderer();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    this.updateRenderer();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.renderer.dispose();
  }

  private updateRenderer(): void {
    this.renderer.update({
      mode: this.mode,
      objectSkin: this.objectSkin,
      stressRatio: this.stressRatio,
      failureXRatio: this.failureXRatio,
      deflectionProfile: this.deflectionProfile,
      active: this.active,
      showBeam: this.showBeam
    });
  }
}
