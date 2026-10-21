// Procedural Web Audio: engine, wind, tyre squeal and UI/game one-shots. No sample files.

import type { VehicleClass } from '../core/vehicles';

/** Engine voice per vehicle class: pitch scale, the pseudo gearbox (km/h per gear) and the filter's base. */
interface Voice {
  pitch: number;
  gears: readonly number[];
  filter: number;
}
const VOICES: Record<VehicleClass, Voice> = {
  car: { pitch: 1, gears: [0, 60, 120, 185, 255, 340, 1000], filter: 500 },
  // A high, buzzy single; it shifts often.
  bike: { pitch: 1.7, gears: [0, 70, 130, 190, 250, 320, 1000], filter: 700 },
  // A low rumble with short gears (top speed about 277 km/h).
  truck: { pitch: 0.55, gears: [0, 40, 80, 125, 170, 220, 1000], filter: 350 },
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineA!: OscillatorNode;
  private engineB!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private skidGain!: GainNode;
  /** The nitro's roar: a noise loop heard only while it pushes (drive's `boost`). */
  private jetGain!: GainNode;
  private noise!: AudioBuffer;
  private volume = 0.7;
  private running = false;
  private voice: Voice = VOICES.car;
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
    for (const g of [this.engineGain, this.windGain, this.skidGain, this.jetGain]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0, t);
    }
    this.targets.fill(NaN);
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
    this.jetGain = this.loopNoise('bandpass', 1400, 0.9);
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

  /** The engine sound of the vehicle class being driven (set when a race, replay or the menu car starts). */
  setVoice(vehicle: VehicleClass): void {
    this.voice = VOICES[vehicle] ?? VOICES.car;
  }

  /** Continuous sounds; call every frame while driving. `boost` is the nitro push 0..1 (CarView.boost). */
  drive(speedKmh: number, throttle: number, slip: number, grounded: boolean, boost = 0): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.running = true;
    // Pseudo gearbox: pitch climbs within a gear then drops back.
    const { gears, pitch, filter } = this.voice;
    let g = 1;
    while (g < gears.length - 1 && speedKmh > gears[g]) g++;
    const lo = gears[g - 1], hi = gears[g];
    const within = Math.min(1, (speedKmh - lo) / (hi - lo));
    const base = (70 + g * 12 + within * (110 + g * 10)) * pitch;
    const f = grounded ? base : base * 1.15;
    this.target(0, this.engineA.frequency, f, t, 0.04);
    this.target(1, this.engineB.frequency, f * 0.5, t, 0.04);
    // The nitro opens the engine's filter and adds its roar; both fall away with the push.
    this.target(2, this.engineFilter.frequency, filter + throttle * 1700 + speedKmh * 2 + boost * 900, t, 0.06);
    this.target(3, this.engineGain.gain, 0.07 + throttle * 0.08, t, 0.08);
    this.target(4, this.windGain.gain, Math.min(0.25, (speedKmh / 400) ** 2 * 0.3), t, 0.1);
    this.target(5, this.skidGain.gain, grounded ? Math.min(0.18, slip * 0.22) : 0, t, 0.05);
    this.target(6, this.jetGain.gain, boost * 0.16, t, boost > 0 ? 0.05 : 0.12);
  }

  /** Last target per drive() parameter; NaN = unknown (after silence or suspend). */
  private readonly targets = new Float64Array(7).fill(NaN);

  /**
   * setTargetAtTime, skipped when the target is within 0.5% of the one already set: drive() runs every
   * frame, and each call queues an event on the audio thread's timeline. The running approach to an
   * unchanged target simply carries on.
   */
  private target(i: number, p: AudioParam, v: number, t: number, tau: number): void {
    const last = this.targets[i];
    if (Math.abs(v - last) <= Math.max(1e-4, Math.abs(last) * 0.005)) return;
    this.targets[i] = v;
    p.setTargetAtTime(v, t, tau);
  }

  silence(): void {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    this.targets.fill(NaN);
    this.engineGain.gain.setTargetAtTime(0, t, 0.08);
    this.windGain.gain.setTargetAtTime(0, t, 0.08);
    this.skidGain.gain.setTargetAtTime(0, t, 0.05);
    this.jetGain.gain.setTargetAtTime(0, t, 0.08);
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

  /** The nitro fires: a rising whoosh over a low thump (the roar that follows is drive's `boost`). */
  nitro(): void {
    this.burst(250, 0.7, 0.4, 4200);
    this.tone(70, 0.35, 'sine', 0.3);
  }

  /** The nitro has recharged: two quiet pings, softer than a checkpoint. */
  nitroReady(): void {
    this.tone(1320, 0.12, 'triangle', 0.1);
    this.tone(1760, 0.16, 'triangle', 0.1, 0.08);
  }

  /** A press that cannot fire yet (the nitro is recharging). */
  deny(): void {
    this.tone(180, 0.08, 'square', 0.06);
  }

  impact(speed: number): void {
    this.burst(160, 0.25, Math.min(0.5, speed / 40));
  }

  /** A fall into water: a hiss of spray falling away over a low plunge (the respawn follows in 0.3 s). */
  splash(): void {
    this.burst(2400, 0.6, 0.4, 300);
    this.tone(85, 0.32, 'sine', 0.28);
  }

  click(): void {
    this.tone(880, 0.05, 'square', 0.06);
  }

  /**
   * Results card cues (src/ui/scoreCard.ts): medals land on rising notes, the secret author medal
   * charges up and then rings, and the record banner ticks. Through the master gain like every
   * one-shot, so the volume and the ad/portal mutes apply.
   */
  scoreCue(kind: string, n = 0): void {
    switch (kind) {
      case 'medal':
        this.tone([392, 523, 659, 784, 1047][n] ?? 784, 0.22, 'triangle', 0.18);
        break;
      case 'charge':
        this.burst(300, 0.55, 0.12, 2600);
        break;
      case 'author':
        [1047, 1319, 1568, 2093].forEach((f, k) => this.tone(f, 0.55, 'triangle', 0.15, k * 0.05));
        break;
      case 'banner':
        this.tone(1568, 0.1, 'square', 0.05);
        break;
    }
  }

  missing(): void {
    this.tone(220, 0.3, 'sawtooth', 0.12);
  }
}
