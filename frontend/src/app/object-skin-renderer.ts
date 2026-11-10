import { capVisualDeflections } from './beam-physics';

export type ObjectSkin = 'beam' | 'iphone' | 'spaghetti' | 'skateboard' | 'wing' | 'diving-board';

export interface ObjectSkinState {
  skin: ObjectSkin;
  mode: 'ductile' | 'brittle';
  stressRatio: number;
  failureXRatio: number;
  deflectionProfile: readonly number[];
  failedAt: number | null;
}

export class ObjectSkinRenderer {
  private profileMaximum = 1;
  private cappedProfile: number[] = [];

  draw(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    state: ObjectSkinState,
    time: number
  ): void {
    if (state.skin === 'beam') return;

    const centerY = height * 0.51;
    const span = { start: width * 0.12, end: width * 0.88 };
    const failX = span.start + state.failureXRatio * (span.end - span.start);
    const age = state.failedAt === null ? 0 : Math.max(0, (time - state.failedAt) / 1000);
    const breaking = state.stressRatio >= 1;
    const gap = breaking ? Math.min(width * 0.055, age * width * 0.045) : 0;
    const maxSag = Math.min(height * 0.14, width * 0.35)
      * Math.min(1, Math.max(0.08, state.stressRatio));
    const rawMaximum = Math.max(
      1e-12,
      ...state.deflectionProfile.map(value => Math.abs(value)).filter(Number.isFinite)
    );
    this.profileMaximum = maxSag;
    this.cappedProfile = capVisualDeflections(
      state.deflectionProfile.map(value => Number.isFinite(value) ? value / rawMaximum * maxSag : 0),
      maxSag
    );

    context.save();
    this.drawBackdrop(context, width, height, centerY, state.stressRatio);
    switch (state.skin) {
      case 'iphone':
        this.drawIphone(context, width, height, centerY, state, time, maxSag, gap);
        break;
      case 'spaghetti':
        this.drawSpaghetti(context, width, height, centerY, span, state, maxSag, gap, age);
        break;
      case 'skateboard':
        this.drawSkateboard(context, width, height, centerY, span, state, maxSag, gap, age);
        break;
      case 'wing':
        this.drawWing(context, width, height, centerY, span, state, maxSag, gap, age);
        break;
      case 'diving-board':
        this.drawDivingBoard(context, width, height, centerY, span, state, maxSag, gap, age);
        break;
    }

    if (breaking) {
      const failureY = centerY + this.deflectionAt(state.deflectionProfile, state.failureXRatio) * maxSag;
      this.drawFracture(context, failX, failureY, height, age, state.mode);
    }
    context.restore();
  }

  private drawBackdrop(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    centerY: number,
    stressRatio: number
  ): void {
    const glow = context.createRadialGradient(width * 0.5, centerY, 8, width * 0.5, centerY, width * 0.44);
    glow.addColorStop(0, stressRatio >= 1 ? 'rgba(255, 0, 85, .20)' : 'rgba(0, 245, 212, .14)');
    glow.addColorStop(0.52, 'rgba(99, 102, 241, .08)');
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
  }

  private drawIphone(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    centerY: number,
    state: ObjectSkinState,
    time: number,
    maxSag: number,
    gap: number
  ): void {
    const phoneWidth = width * 0.52;
    const phoneHeight = Math.min(height * 0.68, phoneWidth * 0.49);
    const left = (width - phoneWidth) / 2;
    const right = left + phoneWidth;
    const segmentCount = 42;
    const breakX = left + state.failureXRatio * phoneWidth;
    const animatedGap = Math.max(2, gap);
    const displacement = (x: number): number => this.deflectionAt(state.deflectionProfile, x) * maxSag;
    const lineY = (x: number): number => centerY + displacement((x - left) / phoneWidth);

    context.save();
    this.traceCurvedCapsule(context, left, right, phoneHeight, centerY, state, maxSag, 16);
    context.clip();
    for (let index = 0; index < segmentCount; index += 1) {
      const x = left + (phoneWidth * index) / segmentCount;
      const nextX = left + (phoneWidth * (index + 1)) / segmentCount;
      const middleX = (x + nextX) / 2;
      const failedGap = state.stressRatio >= 1 && x < breakX + animatedGap / 2 && nextX > breakX - animatedGap / 2;
      if (failedGap) continue;

      const y = lineY(middleX);
      const slope = (lineY(middleX + 2) - lineY(middleX - 2)) / 4;
      context.save();
      context.translate(middleX, y);
      context.rotate(Math.atan(slope));
      const shell = context.createLinearGradient(0, -phoneHeight / 2, 0, phoneHeight / 2);
      shell.addColorStop(0, '#f8fafc');
      shell.addColorStop(0.12, '#cbd5e1');
      shell.addColorStop(0.5, state.stressRatio >= 1 ? '#fb7185' : '#94a3b8');
      shell.addColorStop(0.88, '#cbd5e1');
      shell.addColorStop(1, '#f8fafc');
      context.fillStyle = shell;
      context.shadowColor = state.stressRatio >= 1 ? '#ff0055' : '#6366f1';
      context.shadowBlur = 0;
      context.fillRect(-phoneWidth / segmentCount / 2 - 1, -phoneHeight / 2, phoneWidth / segmentCount + 2, phoneHeight);
      context.restore();
    }
    context.restore();

    this.traceCurvedCapsule(context, left, right, phoneHeight, centerY, state, maxSag, 16);
    context.strokeStyle = '#475569';
    context.lineWidth = 2;
    context.stroke();
    context.save();
    this.traceCurvedCapsule(context, left + 9, right - 9, phoneHeight - 18, centerY, state, maxSag, 21);
    context.clip();
    const panel = context.createLinearGradient(0, centerY - phoneHeight / 2, 0, centerY + phoneHeight / 2);
    panel.addColorStop(0, 'rgba(255,255,255,.50)');
    panel.addColorStop(0.5, 'rgba(148,163,184,.12)');
    panel.addColorStop(1, 'rgba(51,65,85,.22)');
    context.fillStyle = panel;
    context.fillRect(left, centerY - phoneHeight / 2, phoneWidth, phoneHeight);
    for (let index = 1; index < segmentCount; index += 1) {
      const x = left + (phoneWidth * index) / segmentCount;
      const y = lineY(x);
      context.strokeStyle = 'rgba(255,255,255,.09)';
      context.lineWidth = 1;
      if (index % 5 !== 0) continue;
      context.beginPath();
      context.moveTo(x, y - phoneHeight / 2);
      context.lineTo(x, y + phoneHeight / 2);
      context.stroke();
    }
    context.restore();

    const cameraX = left + phoneWidth * 0.09;
    const cameraY = lineY(cameraX) - phoneHeight * 0.32;
    context.fillStyle = '#334155';
    context.beginPath();
    context.arc(cameraX, cameraY, phoneHeight * 0.055, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#67e8f9';
    context.beginPath();
    context.arc(cameraX, cameraY, phoneHeight * 0.031, 0, Math.PI * 2);
    context.fill();
    const logoX = width * 0.5;
    const logoY = lineY(logoX);
    context.fillStyle = '#64748b';
    context.beginPath();
    context.ellipse(logoX - phoneHeight * 0.026, logoY, phoneHeight * 0.038, phoneHeight * 0.058, -0.22, 0, Math.PI * 2);
    context.ellipse(logoX + phoneHeight * 0.026, logoY, phoneHeight * 0.038, phoneHeight * 0.058, 0.22, 0, Math.PI * 2);
    context.ellipse(logoX, logoY + phoneHeight * 0.025, phoneHeight * 0.055, phoneHeight * 0.048, 0, 0, Math.PI * 2);
    context.fill();
    context.save();
    context.translate(logoX + phoneHeight * 0.035, logoY - phoneHeight * 0.07);
    context.rotate(-0.65);
    context.fillStyle = '#64748b';
    context.beginPath();
    context.ellipse(0, 0, phoneHeight * 0.025, phoneHeight * 0.045, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();

    if (state.stressRatio >= 0.75 && state.stressRatio < 1) {
      this.drawHeatBand(context, breakX, lineY(breakX), phoneHeight, time);
    }
    if (state.stressRatio >= 1) {
      this.drawBreakGap(context, breakX, lineY(breakX), phoneHeight, animatedGap);
    }
    this.drawDownArrow(context, width * 0.5, centerY - phoneHeight * 0.65);
    this.drawThreePointSupports(context, left + phoneWidth * 0.08, right - phoneWidth * 0.08, centerY + phoneHeight * 0.56, height);
  }

  private traceCurvedCapsule(
    context: CanvasRenderingContext2D,
    left: number,
    right: number,
    bodyHeight: number,
    centerY: number,
    state: ObjectSkinState,
    maxSag: number,
    inset: number
  ): void {
    const width = right - left;
    const segments = 48;
    const top = centerY - bodyHeight / 2 + inset;
    const bottom = centerY + bodyHeight / 2 - inset;
    const displacement = (x: number): number => this.deflectionAt(state.deflectionProfile, x) * maxSag;
    context.beginPath();
    for (let index = 0; index <= segments; index += 1) {
      const x = left + width * index / segments;
      const y = top + displacement((x - left) / width);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    for (let index = segments; index >= 0; index -= 1) {
      const x = left + width * index / segments;
      context.lineTo(x, bottom + displacement((x - left) / width));
    }
    context.closePath();
  }

  private drawSpaghetti(
    context: CanvasRenderingContext2D,
    _width: number,
    height: number,
    centerY: number,
    span: { start: number; end: number },
    state: ObjectSkinState,
    maxSag: number,
    gap: number,
    age: number
  ): void {
    const failX = span.start + state.failureXRatio * (span.end - span.start);
    const sag = (ratio: number): number => this.deflectionAt(state.deflectionProfile, ratio) * maxSag;
    const y = (ratio: number): number => centerY + sag(ratio);
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(7, height * 0.045);
    context.strokeStyle = '#b45309';
    context.shadowColor = '#f59e0b';
    context.shadowBlur = 16;
    this.strokeCurve(context, span.start, span.end, centerY, y, state.stressRatio >= 1 ? failX - gap / 2 : null);
    if (state.stressRatio >= 1) {
      context.beginPath();
      context.moveTo(failX + gap / 2, y(state.failureXRatio));
      this.traceCurveTo(context, failX + gap / 2, span.end, span, y);
      context.stroke();
    }
    context.lineWidth = Math.max(3, height * 0.018);
    context.strokeStyle = state.stressRatio >= 1 ? '#ff0055' : '#fde68a';
    context.shadowColor = '#fbbf24';
    context.shadowBlur = 8;
    this.strokeCurve(context, span.start, span.end, centerY, y, state.stressRatio >= 1 ? failX - gap / 2 : null);
    if (state.stressRatio >= 1) {
      context.beginPath();
      context.moveTo(failX + gap / 2, y(state.failureXRatio));
      this.traceCurveTo(context, failX + gap / 2, span.end, span, y);
      context.stroke();
    }
    context.restore();
    this.drawThreePointSupports(context, span.start, span.end, centerY + height * 0.09, height);
    this.drawDownArrow(context, failX, centerY - height * 0.18);
    if (state.stressRatio >= 1) this.drawBreakGap(context, failX, y(state.failureXRatio), height * 0.14, gap + age * 3);
  }

  private drawSkateboard(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    centerY: number,
    span: { start: number; end: number },
    state: ObjectSkinState,
    maxSag: number,
    gap: number,
    age: number
  ): void {
    const deckHeight = height * 0.14;
    const failX = span.start + state.failureXRatio * (span.end - span.start);
    const y = (ratio: number): number => centerY + this.deflectionAt(state.deflectionProfile, ratio) * maxSag;
    this.strokeDeck(context, span, deckHeight, y, state, failX, gap, '#a16207');
    context.strokeStyle = '#facc15';
    context.lineWidth = 3;
    this.strokeDeck(context, span, deckHeight * 0.55, y, state, failX, gap, '#d97706');
    for (const xRatio of [0.18, 0.82]) {
      const x = span.start + (span.end - span.start) * xRatio;
      const deckY = y(xRatio) + deckHeight * 0.55;
      context.strokeStyle = '#475569';
      context.lineWidth = 6;
      context.beginPath();
      context.moveTo(x, deckY);
      context.lineTo(x, deckY + height * 0.08);
      context.stroke();
      for (const wheelOffset of [-12, 12]) {
        context.fillStyle = '#334155';
        context.beginPath();
        context.arc(x + wheelOffset, deckY + height * 0.1, height * 0.045, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = '#38bdf8';
        context.beginPath();
        context.arc(x + wheelOffset, deckY + height * 0.1, height * 0.017, 0, Math.PI * 2);
        context.fill();
      }
    }
    for (const xRatio of [0.36, 0.64]) this.drawDownArrow(context, span.start + (span.end - span.start) * xRatio, centerY - deckHeight);
    if (state.stressRatio >= 1) this.drawBreakGap(context, failX, y(state.failureXRatio), deckHeight, gap + age * 3);
    if (width > 0) this.drawThreePointSupports(context, span.start, span.end, centerY + height * 0.24, height);
  }

  private drawWing(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    centerY: number,
    span: { start: number; end: number },
    state: ObjectSkinState,
    maxSag: number,
    gap: number,
    age: number
  ): void {
    const y = (ratio: number): number => centerY + this.deflectionAt(state.deflectionProfile, ratio) * maxSag;
    const failX = span.start + state.failureXRatio * (span.end - span.start);
    const layers = 34;
    for (let index = 0; index < layers; index += 1) {
      const ratio = index / (layers - 1);
      const x = span.start + ratio * (span.end - span.start);
      if (state.stressRatio >= 1 && Math.abs(x - failX) < gap / 2) continue;
      const chord = height * (0.32 - 0.22 * Math.abs(ratio - 0.5) * 2);
      const curveY = y(ratio);
      context.save();
      context.translate(x, curveY);
      context.rotate((y(Math.min(1, ratio + 0.01)) - y(Math.max(0, ratio - 0.01))) / (span.end - span.start) * layers);
      const fill = context.createLinearGradient(0, -chord / 2, 0, chord / 2);
      fill.addColorStop(0, '#67e8f9');
      fill.addColorStop(0.45, state.stressRatio >= 1 ? '#fb7185' : '#818cf8');
      fill.addColorStop(1, '#4338ca');
      context.fillStyle = fill;
      context.fillRect(-1, -chord / 2, (span.end - span.start) / layers + 2, chord);
      context.restore();
    }
    context.strokeStyle = '#38bdf8';
    context.lineWidth = 2;
    this.strokeCurve(context, span.start, span.end, centerY, y, state.stressRatio >= 1 ? failX - gap / 2 : null);
    this.drawDistributedArrows(context, span, height);
    this.drawCantileverSupport(context, span.start, centerY, height);
    if (state.stressRatio >= 1) this.drawBreakGap(context, failX, y(state.failureXRatio), height * 0.2, gap + age * 3);
    if (width < 1) return;
  }

  private drawDivingBoard(
    context: CanvasRenderingContext2D,
    _width: number,
    height: number,
    centerY: number,
    span: { start: number; end: number },
    state: ObjectSkinState,
    maxSag: number,
    gap: number,
    age: number
  ): void {
    const boardHeight = height * 0.09;
    const y = (ratio: number): number => centerY + this.deflectionAt(state.deflectionProfile, ratio) * maxSag;
    const failX = span.start + state.failureXRatio * (span.end - span.start);
    this.strokeDeck(context, span, boardHeight, y, state, failX, gap, '#06b6d4');
    context.strokeStyle = '#e0f2fe';
    context.lineWidth = 3;
    this.strokeDeck(context, span, boardHeight * 0.48, y, state, failX, gap, '#38bdf8');
    this.drawCantileverSupport(context, span.start, centerY, height);
    this.drawDownArrow(context, span.end, centerY - height * 0.2);
    if (state.stressRatio >= 1) this.drawBreakGap(context, failX, y(state.failureXRatio), boardHeight, gap + age * 3);
  }

  private strokeDeck(
    context: CanvasRenderingContext2D,
    span: { start: number; end: number },
    thickness: number,
    y: (ratio: number) => number,
    state: ObjectSkinState,
    failX: number,
    gap: number,
    color: string
  ): void {
    const failed = state.stressRatio >= 1;
    context.beginPath();
    const startRatio = failed ? 0 : 0;
    const breakRatio = (failX - gap / 2 - span.start) / (span.end - span.start);
    const endRatio = failed ? (failX + gap / 2 - span.start) / (span.end - span.start) : 1;
    this.traceDeckHalf(context, span, thickness, y, startRatio, failed ? breakRatio : 1, true);
    if (failed) this.traceDeckHalf(context, span, thickness, y, endRatio, 1, false);
    context.strokeStyle = color;
    context.lineWidth = thickness;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.stroke();
    context.save();
    context.strokeStyle = 'rgba(255,255,255,.35)';
    context.lineWidth = 1;
    for (let line = -1; line <= 1; line += 1) {
      context.beginPath();
      const inset = line * thickness * 0.22;
      context.moveTo(span.start + 14, y(0) + inset);
      context.quadraticCurveTo((span.start + span.end) / 2, y(0.5) + inset, span.end - 14, y(1) + inset);
      context.stroke();
    }
    context.restore();
  }

  private traceDeckHalf(
    context: CanvasRenderingContext2D,
    span: { start: number; end: number },
    thickness: number,
    y: (ratio: number) => number,
    startRatio: number,
    endRatio: number,
    move: boolean
  ): void {
    const startX = span.start + (span.end - span.start) * Math.max(0, Math.min(1, startRatio));
    const endX = span.start + (span.end - span.start) * Math.max(0, Math.min(1, endRatio));
    if (move) context.moveTo(startX, y(startRatio));
    else context.moveTo(startX, y(startRatio));
    context.lineTo(endX, y(endRatio));
  }

  private drawFracture(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    height: number,
    age: number,
    mode: 'ductile' | 'brittle'
  ): void {
    const spread = Math.min(height * 0.12, age * height * 0.15);
    const half = Math.max(6, height * (mode === 'brittle' ? 0.12 : 0.08));
    context.save();
    context.strokeStyle = '#fff';
    context.lineWidth = Math.max(6, height * 0.025);
    context.shadowColor = '#ff0055';
    context.shadowBlur = 20;
    context.beginPath();
    context.moveTo(x - spread / 2, y - half);
    context.lineTo(x + spread / 2, y + half);
    context.stroke();
    context.strokeStyle = '#ff0055';
    context.lineWidth = Math.max(3, height * 0.012);
    context.beginPath();
    context.moveTo(x - spread / 2, y - half);
    const steps = 7;
    for (let index = 1; index <= steps; index += 1) {
      const direction = index % 2 ? 1 : -1;
      context.lineTo(x + spread / 2 + direction * height * 0.018, y - half + (half * 2 * index) / steps);
    }
    context.stroke();
    if (age < 0.45) {
      const progress = age / 0.45;
      context.strokeStyle = '#fbbf24';
      context.lineWidth = Math.max(1.5, height * 0.006);
      context.shadowColor = '#fbbf24';
      context.shadowBlur = 12;
      for (let index = 0; index < 12; index += 1) {
        const angle = Math.PI * 2 * index / 12;
        const inner = half * 0.55;
        const outer = inner + progress * height * 0.16;
        context.beginPath();
        context.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
        context.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
        context.stroke();
      }
    }
    context.restore();
  }

  private drawBreakGap(context: CanvasRenderingContext2D, x: number, y: number, height: number, gap: number): void {
    const width = Math.max(8, gap);
    context.save();
    context.fillStyle = 'rgba(255,255,255,.95)';
    context.beginPath();
    context.moveTo(x - width / 2, y - height / 2);
    context.lineTo(x + width / 2, y - height / 2 + height * 0.19);
    context.lineTo(x - width / 2, y - height * 0.08);
    context.lineTo(x + width / 2, y + height * 0.11);
    context.lineTo(x - width / 2, y + height * 0.28);
    context.lineTo(x + width / 2, y + height / 2);
    context.lineTo(x - width / 2, y + height / 2);
    context.closePath();
    context.fill();
    context.restore();
  }

  private drawHeatBand(context: CanvasRenderingContext2D, x: number, y: number, height: number, time: number): void {
    const pulse = 0.86 + 0.14 * Math.sin(time / 100);
    const glow = context.createRadialGradient(x, y, 2, x, y, height * pulse);
    glow.addColorStop(0, 'rgba(255,0,85,.50)');
    glow.addColorStop(0.45, 'rgba(251,146,60,.28)');
    glow.addColorStop(1, 'rgba(251,146,60,0)');
    context.fillStyle = glow;
    context.fillRect(x - height, y - height, height * 2, height * 2);
  }

  private drawThreePointSupports(context: CanvasRenderingContext2D, left: number, right: number, y: number, height: number): void {
    context.save();
    context.fillStyle = '#8b5cf6';
    context.strokeStyle = '#4c1d95';
    context.lineWidth = 2;
    for (const x of [left, right]) {
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x - height * 0.035, y + height * 0.055);
      context.lineTo(x + height * 0.035, y + height * 0.055);
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  private drawCantileverSupport(context: CanvasRenderingContext2D, x: number, y: number, height: number): void {
    context.save();
    context.fillStyle = '#7c3aed';
    context.fillRect(x - height * 0.055, y - height * 0.22, height * 0.055, height * 0.42);
    context.strokeStyle = '#c4b5fd';
    context.lineWidth = 2;
    for (let index = 0; index < 6; index += 1) {
      const hatchY = y - height * 0.19 + index * height * 0.065;
      context.beginPath();
      context.moveTo(x - height * 0.095, hatchY);
      context.lineTo(x - height * 0.055, hatchY + height * 0.04);
      context.stroke();
    }
    context.restore();
  }

  private drawDownArrow(context: CanvasRenderingContext2D, x: number, y: number): void {
    context.save();
    context.strokeStyle = '#ff0055';
    context.fillStyle = '#ff0055';
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(x, y - 25);
    context.lineTo(x, y + 2);
    context.stroke();
    context.beginPath();
    context.moveTo(x - 7, y - 3);
    context.lineTo(x, y + 7);
    context.lineTo(x + 7, y - 3);
    context.closePath();
    context.fill();
    context.restore();
  }

  private drawDistributedArrows(
    context: CanvasRenderingContext2D,
    span: { start: number; end: number },
    height: number
  ): void {
    for (let index = 0; index < 9; index += 1) {
      const x = span.start + (span.end - span.start) * index / 8;
      this.drawDownArrow(context, x, height * 0.36);
    }
  }

  private strokeCurve(
    context: CanvasRenderingContext2D,
    start: number,
    end: number,
    _centerY: number,
    y: (ratio: number) => number,
    stopX: number | null
  ): void {
    const stop = stopX ?? end;
    context.beginPath();
    for (let index = 0; index <= 60; index += 1) {
      const x = start + (stop - start) * index / 60;
      const ratio = (x - start) / (end - start);
      if (index === 0) context.moveTo(x, y(ratio));
      else context.lineTo(x, y(ratio));
    }
    context.stroke();
  }

  private traceCurveTo(
    context: CanvasRenderingContext2D,
    startX: number,
    endX: number,
    span: { start: number; end: number },
    y: (ratio: number) => number
  ): void {
    for (let index = 1; index <= 40; index += 1) {
      const x = startX + (endX - startX) * index / 40;
      context.lineTo(x, y((x - span.start) / (span.end - span.start)));
    }
  }

  private deflectionAt(profile: readonly number[], ratio: number): number {
    if (profile.length < 2) return 0;
    const position = Math.max(0, Math.min(1, ratio)) * (profile.length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(profile.length - 1, lower + 1);
    const fraction = position - lower;
    const left = Number.isFinite(profile[lower]) ? this.cappedProfile[lower] / this.profileMaximum : 0;
    const right = Number.isFinite(profile[upper]) ? this.cappedProfile[upper] / this.profileMaximum : 0;
    return left + (right - left) * fraction;
  }
}
