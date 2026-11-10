export class StructuralAudioFX {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private creakOscillator: OscillatorNode | null = null;
  private creakGain: GainNode | null = null;
  private creakLfo: OscillatorNode | null = null;
  private creakLfoGain: GainNode | null = null;
  private enabled = false;
  private previousStressRatio: number | null = null;

  async enable(currentStressRatio: number | null): Promise<void> {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) {
      throw new Error('Web Audio is not supported by this browser.');
    }

    this.context ??= new AudioContextConstructor();
    this.masterGain ??= this.context.createGain();
    this.masterGain.gain.value = 0.35;
    this.masterGain.connect(this.context.destination);
    await this.context.resume();
    this.enabled = true;
    this.previousStressRatio = this.validRatio(currentStressRatio);
  }

  updateStressRatio(stressRatio: number): void {
    if (!this.enabled || !this.context || !this.masterGain || !Number.isFinite(stressRatio)) return;

    const ratio = Math.max(0, stressRatio);
    if (this.previousStressRatio !== null && this.previousStressRatio < 1 && ratio >= 1) {
      this.stopCreak();
      this.playSnap();
    }

    this.previousStressRatio = ratio;
    if (ratio >= 0.75 && ratio < 1) this.updateCreak(ratio);
    else this.stopCreak();
  }

  disable(): void {
    this.enabled = false;
    this.previousStressRatio = null;
    this.stopCreak();
  }

  dispose(): void {
    this.disable();
    const context = this.context;
    this.context = null;
    this.masterGain = null;
    if (context && context.state !== 'closed') void context.close();
  }

  private updateCreak(ratio: number): void {
    const context = this.context;
    const masterGain = this.masterGain;
    if (!context || !masterGain) return;

    if (!this.creakOscillator || !this.creakGain || !this.creakLfo || !this.creakLfoGain) {
      this.creakOscillator = context.createOscillator();
      this.creakOscillator.type = 'sawtooth';
      this.creakGain = context.createGain();
      this.creakGain.gain.value = 0.018;
      this.creakLfo = context.createOscillator();
      this.creakLfo.type = 'sine';
      this.creakLfo.frequency.value = 12;
      this.creakLfoGain = context.createGain();
      this.creakLfoGain.gain.value = 0.012;

      this.creakLfo.connect(this.creakLfoGain);
      this.creakLfoGain.connect(this.creakGain.gain);
      this.creakOscillator.connect(this.creakGain);
      this.creakGain.connect(masterGain);
      this.creakOscillator.start();
      this.creakLfo.start();
    }

    const intensity = Math.min(1, Math.max(0, (ratio - 0.75) / 0.25));
    const now = context.currentTime;
    this.creakOscillator.frequency.setTargetAtTime(180 + intensity * 470, now, 0.08);
    this.creakGain.gain.setTargetAtTime(0.01 + intensity * 0.025, now, 0.08);
  }

  private stopCreak(): void {
    const context = this.context;
    if (!context) return;
    const now = context.currentTime;
    this.creakGain?.gain.setTargetAtTime(0, now, 0.04);
    for (const oscillator of [this.creakOscillator, this.creakLfo]) {
      if (oscillator) {
        try {
          oscillator.stop(now + 0.2);
        } catch (error: unknown) {
          if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error;
        }
      }
    }
    this.creakOscillator = null;
    this.creakGain = null;
    this.creakLfo = null;
    this.creakLfoGain = null;
  }

  private playSnap(): void {
    const context = this.context;
    const masterGain = this.masterGain;
    if (!context || !masterGain) return;

    const now = context.currentTime;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.35), context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }

    const noise = context.createBufferSource();
    noise.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.8;
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(0.5, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(masterGain);
    noise.start(now);
    noise.stop(now + 0.36);

    const thud = context.createOscillator();
    thud.type = 'triangle';
    thud.frequency.setValueAtTime(150, now);
    thud.frequency.exponentialRampToValueAtTime(30, now + 0.35);
    const thudGain = context.createGain();
    thudGain.gain.setValueAtTime(0.4, now);
    thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    thud.connect(thudGain);
    thudGain.connect(masterGain);
    thud.start(now);
    thud.stop(now + 0.36);
  }

  private validRatio(value: number | null): number | null {
    return value !== null && Number.isFinite(value) ? Math.max(0, value) : null;
  }
}
