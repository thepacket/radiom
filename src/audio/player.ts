import { decodePcmBe } from '../kiwi/protocol';
import type { AudioFrame } from '../kiwi/types';
import { AdpcmDecoder } from './adpcm';

type LogFn = (s: string) => void;

/** Plays Kiwi audio through Web Audio. Uses AudioWorklet when available
 *  (secure contexts) and falls back to ScriptProcessorNode for insecure
 *  contexts like Android Chrome served over plain HTTP/LAN-IP. */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  // Central mixer. Both Kiwi (when connected) and TEST sample sources feed
  // into it; mixer → speakers + SPEC analyser. Lives for the entire app
  // lifetime once created — disconnect/reconnect of a source never tears
  // it down, which is what keeps test playback alive across Kiwi power
  // cycles and SPEC tapped-in regardless of who's the input source.
  private mixer: GainNode | null = null;
  /** Inline notch on the speaker path (mixer → notch → destination).
   *  Parked at 20 kHz when disabled. Driven by setNotchFreq() when the
   *  shell's auto-notch detector locks onto a carrier. */
  private notch: BiquadFilterNode | null = null;
  /** AMN (Adaptive Multi-Notch / auto-comb) — three additional notches
   *  chained after `notch`. Each can be steered independently by the
   *  shell's `tickAmnotch`, parked at 20 kHz when unused. */
  private notch2: BiquadFilterNode | null = null;
  private notch3: BiquadFilterNode | null = null;
  private notch4: BiquadFilterNode | null = null;
  /** Five peaking biquads forming the audio output equaliser. Frequencies
   *  fixed at 150 / 400 / 1000 / 2500 / 5000 Hz; per-band gain user-adjustable
   *  via setEqGain(band, db). All start at 0 dB. */
  private eqBands: BiquadFilterNode[] = [];
  static readonly EQ_FREQS = [150, 400, 1000, 2500, 5000] as const;
  /** Voice-tracking bandpass on the speaker path: mixer → notch → vBp →
   *  destination. When disabled the biquad is set to type='allpass' so it
   *  is magnitude-transparent. When enabled, a periodic loop estimates the
   *  spectral centroid of the speech band (200-3400 Hz) and smoothly
   *  drives the bandpass centre frequency + Q to follow the voice. */
  private vBp: BiquadFilterNode | null = null;
  private vAnalyser: AnalyserNode | null = null;
  /** VTRK2 — three-band formant-driven enhancer. Sits in series after the
   *  single-band VTRK (vBp). Three peaking biquads track F1, F2, F3 from
   *  the post-notch analyser. Default magnitude-transparent (allpass) so
   *  this stage is a no-op when VTRK2 is off. */
  private vBp1: BiquadFilterNode | null = null;
  private vBp2: BiquadFilterNode | null = null;
  private vBp3: BiquadFilterNode | null = null;
  private vTrack2Enabled = false;
  private vTrack2Timer: number | null = null;
  private vTrack2GainDb = 9;
  private vTrack2F1 = 600;
  private vTrack2F2 = 1500;
  private vTrack2F3 = 2700;
  /** VTRK3 — LPC-driven formant enhancer. Same biquad topology as VTRK2
   *  (three peaking stages in series) but the F1/F2/F3 estimates come
   *  from a real LPC spectral envelope (Levinson-Durbin) instead of an
   *  FFT peak-picker. Cleaner under noise; not biased by pitch harmonics. */
  private vBp1L: BiquadFilterNode | null = null;
  private vBp2L: BiquadFilterNode | null = null;
  private vBp3L: BiquadFilterNode | null = null;
  private vTrack3Enabled = false;
  private vTrack3Timer: number | null = null;
  private vTrack3GainDb = 9;
  private vTrack3F1 = 600;
  private vTrack3F2 = 1500;
  private vTrack3F3 = 2700;
  /** VTRK3 anti-formant stage. Two notch biquads tuned to the geometric
   *  mean of consecutive formant pairs (F1↔F2 and F2↔F3) — i.e. the
   *  inter-formant valleys. Suppressing those valleys sharpens the
   *  spectral envelope without amplifying anything, complementing the
   *  +9 dB peaking stage rather than stacking on it. Allpass when off. */
  private vAnt12: BiquadFilterNode | null = null;
  private vAnt23: BiquadFilterNode | null = null;
  private vAntEnabled = false;
  /** Tail of the post-formant chain. The de-clicker worklet may be
   *  spliced between vBp3L and dhisOut once it finishes loading. */
  private dhisOut: GainNode | null = null;
  /** DCK — Hampel-filter de-clicker / sferic suppressor. */
  private dckNode: AudioWorkletNode | null = null;
  private dckLoading: Promise<void> | null = null;
  private declickEnabled = false;
  private declickK = 3.0;
  /** RFW — RNNoise GRU noise reducer (JakenHerman/RFWhisper integration). */
  private rfwNode: AudioWorkletNode | null = null;
  private rfwLoading: Promise<void> | null = null;
  private rfwEnabled = false;
  private rfwStrength = 0.8;
  /** NB2 — port of Warren Pratt's WDSP NB2 impulse blanker. Operates on
   *  the audio domain (post-demod) inserted between rfwNode and dhisOut. */
  private nb2Node: AudioWorkletNode | null = null;
  private nb2Loading: Promise<void> | null = null;
  private nb2Enabled = false;
  private nb2K = 5.0;
  /** PS — Pitch shifter (two-pointer crossfade). Last in the dhisOut
   *  insert chain so pitch shifting happens after every other DSP. */
  private pshiftNode: AudioWorkletNode | null = null;
  private pshiftLoading: Promise<void> | null = null;
  private pshiftEnabled = false;
  private pshiftSemitones = 0;
  private vTrackEnabled = false;
  private vTrackTimer: number | null = null;
  private vTrackCenter = 1500;
  private vTrackGainDb = 9;
  /** Pre-notch analyser tap so the auto-notch detector can still see the
   *  carrier it's trying to remove. */
  private preNotchAnalyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private spnode: ScriptProcessorNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private compMakeup: GainNode | null = null;  // +6 dB after compressor
  private compEnabled = false;
  private srcNode: AudioNode | null = null;
  private inputRate = 12000;
  private resamplePhase = 0;
  private resampleLast = 0;
  private gain = 1;
  /** When true, Kiwi audio frames are dropped on entry to pushAudio so they
   *  reach neither the audio graph (speakers/SPEC) nor the decoder fan-out.
   *  This is the AUX flag — it does NOT silence the speaker; it just swaps
   *  the input source. injectTestSamples() bypasses this gate so a TEST
   *  sample becomes the sole input app-wide while AUX is on. */
  private blockKiwi = false;

  // Main-thread ring buffer used only by the ScriptProcessor fallback.
  private ring = new Float32Array(48000);
  private ringR = 0;
  private ringW = 0;
  private ringSize = 0;

  /** Lazily build the AudioContext + central mixer + SPEC analyser. Idempotent.
   *  Both Kiwi connect (`start()`) and TEST playback (`playTestBuffer()`)
   *  call this; whichever runs first creates the shared graph. */
  private ensureGraph(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof AudioContext === 'undefined') return null;
    let ctx: AudioContext;
    try { ctx = new AudioContext(); } catch { return null; }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    this.ctx = ctx;

    // Mixer: every audio source connects here; mixer → notch → speakers
    // + analyser. The notch sits inline always; when disabled it parks at
    // 20 kHz (well above the audio band) with low Q, so it has no
    // audible effect.
    const m = ctx.createGain();
    m.gain.value = 1;
    const n = ctx.createBiquadFilter();
    n.type = 'notch';
    n.frequency.value = 20000;
    n.Q.value = 30;
    // AMN (Adaptive Multi-Notch / auto-comb) — three additional notch
    // biquads chained after the primary `n`. All four are normally
    // parked at 20 kHz. The shell's amnotch ticker assigns each to a
    // detected carrier so up to 4 heterodynes can be nulled at once.
    const mkNotch = () => {
      const b = ctx.createBiquadFilter();
      b.type = 'notch';
      b.frequency.value = 20000;
      b.Q.value = 30;
      return b;
    };
    const n2 = mkNotch(), n3 = mkNotch(), n4 = mkNotch();
    // Voice-tracking bandpass — sits between notch and destination.
    // Default magnitude-transparent (allpass) so it has no effect when
    // VTRK is off. setVoiceTrackEnabled flips it to bandpass and starts
    // the tracker.
    const vBp = ctx.createBiquadFilter();
    vBp.type = 'allpass';
    vBp.frequency.value = 1500;
    vBp.Q.value = 1;
    // Analyser tap on the post-notch signal — the tracker reads its FFT
    // to find where voice energy actually is in the channel.
    const vAn = ctx.createAnalyser();
    vAn.fftSize = 2048;
    vAn.smoothingTimeConstant = 0.5;
    vAn.minDecibels = -100;
    vAn.maxDecibels = -10;
    // Three peaking biquads in series for VTRK2 (formant-driven). Default
    // allpass = transparent.
    const mkPeak = (f: number) => {
      const b = ctx.createBiquadFilter();
      b.type = 'allpass';
      b.frequency.value = f;
      b.Q.value = 1.5;
      return b;
    };
    const vBp1 = mkPeak(600);
    const vBp2 = mkPeak(1500);
    const vBp3 = mkPeak(2700);
    const vBp1L = mkPeak(600);
    const vBp2L = mkPeak(1500);
    const vBp3L = mkPeak(2700);
    // Anti-formant notches (VTRK3 stage 2). Allpass = transparent until
    // setVoiceTrackAntiFormantEnabled(true) flips them to notch.
    const mkAnt = (f: number) => {
      const b = ctx.createBiquadFilter();
      b.type = 'allpass';
      b.frequency.value = f;
      b.Q.value = 8.0;
      return b;
    };
    const vAnt12 = mkAnt(Math.sqrt(600 * 1500));   // ~948 Hz default
    const vAnt23 = mkAnt(Math.sqrt(1500 * 2700));  // ~2012 Hz default
    // dhisOut: a GainNode placeholder that terminates the formant chain.
    // On graph init it just routes vBp3L → vAnt12 → vAnt23 → destination.
    // When the de-clicker AudioWorklet loads, it gets spliced in between
    // vAnt23 and dhisOut.
    const dhisOut = ctx.createGain();
    dhisOut.gain.value = 1;
    // 5-band peaking EQ inserted between the audio chain output (dhisOut)
    // and the destination. Bands tuned for HF/SSB voice + broadcast AM:
    // 150 Hz (bass), 400 Hz (warmth), 1 kHz (presence), 2.5 kHz (clarity),
    // 5 kHz (air). All start at 0 dB = transparent.
    const eqBands: BiquadFilterNode[] = [];
    const eqFreqs = [150, 400, 1000, 2500, 5000];
    for (const f of eqFreqs) {
      const b = ctx.createBiquadFilter();
      b.type = 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      eqBands.push(b);
    }
    m.connect(n);
    n.connect(n2);
    n2.connect(n3);
    n3.connect(n4);
    n4.connect(vBp);
    n4.connect(vAn);
    vBp.connect(vBp1);
    vBp1.connect(vBp2);
    vBp2.connect(vBp3);
    vBp3.connect(vBp1L);
    vBp1L.connect(vBp2L);
    vBp2L.connect(vBp3L);
    vBp3L.connect(vAnt12);
    vAnt12.connect(vAnt23);
    vAnt23.connect(dhisOut);
    // Chain the EQ bands: dhisOut → eq[0] → eq[1] → … → destination.
    let prev: AudioNode = dhisOut;
    for (const b of eqBands) { prev.connect(b); prev = b; }
    prev.connect(ctx.destination);
    this.mixer = m;
    this.notch = n;
    this.notch2 = n2;
    this.notch3 = n3;
    this.notch4 = n4;
    this.eqBands = eqBands;
    this.vBp = vBp;
    this.vBp1 = vBp1;
    this.vBp2 = vBp2;
    this.vBp3 = vBp3;
    this.vBp1L = vBp1L;
    this.vBp2L = vBp2L;
    this.vBp3L = vBp3L;
    this.vAnt12 = vAnt12;
    this.vAnt23 = vAnt23;
    this.dhisOut = dhisOut;
    this.vAnalyser = vAn;

    // SPEC analyser tapped off the mixer so it always sees whatever is
    // playing — Kiwi, TEST, or both.
    const a = ctx.createAnalyser();
    a.fftSize = 16384;
    a.smoothingTimeConstant = 0.6;
    a.minDecibels = -100;
    a.maxDecibels = -20;
    const sink = ctx.createGain();
    sink.gain.value = 0;
    try { m.connect(a); } catch {}
    // 0-gain sink keeps Chrome pulling audio through the analyser; the
    // audio graph holds the only reference, no field needed.
    try { a.connect(sink); sink.connect(ctx.destination); } catch {}
    this.analyser = a;

    // Pre-notch analyser — same FFT settings, but tapped on the *raw*
    // mixer output (before the notch) so the auto-notch carrier finder
    // can still see the carrier it's supposed to be killing.
    const an2 = ctx.createAnalyser();
    an2.fftSize = 4096;
    an2.smoothingTimeConstant = 0.4;
    an2.minDecibels = -100;
    an2.maxDecibels = -20;
    const sink2 = ctx.createGain();
    sink2.gain.value = 0;
    try { m.connect(an2); an2.connect(sink2); sink2.connect(ctx.destination); } catch {}
    this.preNotchAnalyser = an2;
    return ctx;
  }

  /** Public access for the auto-notch carrier-finder loop. Snapshot the
   *  pre-notch (= post-mixer) magnitude spectrum into a fresh Uint8Array. */
  getPreNotchSpectrum(): { mag: Uint8Array; sampleRate: number; fftSize: number } | null {
    if (!this.ctx || !this.preNotchAnalyser) return null;
    const N = this.preNotchAnalyser.frequencyBinCount;
    const out = new Uint8Array(N);
    this.preNotchAnalyser.getByteFrequencyData(out);
    return { mag: out, sampleRate: this.ctx.sampleRate, fftSize: this.preNotchAnalyser.fftSize };
  }

  /** Park the notch outside the audio band (= effectively disabled). */
  setNotchEnabled(on: boolean): void {
    if (!this.notch) return;
    if (!on) this.notch.frequency.setTargetAtTime(20000, this.ctx?.currentTime ?? 0, 0.01);
  }
  /** Place the notch at `hz`. Called on each carrier-detector tick. */
  setNotchFreq(hz: number): void {
    if (!this.notch || !this.ctx) return;
    const t = this.ctx.currentTime;
    // Smooth retune so step changes don't click in the audio output.
    this.notch.frequency.setTargetAtTime(hz, t, 0.05);
  }
  /** AMN — assign 0..4 audio-band frequencies to the cascade of four
   *  notch biquads (notch + notch2/3/4). Unused slots park at 20 kHz.
   *  Smooth retune so reshuffles don't click. */
  setMultiNotchFreqs(hzList: number[]): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const slots = [this.notch, this.notch2, this.notch3, this.notch4];
    for (let i = 0; i < slots.length; i++) {
      const b = slots[i];
      if (!b) continue;
      const f = i < hzList.length && hzList[i] > 0 ? hzList[i] : 20000;
      b.frequency.setTargetAtTime(f, t, 0.05);
    }
  }
  /** Per-band EQ gain in dB. Smoothed via setTargetAtTime so slider
   *  drags don't zipper. Band index is 0..4 matching `EQ_FREQS`. */
  setEqGain(band: number, db: number): void {
    if (!this.ctx) return;
    const b = this.eqBands[band];
    if (!b) return;
    b.gain.setTargetAtTime(Math.max(-15, Math.min(15, db)), this.ctx.currentTime, 0.02);
  }
  /** Read the current EQ gain settings (post-init only). Returns 0s
   *  before the audio graph is built. */
  getEqGains(): number[] {
    return this.eqBands.map(b => b.gain.value);
  }

  /** Park all four AMN notches at 20 kHz (effectively disabled). */
  parkAllNotches(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const b of [this.notch, this.notch2, this.notch3, this.notch4]) {
      if (b) b.frequency.setTargetAtTime(20000, t, 0.01);
    }
  }

  /** Toggle the voice-tracking enhancer. Off = allpass (transparent).
   *  On = peaking EQ that *boosts* the dominant speech-band centroid by
   *  ~9 dB while leaving the rest of the spectrum unchanged. This makes
   *  the voice come forward without carving out the surrounding energy
   *  the way a bandpass would. */
  setVoiceTrackEnabled(on: boolean): void {
    this.vTrackEnabled = !!on;
    this.ensureGraph();
    if (!this.vBp || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.vTrackEnabled) {
      this.vBp.type = 'peaking';
      this.vBp.gain.setTargetAtTime(this.vTrackGainDb, t, 0.05);
      this.vBp.Q.setTargetAtTime(0.9, t, 0.05);
      if (this.vTrackTimer == null) {
        this.vTrackTimer = (typeof window !== 'undefined' ? window : globalThis as any)
          .setInterval(() => this.voiceTrackTick(), 80) as unknown as number;
      }
    } else {
      this.vBp.type = 'allpass';
      this.vBp.gain.setTargetAtTime(0, t, 0.05);
      this.vBp.frequency.setTargetAtTime(1500, t, 0.05);
      this.vBp.Q.setTargetAtTime(1, t, 0.05);
      if (this.vTrackTimer != null) {
        clearInterval(this.vTrackTimer);
        this.vTrackTimer = null;
      }
    }
  }

  isVoiceTrackEnabled(): boolean { return this.vTrackEnabled; }
  getVoiceTrackCenter(): number  { return this.vTrackCenter; }

  /** Set the peaking-EQ boost (dB) used when VTRK is on. Live-applied. */
  setVoiceTrackGain(db: number): void {
    if (!Number.isFinite(db)) return;
    this.vTrackGainDb = Math.max(0, Math.min(18, db));
    if (this.vTrackEnabled && this.vBp && this.ctx) {
      this.vBp.gain.setTargetAtTime(this.vTrackGainDb, this.ctx.currentTime, 0.05);
    }
  }

  /** Pull a magnitude spectrum off the post-notch tap, find the energy
   *  centroid inside the speech band (200-3400 Hz), and ease the bandpass
   *  centre frequency toward it. The Q is also softly modulated by how
   *  peaky the spectrum is so steady tones get a tighter filter than wide
   *  speech. */
  private voiceTrackTick(): void {
    if (!this.vTrackEnabled || !this.vAnalyser || !this.ctx || !this.vBp) return;
    const N = this.vAnalyser.frequencyBinCount;
    const buf = new Uint8Array(N);
    this.vAnalyser.getByteFrequencyData(buf);
    const sr = this.ctx.sampleRate;
    const binHz = sr / this.vAnalyser.fftSize;
    const lo = Math.max(1, Math.floor(200  / binHz));
    const hi = Math.min(N - 1, Math.ceil(3400 / binHz));
    let sumW = 0, sumWF = 0, sumW2 = 0, peak = 0;
    for (let i = lo; i <= hi; i++) {
      // 0..255 → linear-ish weight; bias up to suppress noise floor.
      const w = Math.max(0, buf[i] - 80);
      const f = i * binHz;
      sumW  += w;
      sumWF += w * f;
      sumW2 += w * w;
      if (buf[i] > peak) peak = buf[i];
    }
    // Voice activity gate: not enough energy → freeze, don't chase noise.
    if (sumW < 200 || peak < 110) return;
    const centroid = sumWF / sumW;
    // Variance → spread (hi var = wider speech, lo var = tone). Map to Q.
    let mean = centroid;
    let varSum = 0;
    for (let i = lo; i <= hi; i++) {
      const w = Math.max(0, buf[i] - 80);
      const f = i * binHz;
      const d = f - mean;
      varSum += w * d * d;
    }
    const sigma = Math.sqrt(varSum / Math.max(1, sumW));
    // Peaking-EQ tracker: keep the boost generously wide (low Q) so a wide
    // chunk of voice energy gets the lift, not just one formant. Sigma
    // mostly modulates Q so a tight tone gets a slightly tighter peak.
    const targetQ = Math.max(0.6, Math.min(1.4, 900 / Math.max(180, sigma)));
    // Slow single-pole smoothing on the centre — voice formants drift
    // slowly, hf chasing just makes the EQ wobble audibly.
    this.vTrackCenter = this.vTrackCenter * 0.92 + centroid * 0.08;
    // Clamp to the expected human-voice region so deep noise valleys can't
    // drag the boost below ~400 Hz or up into hiss above ~2500 Hz.
    const f = Math.max(400, Math.min(2500, this.vTrackCenter));
    const t = this.ctx.currentTime;
    this.vBp.frequency.setTargetAtTime(f, t, 0.1);
    this.vBp.Q.setTargetAtTime(targetQ, t, 0.1);
  }

  /** Toggle VTRK2 — three-band formant-driven enhancer. When on, three
   *  peaking biquads track F1/F2/F3 of the live audio; when off, they
   *  revert to allpass (transparent). VTRK and VTRK2 are independent —
   *  they sit in series, so both can be on at once. */
  setVoiceTrack2Enabled(on: boolean): void {
    this.vTrack2Enabled = !!on;
    this.ensureGraph();
    if (!this.vBp1 || !this.vBp2 || !this.vBp3 || !this.ctx) return;
    const t = this.ctx.currentTime;
    const stages = [this.vBp1, this.vBp2, this.vBp3];
    if (this.vTrack2Enabled) {
      // Slightly tighter Q than single-band VTRK so three peaks don't
      // overlap into one fat boost. F1 is wider (vowels move it most),
      // F2/F3 narrower.
      stages[0].type = 'peaking';
      stages[1].type = 'peaking';
      stages[2].type = 'peaking';
      stages[0].Q.setTargetAtTime(1.4, t, 0.05);
      stages[1].Q.setTargetAtTime(2.0, t, 0.05);
      stages[2].Q.setTargetAtTime(2.4, t, 0.05);
      // Distribute the boost: F1 full, F2 full, F3 ~70% (less perceptually
      // important and easier to overshoot).
      const g = this.vTrack2GainDb;
      stages[0].gain.setTargetAtTime(g,         t, 0.05);
      stages[1].gain.setTargetAtTime(g,         t, 0.05);
      stages[2].gain.setTargetAtTime(g * 0.7,   t, 0.05);
      if (this.vTrack2Timer == null) {
        this.vTrack2Timer = (typeof window !== 'undefined' ? window : globalThis as any)
          .setInterval(() => this.voiceTrack2Tick(), 70) as unknown as number;
      }
    } else {
      for (const s of stages) {
        s.type = 'allpass';
        s.gain.setTargetAtTime(0, t, 0.05);
        s.Q.setTargetAtTime(1, t, 0.05);
      }
      stages[0].frequency.setTargetAtTime(600,  t, 0.05);
      stages[1].frequency.setTargetAtTime(1500, t, 0.05);
      stages[2].frequency.setTargetAtTime(2700, t, 0.05);
      if (this.vTrack2Timer != null) {
        clearInterval(this.vTrack2Timer);
        this.vTrack2Timer = null;
      }
    }
  }

  isVoiceTrack2Enabled(): boolean { return this.vTrack2Enabled; }
  getVoiceTrack2Formants(): { f1: number; f2: number; f3: number } {
    return { f1: this.vTrack2F1, f2: this.vTrack2F2, f3: this.vTrack2F3 };
  }

  /** Set the peaking-EQ boost (dB) shared by all three VTRK2 stages. */
  setVoiceTrack2Gain(db: number): void {
    if (!Number.isFinite(db)) return;
    this.vTrack2GainDb = Math.max(0, Math.min(18, db));
    if (this.vTrack2Enabled && this.vBp1 && this.vBp2 && this.vBp3 && this.ctx) {
      const t = this.ctx.currentTime;
      this.vBp1.gain.setTargetAtTime(this.vTrack2GainDb,        t, 0.05);
      this.vBp2.gain.setTargetAtTime(this.vTrack2GainDb,        t, 0.05);
      this.vBp3.gain.setTargetAtTime(this.vTrack2GainDb * 0.7,  t, 0.05);
    }
  }

  /** Read the post-notch FFT, smooth into a formant envelope, find peaks
   *  in F1/F2/F3 search bands, and steer the three peaking biquads.
   *  Voicing-gated: if no clear voice energy, freeze the last positions
   *  and ride out the silence. */
  private voiceTrack2Tick(): void {
    if (!this.vTrack2Enabled || !this.vAnalyser || !this.ctx) return;
    if (!this.vBp1 || !this.vBp2 || !this.vBp3) return;
    const N = this.vAnalyser.frequencyBinCount;
    const buf = new Uint8Array(N);
    this.vAnalyser.getByteFrequencyData(buf);
    const sr = this.ctx.sampleRate;
    const binHz = sr / this.vAnalyser.fftSize;

    // Box-smooth ~120 Hz to flatten harmonics into formant envelopes.
    const winBins = Math.max(3, Math.round(120 / binHz) | 1);
    const half = winBins >> 1;
    const env = new Float32Array(N);
    let sum = 0;
    for (let i = 0; i < winBins && i < N; i++) sum += buf[i];
    for (let i = 0; i < N; i++) {
      const lo = i - half, hi = i + half + 1;
      if (i > 0) {
        const add = hi <= N ? buf[hi - 1] : 0;
        const drop = lo - 1 >= 0 ? buf[lo - 1] : 0;
        sum += add - drop;
      }
      const cnt = Math.min(hi, N) - Math.max(lo, 0);
      env[i] = cnt > 0 ? sum / cnt : 0;
    }

    // Voicing gate.
    const lo200  = Math.max(1, Math.floor(200  / binHz));
    const hi3500 = Math.min(N - 1, Math.ceil(3500 / binHz));
    let bandSum = 0, peak = 0;
    for (let i = lo200; i <= hi3500; i++) {
      bandSum += env[i];
      if (env[i] > peak) peak = env[i];
    }
    const bandAvg = bandSum / Math.max(1, hi3500 - lo200 + 1);
    if (bandAvg < 100 || peak < 130) return;   // freeze on silence

    const pickPeak = (loHz: number, hiHz: number): number => {
      const a = Math.max(1, Math.floor(loHz / binHz));
      const b = Math.min(N - 1, Math.ceil(hiHz / binHz));
      let bestI = -1, best = -Infinity;
      for (let i = a; i <= b; i++) {
        if (env[i] > best && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
          best = env[i]; bestI = i;
        }
      }
      if (bestI < 0) return 0;
      const yL = env[Math.max(0, bestI - 1)];
      const yC = env[bestI];
      const yR = env[Math.min(N - 1, bestI + 1)];
      const denom = (yL - 2 * yC + yR);
      const delta = denom !== 0 ? 0.5 * (yL - yR) / denom : 0;
      return (bestI + delta) * binHz;
    };

    const f1 = pickPeak(250, 1000);
    const f2 = pickPeak(Math.max(900, f1 + 200), 2500);
    const f3 = pickPeak(Math.max(2000, f2 + 300), 3500);
    if (f1 <= 0 || f2 <= 0 || f3 <= 0) return;

    // Smooth so peaks don't dance.
    this.vTrack2F1 = this.vTrack2F1 * 0.82 + f1 * 0.18;
    this.vTrack2F2 = this.vTrack2F2 * 0.85 + f2 * 0.15;
    this.vTrack2F3 = this.vTrack2F3 * 0.88 + f3 * 0.12;
    const t = this.ctx.currentTime;
    this.vBp1.frequency.setTargetAtTime(this.vTrack2F1, t, 0.08);
    this.vBp2.frequency.setTargetAtTime(this.vTrack2F2, t, 0.08);
    this.vBp3.frequency.setTargetAtTime(this.vTrack2F3, t, 0.08);
  }

  /** Toggle VTRK3 — LPC-driven formant enhancer. Same biquad topology as
   *  VTRK2 but the formant estimates come from a Levinson-Durbin LPC
   *  spectral envelope instead of FFT peak-picking. Independent from
   *  VTRK / VTRK2; all three can be on at once (heavy boost). */
  setVoiceTrack3Enabled(on: boolean): void {
    this.vTrack3Enabled = !!on;
    this.ensureGraph();
    if (!this.vBp1L || !this.vBp2L || !this.vBp3L || !this.ctx) return;
    const t = this.ctx.currentTime;
    const stages = [this.vBp1L, this.vBp2L, this.vBp3L];
    if (this.vTrack3Enabled) {
      stages[0].type = 'peaking';
      stages[1].type = 'peaking';
      stages[2].type = 'peaking';
      // Slightly tighter than VTRK2 — LPC tracks the formant centre
      // accurately, so a narrower boost is safe and more characteristic.
      stages[0].Q.setTargetAtTime(1.8, t, 0.05);
      stages[1].Q.setTargetAtTime(2.4, t, 0.05);
      stages[2].Q.setTargetAtTime(2.8, t, 0.05);
      const g = this.vTrack3GainDb;
      stages[0].gain.setTargetAtTime(g,         t, 0.05);
      stages[1].gain.setTargetAtTime(g,         t, 0.05);
      stages[2].gain.setTargetAtTime(g * 0.7,   t, 0.05);
      if (this.vTrack3Timer == null) {
        this.vTrack3Timer = (typeof window !== 'undefined' ? window : globalThis as any)
          .setInterval(() => this.voiceTrack3Tick(), 70) as unknown as number;
      }
    } else {
      for (const s of stages) {
        s.type = 'allpass';
        s.gain.setTargetAtTime(0, t, 0.05);
        s.Q.setTargetAtTime(1, t, 0.05);
      }
      stages[0].frequency.setTargetAtTime(600,  t, 0.05);
      stages[1].frequency.setTargetAtTime(1500, t, 0.05);
      stages[2].frequency.setTargetAtTime(2700, t, 0.05);
      if (this.vTrack3Timer != null) {
        clearInterval(this.vTrack3Timer);
        this.vTrack3Timer = null;
      }
    }
  }

  isVoiceTrack3Enabled(): boolean { return this.vTrack3Enabled; }
  getVoiceTrack3Formants(): { f1: number; f2: number; f3: number } {
    return { f1: this.vTrack3F1, f2: this.vTrack3F2, f3: this.vTrack3F3 };
  }

  /** Toggle the VTRK3 anti-formant second stage. When enabled, two
   *  notch biquads are placed at the geometric means of F1↔F2 and
   *  F2↔F3 (the inter-formant valleys), suppressing the spectral dips
   *  that sit between formants. Updated live by the LPC tracker when
   *  VTRK is on; uses default valleys (~948 Hz and ~2012 Hz) when VTRK
   *  is off. Allpass-transparent when disabled. */
  setVoiceTrackAntiFormantEnabled(on: boolean): void {
    this.vAntEnabled = !!on;
    this.ensureGraph();
    if (!this.vAnt12 || !this.vAnt23 || !this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.vAntEnabled) {
      this.vAnt12.type = 'notch';
      this.vAnt23.type = 'notch';
      this.vAnt12.Q.setTargetAtTime(8.0, t, 0.05);
      this.vAnt23.Q.setTargetAtTime(8.0, t, 0.05);
      // Seed at the current formant estimate if VTRK is running, or
      // sensible defaults otherwise.
      this.vAnt12.frequency.setTargetAtTime(
        Math.sqrt(this.vTrack3F1 * this.vTrack3F2), t, 0.05);
      this.vAnt23.frequency.setTargetAtTime(
        Math.sqrt(this.vTrack3F2 * this.vTrack3F3), t, 0.05);
    } else {
      this.vAnt12.type = 'allpass';
      this.vAnt23.type = 'allpass';
      this.vAnt12.Q.setTargetAtTime(1.0, t, 0.05);
      this.vAnt23.Q.setTargetAtTime(1.0, t, 0.05);
    }
  }
  isVoiceTrackAntiFormantEnabled(): boolean { return this.vAntEnabled; }

  setVoiceTrack3Gain(db: number): void {
    if (!Number.isFinite(db)) return;
    this.vTrack3GainDb = Math.max(0, Math.min(18, db));
    if (this.vTrack3Enabled && this.vBp1L && this.vBp2L && this.vBp3L && this.ctx) {
      const t = this.ctx.currentTime;
      this.vBp1L.gain.setTargetAtTime(this.vTrack3GainDb,        t, 0.05);
      this.vBp2L.gain.setTargetAtTime(this.vTrack3GainDb,        t, 0.05);
      this.vBp3L.gain.setTargetAtTime(this.vTrack3GainDb * 0.7,  t, 0.05);
    }
  }

  /** VTRK3 tick: pull a time-domain audio frame, run a 12-pole LPC
   *  analysis, evaluate the spectral envelope 1/|A(e^jω)|² on a 512-bin
   *  grid, peak-pick F1/F2/F3, smooth, and steer the three biquads.
   *  Voicing-gated by autocorrelation prediction-error energy. */
  private voiceTrack3Tick(): void {
    if (!this.vTrack3Enabled || !this.vAnalyser || !this.ctx) return;
    if (!this.vBp1L || !this.vBp2L || !this.vBp3L) return;
    const N = this.vAnalyser.fftSize;
    const x = new Float32Array(N);
    this.vAnalyser.getFloatTimeDomainData(x);
    const sr = this.ctx.sampleRate;

    // Pre-emphasis (flattens the speech spectrum so LPC focuses on
    // formants instead of the low-frequency tilt).
    const pre = new Float32Array(N);
    pre[0] = x[0];
    for (let i = 1; i < N; i++) pre[i] = x[i] - 0.97 * x[i - 1];
    // Hamming window.
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1));
      pre[i] *= w;
      energy += pre[i] * pre[i];
    }
    // Voicing gate. Below this energy the frame is silence/noise — keep
    // the biquads where they are.
    if (energy < N * 1e-5) return;

    // Autocorrelation r[0..p].
    const p = 12;
    const r = new Float32Array(p + 1);
    for (let k = 0; k <= p; k++) {
      let s = 0;
      for (let n = 0; n < N - k; n++) s += pre[n] * pre[n + k];
      r[k] = s;
    }
    if (r[0] <= 0) return;

    // Levinson-Durbin → LPC coefficients a[0..p].
    const a = new Float32Array(p + 1);
    const an = new Float32Array(p + 1);
    a[0] = 1;
    let E = r[0];
    for (let i = 1; i <= p; i++) {
      let acc = r[i];
      for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
      const k_i = -acc / E;
      for (let j = 0; j <= i; j++) an[j] = a[j];
      for (let j = 1; j < i; j++) an[j] = a[j] + k_i * a[i - j];
      an[i] = k_i;
      for (let j = 0; j <= i; j++) a[j] = an[j];
      E *= (1 - k_i * k_i);
      if (E <= 0) return;
    }

    // Evaluate 1/|A(e^jω)|² on a 512-bin grid covering [0, sr/2].
    const NSPEC = 512;
    const env = new Float32Array(NSPEC);
    for (let b = 0; b < NSPEC; b++) {
      const om = (Math.PI * b) / NSPEC;
      let re = 0, im = 0;
      for (let k = 0; k <= p; k++) {
        re += a[k] * Math.cos(-om * k);
        im += a[k] * Math.sin(-om * k);
      }
      const denom = re * re + im * im;
      env[b] = denom > 1e-12 ? 1 / denom : 1e12;
    }

    // Peak pick.
    const binHz = sr / 2 / NSPEC;
    const pickPeak = (loHz: number, hiHz: number): number => {
      const lo = Math.max(1, Math.floor(loHz / binHz));
      const hi = Math.min(NSPEC - 2, Math.ceil(hiHz / binHz));
      let bestI = -1, best = -Infinity;
      for (let i = lo; i <= hi; i++) {
        if (env[i] > best && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
          best = env[i]; bestI = i;
        }
      }
      if (bestI < 0) return 0;
      // Parabolic interpolation in log-magnitude.
      const yL = Math.log(env[Math.max(0, bestI - 1)] + 1e-20);
      const yC = Math.log(env[bestI] + 1e-20);
      const yR = Math.log(env[Math.min(NSPEC - 1, bestI + 1)] + 1e-20);
      const denom = (yL - 2 * yC + yR);
      const delta = denom !== 0 ? 0.5 * (yL - yR) / denom : 0;
      return (bestI + delta) * binHz;
    };
    const f1 = pickPeak(250, 1000);
    const f2 = pickPeak(Math.max(900, f1 + 200), 2500);
    const f3 = pickPeak(Math.max(2000, f2 + 300), 3500);
    if (f1 <= 0 || f2 <= 0 || f3 <= 0) return;

    // Smooth.
    this.vTrack3F1 = this.vTrack3F1 * 0.82 + f1 * 0.18;
    this.vTrack3F2 = this.vTrack3F2 * 0.85 + f2 * 0.15;
    this.vTrack3F3 = this.vTrack3F3 * 0.88 + f3 * 0.12;
    const t = this.ctx.currentTime;
    this.vBp1L.frequency.setTargetAtTime(this.vTrack3F1, t, 0.08);
    this.vBp2L.frequency.setTargetAtTime(this.vTrack3F2, t, 0.08);
    this.vBp3L.frequency.setTargetAtTime(this.vTrack3F3, t, 0.08);
    // Steer the anti-formant notches to the inter-formant valleys
    // (geometric mean is the perceptual midpoint between two peaks).
    if (this.vAntEnabled && this.vAnt12 && this.vAnt23) {
      this.vAnt12.frequency.setTargetAtTime(
        Math.sqrt(this.vTrack3F1 * this.vTrack3F2), t, 0.08);
      this.vAnt23.frequency.setTargetAtTime(
        Math.sqrt(this.vTrack3F2 * this.vTrack3F3), t, 0.08);
    }
  }

  /** Begin async-loading the de-clicker worklet module. Idempotent.
   *  The node is spliced into the chain between vBp3L and dhisOut. */
  ensureDeclickerWorklet(log: LogFn = () => {}): Promise<void> {
    if (this.dckNode) return Promise.resolve();
    if (this.dckLoading) return this.dckLoading;
    const ctx = this.ensureGraph();
    if (!ctx || !ctx.audioWorklet || !this.vBp3L || !this.dhisOut) {
      return Promise.resolve();
    }
    this.dckLoading = (async () => {
      try {
        await ctx.audioWorklet.addModule('/declicker-worklet.js');
        const node = new AudioWorkletNode(ctx, 'declicker', {
          numberOfInputs: 1, numberOfOutputs: 1,
          channelCount: 1, channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { enabled: this.declickEnabled, k: this.declickK },
        });
        this.dckNode = node;
        this.rewireDhisChain();
        node.port.postMessage({ enabled: this.declickEnabled, k: this.declickK });
        log('audio: declicker worklet loaded');
      } catch (e) {
        log('audio: declicker worklet load failed — ' + (e as Error).message);
      }
    })();
    return this.dckLoading;
  }

  /** Rebuild the chain segment vAnt23 → (dckNode →)? (rfwNode →)?
   *  (nb2Node →)? (pshiftNode →)? dhisOut. Called whenever any of the
   *  insertable worklets loads so the new node is spliced in. */
  private rewireDhisChain(): void {
    if (!this.vAnt23 || !this.dhisOut) return;
    try { this.vAnt23.disconnect(); } catch {}
    try { this.dckNode?.disconnect(); } catch {}
    try { this.rfwNode?.disconnect(); } catch {}
    try { this.nb2Node?.disconnect(); } catch {}
    try { this.pshiftNode?.disconnect(); } catch {}
    let prev: AudioNode = this.vAnt23;
    if (this.dckNode)   { prev.connect(this.dckNode);   prev = this.dckNode; }
    if (this.rfwNode)   { prev.connect(this.rfwNode);   prev = this.rfwNode; }
    if (this.nb2Node)   { prev.connect(this.nb2Node);   prev = this.nb2Node; }
    if (this.pshiftNode){ prev.connect(this.pshiftNode); prev = this.pshiftNode; }
    prev.connect(this.dhisOut);
  }

  setDeclickerEnabled(on: boolean): void {
    this.declickEnabled = !!on;
    if (this.dckNode) {
      this.dckNode.port.postMessage({ enabled: this.declickEnabled });
    } else {
      this.ensureDeclickerWorklet();
    }
  }
  isDeclickerEnabled(): boolean { return this.declickEnabled; }
  /** Sensitivity (σ-equivalent). 3.0 = standard outlier cutoff;
   *  lower = more aggressive (catches softer ticks but may eat
   *  transients); higher = gentler. Range 1.5..10. */
  setDeclickerStrength(k: number): void {
    if (!Number.isFinite(k)) return;
    this.declickK = Math.max(1.5, Math.min(10, k));
    this.dckNode?.port.postMessage({ k: this.declickK });
  }
  getDeclickerStrength(): number { return this.declickK; }

  /** Lazy-load the NB2 worklet (port of WDSP NB2 by Warren Pratt). The
   *  node is spliced into the dhisOut chain alongside dckNode / rfwNode. */
  ensureNb2Worklet(log: LogFn = () => {}): Promise<void> {
    if (this.nb2Node) return Promise.resolve();
    if (this.nb2Loading) return this.nb2Loading;
    const ctx = this.ensureGraph();
    if (!ctx || !ctx.audioWorklet || !this.vAnt23 || !this.dhisOut) {
      return Promise.resolve();
    }
    this.nb2Loading = (async () => {
      try {
        await ctx.audioWorklet.addModule('/nb2-worklet.js');
        const node = new AudioWorkletNode(ctx, 'nb2', {
          numberOfInputs: 1, numberOfOutputs: 1,
          channelCount: 1, channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { enabled: this.nb2Enabled, k: this.nb2K },
        });
        this.nb2Node = node;
        this.rewireDhisChain();
        node.port.postMessage({ enabled: this.nb2Enabled, k: this.nb2K });
        log('audio: NB2 worklet loaded');
      } catch (e) {
        log('audio: NB2 worklet load failed — ' + (e as Error).message);
      }
    })();
    return this.nb2Loading;
  }

  setNb2Enabled(on: boolean): void {
    this.nb2Enabled = !!on;
    if (this.nb2Node) {
      this.nb2Node.port.postMessage({ enabled: this.nb2Enabled });
    } else {
      this.ensureNb2Worklet();
    }
  }
  isNb2Enabled(): boolean { return this.nb2Enabled; }
  /** Threshold multiplier K: |x| > K · adaptive_floor triggers blank.
   *  3 = aggressive (catches softer ticks, risks chopping speech peaks);
   *  5 = balanced default; 7 = gentle (only loud impulses). Range 2..15. */
  setNb2Strength(k: number): void {
    if (!Number.isFinite(k)) return;
    this.nb2K = Math.max(2, Math.min(15, k));
    this.nb2Node?.port.postMessage({ k: this.nb2K });
  }
  getNb2Strength(): number { return this.nb2K; }

  /** Lazy-load the Pitch Shifter worklet. Spliced into the dhisOut
   *  chain after rfwNode / nb2Node so pitch shifting is the last
   *  audio-domain transform before the output mixer. */
  ensurePitchShifterWorklet(log: LogFn = () => {}): Promise<void> {
    if (this.pshiftNode) return Promise.resolve();
    if (this.pshiftLoading) return this.pshiftLoading;
    const ctx = this.ensureGraph();
    if (!ctx || !ctx.audioWorklet || !this.vAnt23 || !this.dhisOut) {
      return Promise.resolve();
    }
    this.pshiftLoading = (async () => {
      try {
        await ctx.audioWorklet.addModule('/pitch-shift-worklet.js');
        const node = new AudioWorkletNode(ctx, 'pitch-shift', {
          numberOfInputs: 1, numberOfOutputs: 1,
          channelCount: 1, channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { enabled: this.pshiftEnabled, semitones: this.pshiftSemitones },
        });
        this.pshiftNode = node;
        this.rewireDhisChain();
        node.port.postMessage({ enabled: this.pshiftEnabled, semitones: this.pshiftSemitones });
        log('audio: pitch-shifter worklet loaded');
      } catch (e) {
        log('audio: pitch-shifter worklet load failed — ' + (e as Error).message);
      }
    })();
    return this.pshiftLoading;
  }

  setPitchShifterEnabled(on: boolean): void {
    this.pshiftEnabled = !!on;
    if (this.pshiftNode) {
      this.pshiftNode.port.postMessage({ enabled: this.pshiftEnabled });
    } else {
      this.ensurePitchShifterWorklet();
    }
  }
  isPitchShifterEnabled(): boolean { return this.pshiftEnabled; }

  /** Pitch offset in semitones; -12 ... +12 (one octave each way).
   *  Negative = lower pitch, positive = higher pitch. 0 is bypass. */
  setPitchShifterSemitones(s: number): void {
    if (!Number.isFinite(s)) return;
    this.pshiftSemitones = Math.max(-12, Math.min(12, Math.round(s)));
    this.pshiftNode?.port.postMessage({ semitones: this.pshiftSemitones });
  }
  getPitchShifterSemitones(): number { return this.pshiftSemitones; }

  /** Begin async-loading the RFWhisper (RNNoise) worklet. Idempotent.
   *  Fetches /rnnoise.wasm on the main thread (AudioWorklet context can't
   *  fetch freely), then hands the binary to the worklet via postMessage. */
  ensureRFWhisperWorklet(log: LogFn = () => {}): Promise<void> {
    if (this.rfwNode) return Promise.resolve();
    if (this.rfwLoading) return this.rfwLoading;
    const ctx = this.ensureGraph();
    if (!ctx || !ctx.audioWorklet || !this.vAnt23 || !this.dhisOut) {
      return Promise.resolve();
    }
    this.rfwLoading = (async () => {
      try {
        const [, wasmResp] = await Promise.all([
          ctx.audioWorklet.addModule('/rfwhisper-worklet.js'),
          fetch('/rnnoise.wasm'),
        ]);
        const wasmBinary = await wasmResp.arrayBuffer();
        const node = new AudioWorkletNode(ctx, 'rfwhisper', {
          numberOfInputs: 1, numberOfOutputs: 1,
          channelCount: 1, channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { enabled: this.rfwEnabled, strength: this.rfwStrength },
        });
        await new Promise<void>((resolve, reject) => {
          node.port.onmessage = (e) => {
            const m = e.data || {};
            if (m.type === 'ready') resolve();
            if (m.type === 'error') reject(new Error(m.message));
          };
          node.port.postMessage({ type: 'init', wasmBinary }, [wasmBinary]);
        });
        this.rfwNode = node;
        this.rewireDhisChain();
        node.port.postMessage({ enabled: this.rfwEnabled, strength: this.rfwStrength });
        log('audio: RFWhisper (RNNoise) worklet ready');
      } catch (e) {
        log('audio: RFWhisper worklet load failed — ' + (e as Error).message);
      }
    })();
    return this.rfwLoading;
  }

  setRFWhisperEnabled(on: boolean): void {
    this.rfwEnabled = !!on;
    if (this.rfwNode) {
      this.rfwNode.port.postMessage({ enabled: this.rfwEnabled });
    } else {
      this.ensureRFWhisperWorklet();
    }
  }
  isRFWhisperEnabled(): boolean { return this.rfwEnabled; }

  /** Wet/dry mix strength: 0.0 = bypass, 1.0 = fully denoised. */
  setRFWhisperStrength(s: number): void {
    this.rfwStrength = Math.max(0, Math.min(1, s));
    this.rfwNode?.port.postMessage({ strength: this.rfwStrength });
  }
  getRFWhisperStrength(): number { return this.rfwStrength; }

  /** Must be called from a user gesture. Returns the actual sample rate.
   *  Builds the Kiwi-side worklet/spnode source and connects it to the
   *  shared mixer — does NOT close or recreate the mixer/analyser. */
  async start(log: LogFn = () => {}): Promise<number> {
    const ctx = this.ensureGraph();
    if (!ctx) throw new Error('AudioContext unsupported');
    log(`audio: ctx state=${ctx.state} sr=${ctx.sampleRate}`);
    const resumeP = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
    // Kick off the audio-enhancement worklets in parallel with the rest
    // of graph setup. No-ops if already loaded / loading.
    this.ensureDeclickerWorklet(log);
    this.ensureRFWhisperWorklet(log);

    if (this.srcNode) {
      // Re-entered without a stop() — graph already wired.
      await resumeP;
      return ctx.sampleRate;
    }

    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule('/kiwi-pcm-worklet.js');
        const node = new AudioWorkletNode(ctx, 'kiwi-pcm', { numberOfInputs: 0, outputChannelCount: [1] });
        this.worklet = node;
        this.srcNode = node;
        log('audio: using AudioWorklet');
      } catch (e) {
        log(`audio: worklet failed (${(e as Error).message}), falling back to ScriptProcessor`);
        this.installScriptProcessor(ctx);
      }
    } else {
      log('audio: AudioWorklet unavailable (insecure context) — using ScriptProcessor');
      this.installScriptProcessor(ctx);
    }
    this.rewireGraph();

    await resumeP;
    log(`audio: ctx after resume = ${ctx.state}`);
    this.send({ type: 'gain', value: this.gain });
    return ctx.sampleRate;
  }

  private prebuffered = false;
  // Lower prebuffer = faster audio resume after each server-kick reconnect.
  private static readonly PREBUFFER_THRESHOLD = 2400; // ~50 ms @ 48 kHz

  // Scratch buffer reused per audio frame to avoid GC pressure (~46k allocs/s
  // otherwise). Sized for worst case: 1024 samples × max ratio ~4 = 4096.
  private resampleScratch = new Float32Array(8192);
  // ADPCM decode scratch (int16) and decoder state (preserved across frames).
  private adpcm = new AdpcmDecoder();
  private adpcmScratch = new Int16Array(2048);
  /** Reset ADPCM predictor — call when toggling compression on/off so the
   *  decoder doesn't carry stale state into a new stream. */
  resetAdpcm(): void { this.adpcm.reset(); }

  private installScriptProcessor(ctx: AudioContext): void {
    const bufSize = 4096; // ~85 ms @ 48 kHz — survives main-thread stalls
    const node = ctx.createScriptProcessor(bufSize, 0, 1);
    node.onaudioprocess = (e: AudioProcessingEvent) => {
      const out = e.outputBuffer.getChannelData(0);
      const n = out.length;
      if (!this.prebuffered) {
        if (this.ringSize >= AudioPlayer.PREBUFFER_THRESHOLD) this.prebuffered = true;
        else { out.fill(0); return; }
      }
      if (this.ringSize === 0) { out.fill(0); this.prebuffered = false; return; }
      const take = Math.min(n, this.ringSize);
      const cap = this.ring.length;
      const g = this.gain;
      for (let i = 0; i < take; i++) {
        // tanh soft-clip prevents harsh distortion when the post-AGC gain
        // pushes peaks past full scale.
        const v = this.ring[this.ringR] * g;
        out[i] = v >= 1 ? Math.tanh(v) : v <= -1 ? -Math.tanh(-v) : v;
        this.ringR = (this.ringR + 1) % cap;
      }
      for (let i = take; i < n; i++) out[i] = 0;
      this.ringSize -= take;
    };
    this.spnode = node;
    this.srcNode = node;
  }

  /** Connect Kiwi srcNode → [compressor → makeup-gain] → mixer. The mixer
   *  is the single point of fan-out to speakers + SPEC. */
  private rewireGraph(): void {
    const ctx = this.ctx;
    const src = this.srcNode;
    const mixer = this.mixer;
    if (!ctx || !src || !mixer) return;
    try { src.disconnect(); } catch {}
    if (this.compressor) try { this.compressor.disconnect(); } catch {}
    if (this.compMakeup) try { this.compMakeup.disconnect(); } catch {}
    if (this.compEnabled) {
      if (!this.compressor) {
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = -20;
        c.knee.value = 10;
        c.ratio.value = 4;
        c.attack.value = 0.005;
        c.release.value = 0.15;
        this.compressor = c;
      }
      if (!this.compMakeup) {
        const g = ctx.createGain();
        g.gain.value = 2.0;
        this.compMakeup = g;
      }
      src.connect(this.compressor);
      this.compressor.connect(this.compMakeup);
      this.compMakeup.connect(mixer);
    } else {
      src.connect(mixer);
    }
  }

  setCompressor(on: boolean): void {
    if (this.compEnabled === on) return;
    this.compEnabled = on;
    this.rewireGraph();
  }

  /** Disconnect the Kiwi audio source. The mixer / SPEC analyser / ctx
   *  stay alive so any TEST playback in progress keeps running and SPEC
   *  keeps drawing. Re-call `start()` to reconnect a fresh Kiwi source. */
  stop(): void {
    try { this.worklet?.disconnect(); } catch {}
    try { this.compressor?.disconnect(); } catch {}
    try { this.compMakeup?.disconnect(); } catch {}
    if (this.spnode) { this.spnode.onaudioprocess = null; try { this.spnode.disconnect(); } catch {} }
    this.worklet = null; this.spnode = null;
    this.compressor = null; this.compMakeup = null;
    this.srcNode = null;
    this.resamplePhase = 0; this.resampleLast = 0;
    this.ringR = this.ringW = this.ringSize = 0;
    this.prebuffered = false;
    // ctx, mixer, analyser, analyserSink stay alive — they belong to the
    // app session, not to a single Kiwi connection.
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /** Suspend the AudioContext entirely. Halts the audio render thread,
   *  drops CPU/battery cost to ~0 until `resume()` is called. Safe to
   *  call when ctx is already suspended or has never been started. */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  setInputRate(hz: number): void {
    if (hz <= 0) return;
    const changeRatio = Math.abs(hz - this.inputRate) / this.inputRate;
    this.inputRate = hz;
    // Tiny drift (e.g. 12000 vs 11998.877) — adjust silently. Only flush when
    // the rate actually changes (e.g. server reconfigured).
    if (changeRatio > 0.05) {
      this.send({ type: 'flush' });
      this.ringR = this.ringW = this.ringSize = 0;
      this.resamplePhase = 0; this.resampleLast = 0;
      this.prebuffered = false;
    }
  }

  setGain(g: number): void { this.gain = g; this.send({ type: 'gain', value: g }); }

  /** Trim the audio queue, keeping only the most recent `keepMs`
   *  milliseconds so the speaker catches up to the live RX without
   *  underrun-glitching. Defaults to 500 ms — enough headroom to ride
   *  out a main-thread stall but short enough to feel responsive. */
  flush(keepMs: number = 500): void {
    const sr = this.ctx?.sampleRate ?? 48000;
    const keep = Math.max(0, Math.floor((keepMs / 1000) * sr));
    this.send({ type: 'flush', keep });
    if (this.ringSize > keep) {
      const drop = this.ringSize - keep;
      this.ringR = (this.ringR + drop) % this.ring.length;
      this.ringSize = keep;
    }
    if (this.ringSize === 0) {
      this.resamplePhase = 0;
      this.resampleLast = 0;
      this.prebuffered = false;
    }
  }
  /** Toggle AUX: when true, drops Kiwi frames so injectTestSamples is the
   *  only thing reaching the audio graph and decoder hooks. Speaker output
   *  is unaffected — whatever's in the ring continues playing. */
  setBlockKiwi(b: boolean): void { this.blockKiwi = b; }

  /** Optional sink for raw 12 kHz int16 mono samples (used for transcription). */
  onRawSamples: ((s: Int16Array) => void) | null = null;
  /** Second optional sink for the same samples (used for recording so it can
   *  run alongside transcription). */
  onRecord: ((s: Int16Array) => void) | null = null;
  /** Third optional sink — used by the FT8 decoder window-buffer. */
  onFt8: ((s: Int16Array) => void) | null = null;
  /** Fourth optional sink — used by the CW decoder. */
  onCw: ((s: Int16Array) => void) | null = null;
  /** Fifth optional sink — used by the RTTY decoder. */
  onRtty: ((s: Int16Array) => void) | null = null;
  /** Sixth optional sink — used by the Olivia/MFSK decoder. */
  onOlivia: ((s: Int16Array) => void) | null = null;
  /** Seventh optional sink — used by the PSK31 decoder. */
  onPsk: ((s: Int16Array) => void) | null = null;
  /** Eighth optional sink — used by the autonomous mode classifier. */
  onClassify: ((s: Int16Array) => void) | null = null;
  /** Ninth optional sink — used by the WEFAX decoder. */
  onWefax: ((s: Int16Array) => void) | null = null;
  /** Tenth optional sink — used by the NAVTEX / SITOR-B decoder. */
  onNavtex: ((s: Int16Array) => void) | null = null;
  /** Eleventh optional sink — used by the MFSK decoder. */
  onMfsk: ((s: Int16Array) => void) | null = null;
  /** Twelfth optional sink — used by the MT63 decoder. */
  onMt63: ((s: Int16Array) => void) | null = null;
  /** Thirteenth optional sink — used by the FSQ decoder. */
  onFsq: ((s: Int16Array) => void) | null = null;
  /** Fourteenth optional sink — used by the THOR decoder. */
  onThor: ((s: Int16Array) => void) | null = null;
  /** Fifteenth optional sink — used by the DominoEX decoder. */
  onDominoex: ((s: Int16Array) => void) | null = null;
  /** Sixteenth optional sink — used by the Contestia decoder. */
  onContestia: ((s: Int16Array) => void) | null = null;
  /** Seventeenth optional sink — used by the SITOR-B decoder (NAVTEX RX without
   *  the NAVTEX-specific framing). */
  onSitor: ((s: Int16Array) => void) | null = null;
  /** Eighteenth optional sink — used by the WWV scope. */
  onWwv: ((s: Int16Array) => void) | null = null;
  /** Nineteenth optional sink — used by the ALE 2G decoder. */
  onAle: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the direwolf-vendored HF AX.25 / APRS
   *  packet decoder. Receives the same 12 kHz int16 PCM all other
   *  audio decoders consume. */
  onPacket: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the WSPR decoder (server-side wsprd, with
   *  a 2-minute period buffer). */
  onWspr: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the WSPR-15 decoder (15-min period buffer). */
  onWspr15: ((s: Int16Array) => void) | null = null;
  /** Optional sink — same shape as onWspr but for JS8Call (15-s slots). */
  onJs8:  ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the JT9 decoder (1-min UTC slots). */
  onJt9:  ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the JT65 decoder (1-min UTC slots, jt9 -65). */
  onJt65: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the Q65 decoder (1-min default slots, jt9 -q). */
  onQ65:  ((s: Int16Array) => void) | null = null;
  /** Optional sink for FST4 / FST4W (LF/MF DX, 60-1800 s slots). */
  onFst4: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the FST4W (beacon) decoder. */
  onFst4w: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the STANAG 4285 signal detector. Not a
   *  content decoder; only reports presence / lock state. */
  onStanag: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the STANAG 4539 (high-rate sibling) detector. */
  onStanag4539: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the Feld-Hellschreiber image renderer. */
  onHell: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the analog SSTV decoder (slowrxd). */
  onSstv: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the FreeDV digital-voice decoder. */
  onFreedv: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the fldigi-vendored Throb decoder. */
  onThrob: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the JT4 decoder (1-min UTC slots, jt9 -4). */
  onJt4: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the SELCAL (multimon-ng) decoder. */
  onSelcal: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the POCSAG (multimon-ng) pager decoder. */
  onPocsag: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the DSD (D-STAR/DMR/NXDN/YSF/dPMR/M17/P25)
   *  digital-voice metadata decoder. Receives the same int16 PCM as
   *  the other audio decoders. */
  onDsd: ((s: Int16Array) => void) | null = null;
  /** Optional sink — generic multimon-ng modes (FLEX / ERMES / DTMF /
   *  ZVEI / AFSK1200 / X10 / EAS). One sink, mode multiplexed at the
   *  server end via /ws/decode/multimon?mode=… */
  onMultimon: ((s: Int16Array) => void) | null = null;
  /** Optional sinks — vendored-binary decoders (audio→text). */
  onMsk144:   ((s: Int16Array) => void) | null = null;
  onAis:      ((s: Int16Array) => void) | null = null;
  onAcars:    ((s: Int16Array) => void) | null = null;
  onTetrapol: ((s: Int16Array) => void) | null = null;
  onOp25:     ((s: Int16Array) => void) | null = null;
  onLrpt:     ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the audio oscilloscope panel. */
  onScope: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the THD (total harmonic distortion) panel.
   *  Same int16 PCM stream as `onScope`; the panel buffers it and runs
   *  an FFT to locate the fundamental + harmonics. */
  onThd: ((s: Int16Array) => void) | null = null;
  /** Optional sink — Persistence Spectrum (2D freq×amplitude
   *  histogram). Same int16 PCM stream as `onScope` / `onThd`. */
  onPersist: ((s: Int16Array) => void) | null = null;
  /** Optional sink — Envelope PDF panel. Same int16 PCM stream. */
  onEnvp: ((s: Int16Array) => void) | null = null;
  /** Optional sink — Cepstrum / Pitch Contour panel. */
  onCeps: ((s: Int16Array) => void) | null = null;
  /** Optional sink — Mains-Hum Tracker panel. */
  onMhum: ((s: Int16Array) => void) | null = null;
  /** Optional sink — Welch PSD panel. Averaged periodogram. */
  onWelch: ((s: Int16Array) => void) | null = null;
  /** Optional sinks — 2026 audio-side viewer batch (Crest Factor /
   *  Spectral Mask / Reassigned Spectrogram / LPC Envelope / Group
   *  Delay / A-B Spectrum Compare / Wavelet Scalogram). Same int16
   *  PCM stream as the other audio decoders. */
  onCrest: ((s: Int16Array) => void) | null = null;
  onMask: ((s: Int16Array) => void) | null = null;
  onRspec: ((s: Int16Array) => void) | null = null;
  onLpc: ((s: Int16Array) => void) | null = null;
  onGdelay: ((s: Int16Array) => void) | null = null;
  onAbspec: ((s: Int16Array) => void) | null = null;
  onWavelet: ((s: Int16Array) => void) | null = null;
  /** Optional sinks — 2026 audio-side viewer batch-3 (HHT / Mel / Chro
   *  / ModSpec / ACF / Spectral Entropy / Spectral Flatness / Q-Q /
   *  CI Periodogram / Phase Portrait). */
  onHht: ((s: Int16Array) => void) | null = null;
  onMel: ((s: Int16Array) => void) | null = null;
  onChro: ((s: Int16Array) => void) | null = null;
  onMspec: ((s: Int16Array) => void) | null = null;
  onAcf: ((s: Int16Array) => void) | null = null;
  onSent: ((s: Int16Array) => void) | null = null;
  onSflat: ((s: Int16Array) => void) | null = null;
  onQq: ((s: Int16Array) => void) | null = null;
  onCiper: ((s: Int16Array) => void) | null = null;
  onPhaseP: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the QRSS slow-CW grabber. Receives the
   *  same demodulated int16 PCM stream as the other audio decoders;
   *  QRSS itself runs a long-window audio FFT for sub-Hz resolution. */
  onQrss: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the Lissajous / vector-scope panel. */
  onVect: ((s: Int16Array) => void) | null = null;
  /** Audio-derived IQ source for the IQ View panel — receives the same
   *  int16 mono audio as the other audio decoders. The panel uses this when
   *  AUDIO mode is on, to plot a constellation from any demod mode without
   *  flipping the receiver into IQ. */
  onIqAudio: ((s: Int16Array) => void) | null = null;
  /** Optional sink — used by the eye-diagram panel. */
  onIqEye: ((iqBytes: Uint8Array) => void) | null = null;
  /** Shared sink for the page-5 IQ visualizer panels. Only one is open
   *  at a time so they multiplex through a single sink instead of one
   *  per panel. */
  onIq5: ((iqBytes: Uint8Array) => void) | null = null;
  /** Twentieth optional sink — used by the HFDL decoder.
   *  Receives the raw KiwiSDR IQ payload AFTER the 10-byte GPS header
   *  has been stripped. The bytes are interleaved I/Q int16 big-endian
   *  (Kiwi's stereo-mode wire format); byte-swapping is the consumer's
   *  responsibility. The mono audio mixer / SPEC / decoder fan-out is
   *  bypassed entirely while iqMode is on. */
  onIq: ((iqBytes: Uint8Array) => void) | null = null;
  /** Twenty-first sink — used by the IQ constellation viewer. Receives
   *  the same payload as `onIq` (same byte format, same gating). The
   *  two sinks are siblings so HFDL + the constellation can run
   *  concurrently. */
  onIqView: ((iqBytes: Uint8Array) => void) | null = null;
  /** Recorder sink — fed the same BE-int16 stereo payload as onIq while
   *  iqMode is on. Owned by the shell's REC button so it can run
   *  alongside HFDL / ISB decoders without stomping their onIq hook. */
  onIqRecord: ((iqBytes: Uint8Array) => void) | null = null;
  /** When true, every Kiwi audio frame is treated as a stereo IQ frame
   *  (10-byte GPS header + interleaved I16 BE) and routed only to onIq.
   *  All real-audio paths are skipped. Set by the shell when the demod
   *  mode flips to 'iq'. */
  iqMode = false;
  setIqMode(on: boolean): void { this.iqMode = on; }
  /** Client-side squelch gate. When non-null, audio frames whose
   *  rssiDbm falls below this threshold are zeroed out before reaching
   *  the speakers. Setting null (or a very low number like -200) leaves
   *  the gate fully open. */
  private squelchDbm: number | null = null;
  setSquelchGate(thresholdDbm: number | null): void {
    this.squelchDbm = thresholdDbm;
  }
  /** GATE — soft (progressive) audio noise gate / downward expander.
   *  Threshold in dBFS (rel. 1.0). Null disables.
   *
   *  Behaviour matches a Tecsun-680-style soft squelch: there is no
   *  hard mute. Above threshold the audio passes at unity gain. Below
   *  threshold each dB of "missing" level costs (RATIO − 1) extra dB
   *  of output, so a weak signal fades smoothly toward silence rather
   *  than chopping on and off. A short soft knee around the threshold
   *  smooths the transition, and a per-frame envelope follower with
   *  fast attack / slower release prevents the gain from clicking
   *  between speech consonants.
   *
   *  Unlike `setSquelchGate` (driven by Kiwi RSSI metadata, useless on
   *  OWRX) this works on every source — it looks at the decoded
   *  audio's amplitude. */
  private gateDbfs: number | null = null;
  /** Last applied gain, persisted across frames for the envelope
   *  follower. 1.0 = fully open, 0 = fully closed. */
  private gateGain = 1;
  /** Expander ratio: 4:1 means 1 dB below threshold → 4 dB output
   *  attenuation. Higher = harder gate; lower = subtler expansion. */
  private static readonly GATE_RATIO = 4;
  /** Soft-knee width in dB (centred on threshold). */
  private static readonly GATE_KNEE_DB = 6;
  /** EMA coefficients per frame for the envelope smoothing. ~10 ms
   *  attack / ~150 ms release at typical 1024-sample @ 12 kHz frames
   *  (≈ 85 ms / frame): use frame-rate-independent τ values mapped
   *  back to α from the actual frame duration in pushAudio. */
  private static readonly GATE_ATTACK_MS = 10;
  private static readonly GATE_RELEASE_MS = 150;
  setNoiseGate(thresholdDbfs: number | null): void {
    this.gateDbfs = thresholdDbfs;
    if (thresholdDbfs == null) this.gateGain = 1;
  }
  /** When true, Kiwi audio is NOT routed to any decoder sink. Used by the
   *  MODES picker's "feed → decoder" mode so injected test samples aren't
   *  mixed with live Kiwi input. Recorder/FT8/raw sinks remain active. */
  suppressDecoders = false;

  /** Audio-domain analyser. Created lazily; tapped off the main src so its
   *  output is the demodulated baseband regardless of compressor state. */
  private analyser: AnalyserNode | null = null;
  /** Returns the analyser's FFT byte data. Mirrors whatever the mixer is
   *  outputting — Kiwi, TEST, or both. null until ensureGraph() has run
   *  (which happens on first start() or playTestBuffer()). */
  getAudioFftBins(): Uint8Array | null {
    if (!this.analyser) return null;
    const bins = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(bins);
    return bins;
  }
  /** Sample rate of the audio context (needed to map FFT bin → Hz). */
  getAudioRate(): number { return this.ctx?.sampleRate ?? 48000; }
  /** Underlying AudioContext, ensuring the audio graph is initialised.
   *  Used by client-side IQ demodulators (e.g. ISB) that need their own
   *  output node (typically a ChannelMergerNode → destination) since
   *  the mixer is mono. */
  getOrCreateCtx(): AudioContext | null { return this.ensureGraph(); }
  /** The mono mixer node — VOL/COMP/EQ all feed through this on their
   *  way to ctx.destination. Decoders that emit their own decoded
   *  voice (FreeDV, DSD, …) should connect their per-decoder GainNode
   *  here instead of straight to destination so the VOL knob and the
   *  PWR/mute path govern them like every other audio source. */
  getMixer(): GainNode | null { this.ensureGraph(); return this.mixer; }
  /** Source-side sample rate (the rate of the int16 samples fed via the
   *  onRawSamples / onRecord / onFt8 hooks — typically ~12 kHz from Kiwi). */
  getInputRate(): number { return this.inputRate; }

  pushAudio(frame: AudioFrame): void {
    if (!this.ctx) return;
    // AUX gate — when on, drop Kiwi entirely so the only input to the audio
    // graph and decoders is whatever injectTestSamples() pushes.
    if (this.blockKiwi) return;
    // IQ-mode short-circuit. KiwiSDR's stereo wire format is: 10-byte
    // GPS header (last_gps_solution u8 + dummy u8 + gpssec u32 + gpsnsec
    // u32) followed by interleaved I/Q int16 big-endian. We bypass the
    // mono audio mixer + decoders entirely and forward only to onIq —
    // routing IQ samples through the real-audio path would just produce
    // noise through the speakers. Stereo frames are never compressed.
    if (this.iqMode) {
      const p = frame.payload;
      if (p.length < 10) return;
      const iq = p.subarray(10);
      // Need an even number of int16 samples (each I/Q pair = 4 bytes).
      if ((iq.length & 3) !== 0 || iq.length === 0) return;
      this.onIq?.(iq);
      this.onIqView?.(iq);
      this.onIqEye?.(iq);
      this.onIq5?.(iq);
      this.onIqRecord?.(iq);
      return;
    }
    let src: Float32Array;
    let int16: Int16Array | null = null;
    if (frame.adpcm) {
      const need = frame.payload.length * 2;
      if (this.adpcmScratch.length < need) this.adpcmScratch = new Int16Array(need);
      this.adpcm.decodeInto(frame.payload, this.adpcmScratch);
      int16 = this.adpcmScratch.subarray(0, need);
      src = new Float32Array(need);
      for (let i = 0; i < need; i++) src[i] = int16[i] / 32768;
    } else {
      src = decodePcmBe(frame.payload);
      // For PCM also produce int16 view for transcriber/recorder/ft8.
      if (this.onRawSamples || this.onRecord || this.onFt8 || this.onCw || this.onRtty || this.onOlivia || this.onPsk || this.onClassify || this.onWefax || this.onNavtex || this.onMfsk || this.onAle || this.onPacket || this.onWspr || this.onWspr15 || this.onJs8 || this.onJt9 || this.onJt65 || this.onQ65 || this.onJt4 || this.onFst4 || this.onFst4w || this.onStanag || this.onStanag4539 || this.onHell || this.onSstv || this.onFreedv || this.onThrob || this.onSelcal || this.onPocsag || this.onDsd || this.onMultimon || this.onMsk144 || this.onAis || this.onAcars || this.onTetrapol || this.onOp25 || this.onLrpt || this.onScope || this.onThd || this.onPersist || this.onEnvp || this.onCeps || this.onMhum || this.onWelch || this.onCrest || this.onMask || this.onRspec || this.onLpc || this.onGdelay || this.onAbspec || this.onWavelet || this.onHht || this.onMel || this.onChro || this.onMspec || this.onAcf || this.onSent || this.onSflat || this.onQq || this.onCiper || this.onPhaseP || this.onVect || this.onQrss || this.onIqAudio) {
        const n = src.length;
        const i16 = new Int16Array(n);
        for (let i = 0; i < n; i++) i16[i] = src[i] * 32767 | 0;
        int16 = i16;
      }
    }
    if (this.onRawSamples && int16) this.onRawSamples(int16);
    if (this.onRecord && int16) this.onRecord(int16);
    if (this.onFt8 && int16) this.onFt8(int16);
    // Decoder fan-out — suppressed (a) while a test sample is being injected
    // via the MODES picker so synthetic input is the only thing reaching
    // decoders, and (b) when MUTE is on, so muting Kiwi also stops the
    // decoders from chewing on whatever's in the passband.
    if (!this.suppressDecoders) {
      if (this.onCw && int16) this.onCw(int16);
      if (this.onRtty && int16) this.onRtty(int16);
      if (this.onOlivia && int16) this.onOlivia(int16);
      if (this.onPsk && int16) this.onPsk(int16);
      if (this.onClassify && int16) this.onClassify(int16);
      if (this.onWefax && int16) this.onWefax(int16);
      if (this.onNavtex && int16) this.onNavtex(int16);
      if (this.onMfsk   && int16) this.onMfsk(int16);
      if (this.onMt63   && int16) this.onMt63(int16);
      if (this.onFsq    && int16) this.onFsq(int16);
      if (this.onThor   && int16) this.onThor(int16);
      if (this.onDominoex && int16) this.onDominoex(int16);
      if (this.onContestia && int16) this.onContestia(int16);
      if (this.onSitor    && int16) this.onSitor(int16);
      if (this.onWwv      && int16) this.onWwv(int16);
      if (this.onAle      && int16) this.onAle(int16);
      if (this.onPacket   && int16) this.onPacket(int16);
      if (this.onWspr     && int16) this.onWspr(int16);
      if (this.onWspr15   && int16) this.onWspr15(int16);
      if (this.onJs8      && int16) this.onJs8(int16);
      if (this.onJt9      && int16) this.onJt9(int16);
      if (this.onJt65     && int16) this.onJt65(int16);
      if (this.onQ65      && int16) this.onQ65(int16);
      if (this.onFst4     && int16) this.onFst4(int16);
      if (this.onFst4w    && int16) this.onFst4w(int16);
      if (this.onStanag   && int16) this.onStanag(int16);
      if (this.onStanag4539 && int16) this.onStanag4539(int16);
      if (this.onHell     && int16) this.onHell(int16);
      if (this.onSstv     && int16) this.onSstv(int16);
      if (this.onFreedv   && int16) this.onFreedv(int16);
      if (this.onThrob    && int16) this.onThrob(int16);
      if (this.onJt4      && int16) this.onJt4(int16);
      if (this.onSelcal   && int16) this.onSelcal(int16);
      if (this.onPocsag   && int16) this.onPocsag(int16);
      if (this.onDsd      && int16) this.onDsd(int16);
      if (this.onMultimon && int16) this.onMultimon(int16);
      if (this.onMsk144   && int16) this.onMsk144(int16);
      if (this.onAis      && int16) this.onAis(int16);
      if (this.onAcars    && int16) this.onAcars(int16);
      if (this.onTetrapol && int16) this.onTetrapol(int16);
      if (this.onOp25     && int16) this.onOp25(int16);
      if (this.onLrpt     && int16) this.onLrpt(int16);
      if (this.onScope    && int16) this.onScope(int16);
      if (this.onThd      && int16) this.onThd(int16);
      if (this.onPersist  && int16) this.onPersist(int16);
      if (this.onEnvp     && int16) this.onEnvp(int16);
      if (this.onCeps     && int16) this.onCeps(int16);
      if (this.onMhum     && int16) this.onMhum(int16);
      if (this.onWelch    && int16) this.onWelch(int16);
      if (this.onCrest    && int16) this.onCrest(int16);
      if (this.onMask     && int16) this.onMask(int16);
      if (this.onRspec    && int16) this.onRspec(int16);
      if (this.onLpc      && int16) this.onLpc(int16);
      if (this.onGdelay   && int16) this.onGdelay(int16);
      if (this.onAbspec   && int16) this.onAbspec(int16);
      if (this.onWavelet  && int16) this.onWavelet(int16);
      if (this.onHht      && int16) this.onHht(int16);
      if (this.onMel      && int16) this.onMel(int16);
      if (this.onChro     && int16) this.onChro(int16);
      if (this.onMspec    && int16) this.onMspec(int16);
      if (this.onAcf      && int16) this.onAcf(int16);
      if (this.onSent     && int16) this.onSent(int16);
      if (this.onSflat    && int16) this.onSflat(int16);
      if (this.onQq       && int16) this.onQq(int16);
      if (this.onCiper    && int16) this.onCiper(int16);
      if (this.onPhaseP   && int16) this.onPhaseP(int16);
      if (this.onVect     && int16) this.onVect(int16);
      if (this.onQrss     && int16) this.onQrss(int16);
      if (this.onIqAudio  && int16) this.onIqAudio(int16);
    }
    // Client-side squelch — Kiwi's `SET squelch=` is silently ignored on
    // stock firmware, so we gate the speaker path here based on the
    // frame's RSSI. Decoders above already saw the live signal; only
    // the audible playback drops to silence below the threshold.
    if (this.squelchDbm != null && frame.rssiDbm < this.squelchDbm) {
      src = new Float32Array(src.length);   // zero-filled
    }
    // GATE — soft downward expander on the demodulated audio. Runs
    // *after* the RSSI squelch so the two stack. See setNoiseGate for
    // the full design notes; quick summary: above threshold → unity,
    // below → smooth (RATIO−1)×dB attenuation with a soft knee, EMA-
    // smoothed with separate attack/release time-constants so it
    // doesn't click between speech consonants.
    if (this.gateDbfs != null && src.length > 0) {
      let sumSq = 0;
      for (let i = 0; i < src.length; i++) { const v = src[i]; sumSq += v * v; }
      const rms = Math.sqrt(sumSq / src.length);
      const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -200;
      const T = this.gateDbfs;
      const R = AudioPlayer.GATE_RATIO;
      const K = AudioPlayer.GATE_KNEE_DB;
      // Target gain (in dB) from the expander curve with soft knee.
      // x = level − threshold (positive when above threshold).
      const x = rmsDb - T;
      let attenDb: number;
      if (x >= K / 2) {
        attenDb = 0;
      } else if (x <= -K / 2) {
        attenDb = (R - 1) * (-x);   // below knee: full expansion
      } else {
        // Quadratic soft knee: smoothly interpolates from 0 dB attenuation
        // at +K/2 to (R−1)·(K/2) at −K/2. Standard compressor-knee shape
        // applied symmetrically.
        const t = (K / 2 - x) / K;  // 0 at +K/2, 1 at −K/2
        attenDb = (R - 1) * (K / 2) * t * t;
      }
      const targetGain = Math.pow(10, -attenDb / 20);
      // Frame-rate-independent EMA: choose α from how many ms this
      // frame represents. Faster α when target < current (release is
      // actually a fall here since we're "releasing" the attenuation
      // when audio comes back).
      const frameMs = (src.length / this.inputRate) * 1000;
      const tauMs = targetGain < this.gateGain
        ? AudioPlayer.GATE_ATTACK_MS    // gain dropping → attack (fast)
        : AudioPlayer.GATE_RELEASE_MS;  // gain rising  → release (slow)
      const alpha = 1 - Math.exp(-frameMs / Math.max(1, tauMs));
      this.gateGain += (targetGain - this.gateGain) * alpha;
      // Apply the smoothed gain to a fresh copy so we don't mutate
      // whatever upstream holds the original buffer.
      const g = this.gateGain;
      if (g < 0.999) {
        const out = new Float32Array(src.length);
        for (let i = 0; i < src.length; i++) out[i] = src[i] * g;
        src = out;
      }
    }
    if (src.length === 0) return;
    const dstRate = this.ctx.sampleRate;
    const ratio = this.inputRate / dstRate;
    const N = src.length;
    const maxOut = Math.ceil((N - this.resamplePhase) / ratio) + 1;
    if (this.resampleScratch.length < maxOut) this.resampleScratch = new Float32Array(maxOut * 2);
    const out = this.resampleScratch;
    let n = 0;
    let p = this.resamplePhase;
    while (p < N) {
      const i0 = Math.floor(p);
      const frac = p - i0;
      const a = i0 === 0 ? this.resampleLast : src[i0 - 1];
      const b = src[i0];
      out[n++] = a + (b - a) * frac;
      p += ratio;
    }
    this.resamplePhase = p - N;
    this.resampleLast = src[N - 1];
    if (n) this.deliver(out.subarray(0, n));
  }

  /** Play a TEST sample through a sample-accurate AudioBufferSourceNode
   *  routed into the shared mixer. Mixer fans out to speakers + SPEC, so
   *  TEST audio is heard and analysed identically to Kiwi audio — and
   *  Kiwi disconnect doesn't disturb the test playback (and vice-versa). */
  playTestBuffer(int16: Int16Array, sampleRate: number, loop: boolean, onEnded?: () => void): { stop: () => void } {
    const ctx = this.ensureGraph();
    if (!ctx || !this.mixer) return { stop: () => {} };
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const buf = ctx.createBuffer(1, int16.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.connect(this.mixer);
    src.start();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    };
    src.onended = () => {
      if (!loop) {
        stopped = true;
        try { onEnded?.(); } catch {}
      }
    };
    return { stop };
  }

  /** Inject synthetic test samples into the player as if they were Kiwi
   *  audio — speakers, SPEC analyser, decoders, recorder, FT8, classifier
   *  all see them. Bypasses the MUTE gate so the user can mute Kiwi and
   *  use a TEST sample as the sole audio source. */
  injectTestSamples(int16: Int16Array, sampleRate: number): void {
    if (!this.ctx || int16.length === 0) return;
    // Fan-out (decoders / recorder / ft8 / etc) — always, regardless of mute.
    if (this.onRawSamples) this.onRawSamples(int16);
    if (this.onRecord)     this.onRecord(int16);
    if (this.onFt8)        this.onFt8(int16);
    if (this.onCw)         this.onCw(int16);
    if (this.onRtty)       this.onRtty(int16);
    if (this.onOlivia)     this.onOlivia(int16);
    if (this.onMfsk)       this.onMfsk(int16);
    if (this.onMt63)       this.onMt63(int16);
    if (this.onFsq)        this.onFsq(int16);
    if (this.onThor)       this.onThor(int16);
    if (this.onDominoex)   this.onDominoex(int16);
    if (this.onContestia)  this.onContestia(int16);
    if (this.onSitor)      this.onSitor(int16);
    if (this.onWwv)        this.onWwv(int16);
    if (this.onAle)        this.onAle(int16);
    if (this.onPsk)        this.onPsk(int16);
    if (this.onClassify)   this.onClassify(int16);
    if (this.onWefax)      this.onWefax(int16);
    if (this.onNavtex)     this.onNavtex(int16);
    if (this.onPacket)     this.onPacket(int16);
    if (this.onWspr)       this.onWspr(int16);
    if (this.onWspr15)     this.onWspr15(int16);
    if (this.onJs8)        this.onJs8(int16);
    if (this.onJt9)        this.onJt9(int16);
    if (this.onJt65)       this.onJt65(int16);
    if (this.onQ65)        this.onQ65(int16);
    if (this.onFst4)       this.onFst4(int16);
    if (this.onFst4w)      this.onFst4w(int16);
    if (this.onStanag)     this.onStanag(int16);
    if (this.onStanag4539) this.onStanag4539(int16);
    if (this.onHell)       this.onHell(int16);
    if (this.onSstv)       this.onSstv(int16);
    if (this.onFreedv)     this.onFreedv(int16);
    if (this.onThrob)      this.onThrob(int16);
    if (this.onJt4)        this.onJt4(int16);
    if (this.onSelcal)     this.onSelcal(int16);
    if (this.onPocsag)     this.onPocsag(int16);
    if (this.onDsd)        this.onDsd(int16);
    if (this.onMultimon)   this.onMultimon(int16);
    if (this.onMsk144)     this.onMsk144(int16);
    if (this.onAis)        this.onAis(int16);
    if (this.onAcars)      this.onAcars(int16);
    if (this.onTetrapol)   this.onTetrapol(int16);
    if (this.onOp25)       this.onOp25(int16);
    if (this.onLrpt)       this.onLrpt(int16);
    if (this.onScope)      this.onScope(int16);
    if (this.onThd)        this.onThd(int16);
    if (this.onPersist)    this.onPersist(int16);
    if (this.onEnvp)       this.onEnvp(int16);
    if (this.onCeps)       this.onCeps(int16);
    if (this.onMhum)       this.onMhum(int16);
    if (this.onWelch)      this.onWelch(int16);
    if (this.onCrest)      this.onCrest(int16);
    if (this.onMask)       this.onMask(int16);
    if (this.onRspec)      this.onRspec(int16);
    if (this.onLpc)        this.onLpc(int16);
    if (this.onGdelay)     this.onGdelay(int16);
    if (this.onAbspec)     this.onAbspec(int16);
    if (this.onWavelet)    this.onWavelet(int16);
    if (this.onHht)        this.onHht(int16);
    if (this.onMel)        this.onMel(int16);
    if (this.onChro)       this.onChro(int16);
    if (this.onMspec)      this.onMspec(int16);
    if (this.onAcf)        this.onAcf(int16);
    if (this.onSent)       this.onSent(int16);
    if (this.onSflat)      this.onSflat(int16);
    if (this.onQq)         this.onQq(int16);
    if (this.onCiper)      this.onCiper(int16);
    if (this.onPhaseP)     this.onPhaseP(int16);
    if (this.onVect)       this.onVect(int16);
    if (this.onIqAudio)    this.onIqAudio(int16);
    if (this.onQrss)       this.onQrss(int16);
    // Convert to Float32 and resample to ctx rate using a small local
    // resampler (separate state from the Kiwi resampler so they don't
    // interfere if both ever run concurrently).
    const src = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) src[i] = int16[i] / 32768;
    const dstRate = this.ctx.sampleRate;
    const ratio = sampleRate / dstRate;
    if (Math.abs(ratio - 1) < 1e-6) {
      this.deliver(src);
      return;
    }
    const N = src.length;
    const maxOut = Math.ceil((N - this.testResamplePhase) / ratio) + 1;
    if (this.testResampleScratch.length < maxOut) {
      this.testResampleScratch = new Float32Array(maxOut * 2);
    }
    const out = this.testResampleScratch;
    let n = 0;
    let p = this.testResamplePhase;
    while (p < N) {
      const i0 = Math.floor(p);
      const frac = p - i0;
      const a = i0 === 0 ? this.testResampleLast : src[i0 - 1];
      const b = src[i0];
      out[n++] = a + (b - a) * frac;
      p += ratio;
    }
    this.testResamplePhase = p - N;
    this.testResampleLast = src[N - 1];
    if (n) this.deliver(out.subarray(0, n));
  }
  private testResampleScratch = new Float32Array(8192);
  private testResamplePhase = 0;
  private testResampleLast = 0;
  /** Reset the test-sample resampler state (call on stop/loop boundary). */
  resetTestSampleResampler(): void {
    this.testResamplePhase = 0;
    this.testResampleLast = 0;
  }

  private deliver(samples: Float32Array): void {
    if (this.worklet) {
      // Worklet runs on a different thread — must copy before transfer.
      // (Android uses ScriptProcessor path below, which copies into the ring.)
      const copy = new Float32Array(samples);
      this.worklet.port.postMessage({ type: 'samples', data: copy }, [copy.buffer]);
    } else if (this.spnode) {
      this.pushToRing(samples); // copies into ring; scratch can be reused
    }
  }

  private pushToRing(samples: Float32Array): void {
    if (this.ringSize + samples.length > this.ring.length) this.growRing(this.ringSize + samples.length);
    const cap = this.ring.length;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringW] = samples[i];
      this.ringW = (this.ringW + 1) % cap;
    }
    this.ringSize += samples.length;
  }

  private growRing(min: number): void {
    let cap = this.ring.length;
    while (cap < min) cap *= 2;
    const nb = new Float32Array(cap);
    for (let i = 0; i < this.ringSize; i++) nb[i] = this.ring[(this.ringR + i) % this.ring.length];
    this.ring = nb; this.ringR = 0; this.ringW = this.ringSize;
  }

  private send(msg: object): void {
    if (this.worklet) {
      const tx = (msg as { data?: Float32Array }).data;
      this.worklet.port.postMessage(msg, tx ? [tx.buffer] : []);
    }
    // ScriptProcessor path keeps gain/mute as instance fields; nothing to post.
  }
}
