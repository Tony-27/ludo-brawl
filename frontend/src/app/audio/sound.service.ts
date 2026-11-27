import { Injectable, signal } from '@angular/core';
import type { SceneCue } from '../engine/presentation/event-player';

const MUSIC_KEY = 'ludo-brawl:music';
const SFX_KEY = 'ludo-brawl:sfx';

const BPM = 92;
const STEP = 60 / BPM / 4; // one 16th note
const LOOKAHEAD = 0.15;

// An original 8-bar adventure loop in D minor: Dm Bb F C | Dm Bb Gm A.
const CHORDS: number[][] = [
  [50, 53, 57],
  [46, 50, 53],
  [53, 57, 60],
  [48, 52, 55],
  [50, 53, 57],
  [46, 50, 53],
  [55, 58, 62],
  [45, 49, 52],
];

// [step, midi note, length in 16ths]
const MELODY: [number, number, number][][] = [
  [[0, 74, 4], [4, 77, 2], [6, 76, 2], [8, 74, 4], [12, 69, 4]],
  [[0, 70, 4], [4, 74, 4], [8, 77, 6], [14, 76, 2]],
  [[0, 72, 4], [4, 69, 2], [6, 72, 2], [8, 77, 4], [12, 76, 2], [14, 74, 2]],
  [[0, 72, 6], [6, 67, 2], [8, 72, 4], [12, 76, 4]],
  [[0, 74, 2], [2, 76, 2], [4, 77, 4], [8, 81, 4], [12, 79, 2], [14, 77, 2]],
  [[0, 79, 4], [4, 77, 2], [6, 74, 2], [8, 77, 8]],
  [[0, 74, 4], [4, 70, 4], [8, 74, 2], [10, 79, 2], [12, 77, 4]],
  [[0, 76, 6], [6, 73, 2], [8, 76, 4], [12, 69, 4]],
];

const ARP = [0, 1, 2, 3, 2, 1, 2, 1];
const BASS_STEPS = [0, 6, 8, 11, 14];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Procedural music and sound effects with the Web Audio API. Everything is
 * synthesised live, so there are no audio files to ship or license.
 */
@Injectable({ providedIn: 'root' })
export class SoundService {
  readonly musicOn = signal(localStorage.getItem(MUSIC_KEY) !== 'off');
  readonly sfxOn = signal(localStorage.getItem(SFX_KEY) !== 'off');

  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private reverb!: ConvolverNode;
  private noise!: AudioBuffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private loop = 0;

  constructor() {
    // Browsers only allow audio after a user gesture.
    const unlock = () => {
      this.ensure();
      if (this.musicOn()) this.startMusic();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  toggleMusic() {
    const on = !this.musicOn();
    this.musicOn.set(on);
    localStorage.setItem(MUSIC_KEY, on ? 'on' : 'off');
    this.ensure();
    if (on) this.startMusic();
    else this.stopMusic();
  }

  toggleSfx() {
    const on = !this.sfxOn();
    this.sfxOn.set(on);
    localStorage.setItem(SFX_KEY, on ? 'on' : 'off');
    if (on) this.play('click');
  }

  // ---------------------------------------------------------------- engine
  private ensure(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(this.master);

    // Generated hall reverb.
    this.reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.4;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    this.reverb.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.reverb.connect(wet).connect(this.master);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    return ctx;
  }

  private startMusic() {
    const ctx = this.ensure();
    if (!ctx || this.timer) return;
    this.musicBus.gain.cancelScheduledValues(ctx.currentTime);
    this.musicBus.gain.setTargetAtTime(0.42, ctx.currentTime, 0.6);
    this.nextTime = ctx.currentTime + 0.1;
    this.step = 0;
    this.bar = 0;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  private stopMusic() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ctx) this.musicBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  private schedule() {
    const ctx = this.ctx!;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.nextTime);
      this.nextTime += STEP;
      if (++this.step === 16) {
        this.step = 0;
        if (++this.bar === 8) {
          this.bar = 0;
          this.loop++;
        }
      }
    }
  }

  private playStep(t: number) {
    const chord = CHORDS[this.bar];
    const s = this.step;
    const withMelody = this.loop % 3 !== 0;

    if (s === 0) this.pad(t, chord, STEP * 16);
    if (BASS_STEPS.includes(s)) this.bass(t, chord[0] - 12, s === 0 ? STEP * 5 : STEP * 2);
    if (s % 2 === 0) {
      const i = ARP[(s / 2) % ARP.length];
      const note = i === 3 ? chord[0] + 12 : chord[i] + 12;
      this.pluck(t, note, STEP * 3, withMelody ? 0.07 : 0.1);
    }
    if (withMelody) {
      for (const [at, note, len] of MELODY[this.bar]) if (at === s) this.lead(t, note, len * STEP);
    }
    // Drums: kick, frame drum and a soft shaker.
    if (s === 0 || s === 8 || (s === 10 && this.bar % 2 === 1)) this.kick(t);
    if (s === 4 || s === 12) this.tom(t);
    this.shaker(t, s % 4 === 2 ? 0.05 : 0.022);
  }

  // ---------------------------------------------------------------- instruments
  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private osc(type: OscillatorType, freq: number, t: number, dur: number, out: AudioNode) {
    const o = this.ctx!.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private pluck(t: number, midi: number, dur: number, vol: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(500, t + dur);
    this.env(g, t, vol, 0.004, dur);
    g.connect(f);
    f.connect(this.musicBus);
    f.connect(this.reverb);
    this.osc('triangle', hz(midi), t, dur, g);
    this.osc('square', hz(midi) * 1.003, t, dur, g).detune.value = 4;
  }

  private bass(t: number, midi: number, dur: number) {
    const g = this.ctx!.createGain();
    this.env(g, t, 0.22, 0.01, dur);
    g.connect(this.musicBus);
    this.osc('triangle', hz(midi), t, dur, g);
    this.osc('sine', hz(midi - 12), t, dur, g);
  }

  private lead(t: number, midi: number, dur: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085, t + 0.05);
    g.gain.setValueAtTime(0.085, t + Math.max(0.06, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    g.connect(this.musicBus);
    g.connect(this.reverb);
    const vib = ctx.createOscillator();
    const vibAmt = ctx.createGain();
    vib.frequency.value = 5.2;
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(hz(midi) * 0.006, t + 0.25);
    vib.connect(vibAmt);
    const a = this.osc('sine', hz(midi), t, dur + 0.15, g);
    const b = this.osc('triangle', hz(midi) * 2, t, dur + 0.15, g);
    b.detune.value = -6;
    vibAmt.connect(a.frequency);
    vib.start(t);
    vib.stop(t + dur + 0.2);
  }

  private pad(t: number, chord: number[], dur: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03, t + 0.6);
    g.gain.setValueAtTime(0.03, t + dur - 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    g.connect(f);
    f.connect(this.musicBus);
    f.connect(this.reverb);
    for (const n of chord) {
      this.osc('sawtooth', hz(n), t, dur + 0.3, g).detune.value = -7;
      this.osc('sawtooth', hz(n), t, dur + 0.3, g).detune.value = 7;
    }
  }

  private kick(t: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    this.env(g, t, 0.45, 0.003, 0.22);
    g.connect(this.musicBus);
    const o = this.osc('sine', 130, t, 0.25, g);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  }

  private tom(t: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    this.env(g, t, 0.18, 0.003, 0.2);
    g.connect(this.musicBus);
    g.connect(this.reverb);
    const o = this.osc('sine', 210, t, 0.22, g);
    o.frequency.exponentialRampToValueAtTime(110, t + 0.15);
    this.noiseHit(t, 0.06, 0.04, 'bandpass', 1800, this.musicBus);
  }

  private shaker(t: number, vol: number) {
    this.noiseHit(t, vol, 0.045, 'highpass', 7000, this.musicBus);
  }

  private noiseHit(t: number, vol: number, dur: number, type: BiquadFilterType, freq: number, out: AudioNode) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    this.env(g, t, vol, 0.002, dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  private tone(t: number, type: OscillatorType, from: number, to: number, dur: number, vol: number, verb = false) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    this.env(g, t, vol, 0.005, dur);
    g.connect(this.sfxBus);
    if (verb) g.connect(this.reverb);
    const o = this.osc(type, from, t, dur, g);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  }

  private notes(t: number, midis: number[], gap: number, type: OscillatorType, vol: number, len = 0.25) {
    midis.forEach((m, i) => this.tone(t + i * gap, type, hz(m), hz(m), len, vol, true));
  }

  // ---------------------------------------------------------------- sound effects
  play(name: 'dice' | 'yourTurn' | 'gameOver' | 'click' | 'hop' | 'victory' | SceneCue) {
    if (!this.sfxOn()) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    switch (name) {
      case 'dice': {
        let at = t;
        for (let i = 0; i < 7; i++) {
          this.noiseHit(at, 0.25 - i * 0.02, 0.03, 'bandpass', 2500 + Math.random() * 1500, this.sfxBus);
          at += 0.04 + Math.random() * 0.06 + i * 0.008;
        }
        this.tone(at, 'square', 900, 700, 0.05, 0.05);
        this.noiseHit(at, 0.3, 0.06, 'bandpass', 1800, this.sfxBus);
        break;
      }
      case 'hop':
      case 'step':
        this.noiseHit(t, 0.06, 0.04, 'lowpass', 700, this.sfxBus);
        this.tone(t, 'sine', 140, 90, 0.06, 0.08);
        break;
      case 'cast':
        this.tone(t, 'triangle', 300, 900, 0.45, 0.07, true);
        this.noiseHit(t, 0.06, 0.4, 'bandpass', 2400, this.sfxBus);
        break;
      case 'slash':
        this.noiseHit(t, 0.35, 0.22, 'highpass', 2500, this.sfxBus);
        this.tone(t, 'sawtooth', 900, 200, 0.2, 0.05);
        break;
      case 'zap':
        for (let i = 0; i < 6; i++) this.noiseHit(t + i * 0.03, 0.3, 0.05, 'bandpass', 3000 + i * 400, this.sfxBus);
        this.tone(t, 'square', 1800, 120, 0.35, 0.08, true);
        this.tone(t + 0.05, 'sine', 90, 40, 0.5, 0.5);
        break;
      case 'blink':
        this.tone(t, 'sine', 400, 1600, 0.25, 0.1, true);
        this.tone(t + 0.25, 'sine', 1600, 600, 0.25, 0.08, true);
        break;
      case 'blocked':
        this.tone(t, 'triangle', 1500, 1400, 0.4, 0.12, true);
        this.tone(t, 'triangle', 2250, 2100, 0.3, 0.06, true);
        break;
      case 'mana':
        this.notes(t, [86, 90, 93], 0.06, 'sine', 0.08, 0.3);
        break;
      case 'summon':
        this.notes(t, [62, 69, 74, 81], 0.06, 'triangle', 0.12, 0.2);
        this.noiseHit(t, 0.08, 0.35, 'bandpass', 1200, this.sfxBus);
        break;
      case 'charge':
        this.tone(t, 'sawtooth', 180, 640, 0.3, 0.07);
        break;
      case 'hit':
        this.noiseHit(t, 0.7, 0.18, 'lowpass', 1600, this.sfxBus);
        this.tone(t, 'sine', 160, 38, 0.35, 0.7);
        this.tone(t, 'square', 1250, 900, 0.12, 0.08, true);
        this.tone(t + 0.01, 'triangle', 2600, 2400, 0.25, 0.05, true);
        break;
      case 'launch':
        this.tone(t + 0.05, 'sine', 1500, 380, 0.95, 0.09);
        break;
      case 'land':
        this.tone(t, 'sine', 110, 50, 0.16, 0.4);
        this.noiseHit(t, 0.2, 0.08, 'lowpass', 600, this.sfxBus);
        break;
      case 'victory':
        this.notes(t, [72, 76, 79], 0.08, 'square', 0.06, 0.16);
        break;
      case 'home':
        this.notes(t, [74, 78, 81, 86, 90], 0.07, 'triangle', 0.13, 0.4);
        break;
      case 'finish':
        this.notes(t, [62, 66, 69, 74], 0.12, 'square', 0.07, 0.3);
        this.notes(t + 0.5, [74, 78, 81, 86], 0.0, 'triangle', 0.08, 1.0);
        break;
      case 'yourTurn':
        this.notes(t, [79, 84], 0.11, 'sine', 0.14, 0.45);
        break;
      case 'gameOver':
        this.notes(t, [62, 62, 62, 66, 69], 0.14, 'square', 0.07, 0.22);
        this.notes(t + 0.75, [74, 78, 81, 86], 0.0, 'triangle', 0.09, 1.6);
        this.notes(t + 0.75, [50, 57], 0.0, 'sawtooth', 0.04, 1.6);
        break;
      case 'click':
        this.tone(t, 'sine', 900, 1200, 0.05, 0.06);
        break;
    }
  }

}
