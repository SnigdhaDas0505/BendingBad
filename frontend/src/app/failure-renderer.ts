import { ObjectSkinRenderer, type ObjectSkin } from './object-skin-renderer';

export type FailureMode = 'ductile' | 'brittle';

export interface FailureRenderState {
  mode: FailureMode;
  objectSkin: ObjectSkin;
  stressRatio: number;
  failureXRatio: number;
  deflectionProfile: readonly number[];
  active: boolean;
  showBeam: boolean;
}

interface DebrisParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  size: number;
}

export class FailureRenderer {
  private readonly objectSkinRenderer = new ObjectSkinRenderer();
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private animationFrame: number | null = null;
  private state: FailureRenderState = {
    mode: 'ductile',
    objectSkin: 'beam',
    stressRatio: 0,
    failureXRatio: 0.5,
    deflectionProfile: [],
    active: false,
    showBeam: false
  };
  private failureStartedAt: number | null = null;
  private particles: DebrisParticle[] = [];

  attach(canvas: HTMLCanvasElement | null): void {
    this.stop();
    this.canvas = canvas;
    this.context = canvas?.getContext('2d', { alpha: true, desynchronized: true }) ?? null;
    if (canvas) this.draw(performance.now());
  }

  update(state: FailureRenderState): void {
    const justFailed = state.active && state.stressRatio >= 1
      && (!this.state.active || this.state.stressRatio < 1);
    this.state = {
      ...state,
      stressRatio: Number.isFinite(state.stressRatio) ? Math.max(0, state.stressRatio) : 0,
      failureXRatio: Number.isFinite(state.failureXRatio)
        ? Math.max(0, Math.min(1, state.failureXRatio))
        : 0.5
    };

    if (justFailed) {
      this.failureStartedAt = performance.now();
      this.createParticles();
    } else if (this.state.stressRatio < 1 || !this.state.active) {
      this.failureStartedAt = null;
      this.particles = [];
    }

    if (this.state.active) this.start();
    else {
      this.stop();
      this.draw(performance.now());
    }
  }

  dispose(): void {
    this.stop();
    this.canvas = null;
    this.context = null;
  }

  private start(): void {
    if (this.animationFrame !== null || !this.canvas) return;
    if (this.prefersReducedMotion()) {
      this.draw(performance.now());
      return;
    }
    const frame = (time: number): void => {
      this.animationFrame = null;
      this.draw(time);
      if (this.state.active && this.canvas && !this.prefersReducedMotion()) {
        this.animationFrame = requestAnimationFrame(frame);
      }
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  private stop(): void {
    if (this.animationFrame === null) return;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  private draw(time: number): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const backingWidth = Math.round(bounds.width * pixelRatio);
    const backingHeight = Math.round(bounds.height * pixelRatio);
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
    const context = this.context;
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    if (this.state.showBeam) {
      context.fillStyle = '#F8FAFC';
      context.fillRect(0, 0, bounds.width, bounds.height);
    }

    const width = bounds.width;
    const height = bounds.height;
    const beamStart = width * 0.07;
    const beamEnd = width * 0.93;
    const beamY = height * (158 / 310);
    const failX = beamStart + this.state.failureXRatio * (beamEnd - beamStart);
    const intensity = Math.min(1, this.state.stressRatio / 1.15);
    const zoneRadius = Math.max(24, width * (0.055 + intensity * 0.05));

    if (this.state.objectSkin !== 'beam') {
      this.objectSkinRenderer.draw(context, width, height, {
        skin: this.state.objectSkin,
        mode: this.state.mode,
        stressRatio: this.state.stressRatio,
        failureXRatio: this.state.failureXRatio,
        deflectionProfile: this.state.deflectionProfile,
        failedAt: this.failureStartedAt
      }, time);
      if (this.state.active && this.state.stressRatio >= 1 && this.state.mode === 'brittle') {
        const elapsed = this.failureStartedAt === null ? 0 : (time - this.failureStartedAt) / 1000;
        if (!this.prefersReducedMotion() && elapsed < 1.5) this.drawParticles(context, elapsed, height);
      }
      return;
    }

    if (this.state.showBeam) this.drawBeam(context, beamStart, beamEnd, beamY, height);
    if (this.state.stressRatio >= 0.75) {
      this.drawYieldGlow(context, failX, beamY, zoneRadius, time);
    }

    if (!this.state.active) return;
    if (this.state.mode === 'ductile') {
      this.drawDuctile(context, beamStart, beamEnd, beamY, failX, height, intensity, time);
    } else if (this.state.stressRatio >= 1) {
      this.drawBrittle(context, failX, beamY, height, time);
    }
  }

  private drawBeam(
    context: CanvasRenderingContext2D,
    start: number,
    end: number,
    y: number,
    height: number
  ): void {
    context.save();
    context.lineCap = 'round';
    context.strokeStyle = '#475569';
    context.lineWidth = Math.max(4, height * 0.08);
    context.beginPath();
    context.moveTo(start, y);
    context.lineTo(end, y);
    context.stroke();
    context.fillStyle = '#F8FAFC';
    context.strokeStyle = '#475569';
    context.lineWidth = 1.5;
    for (const x of [start, end]) {
      context.beginPath();
      context.moveTo(x, y + height * 0.045);
      context.lineTo(x - height * 0.035, y + height * 0.09);
      context.lineTo(x + height * 0.035, y + height * 0.09);
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawYieldGlow(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    time: number
  ): void {
    const pulse = this.prefersReducedMotion() ? 1 : 0.88 + 0.12 * Math.sin(time / 160);
    const glow = context.createRadialGradient(x, y, 1, x, y, radius * pulse);
    glow.addColorStop(0, 'rgba(220, 38, 38, 0.40)');
    glow.addColorStop(0.45, 'rgba(239, 68, 68, 0.20)');
    glow.addColorStop(1, 'rgba(239, 68, 68, 0)');
    context.fillStyle = glow;
    context.beginPath();
    context.ellipse(x, y, radius * pulse, Math.max(12, radius * 0.55), 0, 0, Math.PI * 2);
    context.fill();
  }

  private drawDuctile(
    context: CanvasRenderingContext2D,
    start: number,
    end: number,
    beamY: number,
    failX: number,
    height: number,
    intensity: number,
    time: number
  ): void {
    const previewRatio = Math.max(this.state.stressRatio, 0.8);
    const sag = height * (0.035 + Math.min(previewRatio, 1.4) * 0.045);
    const wave = this.state.stressRatio >= 1 && !this.prefersReducedMotion()
      ? 1 + 0.025 * Math.sin(time / 75)
      : 1;
    const failureY = beamY + sag * wave;
    context.save();
    context.beginPath();
    context.moveTo(start, beamY);
    context.quadraticCurveTo(failX, failureY * 2 - beamY, end, beamY);
    context.strokeStyle = this.state.stressRatio >= 1
      ? 'rgba(153, 27, 27, 0.9)'
      : 'rgba(180, 83, 9, 0.8)';
    context.lineWidth = Math.max(2, height * 0.012);
    context.setLineDash([6, 4]);
    context.stroke();
    context.setLineDash([]);

    if (this.state.stressRatio >= 1) {
      context.translate(failX, failureY);
      context.scale(0.68, 1);
      context.beginPath();
      context.ellipse(0, 0, Math.max(9, height * 0.035), Math.max(4, height * 0.018), 0, 0, Math.PI * 2);
      context.fillStyle = 'rgba(153, 27, 27, 0.72)';
      context.shadowColor = '#ef4444';
      context.shadowBlur = 18 + intensity * 8;
      context.fill();
    }
    context.restore();
  }

  private drawBrittle(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    height: number,
    time: number
  ): void {
    const elapsed = this.failureStartedAt === null ? 0 : (time - this.failureStartedAt) / 1000;
    const reducedMotion = this.prefersReducedMotion();
    const propagation = reducedMotion ? 1 : Math.min(1, elapsed / 0.35);
    context.save();
    context.beginPath();
    context.moveTo(x, y - height * 0.07);
    const segments = 8;
    for (let index = 1; index <= segments; index += 1) {
      const direction = index % 2 === 0 ? 1 : -1;
      const segmentY = y - height * 0.07 + (height * 0.14 * index) / segments;
      context.lineTo(x + direction * height * 0.018 * propagation, segmentY);
    }
    context.strokeStyle = '#991b1b';
    context.lineWidth = 2.5;
    context.shadowColor = '#ef4444';
    context.shadowBlur = 8;
    context.stroke();
    context.restore();

    if (!reducedMotion && elapsed < 1.5) this.drawParticles(context, elapsed, height);
  }

  private createParticles(): void {
    this.particles = Array.from({ length: 25 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 25 + (Math.random() - 0.5) * 0.5;
      const speed = 25 + Math.random() * 105;
      return {
        x: 0,
        y: 0,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 18,
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 9,
        size: 2 + Math.random() * 4
      };
    });
  }

  private drawParticles(context: CanvasRenderingContext2D, elapsed: number, height: number): void {
    const x = context.canvas.clientWidth * (0.07 + this.state.failureXRatio * 0.86);
    const y = context.canvas.clientHeight * (158 / 310);
    const gravity = height * 1.8;
    context.save();
    context.fillStyle = 'rgba(127, 29, 29, 0.82)';
    for (const particle of this.particles) {
      const px = x + particle.vx * elapsed;
      const py = y + particle.vy * elapsed + 0.5 * gravity * elapsed ** 2;
      if (py < -10 || py > context.canvas.clientHeight + 10) continue;
      context.save();
      context.translate(px, py);
      context.rotate(particle.rotation + particle.spin * elapsed);
      context.fillRect(-particle.size / 2, -particle.size / 2, particle.size, particle.size * 1.5);
      context.restore();
    }
    context.restore();
  }

  private prefersReducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
