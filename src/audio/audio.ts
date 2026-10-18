// Procedural Web Audio: engine, wind, tyre squeal and UI/game one-shots. No sample files.

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineA!: OscillatorNode;
  private engineB!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private skidGain!: GainNode;
  private noise!: AudioBuffer;
  private volume = 0.7;
  private running = false;
  /** Reasons the game is muted ('ad', 'platform'); the volume setting is kept underneath. */
  private muted = new Set<string>();

  /** Must be called from a user gesture on mobile browsers. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Release the audio device while the app is in the background (Android keeps it open otherwise). */
  suspend(): void {
    if (!this.ctx) return;
    // Cut the loops now: a fade still running when the clock stops would finish on return.
    const t = this.ctx.currentTime;
    for (const g of [this.engineGain, this.windGain, this.skidGain]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0, t);
    }
    this.running = false;
    // No state check here or in resume(): suspend() is asynchronous, and the last call wins.
    void this.ctx.suspend();
  }

  /** Undo suspend(). Needs no new gesture: the page already has sticky user activation. */
  resume(): void {
    this.ctx?.resume().catch(() => {});
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyGain();
  }

  /** Mute for `why` (an ad playing, the portal's mute setting) until the same reason lifts it. */
  mute(why: string, on: boolean): void {
    if (on) this.muted.add(why);
    else this.muted.delete(why);
    this.applyGain();
  }

  private get gain(): number {
    return this.muted.size ? 0 : this.volume;
  }

  private applyGain(): void {
    if (this.ctx) this.master.gain.setTargetAtTime(this.gain, this.ctx.currentTime, 0.05);
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = this.gain;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 900;
    this.engineFilter.Q.value = 4;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineA = ctx.createOscillator();
    this.engineA.type = 'sawtooth';
    this.engineB = ctx.createOscillator();
    this.engineB.type = 'square';
    const bGain = ctx.createGain();
    bGain.gain.value = 0.35;
    this.engineA.connect(this.engineFilter);
    this.engineB.connect(bGain).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.engineA.start();
    this.engineB.start();

    this.windGain = this.loopNoise('bandpass', 700, 0.6);
    this.skidGain = this.loopNoise('bandpass', 2200, 6);
  }

  private loopNoise(type: BiquadFilterType, freq: number, q: number): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    return g;
  }

  /** Continuous sounds; call every frame while driving. */
  drive(speedKmh: number, throttle: number, slip: number, grounded: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.running = true;
    // Pseudo gearbox: pitch climbs within a gear then drops back.
    const gears = [0, 60, 120, 185, 255, 340, 1000];
    let g = 1;
    while (g < gears.length - 1 && speedKmh > gears[g]) g++;
    const lo = gears[g - 1], hi = gears[g];
    const within = Math.min(1, (speedKmh - lo) / (hi - lo));
    const base = 70 + g * 12 + within * (110 + g * 10);
    const f = grounded ? base : base * 1.15;
    this.engineA.frequency.setTargetAtTime(f, t, 0.04);
    this.engineB.frequency.setTargetAtTime(f * 0.5, t, 0.04);
    this.engineFilter.frequency.setTargetAtTime(500 + throttle * 1700 + speedKmh * 2, t, 0.06);
    this.engineGain.gain.setTargetAtTime(0.07 + throttle * 0.08, t, 0.08);
    this.windGain.gain.setTargetAtTime(Math.min(0.25, (speedKmh / 400) ** 2 * 0.3), t, 0.1);
    this.skidGain.gain.setTargetAtTime(grounded ? Math.min(0.18, slip * 0.22) : 0, t, 0.05);
  }

  silence(): void {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.setTargetAtTime(0, t, 0.08);
    this.windGain.gain.setTargetAtTime(0, t, 0.08);
    this.skidGain.gain.setTargetAtTime(0, t, 0.05);
    this.running = false;
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.25, delay = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(freq: number, dur: number, vol: number, sweepTo?: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  countdown(n: number): void {
    this.tone(n > 0 ? 520 : 1040, n > 0 ? 0.18 : 0.45, 'square', 0.12);
  }

  checkpoint(ahead: boolean | null): void {
    const a = ahead === false ? 587 : 784;
    this.tone(a, 0.16, 'triangle', 0.25);
    this.tone(a * 1.5, 0.22, 'triangle', 0.22, 0.09);
  }

  finish(record: boolean): void {
    const notes = record ? [523, 659, 784, 1047, 1319] : [523, 659, 784];
    notes.forEach((n, i) => this.tone(n, 0.3, 'triangle', 0.22, i * 0.1));
  }

  boost(turbo: boolean): void {
    this.burst(400, turbo ? 0.9 : 0.6, 0.35, turbo ? 3200 : 2200);
  }

  impact(speed: number): void {
    this.burst(160, 0.25, Math.min(0.5, speed / 40));
  }

  click(): void {
    this.tone(880, 0.05, 'square', 0.06);
  }

  missing(): void {
    this.tone(220, 0.3, 'sawtooth', 0.12);
  }
}
