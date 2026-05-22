/** SID — local "signal-identification specialist" analysis of a 1 s
 *  demodulated-audio clip.
 *
 *  Computes the full battery of measurements that an intercept analyst
 *  / SIGINT operator would extract from a captured signal:
 *
 *  • Time-domain: peak, RMS, DC offset, crest factor, higher-order
 *    moments (skewness, kurtosis), noise floor + SNR.
 *  • Envelope (via analytic signal): mean, std, skew, kurt, AM index,
 *    duty cycle, burst rate, average burst / gap length, rise / fall
 *    time (10 .. 90 %).
 *  • Spectrum: centroid, spread, skewness, kurtosis, slope, Wiener
 *    flatness, Shannon entropy, 95 / 99 % rolloff, occupied bandwidth
 *    at −3 / −6 / −20 dB, sub-band power distribution (8 bands),
 *    sideband symmetry P.
 *  • Instantaneous amplitude (|z|): centred-normalised stats, σ_aa,
 *    γ_max (max PSD of normalised centred amplitude).
 *  • Instantaneous frequency (d/dt arg z): mean, std (FM deviation),
 *    skew, kurt, range, σ_af.
 *  • Instantaneous phase: σ_ap (nonlinear centred), σ_dp (nonlinear
 *    direct), phase-jump rate.
 *  • Higher-order cumulants on the analytic signal (|C20|, |C21|,
 *    |C40|, |C42|, μ_42) — used by Azzouz-Nandi modulation
 *    classifiers.
 *  • Cepstrum: top quefrencies + pitch estimate.
 *  • Tones: parabolic-interpolated peak list with dB above floor,
 *    median spacing + spacing std + GCD candidate.
 *  • Symbol rate: autocorrelation of envelope, top-3 candidates.
 *  • Cyclic spectrum: CAF magnitude at each baud candidate.
 *  • Verdict: heuristic fingerprint matcher against well-known HF
 *    waveforms (RTTY, NAVTEX, PSK31, FT8, Olivia, WEFAX, CW, AM,
 *    SSB, OFDM, empty-channel, etc.) with confidence + alternatives.
 *
 *  All runs locally — no network. */

import { applyIqFilterChain, type IqFilterChainOpts } from '../util/iq-filters';

export interface LocalAnalysisOpts {
  samples: Float32Array;     // mono PCM in [-1, 1]
  sampleRate: number;
  freqKHz: number;
  mode: string;              // demodulator mode at capture time
}

/* ──────────────────────────  WAV decode  ────────────────────────── */

/** Decode a stereo (or mono) WAV blob to separate I / Q Float32 arrays
 *  in [-1, 1]. For SID's IQ capture the WAV is always 2-channel with
 *  L = I, R = Q (see captureAudio in shell.ts). A mono WAV falls back
 *  to I = samples, Q = zeros so the rest of the pipeline still runs. */
export async function decodeWavIQ(blob: Blob): Promise<{ I: Float32Array; Q: Float32Array; sampleRate: number }> {
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) {
    throw new Error('not a WAV blob');
  }
  let p = 12;
  let channels = 1, sampleRate = 12000, bitsPerSample = 16, dataOffset = -1, dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id  = dv.getUint32(p, false); p += 4;
    const len = dv.getUint32(p, true);  p += 4;
    if (id === 0x666d7420) {
      channels      = dv.getUint16(p + 2, true);
      sampleRate    = dv.getUint32(p + 4, true);
      bitsPerSample = dv.getUint16(p + 14, true);
    } else if (id === 0x64617461) {
      dataOffset = p; dataLen = len; break;
    }
    p += len + (len & 1);
  }
  if (dataOffset < 0 || bitsPerSample !== 16) throw new Error('unsupported WAV layout');
  const nFrames = (dataLen / 2 / channels) | 0;
  const I = new Float32Array(nFrames);
  const Q = new Float32Array(nFrames);
  if (channels === 1) {
    for (let i = 0; i < nFrames; i++) I[i] = dv.getInt16(dataOffset + i * 2, true) / 32768;
    // Q stays zero — caller is expected to be operating on a real-valued
    // demodulated audio capture if it ever lands here.
  } else {
    const step = channels * 2;
    for (let i = 0; i < nFrames; i++) {
      I[i] = dv.getInt16(dataOffset + i * step,     true) / 32768;
      Q[i] = dv.getInt16(dataOffset + i * step + 2, true) / 32768;
    }
  }
  return { I, Q, sampleRate };
}

export async function decodeWavMono(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const buf = await blob.arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) {
    throw new Error('not a WAV blob');
  }
  let p = 12;
  let channels = 1, sampleRate = 12000, bitsPerSample = 16, dataOffset = -1, dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id  = dv.getUint32(p, false); p += 4;
    const len = dv.getUint32(p, true);  p += 4;
    if (id === 0x666d7420) {
      channels      = dv.getUint16(p + 2, true);
      sampleRate    = dv.getUint32(p + 4, true);
      bitsPerSample = dv.getUint16(p + 14, true);
    } else if (id === 0x64617461) {
      dataOffset = p; dataLen = len; break;
    }
    p += len + (len & 1);
  }
  if (dataOffset < 0 || bitsPerSample !== 16) throw new Error('unsupported WAV layout');
  const nFrames = (dataLen / 2 / channels) | 0;
  const out = new Float32Array(nFrames);
  if (channels === 1) {
    for (let i = 0; i < nFrames; i++) out[i] = dv.getInt16(dataOffset + i * 2, true) / 32768;
  } else {
    const step = channels * 2;
    for (let i = 0; i < nFrames; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += dv.getInt16(dataOffset + i * step + c * 2, true);
      out[i] = s / (channels * 32768);
    }
  }
  return { samples: out, sampleRate };
}

/* ─────────────────────────  FFT primitives  ─────────────────────── */

function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p; }

function hannInPlace(x: Float32Array, len = x.length): void {
  for (let i = 0; i < len; i++) x[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
}

function fft(re: Float32Array, im: Float32Array): void {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j |= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const ang = -2 * Math.PI / size;
    const wre = Math.cos(ang), wim = Math.sin(ang);
    for (let s = 0; s < N; s += size) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const i0 = s + k, i1 = i0 + half;
        const tr = cr * re[i1] - ci * im[i1];
        const ti = cr * im[i1] + ci * re[i1];
        re[i1] = re[i0] - tr; im[i1] = im[i0] - ti;
        re[i0] += tr;         im[i0] += ti;
        const ncr = cr * wre - ci * wim;
        ci = cr * wim + ci * wre;
        cr = ncr;
      }
    }
  }
}

function ifft(re: Float32Array, im: Float32Array): void {
  const N = re.length;
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / N;
  for (let i = 0; i < N; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}

/* ────────────────  Statistical / DSP helpers  ──────────────────── */

function moments(x: Float32Array | number[]): {
  mean: number; variance: number; std: number; skew: number; kurt: number;
} {
  const N = x.length;
  if (N === 0) return { mean: 0, variance: 0, std: 0, skew: 0, kurt: 0 };
  let mean = 0;
  for (let i = 0; i < N; i++) mean += x[i];
  mean /= N;
  let m2 = 0, m3 = 0, m4 = 0;
  for (let i = 0; i < N; i++) {
    const d = x[i] - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= N; m3 /= N; m4 /= N;
  const std = Math.sqrt(m2);
  const skew = std > 0 ? m3 / (std * std * std) : 0;
  const kurt = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;
  return { mean, variance: m2, std, skew, kurt };
}

function percentile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * q)));
  return sorted[idx];
}

/** Hilbert-transformed analytic signal: returns real / imag parts of
 *  z(t) = x(t) + j·H{x(t)} via spectral zeroing of the negative-frequency half. */
function analyticSignal(x: Float32Array): { re: Float32Array; im: Float32Array } {
  const N = nextPow2(x.length);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  re.set(x);
  fft(re, im);
  const half = N >> 1;
  for (let i = 1; i < half; i++) { re[i] *= 2; im[i] *= 2; }
  for (let i = half + 1; i < N; i++) { re[i] = 0; im[i] = 0; }
  ifft(re, im);
  return { re: re.subarray(0, x.length), im: im.subarray(0, x.length) };
}

/* ─────────────────────────  Spectrum  ───────────────────────────── */

interface Spectrum {
  mag: Float32Array;       // half-spectrum magnitude (length N/2+1)
  power: Float32Array;     // |mag|² for psd-shape stats
  binHz: number;
  N: number;               // FFT length
}

function magnitudeSpectrum(samples: Float32Array, sampleRate: number): Spectrum {
  const N = nextPow2(samples.length);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  re.set(samples);
  hannInPlace(re, samples.length);
  fft(re, im);
  const half = (N >> 1) + 1;
  const mag = new Float32Array(half);
  const power = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const m = Math.hypot(re[i], im[i]);
    mag[i] = m;
    power[i] = m * m;
  }
  return { mag, power, binHz: sampleRate / N, N };
}

interface SpectralStats {
  centroidHz: number;
  spreadHz: number;
  skewness: number;
  kurtosis: number;
  slopeDbPerOct: number;
  flatness: number;          // Wiener entropy 0..1
  entropy: number;           // Shannon entropy of normalised power, in nats
  rolloff95Hz: number;
  rolloff99Hz: number;
  subBandPower: number[];    // 8 bands, normalised
  sidebandP: number;         // 0 = all power below centroid, 1 = above
}

function spectralStats(spec: Spectrum, loHz = 100, hiHz = 5500): SpectralStats {
  const { power, binHz } = spec;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(power.length - 1, Math.floor(hiHz / binHz));
  let total = 0;
  for (let i = lo; i <= hi; i++) total += power[i];
  if (total <= 0) {
    return {
      centroidHz: 0, spreadHz: 0, skewness: 0, kurtosis: 0, slopeDbPerOct: 0,
      flatness: 0, entropy: 0, rolloff95Hz: 0, rolloff99Hz: 0,
      subBandPower: [0,0,0,0,0,0,0,0], sidebandP: 0.5,
    };
  }

  // Probability mass over freq bins (normalised).
  let centroid = 0;
  for (let i = lo; i <= hi; i++) centroid += i * binHz * power[i];
  centroid /= total;

  let m2 = 0, m3 = 0, m4 = 0;
  for (let i = lo; i <= hi; i++) {
    const d = i * binHz - centroid;
    const w = power[i] / total;
    const d2 = d * d;
    m2 += d2 * w;
    m3 += d2 * d * w;
    m4 += d2 * d2 * w;
  }
  const spread = Math.sqrt(Math.max(0, m2));
  const skew = spread > 0 ? m3 / (spread * spread * spread) : 0;
  const kurt = m2 > 0 ? m4 / (m2 * m2) - 3 : 0;

  // Spectral slope: fit log10(power) vs log2(freq) → dB/octave.
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let i = lo; i <= hi; i++) {
    const f = i * binHz;
    if (f <= 0 || power[i] <= 0) continue;
    const x = Math.log2(f);
    const y = 10 * Math.log10(power[i]);
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  const slope = (n > 1 && (sxx * n - sx * sx) > 0)
    ? (n * sxy - sx * sy) / (n * sxx - sx * sx)
    : 0;

  // Wiener flatness (geomean / arithmean).
  let logSum = 0, linSum = 0, nf = 0;
  for (let i = lo; i <= hi; i++) {
    const p = Math.max(1e-20, power[i]);
    logSum += Math.log(p);
    linSum += p;
    nf++;
  }
  const flatness = nf > 0 ? Math.exp(logSum / nf) / (linSum / nf) : 0;

  // Shannon entropy of normalised power (nats).
  let entropy = 0;
  for (let i = lo; i <= hi; i++) {
    const p = power[i] / total;
    if (p > 1e-12) entropy -= p * Math.log(p);
  }

  // Roll-off.
  let cum = 0, r95 = (hi * binHz), r99 = (hi * binHz);
  let hit95 = false, hit99 = false;
  for (let i = lo; i <= hi; i++) {
    cum += power[i];
    if (!hit95 && cum >= 0.95 * total) { r95 = i * binHz; hit95 = true; }
    if (!hit99 && cum >= 0.99 * total) { r99 = i * binHz; hit99 = true; }
  }

  // Sub-band power (8 equal-log bands across loHz .. hiHz).
  const subBand: number[] = [];
  const bands = 8;
  for (let b = 0; b < bands; b++) {
    const fLo = loHz * Math.pow(hiHz / loHz, b / bands);
    const fHi = loHz * Math.pow(hiHz / loHz, (b + 1) / bands);
    const iLo = Math.max(lo, Math.floor(fLo / binHz));
    const iHi = Math.min(hi, Math.ceil(fHi / binHz));
    let p = 0;
    for (let i = iLo; i <= iHi; i++) p += power[i];
    subBand.push(p / total);
  }

  // Sideband symmetry P relative to centroid bin.
  const cBin = Math.round(centroid / binHz);
  let pBelow = 0, pAbove = 0;
  for (let i = lo;     i < cBin; i++) pBelow += power[i];
  for (let i = cBin + 1; i <= hi; i++) pAbove += power[i];
  const sidebandP = (pAbove + pBelow) > 0 ? pAbove / (pAbove + pBelow) : 0.5;

  return {
    centroidHz: centroid, spreadHz: spread, skewness: skew, kurtosis: kurt,
    slopeDbPerOct: slope, flatness, entropy, rolloff95Hz: r95, rolloff99Hz: r99,
    subBandPower: subBand, sidebandP,
  };
}

interface Peak { hz: number; mag: number; db: number; }

function findPeaks(spec: Spectrum, loHz = 100, hiHz = 4500, limit = 16): Peak[] {
  const { mag, binHz } = spec;
  const lo = Math.max(2, Math.floor(loHz / binHz));
  const hi = Math.min(mag.length - 2, Math.floor(hiHz / binHz));
  const sorted = Array.from(mag.subarray(lo, hi)).sort((a, b) => a - b);
  const floor = sorted[sorted.length >> 1] || 1e-9;
  const thrAbs = floor * Math.pow(10, 8 / 20);
  const peaks: Peak[] = [];
  for (let i = lo + 1; i < hi - 1; i++) {
    const v = mag[i];
    if (v < thrAbs) continue;
    if (v <= mag[i - 1] || v <= mag[i + 1]) continue;
    const a = mag[i - 1], b = v, c = mag[i + 1];
    const denom = (a - 2 * b + c);
    const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    const hz = (i + delta) * binHz;
    peaks.push({ hz, mag: v, db: 20 * Math.log10(v / floor) });
  }
  peaks.sort((p, q) => q.mag - p.mag);
  const kept: Peak[] = [];
  for (const p of peaks) {
    if (kept.length >= limit) break;
    if (kept.some(k => Math.abs(k.hz - p.hz) < 25)) continue;
    kept.push(p);
  }
  return kept;
}

function bandwidthAt(spec: Spectrum, dbDown: number): { loHz: number; hiHz: number } {
  const { mag, binHz } = spec;
  const lo0 = Math.max(2, Math.floor(50 / binHz));
  const hi0 = Math.min(mag.length - 2, Math.floor(5500 / binHz));
  let peak = 0;
  for (let i = lo0; i < hi0; i++) if (mag[i] > peak) peak = mag[i];
  if (peak <= 0) return { loHz: 0, hiHz: 0 };
  const thr = peak * Math.pow(10, -Math.abs(dbDown) / 20);
  let lo = hi0, hi = lo0;
  for (let i = lo0; i < hi0; i++) {
    if (mag[i] >= thr) { if (i < lo) lo = i; if (i > hi) hi = i; }
  }
  return { loHz: lo * binHz, hiHz: hi * binHz };
}

/* ─────────────────────────  Envelope analysis  ──────────────────── */

interface EnvStats {
  envelope: Float32Array;
  mean: number;
  std: number;
  skew: number;
  kurt: number;
  amIndex: number;
  dutyCycle: number;
  burstCount: number;        // bursts per second
  avgBurstSec: number;
  avgGapSec: number;
  riseMs: number;            // 10..90 % average rise
  fallMs: number;
}

function envelopeStats(analytic: { re: Float32Array; im: Float32Array }, sampleRate: number): EnvStats {
  const N = analytic.re.length;
  const env = new Float32Array(N);
  for (let i = 0; i < N; i++) env[i] = Math.hypot(analytic.re[i], analytic.im[i]);
  const m = moments(env);
  let mx = -Infinity, mn = Infinity;
  for (let i = 0; i < N; i++) { if (env[i] > mx) mx = env[i]; if (env[i] < mn) mn = env[i]; }
  const amIndex = (mx + mn) > 0 ? (mx - mn) / (mx + mn) : 0;

  // Burst statistics.
  const thr = m.mean;
  let onCount = 0, transitions = 0;
  const burstLens: number[] = [];
  const gapLens: number[] = [];
  let runStart = 0;
  let prev = env[0] > thr ? 1 : 0;
  for (let i = 1; i < N; i++) {
    const cur = env[i] > thr ? 1 : 0;
    if (cur !== prev) {
      const lenS = (i - runStart) / sampleRate;
      if (prev) burstLens.push(lenS);
      else      gapLens.push(lenS);
      runStart = i;
      transitions++;
      prev = cur;
    }
    if (cur) onCount++;
  }
  const burstCount = transitions > 0 ? (transitions / 2) * (sampleRate / N) : 0;
  const avgBurstSec = burstLens.length ? burstLens.reduce((a, b) => a + b, 0) / burstLens.length : 0;
  const avgGapSec   = gapLens.length   ? gapLens.reduce((a, b) => a + b, 0)   / gapLens.length   : 0;

  // Rise / fall (10..90 %). Walk through each burst edge.
  const riseTimes: number[] = [];
  const fallTimes: number[] = [];
  const peakLevel = mx;
  const t10 = 0.1 * peakLevel;
  const t90 = 0.9 * peakLevel;
  for (let i = 1; i < N; i++) {
    if (env[i - 1] < t10 && env[i] >= t10) {
      // scan forward for first sample ≥ t90
      let j = i;
      while (j < N && env[j] < t90) j++;
      if (j < N) riseTimes.push((j - i) / sampleRate);
    } else if (env[i - 1] > t90 && env[i] <= t90) {
      let j = i;
      while (j < N && env[j] > t10) j++;
      if (j < N) fallTimes.push((j - i) / sampleRate);
    }
  }
  const avg = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

  return {
    envelope: env,
    mean: m.mean, std: m.std, skew: m.skew, kurt: m.kurt,
    amIndex,
    dutyCycle: onCount / N,
    burstCount,
    avgBurstSec, avgGapSec,
    riseMs: avg(riseTimes) * 1000,
    fallMs: avg(fallTimes) * 1000,
  };
}

/* ─────────────────────  Inst-freq / phase / AMC  ────────────────── */

interface InstFreqStats {
  meanHz: number; stdHz: number; skew: number; kurt: number;
  minHz: number; maxHz: number; rangeHz: number;
  values: Float32Array;                    // for σ_af
}

function instantaneousFrequency(analytic: { re: Float32Array; im: Float32Array }, sampleRate: number): InstFreqStats {
  const N = analytic.re.length;
  const f = new Float32Array(Math.max(0, N - 1));
  let kept = 0;
  for (let i = 0; i + 1 < N; i++) {
    const r0 = analytic.re[i], i0 = analytic.im[i];
    const r1 = analytic.re[i + 1], i1 = analytic.im[i + 1];
    const mag = r0 * r0 + i0 * i0;
    if (mag < 1e-10) continue;
    const dot   = r0 * r1 + i0 * i1;
    const cross = r0 * i1 - i0 * r1;
    const dphi  = Math.atan2(cross, dot);
    f[kept++] = dphi * sampleRate / (2 * Math.PI);
  }
  const trimmed = f.subarray(0, kept);
  const m = moments(trimmed);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < kept; i++) { if (trimmed[i] < mn) mn = trimmed[i]; if (trimmed[i] > mx) mx = trimmed[i]; }
  if (kept === 0) { mn = 0; mx = 0; }
  return {
    meanHz: m.mean, stdHz: m.std, skew: m.skew, kurt: m.kurt,
    minHz: mn, maxHz: mx, rangeHz: mx - mn,
    values: trimmed,
  };
}

interface InstPhaseStats {
  sigmaAp: number;        // std of |φ_NL_centered|
  sigmaDp: number;        // std of φ_NL_centered (signed)
  jumpRate: number;       // discrete jumps > π/4 per second
}

function instantaneousPhase(analytic: { re: Float32Array; im: Float32Array }, sampleRate: number): InstPhaseStats {
  const N = analytic.re.length;
  if (N < 4) return { sigmaAp: 0, sigmaDp: 0, jumpRate: 0 };
  // Unwrapped phase.
  const phi = new Float32Array(N);
  phi[0] = Math.atan2(analytic.im[0], analytic.re[0]);
  for (let i = 1; i < N; i++) {
    let p = Math.atan2(analytic.im[i], analytic.re[i]);
    let dp = p - (phi[i - 1] - Math.floor(phi[i - 1] / (2 * Math.PI)) * (2 * Math.PI));
    // Approximate unwrap.
    while (p - phi[i - 1] > Math.PI)  p -= 2 * Math.PI;
    while (p - phi[i - 1] < -Math.PI) p += 2 * Math.PI;
    phi[i] = p;
    void dp;
  }
  // Linear trend ax + b (removes mean carrier offset).
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < N; i++) { sx += i; sy += phi[i]; sxx += i * i; sxy += i * phi[i]; }
  const denom = N * sxx - sx * sx;
  const a = denom !== 0 ? (N * sxy - sx * sy) / denom : 0;
  const b = (sy - a * sx) / N;
  const phiNL = new Float32Array(N);
  for (let i = 0; i < N; i++) phiNL[i] = phi[i] - (a * i + b);

  // Restrict to high-SNR samples (|z| > median).
  const env = new Float32Array(N);
  for (let i = 0; i < N; i++) env[i] = Math.hypot(analytic.re[i], analytic.im[i]);
  const sortedEnv = Array.from(env).sort((u, v) => u - v);
  const envThr = sortedEnv[N >> 1];
  const sel: number[] = [];
  for (let i = 0; i < N; i++) if (env[i] > envThr) sel.push(phiNL[i]);
  if (sel.length < 4) return { sigmaAp: 0, sigmaDp: 0, jumpRate: 0 };
  const mAbs = moments(sel.map(Math.abs));
  const mSig = moments(sel);

  // Phase-jump rate: |Δφ_unwrapped| > π/4 between consecutive samples
  // amongst the high-SNR set.
  let jumps = 0, scanned = 0;
  for (let i = 1; i < N; i++) {
    if (env[i] <= envThr || env[i - 1] <= envThr) continue;
    scanned++;
    if (Math.abs(phiNL[i] - phiNL[i - 1]) > Math.PI / 4) jumps++;
  }
  const jumpRate = scanned > 0 ? jumps * sampleRate / N : 0;
  return { sigmaAp: mAbs.std, sigmaDp: mSig.std, jumpRate };
}

interface AzzouzFeatures {
  sigma_aa: number;     // std of normalised centred amplitude
  gamma_max: number;    // max PSD value of normalised centred amplitude
  sigma_af: number;     // std of normalised centred absolute inst. freq
  sigma_ap: number;     // copied from phase stats
  sigma_dp: number;
  P: number;            // sideband symmetry (from spectral stats)
}

function azzouzFeatures(envelope: Float32Array, inst: InstFreqStats, phase: InstPhaseStats,
                        sidebandP: number): AzzouzFeatures {
  // Normalised centred amplitude a_cn(n) = env(n)/mean(env) - 1.
  const N = envelope.length;
  let envMean = 0;
  for (let i = 0; i < N; i++) envMean += envelope[i];
  envMean /= N;
  const aCn = new Float32Array(N);
  for (let i = 0; i < N; i++) aCn[i] = envMean > 0 ? envelope[i] / envMean - 1 : 0;

  // γ_max = max | FFT(a_cn) |² / N
  const Nf = nextPow2(N);
  const re = new Float32Array(Nf);
  const im = new Float32Array(Nf);
  re.set(aCn);
  fft(re, im);
  let gMax = 0;
  for (let i = 1; i < Nf / 2; i++) {
    const v = re[i] * re[i] + im[i] * im[i];
    if (v > gMax) gMax = v;
  }
  gMax /= N;

  const sigmaAa = moments(aCn).std;

  // σ_af: std of normalised centred absolute inst. freq.
  if (inst.values.length === 0) return {
    sigma_aa: sigmaAa, gamma_max: gMax, sigma_af: 0,
    sigma_ap: phase.sigmaAp, sigma_dp: phase.sigmaDp, P: sidebandP,
  };
  // f_cn = f(n)/mean(|f|) -1 — using mean of f.
  let fMean = 0;
  for (let i = 0; i < inst.values.length; i++) fMean += inst.values[i];
  fMean /= inst.values.length;
  const fAbsN = new Float32Array(inst.values.length);
  const denom = Math.abs(fMean) > 1e-6 ? Math.abs(fMean) : 1;
  for (let i = 0; i < inst.values.length; i++) {
    fAbsN[i] = Math.abs(inst.values[i] - fMean) / denom;
  }
  const sigmaAf = moments(fAbsN).std;

  return {
    sigma_aa: sigmaAa, gamma_max: gMax, sigma_af: sigmaAf,
    sigma_ap: phase.sigmaAp, sigma_dp: phase.sigmaDp, P: sidebandP,
  };
}

/* ───────────────────────  Higher-order cumulants  ───────────────── */

interface Cumulants {
  c20Abs: number;
  c21: number;
  c40Abs: number;
  c41Abs: number;
  c42: number;
  mu42: number;     // = c42 / c21² (normalised)
}

function higherOrderCumulants(analytic: { re: Float32Array; im: Float32Array }): Cumulants {
  const N = analytic.re.length;
  if (N < 8) return { c20Abs: 0, c21: 0, c40Abs: 0, c41Abs: 0, c42: 0, mu42: 0 };
  // Normalise by RMS of |z|.
  let rms2 = 0;
  for (let i = 0; i < N; i++) rms2 += analytic.re[i] ** 2 + analytic.im[i] ** 2;
  const rms = Math.sqrt(rms2 / N);
  if (rms <= 0) return { c20Abs: 0, c21: 0, c40Abs: 0, c41Abs: 0, c42: 0, mu42: 0 };
  // Moments: M20 = E[z²], M21 = E[|z|²], M40 = E[z⁴], M41 = E[z³ z*], M42 = E[z² z*²]
  let m20re = 0, m20im = 0;
  let m21 = 0;
  let m40re = 0, m40im = 0;
  let m41re = 0, m41im = 0;
  let m42 = 0;
  for (let i = 0; i < N; i++) {
    const r = analytic.re[i] / rms;
    const m = analytic.im[i] / rms;
    const r2 = r * r - m * m;          // re(z²)
    const i2 = 2 * r * m;               // im(z²)
    const absSq = r * r + m * m;         // |z|²
    m20re += r2; m20im += i2;
    m21 += absSq;
    // z⁴ = (z²)²
    const r4 = r2 * r2 - i2 * i2;
    const i4 = 2 * r2 * i2;
    m40re += r4; m40im += i4;
    // z³ · z* = z² · |z|²  (then multiply by z again? No — z³ z* = z² · (z · z*) = z² · |z|²)
    m41re += r2 * absSq;
    m41im += i2 * absSq;
    // z² z*² = |z²|² = |z|⁴
    m42 += absSq * absSq;
  }
  m20re /= N; m20im /= N;
  m21 /= N;
  m40re /= N; m40im /= N;
  m41re /= N; m41im /= N;
  m42 /= N;
  // Cumulants (assuming zero-mean — analytic signal of a real audio is zero-mean except DC).
  // C20 = M20
  // C21 = M21
  // C40 = M40 - 3·M20²
  // C41 = M41 - 3·M20·M21
  // C42 = M42 - |M20|² - 2·M21²
  const c20Abs = Math.hypot(m20re, m20im);
  const c21 = m21;
  const m20re2 = m20re * m20re - m20im * m20im;
  const m20im2 = 2 * m20re * m20im;
  const c40re = m40re - 3 * m20re2;
  const c40im = m40im - 3 * m20im2;
  const c40Abs = Math.hypot(c40re, c40im);
  const c41re = m41re - 3 * m20re * m21;
  const c41im = m41im - 3 * m20im * m21;
  const c41Abs = Math.hypot(c41re, c41im);
  const c42 = m42 - (m20re * m20re + m20im * m20im) - 2 * m21 * m21;
  const mu42 = c21 > 0 ? c42 / (c21 * c21) : 0;
  return { c20Abs, c21, c40Abs, c41Abs, c42, mu42 };
}

/* ─────────────────────────  Cepstrum  ───────────────────────────── */

interface CepstrumInfo {
  topQuefrencies: Array<{ ms: number; hz: number; mag: number }>;
  pitchHz: number | null;
}

function realCepstrum(samples: Float32Array, sampleRate: number): CepstrumInfo {
  const N = nextPow2(samples.length);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  re.set(samples);
  hannInPlace(re, samples.length);
  fft(re, im);
  // log|X(k)| — symmetric.
  for (let i = 0; i < N; i++) {
    const m = Math.max(1e-12, Math.hypot(re[i], im[i]));
    re[i] = Math.log(m);
    im[i] = 0;
  }
  ifft(re, im);
  // Look for peaks in real(cepstrum) for quefrency 1 ms .. 50 ms.
  const qMin = Math.max(1, Math.floor(0.001 * sampleRate));   // 1 ms
  const qMax = Math.min(N >> 1, Math.floor(0.050 * sampleRate)); // 50 ms
  type Q = { ms: number; hz: number; mag: number };
  const cands: Q[] = [];
  for (let n = qMin + 1; n < qMax - 1; n++) {
    const v = re[n];
    if (v <= re[n - 1] || v <= re[n + 1]) continue;
    cands.push({ ms: 1000 * n / sampleRate, hz: sampleRate / n, mag: v });
  }
  cands.sort((a, b) => b.mag - a.mag);
  const top = cands.slice(0, 3);
  return {
    topQuefrencies: top,
    pitchHz: top.length > 0 && top[0].mag > 0.05 ? top[0].hz : null,
  };
}

/* ─────────────────────────  Symbol rate  ────────────────────────── */

interface BaudPick { baud: number; score: number; periodSec: number; }

function symbolRateCandidates(envelope: Float32Array, sampleRate: number, top = 5): BaudPick[] {
  // FFT-based autocorrelation: pad to 2N, |X|², IFFT → r[lag] in re[].
  // O(N log N) — required at 10-second clip lengths.
  const N = envelope.length;
  if (N < 64) return [];
  let mean = 0;
  for (let i = 0; i < N; i++) mean += envelope[i];
  mean /= N;
  const M = nextPow2(2 * N);
  const re = new Float32Array(M);
  const im = new Float32Array(M);
  for (let i = 0; i < N; i++) re[i] = envelope[i] - mean;
  fft(re, im);
  for (let i = 0; i < M; i++) {
    const p = re[i] * re[i] + im[i] * im[i];
    re[i] = p; im[i] = 0;
  }
  ifft(re, im);
  // re[lag] is the unnormalised autocorrelation. Divide by r0 for score.
  const r0 = re[0];
  if (r0 <= 0) return [];

  const minLag = Math.max(2, Math.floor(sampleRate / 2000));
  const maxLag = Math.min(N - 1, Math.floor(sampleRate / 4));
  const cands: BaudPick[] = [];
  for (let lag = minLag + 1; lag <= maxLag - 1; lag++) {
    const v = re[lag] / r0;
    if (v <= re[lag - 1] / r0 || v <= re[lag + 1] / r0) continue;
    if (v < 0.02) continue;
    const a = re[lag - 1] / r0, b = v, c = re[lag + 1] / r0;
    const denom = (a - 2 * b + c);
    const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    const lagS = (lag + delta) / sampleRate;
    cands.push({ baud: 1 / lagS, score: v, periodSec: lagS });
  }
  cands.sort((p, q) => q.score - p.score);
  const kept: BaudPick[] = [];
  for (const c of cands) {
    if (kept.length >= top) break;
    if (kept.some(k => Math.abs(k.baud - c.baud) / k.baud < 0.10)) continue;
    kept.push(c);
  }
  return kept;
}

/* ─────────────────────────  Cyclic spectrum  ────────────────────── */

/** Compute |E[x(n)² · exp(−j 2π α n / fs)]| at cyclic frequency α —
 *  the squared-signal cyclic moment at lag 0. Strong peaks at α = baud
 *  indicate a cyclostationary symbol-rate signature. */
function cyclicAutocorrelationAtAlpha(samples: Float32Array, sampleRate: number, alphaHz: number): number {
  const N = samples.length;
  let re = 0, im = 0;
  let energy = 0;
  for (let i = 0; i < N; i++) {
    const x2 = samples[i] * samples[i];
    const arg = -2 * Math.PI * alphaHz * i / sampleRate;
    re += x2 * Math.cos(arg);
    im += x2 * Math.sin(arg);
    energy += x2;
  }
  if (energy <= 0) return 0;
  return Math.hypot(re, im) / energy;
}

/* ─────────────  MFSK hopping detector (STFT-based)  ────────────── */

/** Detect an MFSK signal by short-time analysis of which tone is
 *  active in each symbol slot. A 10-second time-averaged FFT can't
 *  resolve MFSK tone structure (spectral leakage from per-tone bursts
 *  smears the spectrum into a dense forest), but a frame-by-frame
 *  STFT keyed on the symbol duration sees one dominant tone per
 *  frame — the classic MFSK fingerprint.
 *
 *  The score combines two metrics:
 *
 *  1. **Dominance**  — for each frame, the ratio of the strongest
 *     in-band FFT bin energy to the total in-band energy. MFSK has
 *     one active tone per slot, so dominance is high (~0.4+). OFDM
 *     /MT63 distributes energy across all carriers simultaneously,
 *     so dominance is low (~1/N). PSK has constant tone(s), but
 *     dominance is also high — discriminated by the second metric.
 *
 *  2. **Tone-bin usage uniformity** — the dominant tone, quantised
 *     onto the expected N-tone grid, should populate every tone
 *     bin roughly equally over many frames (random data ≈ uniform
 *     tone usage). PSK signals always map to the same bin → CV ≈
 *     ∞ → uniformity 0. A signal that only uses M < N tones (CIS
 *     etc.) gets a partial uniformity score.
 *
 *  Returns score in [0, 1]; for slow rates where < 8 frames fit in
 *  the clip the detector returns 0 (signals fall through to the
 *  structural matcher).
 */
function mfskHoppingScore(
  I: Float32Array, Q: Float32Array, sampleRate: number,
  nTones: number, spacingHz: number, baudBd: number,
): { score: number; dominance: number; uniformity: number; framesUsed: number } {
  const symSamples = Math.max(8, Math.round(sampleRate / baudBd));
  const N = I.length;
  const nFrames = Math.floor(N / symSamples);
  if (nFrames < 8) return { score: 0, dominance: 0, uniformity: 0, framesUsed: nFrames };
  const fftN = nextPow2(Math.min(symSamples * 2, 8192));
  const binHz = sampleRate / fftN;
  // ±half-band: nTones × spacing / 2 plus one spacing of slop.
  const halfBandBins = Math.ceil((nTones * spacingHz / 2 + spacingHz) / binHz);
  if (halfBandBins * 2 < nTones) return { score: 0, dominance: 0, uniformity: 0, framesUsed: 0 };
  const re = new Float32Array(fftN);
  const im = new Float32Array(fftN);
  // Pre-computed Hann window for the symbol-length data; bins outside
  // the symbol get zeros (rectangular padding to fftN).
  const win = new Float32Array(symSamples);
  for (let k = 0; k < symSamples; k++) {
    win[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (symSamples - 1));
  }
  const toneHistogram = new Int32Array(nTones);
  let dominanceSum = 0;
  let framesUsed = 0;
  for (let f = 0; f < nFrames; f++) {
    const offset = f * symSamples;
    re.fill(0); im.fill(0);
    for (let k = 0; k < symSamples; k++) {
      re[k] = I[offset + k] * win[k];
      im[k] = Q[offset + k] * win[k];
    }
    fft(re, im);
    // Scan ±halfBandBins. Bin index modular.
    let bestMag = 0;
    let bestBinSigned = 0;
    let totalE = 0;
    for (let kk = -halfBandBins; kk <= halfBandBins; kk++) {
      const idx = ((kk % fftN) + fftN) % fftN;
      const m = re[idx] * re[idx] + im[idx] * im[idx];
      totalE += m;
      if (m > bestMag) { bestMag = m; bestBinSigned = kk; }
    }
    if (totalE <= 0) continue;
    framesUsed++;
    dominanceSum += bestMag / totalE;
    // Map signed bin to tone-grid index. Tones expected at
    // (k - (nTones-1)/2) * spacingHz for k = 0..nTones-1.
    const toneHz = bestBinSigned * binHz;
    const idx = Math.max(0, Math.min(nTones - 1,
      Math.round(toneHz / spacingHz + (nTones - 1) / 2)));
    toneHistogram[idx]++;
  }
  if (framesUsed < 8) return { score: 0, dominance: 0, uniformity: 0, framesUsed };
  const dominance = dominanceSum / framesUsed;
  // Compare dominance to the chance baseline: a uniform-noise signal
  // would have dominance ≈ 1/(in-band bin count), since the strongest
  // of K random bins has expected energy ~1/K. A real MFSK signal has
  // dominance many × baseline. We score the ratio.
  const inBandBins = 2 * halfBandBins + 1;
  const baseline = 1 / inBandBins;
  const domRatio = dominance / baseline;     // 1 ≈ noise, ≥ 4 = signal
  const domNorm = Math.max(0, Math.min(1, (domRatio - 2) / 4));
  // Tone-usage uniformity. Each bin must reach at least HALF of the
  // expected per-bin share (= framesUsed/N). At the loose 5 % threshold
  // we used before, random noise-wobble of the dominant bin on a PSK
  // signal trivially populates every bin → fake uniformity=1.0. With
  // the strict 50 % threshold, only bins receiving genuine MFSK hops
  // qualify — PSK's single-tone histogram concentrates ≥ 90 % in one
  // bin, the others fail. True MFSK with random data gets all bins
  // near the mean → all qualify.
  const meanUse = framesUsed / nTones;
  let usedTones = 0;
  for (let t = 0; t < nTones; t++) {
    if (toneHistogram[t] >= 0.5 * meanUse) usedTones++;
  }
  const uniformity = usedTones / nTones;
  // Hard threshold: a real MFSK signal populates at least half of
  // its N tones over a 10-second clip. Below this, the dominant bin
  // is too concentrated (single-tone PSK / FSK leakage / noise) for
  // an MFSK call to make sense.
  if (uniformity < 0.5) {
    return { score: 0, dominance, uniformity, framesUsed };
  }
  const score = domNorm * uniformity * uniformity;
  return { score, dominance, uniformity, framesUsed };
}

/* ─────────────────  Cyclostationary baud detector  ─────────────── */

/** Strength of the cyclostationary feature at α = baudBd in |z|².
 *
 *  For a PSK/QAM signal with non-rectangular pulse shaping (which is
 *  every real-world transmitter), the instantaneous power |z(t)|² has
 *  a periodic ripple at the symbol rate. The Fourier component of
 *  (|z|² − mean) at f = baudBd is therefore a direct, *rate-specific*
 *  baud detector — unlike envelope autocorrelation which can't tell
 *  the symbol rate from its sub-harmonics on a constant-envelope
 *  signal.
 *
 *  Implemented as a single-bin Goertzel for O(N) cost. Returns a
 *  unitless score in [0, ~1]: ratio of the bin magnitude to the
 *  total ripple energy. Correct rate → close to 1; half/double rate
 *  → close to 0.
 */
function cyclicBaudStrength(I: Float32Array, Q: Float32Array, sampleRate: number, baudBd: number): number {
  const N = I.length;
  if (N < 64 || baudBd <= 0 || baudBd > sampleRate / 4) return 0;
  // |z|² with DC removed.
  let mean = 0;
  for (let i = 0; i < N; i++) mean += I[i] * I[i] + Q[i] * Q[i];
  mean /= N;
  let totalVar = 0;
  // Goertzel coefficient for f = baudBd.
  const omega = 2 * Math.PI * baudBd / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0, s1 = 0;
  for (let i = 0; i < N; i++) {
    const x = (I[i] * I[i] + Q[i] * Q[i]) - mean;
    totalVar += x * x;
    const s = x + coeff * s0 - s1;
    s1 = s0; s0 = s;
  }
  const re = s0 - s1 * Math.cos(omega);
  const im = s1 * Math.sin(omega);
  const binMag = Math.hypot(re, im);
  // Parseval-ish normalisation: binMag / sqrt(N · totalVar / 2).
  const denom = Math.sqrt(N * totalVar / 2);
  return denom > 0 ? Math.min(1, binMag / denom) : 0;
}

/* ─────────────────────────  Tone spacing  ───────────────────────── */

interface ToneSpacingStats { diffs: number[]; median: number; std: number; mean: number; }

function toneSpacing(peaks: Peak[]): ToneSpacingStats | null {
  if (peaks.length < 2) return null;
  const sorted = peaks.slice().sort((a, b) => a.hz - b.hz);
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) diffs.push(sorted[i].hz - sorted[i - 1].hz);
  const med = [...diffs].sort((a, b) => a - b)[diffs.length >> 1];
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / diffs.length);
  return { diffs, median: med, std: sd, mean };
}

/* ─────────────────────────  Classifier  ─────────────────────────── */

interface Verdict { name: string; confidence: 'high' | 'medium' | 'low'; rationale: string; }

interface ClassifyInput {
  mode: string;
  peaks: Peak[];
  spec: SpectralStats;
  bw3:  { loHz: number; hiHz: number };
  bw20: { loHz: number; hiHz: number };
  envStats: EnvStats;
  instFreq: InstFreqStats;
  phase: InstPhaseStats;
  amc: AzzouzFeatures;
  cum: Cumulants;
  bauds: BaudPick[];
  spacing: ToneSpacingStats | null;
}

function classify(c: ClassifyInput): { primary: Verdict; alternatives: Verdict[] } {
  const m = c.mode.toLowerCase();
  const nTones = c.peaks.length;
  const top = c.peaks[0];
  const bw3w  = c.bw3.hiHz  - c.bw3.loHz;
  const bw20w = c.bw20.hiHz - c.bw20.loHz;
  const am = c.envStats.amIndex;
  const flat = c.spec.flatness;
  const best = c.bauds[0];
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

  if (nTones === 0 || flat > 0.5) {
    return {
      primary: { name: 'Empty channel / band noise',
        confidence: flat > 0.7 ? 'high' : 'medium',
        rationale: `flatness ${flat.toFixed(2)}, ${nTones} peaks above floor.` },
      alternatives: [],
    };
  }
  if (nTones === 1 && am > 0.6 && bw3w < 200) {
    return {
      primary: { name: `CW (single keyed tone ${top.hz.toFixed(0)} Hz)`, confidence: 'high',
        rationale: `single peak, AM index ${am.toFixed(2)}, BW ${bw3w.toFixed(0)} Hz, jumpRate ${c.phase.jumpRate.toFixed(0)}/s.` },
      alternatives: [],
    };
  }
  if (nTones >= 2 && c.spacing && c.spacing.std < 20) {
    const shift = c.spacing.median;
    const bd = best?.baud ?? 0;
    const V = (name: string, conf: 'high' | 'medium' | 'low', r: string): Verdict =>
      ({ name, confidence: conf, rationale: r });
    if (nTones === 2 || (nTones <= 4 && c.peaks[2].db < c.peaks[1].db - 6)) {
      if (near(shift, 170, 25) && near(bd, 45.45, 6)) {
        return { primary: V('RTTY 45.45 Bd / 170 Hz shift (Baudot)', 'high',
          `Δf = ${shift.toFixed(0)} Hz; baud ${bd.toFixed(1)}.`), alternatives: [] };
      }
      if (near(shift, 170, 25)) {
        for (const std of [50, 75, 100]) {
          if (near(bd, std, 6)) return { primary: V(`RTTY ${std} Bd / 170 Hz shift`, 'medium',
            `Δf ${shift.toFixed(0)} Hz, baud ${bd.toFixed(1)} ≈ ${std}.`), alternatives: [] };
        }
      }
      if (near(shift, 170, 25) && near(bd, 100, 8)) {
        return { primary: V('NAVTEX / SITOR-B (100 Bd FSK, 170 Hz)', 'high',
          `Δf ${shift.toFixed(0)} Hz, 100 Bd autocorr.`), alternatives: [] };
      }
      if (near(shift, 200, 40) && near(bd, 200, 25)) {
        return { primary: V('DGPS MSK 200 Bd', 'medium',
          `Δf ${shift.toFixed(0)} Hz, baud ${bd.toFixed(1)}.`), alternatives: [] };
      }
      return {
        primary: V(`2-FSK / FSK modem (shift ≈ ${shift.toFixed(0)} Hz)`, 'medium',
          `2 dominant tones; ${bd ? bd.toFixed(1) + ' Bd' : 'no clear baud'}.`),
        alternatives: [
          { name: 'RTTY', confidence: 'low', rationale: 'check baud against 45.45/50/75.' },
          { name: 'NAVTEX/SITOR-B', confidence: 'low', rationale: 'check baud against 100.' },
          { name: 'POCSAG/FLEX', confidence: 'low', rationale: 'pagers — short bursts; 512/1200/2400 Bd.' },
        ],
      };
    }
    if (nTones >= 3 && nTones <= 64) {
      if (nTones === 8 && near(shift, 6.25, 1.5)) return { primary: V('FT8 (8-MFSK, 6.25 Hz)', 'high',
        '8 tones, 6.25 Hz spacing — FT8 fingerprint.'), alternatives: [] };
      if (nTones === 4 && near(shift, 5.4, 2)) return { primary: V('FT4 (4-MFSK, 5.4 Hz)', 'high',
        '4 tones, ~5.4 Hz spacing.'), alternatives: [] };
      if (nTones === 8) {
        if (near(shift, 31.25, 4))  return { primary: V('Olivia 8/250',  'medium', '8 tones, ~31 Hz spacing.'), alternatives: [] };
        if (near(shift, 62.5,  8))  return { primary: V('Olivia 8/500',  'medium', '8 tones, ~62 Hz spacing.'), alternatives: [] };
        if (near(shift, 125,   15)) return { primary: V('Olivia 8/1000', 'medium', '8 tones, ~125 Hz spacing.'), alternatives: [] };
      }
      if (nTones === 16) {
        if (near(shift, 15.625, 3)) return { primary: V('Olivia 16/250', 'medium', '16 tones, ~16 Hz spacing.'), alternatives: [] };
        if (near(shift, 31.25,  5)) return { primary: V('Olivia 16/500', 'medium', '16 tones, ~31 Hz spacing.'), alternatives: [] };
      }
      return {
        primary: V(`MFSK (${nTones} tones, ${shift.toFixed(0)} Hz spacing, BW ${bw20w.toFixed(0)} Hz)`,
          'medium', `regular tones (Δstd ${c.spacing.std.toFixed(1)} Hz).`),
        alternatives: [
          { name: 'Olivia', confidence: 'low', rationale: '4/8/16/32/64 tones × 125/250/500/1000/2000 Hz.' },
          { name: 'MFSK-16', confidence: 'low', rationale: '16 tones, ~15.6 Hz spacing.' },
        ],
      };
    }
  }
  if (nTones === 1 && Math.abs(top.hz - 1000) < 200 && bw3w < 70 && best && Math.abs(best.baud - 31.25) < 6) {
    return {
      primary: { name: 'PSK31 (~31.25 Bd BPSK)', confidence: 'high',
        rationale: `single carrier ${top.hz.toFixed(0)} Hz, BW ${bw3w.toFixed(0)} Hz, ${best.baud.toFixed(1)} Bd.` },
      alternatives: [],
    };
  }
  if ((m === 'usb' || m === 'lsb') && bw20w > 1500 && am > 0.3 && flat < 0.3) {
    return {
      primary: { name: 'SSB voice', confidence: 'high',
        rationale: `BW ${bw20w.toFixed(0)} Hz, AM index ${am.toFixed(2)}, flatness ${flat.toFixed(2)}.` },
      alternatives: [
        { name: 'Amateur SSB QSO', confidence: 'medium', rationale: 'check band plan.' },
        { name: 'Marine / aero SSB', confidence: 'low', rationale: '2.182 MHz, aero HF bands.' },
      ],
    };
  }
  if ((m === 'am' || m === 'amn' || m === 'sam') && am > 0.15 && bw20w > 4000) {
    return {
      primary: { name: 'AM broadcast / voice', confidence: 'high',
        rationale: `BW ${bw20w.toFixed(0)} Hz, AM index ${am.toFixed(2)}.` },
      alternatives: [],
    };
  }
  if (nTones > 16 && bw20w > 1500) {
    return {
      primary: { name: `OFDM / multi-carrier (${nTones} tones, ${bw20w.toFixed(0)} Hz)`, confidence: 'medium',
        rationale: `${nTones} peaks across ${bw20w.toFixed(0)} Hz, flatness ${flat.toFixed(2)}.` },
      alternatives: [
        { name: 'HFDL (1800 bps)',  confidence: 'low', rationale: '8-PSK OFDM.' },
        { name: 'STANAG 4539',      confidence: 'low', rationale: 'wideband HF OFDM.' },
        { name: 'DRM30',            confidence: 'low', rationale: 'broadcast OFDM, 10 kHz channels.' },
      ],
    };
  }
  return {
    primary: { name: 'Unresolved waveform', confidence: 'low',
      rationale: `${nTones} tones, BW ${bw20w.toFixed(0)} Hz, ${best ? best.baud.toFixed(1) + ' Bd' : 'no baud'}, AM ${am.toFixed(2)}, flat ${flat.toFixed(2)}, γmax ${c.amc.gamma_max.toFixed(2)}, μ42 ${c.cum.mu42.toFixed(2)}.` },
    alternatives: [],
  };
}

/* ─────────────────────────  Public entry point  ─────────────────── */

function dbfs(x: number): string {
  if (x <= 0) return '-∞ dBFS';
  return (20 * Math.log10(x)).toFixed(1) + ' dBFS';
}

function pct(v: number): string { return (v * 100).toFixed(1) + '%'; }

export function analyzeLocal(opts: LocalAnalysisOpts): string {
  const { samples, sampleRate, freqKHz, mode } = opts;
  if (samples.length < 2048) return 'SID — clip too short to analyse.';

  // ── Time-domain.
  let sumSq = 0, peakAbs = 0, dc = 0;
  for (let i = 0; i < samples.length; i++) {
    dc += samples[i];
    const a = Math.abs(samples[i]);
    sumSq += samples[i] * samples[i];
    if (a > peakAbs) peakAbs = a;
  }
  dc /= samples.length;
  const rms = Math.sqrt(sumSq / samples.length);
  const crestDb = rms > 0 ? 20 * Math.log10(peakAbs / rms) : 0;
  const tMoments = moments(samples);

  // Noise-floor estimate (10th-pctile of |x|).
  const absSorted = Float32Array.from(samples, Math.abs).sort();
  const noiseFloor = percentile(absSorted, 0.10);
  const snrDb = noiseFloor > 0 ? 20 * Math.log10(rms / noiseFloor) : 0;

  // ── Analytic signal + envelope + inst stats.
  const analytic = analyticSignal(samples);
  const env = envelopeStats(analytic, sampleRate);
  const ifs = instantaneousFrequency(analytic, sampleRate);
  const ips = instantaneousPhase(analytic, sampleRate);

  // ── Spectrum.
  const spec = magnitudeSpectrum(samples, sampleRate);
  const sStats = spectralStats(spec, 50, 5500);
  const peaks = findPeaks(spec, 100, 4500, 16);
  const bw3   = bandwidthAt(spec, 3);
  const bw6   = bandwidthAt(spec, 6);
  const bw20  = bandwidthAt(spec, 20);
  const spacing = toneSpacing(peaks);

  // ── AMC features + higher-order cumulants.
  const amc = azzouzFeatures(env.envelope, ifs, ips, sStats.sidebandP);
  const cum = higherOrderCumulants(analytic);

  // ── Cepstrum + symbol-rate + cyclic-spectrum.
  const cep = realCepstrum(samples, sampleRate);
  const bauds = symbolRateCandidates(env.envelope, sampleRate, 3);
  const caf = bauds.map(b => ({ alpha: b.baud, score: cyclicAutocorrelationAtAlpha(samples, sampleRate, b.baud) }));

  // ── Zero-crossing rate.
  let zc = 0;
  for (let i = 1; i < samples.length; i++) if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) zc++;
  const zcr = zc * sampleRate / samples.length;

  // ── Verdict.
  const cls = classify({
    mode, peaks, spec: sStats, bw3, bw20, envStats: env, instFreq: ifs, phase: ips,
    amc, cum, bauds, spacing,
  });

  // ── Render.
  const L: string[] = [];
  const freqLabel = freqKHz >= 1000
    ? `${(freqKHz / 1000).toFixed(3)} MHz`
    : `${freqKHz.toFixed(3)} kHz`;
  L.push(`SID — Signal Identification Specialist Analysis`);
  L.push(`================================================`);
  L.push(`Source: ${freqLabel} (${mode.toUpperCase()})   Duration: ${(samples.length / sampleRate).toFixed(3)} s @ ${sampleRate} Hz`);
  L.push('');
  L.push(`── Verdict ────────`);
  L.push(`(What the heuristic classifier concluded after looking at every`);
  L.push(` section below. Confidence is high only when several independent`);
  L.push(` features all agree.)`);
  L.push(`Modulation       : ${cls.primary.name}`);
  L.push(`Confidence       : ${cls.primary.confidence}`);
  L.push(`Rationale        : ${cls.primary.rationale}`);
  if (cls.alternatives.length) {
    L.push('Alternatives     :');
    for (const a of cls.alternatives) L.push(`  · [${a.confidence}] ${a.name} — ${a.rationale}`);
  }

  L.push('');
  L.push(`── Time-domain ────`);
  L.push(`(Raw amplitude statistics on the sampled audio. Peak / RMS / crest`);
  L.push(` factor describe how loud the signal is and how impulsive (high`);
  L.push(` crest = bursty / spiky, low crest = constant envelope). Skewness`);
  L.push(` and kurtosis are 3rd and 4th moments of x(t): a constant-envelope`);
  L.push(` digital signal has near-zero skew and ≈-1.5 kurt; an impulsive`);
  L.push(` signal has high kurt. SNR uses the 10th-percentile of |x| as a`);
  L.push(` proxy for the noise floor.)`);
  L.push(`Peak |x|         : ${peakAbs.toFixed(4)}  (${dbfs(peakAbs)})`);
  L.push(`RMS              : ${rms.toFixed(4)}      (${dbfs(rms)})`);
  L.push(`DC offset        : ${dc.toExponential(2)}`);
  L.push(`Crest factor     : ${crestDb.toFixed(1)} dB`);
  L.push(`Skewness         : ${tMoments.skew.toFixed(3)}`);
  L.push(`Excess kurtosis  : ${tMoments.kurt.toFixed(3)}`);
  L.push(`Noise floor (p10): ${dbfs(noiseFloor)}`);
  L.push(`SNR estimate     : ${snrDb.toFixed(1)} dB`);
  L.push(`Zero-cross rate  : ${zcr.toFixed(0)} Hz`);

  L.push('');
  L.push(`── Envelope (analytic |z|) ──`);
  L.push(`(|z(t)| of the Hilbert-derived analytic signal — the instantaneous`);
  L.push(` amplitude envelope. AM index ≈ 1 → on/off keyed (CW, bursts);`);
  L.push(` ≈ 0 → constant envelope (FM, FSK, PSK). Burst rate / lengths /`);
  L.push(` gaps describe how the signal is keyed; rise / fall (10-90 %)`);
  L.push(` distinguish hard-keyed CW from raised-cosine shaped modems.)`);
  L.push(`Mean             : ${env.mean.toFixed(4)}`);
  L.push(`Std              : ${env.std.toFixed(4)}  (${pct(env.std / Math.max(1e-9, env.mean))} of mean)`);
  L.push(`Skewness         : ${env.skew.toFixed(3)}`);
  L.push(`Excess kurtosis  : ${env.kurt.toFixed(3)}`);
  L.push(`AM index         : ${env.amIndex.toFixed(3)}  (0=constant, 1=full OOK)`);
  L.push(`Duty cycle       : ${pct(env.dutyCycle)} above mean`);
  L.push(`Burst rate       : ${env.burstCount.toFixed(1)} bursts/s`);
  L.push(`Avg burst length : ${(env.avgBurstSec * 1000).toFixed(1)} ms`);
  L.push(`Avg gap length   : ${(env.avgGapSec * 1000).toFixed(1)} ms`);
  L.push(`Rise / fall      : ${env.riseMs.toFixed(1)} / ${env.fallMs.toFixed(1)} ms  (10-90 %)`);

  L.push('');
  L.push(`── Spectrum ───────`);
  L.push(`(Shape of |X(f)|. Centroid = "centre of mass", spread = how wide,`);
  L.push(` skew / kurt = asymmetry and peakedness. Wiener flatness near 0`);
  L.push(` means tonal (clear peaks); near 1 means white noise. Shannon`);
  L.push(` entropy measures spectral diversity. Roll-off and occupied-BW`);
  L.push(` at -3/-6/-20 dB are the standard "how wide is the signal"`);
  L.push(` measurements. Sub-band power shows where the energy sits, in 8`);
  L.push(` log-spaced bands. Sideband ratio P = USB-power / total-power;`);
  L.push(` 0.5 = symmetric (AM/FSK/PSK), <0.5 = LSB-biased, >0.5 = USB.)`);
  L.push(`Centroid         : ${sStats.centroidHz.toFixed(0)} Hz`);
  L.push(`Spread (σ)       : ${sStats.spreadHz.toFixed(0)} Hz`);
  L.push(`Skewness         : ${sStats.skewness.toFixed(3)}`);
  L.push(`Kurtosis         : ${sStats.kurtosis.toFixed(3)}`);
  L.push(`Slope            : ${sStats.slopeDbPerOct.toFixed(1)} dB/oct`);
  L.push(`Flatness (Wiener): ${sStats.flatness.toFixed(3)}  (0=tonal, 1=white)`);
  L.push(`Entropy (Shannon): ${sStats.entropy.toFixed(2)} nats`);
  L.push(`95 % rolloff     : ${sStats.rolloff95Hz.toFixed(0)} Hz`);
  L.push(`99 % rolloff     : ${sStats.rolloff99Hz.toFixed(0)} Hz`);
  L.push(`Occupied BW (-3) : ${bw3.loHz.toFixed(0)}..${bw3.hiHz.toFixed(0)} Hz  (Δ ${(bw3.hiHz - bw3.loHz).toFixed(0)} Hz)`);
  L.push(`Occupied BW (-6) : ${bw6.loHz.toFixed(0)}..${bw6.hiHz.toFixed(0)} Hz  (Δ ${(bw6.hiHz - bw6.loHz).toFixed(0)} Hz)`);
  L.push(`Occupied BW (-20): ${bw20.loHz.toFixed(0)}..${bw20.hiHz.toFixed(0)} Hz  (Δ ${(bw20.hiHz - bw20.loHz).toFixed(0)} Hz)`);
  L.push(`Sub-band power   : [${sStats.subBandPower.map(p => p.toFixed(3)).join(' ')}]  (8 log bands)`);
  L.push(`Sideband ratio P : ${sStats.sidebandP.toFixed(3)}  (0=LSB-only, 1=USB-only)`);

  L.push('');
  L.push(`── Instantaneous frequency (Hilbert) ──`);
  L.push(`(f_i(t) = (1/2π)·dφ/dt of the analytic signal. Std is the FM`);
  L.push(` deviation. For an FSK signal the f_i histogram is bimodal at`);
  L.push(` ±shift/2; for SSB voice it's broadly distributed; for a pure`);
  L.push(` carrier or CW it's tightly peaked at one frequency.)`);
  L.push(`Mean             : ${ifs.meanHz.toFixed(1)} Hz`);
  L.push(`Std (FM dev)     : ${ifs.stdHz.toFixed(1)} Hz`);
  L.push(`Skewness         : ${ifs.skew.toFixed(3)}`);
  L.push(`Excess kurtosis  : ${ifs.kurt.toFixed(3)}`);
  L.push(`Range            : ${ifs.minHz.toFixed(1)} .. ${ifs.maxHz.toFixed(1)} Hz  (Δ ${ifs.rangeHz.toFixed(1)} Hz)`);

  L.push('');
  L.push(`── Instantaneous phase (Hilbert) ──`);
  L.push(`(Stats of φ(t) after removing the linear-trend carrier. σ_ap and`);
  L.push(` σ_dp are Azzouz-Nandi features: high σ_ap with low σ_dp suggests`);
  L.push(` PSK; high in both suggests FM/PM. Phase-jump rate counts |Δφ| >`);
  L.push(` π/4 between samples — a strong PSK signature.)`);
  L.push(`σ_ap (|φ_NLc|)   : ${ips.sigmaAp.toFixed(3)}  rad`);
  L.push(`σ_dp ( φ_NLc )   : ${ips.sigmaDp.toFixed(3)}  rad`);
  L.push(`Phase-jump rate  : ${ips.jumpRate.toFixed(0)} /s  (|Δφ| > π/4)`);

  L.push('');
  L.push(`── Azzouz / Nandi AMC features ──`);
  L.push(`(Standard automatic-modulation-classification features (Azzouz &`);
  L.push(` Nandi 1995). σ_aa: amplitude variability (high for AM, low for`);
  L.push(` FM/PSK). γ_max: peak PSD of normalised-centred amplitude; large`);
  L.push(` ⇒ residual carrier / strong AM. σ_af: FSK-vs-FM discriminator.`);
  L.push(` σ_ap, σ_dp: PSK-vs-FM discriminators. P: sideband symmetry.`);
  L.push(` These six values feed most published HF/VHF AMC classifiers.)`);
  L.push(`σ_aa             : ${amc.sigma_aa.toFixed(4)}  (std normalised centred amplitude)`);
  L.push(`γ_max            : ${amc.gamma_max.toFixed(4)}  (max PSD of normalised centred amplitude)`);
  L.push(`σ_af             : ${amc.sigma_af.toFixed(4)}  (std normalised centred |Δf|)`);
  L.push(`σ_ap             : ${amc.sigma_ap.toFixed(4)}`);
  L.push(`σ_dp             : ${amc.sigma_dp.toFixed(4)}`);
  L.push(`P                : ${amc.P.toFixed(3)}  (sideband symmetry)`);

  L.push('');
  L.push(`── Higher-order cumulants (analytic signal, normalised) ──`);
  L.push(`(C_pq are joint moments / cumulants of the complex analytic`);
  L.push(` signal. They take known values for each modulation: BPSK has`);
  L.push(` C42 = -2, QPSK = -1, 8-PSK = 0, QAM-16 ≈ -0.68, Gaussian noise`);
  L.push(` = 0. μ_42 = C42/C21² is the same metric, rescaled to be`);
  L.push(` invariant to power. C40, C41 separate constant-modulus mods`);
  L.push(` (PSK, FSK) from amplitude-modulated ones.)`);
  L.push(`|C20|            : ${cum.c20Abs.toFixed(4)}`);
  L.push(`C21              : ${cum.c21.toFixed(4)}`);
  L.push(`|C40|            : ${cum.c40Abs.toFixed(4)}`);
  L.push(`|C41|            : ${cum.c41Abs.toFixed(4)}`);
  L.push(`C42              : ${cum.c42.toFixed(4)}`);
  L.push(`μ_42 = C42/C21²  : ${cum.mu42.toFixed(4)}`);

  L.push('');
  L.push(`── Cepstrum ────────`);
  L.push(`(IFFT of log |X(f)|. Peaks at quefrency T reveal a harmonic comb`);
  L.push(` of spacing 1/T in the spectrum — i.e. a fundamental period.`);
  L.push(` Voice F0 (≈ 80–300 Hz), MFSK tone spacing, and periodic key`);
  L.push(` clicks all show up here. Strong peak = strongly periodic.)`);
  if (cep.topQuefrencies.length === 0) {
    L.push('  (no quefrency peaks)');
  } else {
    L.push('Top quefrencies (period → equivalent F0):');
    for (const q of cep.topQuefrencies) {
      L.push(`  ${q.ms.toFixed(2).padStart(6)} ms   →   ${q.hz.toFixed(1).padStart(6)} Hz   mag ${q.mag.toFixed(3)}`);
    }
    if (cep.pitchHz) L.push(`Strongest pitch  : F0 = ${cep.pitchHz.toFixed(1)} Hz`);
  }

  L.push('');
  L.push(`── Tones (top ${peaks.length}) ──`);
  L.push(`(Spectral peaks above an 8 dB local threshold, parabolic-`);
  L.push(` interpolated for sub-bin frequency accuracy, deduped within 25 Hz.`);
  L.push(` A regular spacing pattern is the fingerprint of MFSK / OFDM`);
  L.push(` modems; irregular = voice / noise / chaotic modulation.)`);
  if (peaks.length === 0) {
    L.push('  (none above noise floor)');
  } else {
    for (const p of peaks) L.push(`  ${p.hz.toFixed(1).padStart(8)} Hz   ${p.db.toFixed(1).padStart(5)} dB`);
    if (spacing) {
      L.push('');
      L.push(`Tone spacing     : median ${spacing.median.toFixed(1)} Hz   std ${spacing.std.toFixed(1)} Hz   mean ${spacing.mean.toFixed(1)} Hz`);
      L.push(`Pair Δ list (Hz) : ${spacing.diffs.map(d => d.toFixed(1)).join('  ')}`);
    }
  }

  L.push('');
  L.push(`── Symbol rate (autocorr of envelope) ──`);
  L.push(`(Linear autocorrelation r[τ] of the envelope, computed via the`);
  L.push(` Wiener-Khinchin identity r = IFFT(|FFT(x)|²) with zero-padding`);
  L.push(` to 2N — mathematically identical to the direct sum`);
  L.push(` Σ x[n]·x[n+τ] but O(N log N) instead of O(N²). Local maxima of`);
  L.push(` r[τ] correspond to candidate symbol periods; score = r[τ]/r[0]`);
  L.push(` ∈ [0, 1] is the normalised periodicity.)`);
  if (bauds.length === 0) {
    L.push('  (no significant periodicity)');
  } else {
    bauds.forEach((b, i) => {
      const symbols = Math.round(b.baud * (samples.length / sampleRate));
      L.push(`  ${(i === 0 ? '★' : ' ')} ${b.baud.toFixed(2).padStart(7)} Bd   ` +
             `period ${(b.periodSec * 1000).toFixed(2)} ms   score ${b.score.toFixed(2)}   ≈${symbols} sym`);
    });
  }

  L.push('');
  L.push(`── Cyclic spectrum (|CAF| at baud candidates) ──`);
  L.push(`(Cyclic Autocorrelation Function at α = candidate baud rate:`);
  L.push(` |E[x(t)² · e^{-j2παt}]|, an independent test for cyclostationarity.`);
  L.push(` A real symbol-rate signature should show up at α = baud and`);
  L.push(` harmonics; spurious autocorr peaks from voice/noise will not.`);
  L.push(` Threshold ≈ 0.05 is the practical "yes, that's cyclostationary"`);
  L.push(` line on a noisy HF channel.)`);
  if (caf.length === 0) {
    L.push('  (no candidates)');
  } else {
    for (const c of caf) {
      L.push(`  α = ${c.alpha.toFixed(2).padStart(7)} Hz   |CAF| = ${c.score.toFixed(3)}` +
             (c.score > 0.05 ? '   ★ cyclostationary' : ''));
    }
  }

  return L.join('\n');
}

/* ─────────────────  IQ (complex baseband) analyser  ────────────── */

export interface IQAnalysisOpts {
  I: Float32Array;
  Q: Float32Array;
  sampleRate: number;       // baseband sample rate, Hz (12 000 for Kiwi)
  freqKHz: number;          // receiver tuned centre frequency, kHz
  mode: string;             // typically 'iq'
  /** Optional IQ-domain cleanup chain — mirrors the audio path's
   *  Passband / Notch / NB / DCK / NR but applied to complex baseband.
   *  Applied AFTER auto-centring so the passband is symmetric around
   *  the signal of interest at DC. */
  filterChain?: IqFilterChainOpts | null;
}

interface ComplexSpectrum {
  /** magnitude bins, length N, centred so bin 0 = -fs/2, bin N/2 = 0 Hz,
   *  bin N-1 = +fs/2 − binHz. */
  mag: Float32Array;
  power: Float32Array;
  binHz: number;
  N: number;
}

/** Two-sided FFT magnitude of a complex baseband (Hann-windowed),
 *  fft-shifted so DC is at the centre bin (N/2). */
function complexSpectrum(I: Float32Array, Q: Float32Array, sampleRate: number): ComplexSpectrum {
  const len = I.length;
  const N = nextPow2(len);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < len; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
    re[i] = I[i] * w;
    im[i] = Q[i] * w;
  }
  fft(re, im);
  // fft-shift: rearrange so negative freqs come first.
  const mag = new Float32Array(N);
  const power = new Float32Array(N);
  const half = N >> 1;
  for (let i = 0; i < N; i++) {
    const src = i < half ? i + half : i - half;
    const m = Math.hypot(re[src], im[src]);
    mag[i] = m;
    power[i] = m * m;
  }
  return { mag, power, binHz: sampleRate / N, N };
}

/** Spectral peak search on the two-sided baseband spectrum.
 *  Returns peaks with frequency offset from DC (signed). */
function findIQPeaks(spec: ComplexSpectrum, limit = 24): Peak[] {
  const { mag, binHz, N } = spec;
  const half = N >> 1;
  // Noise floor: median of the whole two-sided spectrum.
  const sorted = Array.from(mag).sort((a, b) => a - b);
  const floor = sorted[N >> 1] || 1e-9;
  const thrAbs = floor * Math.pow(10, 8 / 20);
  const peaks: Peak[] = [];
  for (let i = 1; i < N - 1; i++) {
    const v = mag[i];
    if (v < thrAbs) continue;
    if (v <= mag[i - 1] || v <= mag[i + 1]) continue;
    const a = mag[i - 1], b = v, c = mag[i + 1];
    const denom = (a - 2 * b + c);
    const delta = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    const offsetHz = (i + delta - half) * binHz;
    peaks.push({ hz: offsetHz, mag: v, db: 20 * Math.log10(v / floor) });
  }
  peaks.sort((p, q) => q.mag - p.mag);
  const kept: Peak[] = [];
  for (const p of peaks) {
    if (kept.length >= limit) break;
    if (kept.some(k => Math.abs(k.hz - p.hz) < 5)) continue;
    kept.push(p);
  }
  return kept;
}

interface IQSpectralStats {
  centroidHz: number;       // offset from DC
  spreadHz: number;
  flatness: number;
  entropy: number;
  rolloff95: { loHz: number; hiHz: number };
  occBw3:  { loHz: number; hiHz: number };
  occBw20: { loHz: number; hiHz: number };
  sidebandP: number;        // 0 = LSB only (negative freqs), 1 = USB only
  upperPowerFrac: number;   // power above DC / total
  lowerPowerFrac: number;
  carrierDb: number;        // bin at DC vs noise floor (10*log10)
}

function iqSpectralStats(spec: ComplexSpectrum): IQSpectralStats {
  const { power, binHz, N } = spec;
  const half = N >> 1;
  let total = 0;
  for (let i = 0; i < N; i++) total += power[i];
  if (total <= 0) {
    return {
      centroidHz: 0, spreadHz: 0, flatness: 0, entropy: 0,
      rolloff95: { loHz: 0, hiHz: 0 },
      occBw3:    { loHz: 0, hiHz: 0 },
      occBw20:   { loHz: 0, hiHz: 0 },
      sidebandP: 0.5, upperPowerFrac: 0.5, lowerPowerFrac: 0.5, carrierDb: 0,
    };
  }
  let centroid = 0;
  for (let i = 0; i < N; i++) centroid += (i - half) * binHz * power[i];
  centroid /= total;
  let m2 = 0;
  for (let i = 0; i < N; i++) {
    const d = (i - half) * binHz - centroid;
    m2 += d * d * power[i];
  }
  m2 /= total;
  const spread = Math.sqrt(m2);

  let logSum = 0, linSum = 0;
  for (let i = 0; i < N; i++) {
    const p = Math.max(1e-20, power[i]);
    logSum += Math.log(p);
    linSum += p;
  }
  const flatness = Math.exp(logSum / N) / (linSum / N);

  let entropy = 0;
  for (let i = 0; i < N; i++) {
    const p = power[i] / total;
    if (p > 1e-12) entropy -= p * Math.log(p);
  }

  // Occupied bandwidth (around peak, two-sided).
  let peak = 0;
  for (let i = 0; i < N; i++) if (power[i] > peak) peak = power[i];
  const span = (dbDown: number) => {
    const thr = peak * Math.pow(10, -Math.abs(dbDown) / 10);
    let lo = N - 1, hi = 0;
    for (let i = 0; i < N; i++) {
      if (power[i] >= thr) { if (i < lo) lo = i; if (i > hi) hi = i; }
    }
    return { loHz: (lo - half) * binHz, hiHz: (hi - half) * binHz };
  };
  const occ3  = span(3);
  const occ20 = span(20);

  // 95 % rolloff (around centroid).
  let cum = 0, r95Lo = 0, r95Hi = 0;
  for (let i = 0; i < N; i++) { cum += power[i]; if (cum >= 0.025 * total) { r95Lo = (i - half) * binHz; break; } }
  cum = 0;
  for (let i = N - 1; i >= 0; i--) { cum += power[i]; if (cum >= 0.025 * total) { r95Hi = (i - half) * binHz; break; } }

  // Sideband power (USB = bins above half, LSB = below).
  let upPow = 0, dnPow = 0;
  for (let i = 0; i < half; i++) dnPow += power[i];
  for (let i = half + 1; i < N; i++) upPow += power[i];
  const sidebandP = (upPow + dnPow) > 0 ? upPow / (upPow + dnPow) : 0.5;
  const upperPowerFrac = upPow / total;
  const lowerPowerFrac = dnPow / total;

  // Carrier presence at DC bin vs spectral median.
  const sortedMag = Array.from(spec.mag).sort((a, b) => a - b);
  const med = sortedMag[N >> 1] || 1e-9;
  const carrierDb = 20 * Math.log10(spec.mag[half] / med);

  return {
    centroidHz: centroid, spreadHz: spread, flatness, entropy,
    rolloff95: { loHz: r95Lo, hiHz: r95Hi },
    occBw3: occ3, occBw20: occ20,
    sidebandP, upperPowerFrac, lowerPowerFrac, carrierDb,
  };
}

/** Cyclic spectrum on a complex signal: r_x(α) = E[x(t)² · e^{-j2παt}]. */
function iqCyclicAutocorrelationAtAlpha(I: Float32Array, Q: Float32Array, sampleRate: number, alphaHz: number): number {
  const N = I.length;
  let re = 0, im = 0, energy = 0;
  for (let i = 0; i < N; i++) {
    const a = I[i], b = Q[i];
    // x² = (a + jb)² = (a² − b²) + j(2ab)
    const xr = a * a - b * b;
    const xi = 2 * a * b;
    const arg = -2 * Math.PI * alphaHz * i / sampleRate;
    const cs = Math.cos(arg), sn = Math.sin(arg);
    re += xr * cs - xi * sn;
    im += xr * sn + xi * cs;
    energy += xr * xr + xi * xi;
  }
  if (energy <= 0) return 0;
  return Math.hypot(re, im) / Math.sqrt(energy);
}


/** Multiply z(n) by e^{−j 2π Δf n / fs} so the signal centroid moves to
 *  DC. Uses an incremental complex rotation to avoid trig calls per
 *  sample. Returns NEW arrays — caller's originals are untouched. */
function frequencyShift(I: Float32Array, Q: Float32Array, deltaHz: number, sampleRate: number)
    : { I: Float32Array; Q: Float32Array } {
  const N = I.length;
  const Iout = new Float32Array(N);
  const Qout = new Float32Array(N);
  const wRe = Math.cos(-2 * Math.PI * deltaHz / sampleRate);
  const wIm = Math.sin(-2 * Math.PI * deltaHz / sampleRate);
  let cRe = 1, cIm = 0;
  for (let n = 0; n < N; n++) {
    // z' = z · c
    Iout[n] = I[n] * cRe - Q[n] * cIm;
    Qout[n] = I[n] * cIm + Q[n] * cRe;
    // c *= w
    const tRe = cRe * wRe - cIm * wIm;
    cIm = cRe * wIm + cIm * wRe;
    cRe = tRe;
  }
  return { I: Iout, Q: Qout };
}

export function analyzeLocalIQ(opts: IQAnalysisOpts): string {
  let { I, Q } = opts;                  // may be replaced by centred / filtered copies below
  const { sampleRate, freqKHz, mode } = opts;
  let filterNote: string | null = null;
  const N = I.length;
  if (N < 2048) return 'SID — clip too short to analyse.';

  // ── Auto-centring: measure the spectral centroid of the *original*
  // capture, then frequency-shift the signal so the centroid lands at
  // DC (0 Hz baseband). This is required for the higher-order cumulants
  // and the classifier heuristics to read correctly — see the long
  // discussion in PR #… for why. Offsets > 2 kHz are not corrected
  // because the operator probably mis-tuned and the signal isn't in
  // the captured IQ window.
  let centringNote: string;
  let originalOffsetHz: number;
  let residualOffsetHz: number;
  {
    const probeSpec  = complexSpectrum(I, Q, sampleRate);
    const probeStats = iqSpectralStats(probeSpec);
    originalOffsetHz = probeStats.centroidHz;
    if (Math.abs(originalOffsetHz) >= 5 && Math.abs(originalOffsetHz) < 2000) {
      // frequencyShift multiplies by e^{−j2π·Δf·n/fs} which shifts the
      // spectrum by −Δf in frequency. To bring a centroid at +f₀ down
      // to DC we therefore call it with Δf = +f₀ (NOT −f₀).
      const shifted = frequencyShift(I, Q, originalOffsetHz, sampleRate);
      I = shifted.I; Q = shifted.Q;
      const newSpec = complexSpectrum(I, Q, sampleRate);
      residualOffsetHz = iqSpectralStats(newSpec).centroidHz;
      centringNote = `Auto-centred: tuning was ${originalOffsetHz >= 0 ? '+' : ''}${originalOffsetHz.toFixed(1)} Hz off the spectral centroid; corrected. Residual after shift: ${residualOffsetHz >= 0 ? '+' : ''}${residualOffsetHz.toFixed(2)} Hz.`;
    } else if (Math.abs(originalOffsetHz) >= 2000) {
      residualOffsetHz = originalOffsetHz;
      centringNote = `WARNING: centroid offset ${originalOffsetHz.toFixed(0)} Hz is large (> 2 kHz). The signal of interest may be outside the captured IQ window. NOT auto-centred; classifier heuristics may be unreliable.`;
    } else {
      residualOffsetHz = originalOffsetHz;
      centringNote = `Cursor already on-centre (offset ${originalOffsetHz.toFixed(2)} Hz < 5 Hz threshold). No shift applied.`;
    }
  }

  // ── IQ-domain cleanup chain (NB → DCK → Passband+Notch → NR).
  // This is the IQ-side mirror of the audio cleanup filters. Audio
  // path is never touched; everything here runs on complex baseband
  // and feeds only the SID feature extractors below.
  if (opts.filterChain) {
    const r = applyIqFilterChain(I, Q, sampleRate, opts.filterChain);
    I = r.I; Q = r.Q;
    const rep = r.report;
    const parts: string[] = [];
    if (opts.filterChain.nb)       parts.push(`NB blanked ${(rep.nbBlankedFrac * 100).toFixed(2)} % of samples`);
    if (opts.filterChain.dck)      parts.push(`DCK replaced ${(rep.dckReplacedFrac * 100).toFixed(2)} % of samples`);
    if (opts.filterChain.passband) parts.push(`Passband kept ${(rep.passbandKeptFrac * 100).toFixed(1)} % of energy (rejected ${rep.passbandRejectedDb.toFixed(1)} dB out-of-band)`);
    if (opts.filterChain.notches && rep.notchesAppliedHz.length)
                                   parts.push(`Notch at ${rep.notchesAppliedHz.map(h => `${h >= 0 ? '+' : ''}${h.toFixed(0)} Hz`).join(', ')}`);
    if (opts.filterChain.nr)       parts.push(`NR avg Wiener gain ${rep.nrAvgGainDb.toFixed(1)} dB`);
    filterNote = parts.length ? parts.join('; ') : 'no stages active';
  }

  // ── Reuse Hilbert-domain helpers by passing I/Q directly as the
  // analytic signal (re = I, im = Q). No Hilbert step needed.
  const analytic = { re: I, im: Q };

  // ── Levels (on |z|).
  let env2 = 0, peakAbs = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.hypot(I[i], Q[i]);
    env2 += a * a;
    if (a > peakAbs) peakAbs = a;
  }
  const rms = Math.sqrt(env2 / N);
  const crestDb = rms > 0 ? 20 * Math.log10(peakAbs / rms) : 0;

  // |z| noise floor.
  const absSorted = new Float32Array(N);
  for (let i = 0; i < N; i++) absSorted[i] = Math.hypot(I[i], Q[i]);
  absSorted.sort();
  const noiseFloor = percentile(absSorted, 0.10);
  const snrDb = noiseFloor > 0 ? 20 * Math.log10(rms / noiseFloor) : 0;

  // ── Envelope, inst-freq, inst-phase, AMC features, cumulants.
  const env = envelopeStats(analytic, sampleRate);
  const ifs = instantaneousFrequency(analytic, sampleRate);
  const ips = instantaneousPhase(analytic, sampleRate);
  const cum = higherOrderCumulants(analytic);

  // ── Two-sided complex spectrum + sideband-aware stats.
  const spec  = complexSpectrum(I, Q, sampleRate);
  const sStats = iqSpectralStats(spec);
  // Limit raised from 24 → 80 to give MT63 / OFDM detectors enough
  // tones to actually fingerprint (MT63-1000 = 64 carriers, MT63-2000
  // = 64 wider carriers). Other detectors slice to the count they
  // need or accept ≥ N so a higher ceiling is harmless for them.
  const peaks  = findIQPeaks(spec, 80);
  const amc    = azzouzFeatures(env.envelope, ifs, ips, sStats.sidebandP);

  // ── Symbol-rate + cyclic-spectrum (operate on |z|² and on complex).
  const bauds = symbolRateCandidates(env.envelope, sampleRate, 5);
  const caf = bauds.map(b => ({
    alpha: b.baud,
    score: iqCyclicAutocorrelationAtAlpha(I, Q, sampleRate, b.baud),
  }));

  // ── Cepstrum on |X(f)|.
  // Build a real spectrum (magnitude only, two-sided) and take log/IFFT.
  const cepN = spec.N;
  const cre = new Float32Array(cepN);
  const cim = new Float32Array(cepN);
  for (let i = 0; i < cepN; i++) cre[i] = Math.log(Math.max(1e-12, spec.mag[i]));
  ifft(cre, cim);
  const qMin = Math.max(1, Math.floor(0.001 * sampleRate));
  const qMax = Math.min(cepN >> 1, Math.floor(0.050 * sampleRate));
  type Q = { ms: number; hz: number; mag: number };
  const cepPeaks: Q[] = [];
  for (let n = qMin + 1; n < qMax - 1; n++) {
    const v = cre[n];
    if (v <= cre[n - 1] || v <= cre[n + 1]) continue;
    cepPeaks.push({ ms: 1000 * n / sampleRate, hz: sampleRate / n, mag: v });
  }
  cepPeaks.sort((a, b) => b.mag - a.mag);
  const cepTop = cepPeaks.slice(0, 3);

  // ── Tone spacing (in offset Hz, not absolute audio Hz).
  let spacing: ToneSpacingStats | null = null;
  if (peaks.length >= 2) {
    const sorted = peaks.slice().sort((a, b) => a.hz - b.hz);
    const diffs: number[] = [];
    for (let i = 1; i < sorted.length; i++) diffs.push(sorted[i].hz - sorted[i - 1].hz);
    const med = [...diffs].sort((a, b) => a - b)[diffs.length >> 1];
    const mn = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mn) * (v - mn), 0) / diffs.length);
    spacing = { diffs, median: med, std: sd, mean: mn };
  }

  // Protocol fingerprinting / classification was removed — SID now
  // reports raw DSP measurements only. The reader interprets them.

  // ── Render as Markdown. SID emits raw DSP measurements only; the
  // panel renders this as markdown so headings, prose, and numeric
  // tables (fenced code blocks) are visually distinct.
  const L: string[] = [];
  const freqLabel = freqKHz >= 1000
    ? `${(freqKHz / 1000).toFixed(3)} MHz`
    : `${freqKHz.toFixed(3)} kHz`;
  const fmt = (hz: number, decimals = 1) =>
    (hz >= 0 ? '+' : '') + hz.toFixed(decimals);
  const table = (rows: Array<[string, string]>) => {
    const w = Math.max(...rows.map(r => r[0].length));
    L.push('```');
    for (const [k, v] of rows) L.push(`${k.padEnd(w)} : ${v}`);
    L.push('```');
  };

  L.push(`# SID — IQ baseband DSP measurements`);
  L.push('');
  L.push(`**Source:** ${freqLabel} (${mode.toUpperCase()}) · **Duration:** ${(N / sampleRate).toFixed(3)} s @ ${sampleRate} Hz · **Frequency axis:** ±${(sampleRate / 2).toFixed(0)} Hz around tuned ${freqLabel}.`);
  L.push('');
  L.push(`No classification is performed. The figures below are direct measurements on the complex baseband; interpretation is up to the reader.`);

  L.push('');
  L.push(`## Centring`);
  L.push(`Spectral centroid of the capture is measured and the I/Q stream is shifted so the signal sits at DC via z[n] ← z[n] · e^{−j2πΔf·n/fs}. This is a prerequisite for the higher-order cumulants and Azzouz–Nandi features to read against their published references.`);
  L.push('');
  L.push(`> ${centringNote}`);

  if (filterNote) {
    L.push('');
    L.push(`## IQ cleanup chain`);
    L.push(`NB → DCK → Passband + Notch → NR is applied to complex baseband before feature extraction. The operator's listening audio is untouched. AGC, RNNoise and VTRK are deliberately *not* applied here — they would flatten the envelope and corrupt the higher-order cumulants.`);
    L.push('');
    L.push(`> ${filterNote}`);
  }

  L.push('');
  L.push(`## Levels — |z| on complex baseband`);
  L.push(`Statistics of |z| = √(I² + Q²). The noise floor uses the 10th-percentile of |z| as a proxy.`);
  L.push('');
  table([
    ['Peak |z|',          `${peakAbs.toFixed(4)}  (${dbfs(peakAbs)})`],
    ['RMS |z|',           `${rms.toFixed(4)}      (${dbfs(rms)})`],
    ['Crest factor',      `${crestDb.toFixed(1)} dB`],
    ['Noise floor (p10)', dbfs(noiseFloor)],
    ['SNR estimate',      `${snrDb.toFixed(1)} dB`],
  ]);

  L.push('');
  L.push(`## Envelope`);
  L.push(`|z(t)| trajectory. AM index ≈ 1 ⇒ on/off keyed; ≈ 0 ⇒ constant-envelope (FM/FSK/PSK). Burst/gap statistics describe how the signal is keyed; rise/fall (10–90 %) distinguishes hard-keyed CW from raised-cosine shaped modems.`);
  L.push('');
  table([
    ['Mean',             env.mean.toFixed(4)],
    ['Std',              `${env.std.toFixed(4)}  (${pct(env.std / Math.max(1e-9, env.mean))} of mean)`],
    ['Skewness',         env.skew.toFixed(3)],
    ['Excess kurtosis',  env.kurt.toFixed(3)],
    ['AM index',         `${env.amIndex.toFixed(3)}  (0=constant, 1=full OOK)`],
    ['Duty cycle',       `${pct(env.dutyCycle)} above mean`],
    ['Burst rate',       `${env.burstCount.toFixed(1)} bursts/s`],
    ['Avg burst length', `${(env.avgBurstSec * 1000).toFixed(1)} ms`],
    ['Avg gap length',   `${(env.avgGapSec * 1000).toFixed(1)} ms`],
    ['Rise / fall',      `${env.riseMs.toFixed(1)} / ${env.fallMs.toFixed(1)} ms`],
  ]);

  L.push('');
  L.push(`## Spectrum — two-sided baseband, ±${(sampleRate / 2).toFixed(0)} Hz`);
  L.push(`Complex-baseband FFT — negative and positive offsets are distinct. **Sideband ratio P** is the canonical SSB discriminator: ≈ 0.5 = symmetric (AM/FSK/PSK), > 0.7 = USB-dominant, < 0.3 = LSB. **DC carrier level** measures the DC bin (tuned-carrier residue) vs noise — large value ⇒ AM-with-carrier or unmodulated.`);
  L.push('');
  table([
    ['Centroid offset',   `${fmt(sStats.centroidHz, 0)} Hz`],
    ['Spread (σ)',        `${sStats.spreadHz.toFixed(0)} Hz`],
    ['Flatness (Wiener)', `${sStats.flatness.toFixed(3)}  (0=tonal, 1=white)`],
    ['Entropy (Shannon)', `${sStats.entropy.toFixed(2)} nats`],
    ['95 % energy span',  `${fmt(sStats.rolloff95.loHz, 0)} .. ${fmt(sStats.rolloff95.hiHz, 0)} Hz`],
    ['Occupied BW (-3)',  `${fmt(sStats.occBw3.loHz, 0)} .. ${fmt(sStats.occBw3.hiHz, 0)} Hz  (Δ ${(sStats.occBw3.hiHz - sStats.occBw3.loHz).toFixed(0)} Hz)`],
    ['Occupied BW (-20)', `${fmt(sStats.occBw20.loHz, 0)} .. ${fmt(sStats.occBw20.hiHz, 0)} Hz  (Δ ${(sStats.occBw20.hiHz - sStats.occBw20.loHz).toFixed(0)} Hz)`],
    ['Sideband ratio P',  `${sStats.sidebandP.toFixed(3)}  (USB / total) — LSB: ${pct(sStats.lowerPowerFrac)}, USB: ${pct(sStats.upperPowerFrac)}`],
    ['DC carrier level',  `${sStats.carrierDb.toFixed(1)} dB above spectral median`],
  ]);

  L.push('');
  L.push(`## Instantaneous frequency`);
  L.push(`True frequency offset f_i(t) = (1/2π) · dφ/dt from the complex baseband. **Mean** = average carrier offset from tuned centre; **std** = FM deviation; **range** = full frequency excursion.`);
  L.push('');
  table([
    ['Mean offset',     `${fmt(ifs.meanHz, 1)} Hz`],
    ['Std (FM dev)',    `${ifs.stdHz.toFixed(1)} Hz`],
    ['Skewness',        ifs.skew.toFixed(3)],
    ['Excess kurtosis', ifs.kurt.toFixed(3)],
    ['Range',           `${fmt(ifs.minHz, 1)} .. ${fmt(ifs.maxHz, 1)} Hz  (Δ ${ifs.rangeHz.toFixed(1)} Hz)`],
  ]);

  L.push('');
  L.push(`## Instantaneous phase`);
  L.push(`φ(t) after linear-trend removal. **σ_ap** and **σ_dp** are the Azzouz–Nandi features; **phase-jump rate** counts |Δφ| > π/4.`);
  L.push('');
  table([
    ['σ_ap (|φ_NLc|)',  `${ips.sigmaAp.toFixed(3)} rad`],
    ['σ_dp ( φ_NLc )',  `${ips.sigmaDp.toFixed(3)} rad`],
    ['Phase-jump rate', `${ips.jumpRate.toFixed(0)} /s  (|Δφ| > π/4)`],
  ]);

  L.push('');
  L.push(`## Azzouz / Nandi AMC features`);
  L.push(`Classic AMC feature set computed on the complex baseband. σ_aa: amplitude variability; γ_max: residual-carrier energy; σ_af: FSK-vs-FM discriminator; σ_ap, σ_dp: PSK-vs-FM; P: sideband symmetry (see Spectrum).`);
  L.push('');
  table([
    ['σ_aa',         amc.sigma_aa.toFixed(4)],
    ['γ_max',        amc.gamma_max.toFixed(4)],
    ['σ_af',         amc.sigma_af.toFixed(4)],
    ['σ_ap',         amc.sigma_ap.toFixed(4)],
    ['σ_dp',         amc.sigma_dp.toFixed(4)],
    ['P (sideband)', amc.P.toFixed(3)],
  ]);

  L.push('');
  L.push(`## Higher-order cumulants`);
  L.push(`Moments / cumulants of the complex signal. Reference values: Gaussian noise = 0, BPSK ⇒ C42 ≈ −2, QPSK ≈ −1, 8-PSK ≈ 0, QAM-16 ≈ −0.68. μ_42 = C42 / C21² is power-invariant.`);
  L.push('');
  table([
    ['|C20|',           cum.c20Abs.toFixed(4)],
    ['C21',             cum.c21.toFixed(4)],
    ['|C40|',           cum.c40Abs.toFixed(4)],
    ['|C41|',           cum.c41Abs.toFixed(4)],
    ['C42',             cum.c42.toFixed(4)],
    ['μ_42 = C42/C21²', cum.mu42.toFixed(4)],
  ]);

  L.push('');
  L.push(`## Cepstrum`);
  L.push(`Real cepstrum = IFFT[log |X(f)|]. Peaks at quefrency T reveal a harmonic comb of spacing 1/T — voice F0, MFSK tone spacing, periodic key clicks all show up here.`);
  if (cepTop.length === 0) {
    L.push('');
    L.push(`*(no quefrency peaks)*`);
  } else {
    L.push('');
    L.push(`Top quefrencies (period → equivalent F0):`);
    L.push('');
    L.push('```');
    for (const q of cepTop) {
      L.push(`  ${q.ms.toFixed(2).padStart(6)} ms   →   ${q.hz.toFixed(1).padStart(6)} Hz   mag ${q.mag.toFixed(3)}`);
    }
    L.push('```');
  }

  L.push('');
  L.push(`## Tones — top ${peaks.length} peaks, offset from tuned Fc`);
  L.push(`Spectral peaks above an 8 dB local threshold, parabolic-interpolated for sub-bin accuracy, deduped within 5 Hz. Regular spacing ⇒ MFSK / OFDM; irregular ⇒ voice / noise / chaotic.`);
  if (peaks.length === 0) {
    L.push('');
    L.push(`*(none above noise floor)*`);
  } else {
    L.push('');
    L.push('```');
    for (const p of peaks) L.push(`  ${fmt(p.hz, 1).padStart(9)} Hz   ${p.db.toFixed(1).padStart(5)} dB`);
    L.push('```');
    if (spacing) {
      L.push('');
      table([
        ['Tone spacing',     `median ${spacing.median.toFixed(1)} Hz   std ${spacing.std.toFixed(1)} Hz   mean ${spacing.mean.toFixed(1)} Hz`],
        ['Pair Δ list (Hz)', spacing.diffs.map(d => d.toFixed(1)).join('  ')],
      ]);
    }
  }

  L.push('');
  L.push(`## Symbol rate — autocorr of |z|`);
  L.push(`Wiener–Khinchin autocorrelation of the envelope, IFFT(|FFT|²) with zero-padding. Local maxima of r[τ] / r[0] are candidate symbol periods; score is the normalised periodicity.`);
  if (bauds.length === 0) {
    L.push('');
    L.push(`*(no significant periodicity)*`);
  } else {
    L.push('');
    L.push('```');
    bauds.forEach((b, i) => {
      const symbols = Math.round(b.baud * (N / sampleRate));
      L.push(`  ${(i === 0 ? '*' : ' ')} ${b.baud.toFixed(2).padStart(7)} Bd   period ${(b.periodSec * 1000).toFixed(2)} ms   score ${b.score.toFixed(2)}   ≈${symbols} sym`);
    });
    L.push('```');
  }

  L.push('');
  L.push(`## Cyclic spectrum — |CAF| of x² at baud candidates`);
  L.push(`Cyclic Autocorrelation Function on the complex signal, evaluated at α = candidate baud rate. Strong peaks at α = baud (and harmonics) confirm true cyclostationarity — i.e. the baud is a real symbol rate, not a coincidental envelope wiggle.`);
  if (caf.length === 0) {
    L.push('');
    L.push(`*(no candidates)*`);
  } else {
    L.push('');
    L.push('```');
    for (const c of caf) {
      L.push(`  α = ${c.alpha.toFixed(2).padStart(7)} Hz   |CAF| = ${c.score.toFixed(3)}` +
             (c.score > 0.05 ? '   * cyclostationary' : ''));
    }
    L.push('```');
  }

  return L.join('\n');
}

/* ─────────────────  Protocol-specific fingerprints  ────────────── */

interface ProtocolHit {
  name: string;
  score: number;        // 0..1 — strength of the fingerprint
  details: string;      // human-readable explanation
}

/** Detect FT8: 8-MFSK, 6.25 Hz tone spacing, 0.16 s symbol duration,
 *  Costas array [3, 1, 4, 0, 6, 5, 2] at symbol positions 0, 36, 72.
 *  We split the 20 s capture into 0.16 s windows, find the dominant
 *  tone in each, quantise to one of 8 tone indices, and search for the
 *  Costas pattern at every offset. The score = best matching count / 7
 *  weighted by whether 2 or 3 of the canonical positions also match. */
function detectFT8(I: Float32Array, Q: Float32Array, sampleRate: number): ProtocolHit {
  const SYM = 0.16;
  const TONE = 6.25;
  const FT8_COSTAS = [3, 1, 4, 0, 6, 5, 2];
  const symSamples = Math.round(SYM * sampleRate);
  const fftN = nextPow2(symSamples);
  const N = I.length;
  const nSym = Math.floor(N / symSamples);
  if (nSym < 14) return { name: 'FT8', score: 0, details: 'clip too short' };

  // STFT magnitude per symbol → dominant tone offset (in bins of fftN).
  const toneHz: number[] = [];
  for (let s = 0; s < nSym; s++) {
    const re = new Float32Array(fftN);
    const im = new Float32Array(fftN);
    for (let k = 0; k < symSamples; k++) {
      const idx = s * symSamples + k;
      if (idx >= N) break;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (symSamples - 1));
      re[k] = I[idx] * w;
      im[k] = Q[idx] * w;
    }
    fft(re, im);
    // Find peak in the ±60 Hz window around DC (FT8 should be centred there).
    const bandHz = 60;
    const bandBins = Math.ceil(bandHz * fftN / sampleRate);
    let bestK = 0, bestV = 0;
    for (let k = -bandBins; k <= bandBins; k++) {
      const idx = (k + fftN) % fftN;
      const v = re[idx] * re[idx] + im[idx] * im[idx];
      if (v > bestV) { bestV = v; bestK = k; }
    }
    toneHz.push(bestK * sampleRate / fftN);
  }
  // Anchor the lowest expected tone at the 10th percentile of detected tones.
  const sorted = toneHz.slice().sort((a, b) => a - b);
  const lo = sorted[Math.max(0, Math.floor(sorted.length * 0.1))];
  const syms = toneHz.map(hz => {
    const idx = Math.round((hz - lo) / TONE);
    return Math.max(0, Math.min(7, idx));
  });

  // Slide the 7-symbol Costas across every position; track best raw count.
  let bestMatches = 0;
  for (let p = 0; p + FT8_COSTAS.length <= syms.length; p++) {
    let m = 0;
    for (let i = 0; i < FT8_COSTAS.length; i++) if (syms[p + i] === FT8_COSTAS[i]) m++;
    if (m > bestMatches) bestMatches = m;
  }
  // Canonical-position bonus: an FT8 frame is 79 symbols (12.64 s), so in
  // a 20 s clip we can hope to see at least two of {0, 36, 72} +/- frame
  // boundary. Count how many of those three positions reach ≥ 5/7 matches.
  let canonicalHits = 0;
  for (const start of [0, 36, 72]) {
    for (let off = -2; off <= 2; off++) {
      const p = start + off;
      if (p < 0 || p + 7 > syms.length) continue;
      let m = 0;
      for (let i = 0; i < 7; i++) if (syms[p + i] === FT8_COSTAS[i]) m++;
      if (m >= 5) { canonicalHits++; break; }
    }
  }
  // Chance baseline: with 7 tones, the expected best-match count for a
  // random signal over ~80 windows is ~4/7 (binomial × max-of-K). Score
  // above that baseline; below = 0. This is the main fix — without it,
  // FT8 fired on any signal that happened to quantize into 4 matching
  // tones somewhere.
  const matchScore = Math.max(0, (bestMatches - 4) / 3);
  // Canonical-position bonus is now additive on the residual, not
  // multiplicative on the baseline — a true FT8 frame reaches ≥ 5/7 at
  // canonical positions, so canonicalHits is the strong signal.
  const canonicalScore = canonicalHits / 3;
  const score = Math.min(1, 0.6 * matchScore + 0.6 * canonicalScore);
  return {
    name: 'FT8',
    score,
    details: `best ${bestMatches}/7 Costas (chance ~4/7), canonical hits ${canonicalHits}/3`,
  };
}

/** Detect FT4: 4-MFSK, ~5.4 Hz tone spacing, 0.048 s symbol duration,
 *  Costas arrays of length 4 at positions 0, 33, 70, 103. Each Costas
 *  is a different 4-permutation; we accept *any* of them. */
function detectFT4(I: Float32Array, Q: Float32Array, sampleRate: number): ProtocolHit {
  const SYM = 0.048;
  const TONE = 4 * 60 / 25 / 5;   // FT4: 5.376 Hz, simplified to 5.4 here
  const FT4_COSTAS = [
    [0, 1, 3, 2],
    [1, 0, 2, 3],
    [2, 3, 1, 0],
    [3, 2, 0, 1],
  ];
  const symSamples = Math.round(SYM * sampleRate);
  const fftN = nextPow2(symSamples);
  const N = I.length;
  const nSym = Math.floor(N / symSamples);
  if (nSym < 24) return { name: 'FT4', score: 0, details: 'clip too short' };

  const toneHz: number[] = [];
  for (let s = 0; s < nSym; s++) {
    const re = new Float32Array(fftN);
    const im = new Float32Array(fftN);
    for (let k = 0; k < symSamples; k++) {
      const idx = s * symSamples + k;
      if (idx >= N) break;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (symSamples - 1));
      re[k] = I[idx] * w;
      im[k] = Q[idx] * w;
    }
    fft(re, im);
    const bandHz = 40;
    const bandBins = Math.ceil(bandHz * fftN / sampleRate);
    let bestK = 0, bestV = 0;
    for (let k = -bandBins; k <= bandBins; k++) {
      const idx = (k + fftN) % fftN;
      const v = re[idx] * re[idx] + im[idx] * im[idx];
      if (v > bestV) { bestV = v; bestK = k; }
    }
    toneHz.push(bestK * sampleRate / fftN);
  }
  const sorted = toneHz.slice().sort((a, b) => a - b);
  const lo = sorted[Math.max(0, Math.floor(sorted.length * 0.1))];
  const syms = toneHz.map(hz => {
    const idx = Math.round((hz - lo) / TONE);
    return Math.max(0, Math.min(3, idx));
  });

  let bestMatches = 0, bestPos = -1, bestCostas = 0;
  let perfectHits = 0;        // count of windows that match 4/4
  for (let p = 0; p + 4 <= syms.length; p++) {
    for (let cIdx = 0; cIdx < FT4_COSTAS.length; cIdx++) {
      const c = FT4_COSTAS[cIdx];
      let m = 0;
      for (let i = 0; i < 4; i++) if (syms[p + i] === c[i]) m++;
      if (m > bestMatches) { bestMatches = m; bestPos = p; bestCostas = cIdx; }
      if (m === 4) perfectHits++;
    }
  }
  // FT4 has only 4 tones × 4 symbols → random chance of 4/4 in any
  // single window is 1/256 but there are ~250 windows × 4 Costas = 1000
  // trials, so a *single* 4/4 match is at the chance level. A real FT4
  // signal contains the Costas at the start, middle, and end of each
  // frame, so we want multiple coincidences. Score is the count of
  // perfect matches normalized — 0 hits = 0, 3+ hits = 1.0.
  const score = Math.min(1, perfectHits / 3);
  return {
    name: 'FT4',
    score,
    details: `${perfectHits} × 4/4 Costas hits (best ${bestMatches}/4 @ sym ${bestPos}, Costas ${bestCostas})`,
  };
}

/** Detect PSK31 idle: BPSK at 31.25 Bd on a single audio carrier,
 *  with phase reversing (Δφ ≈ ±π) at every symbol boundary during idle
 *  ("0000…" in varicode). We:
 *    1. find the strongest tone (already centred to DC by SID),
 *    2. shift it down to DC if it isn't,
 *    3. integrate over each 32 ms symbol,
 *    4. measure the spread of |Δφ| between consecutive symbol integrals.
 *  Score = fraction of consecutive-symbol pairs whose |Δφ| is within
 *  20° of π. */
/** Generic 2-FSK / FSK-modem template. Confirms the two strongest
 *  tones are separated by the expected shift and the autocorr baud
 *  matches the expected symbol rate. Used by all RTTY rates,
 *  NAVTEX/SITOR-B, DGPS MSK. */
function detectFSK2(
  peaks: Peak[], bauds: BaudPick[],
  shiftHz: number, baudBd: number, name: string,
  shiftTol = 25, baudTol = 8,
): ProtocolHit {
  if (peaks.length < 2) return { name, score: 0, details: 'fewer than 2 tones' };
  const sorted = peaks.slice(0, 2).sort((a, b) => a.hz - b.hz);
  const shift = Math.abs(sorted[1].hz - sorted[0].hz);
  const baud = bauds[0]?.baud ?? 0;
  // Exclude obvious multi-tone (MFSK / OFDM) signals — 2-FSK should
  // have exactly two dominant peaks.
  const thirdPenalty = peaks.length >= 3 && peaks[2].db > peaks[1].db - 4 ? 0.5 : 1.0;
  const shiftScore = Math.max(0, 1 - Math.abs(shift - shiftHz) / shiftTol);
  const baudScore  = baud ? Math.max(0, 1 - Math.abs(baud - baudBd) / baudTol) : 0;
  const score = Math.min(shiftScore, baudScore) * thirdPenalty;
  return {
    name, score,
    details: `Δf=${shift.toFixed(0)} Hz (target ${shiftHz}), baud=${baud.toFixed(1)} (target ${baudBd})`,
  };
}

/** Generic M-FSK template. Confirms detected-peak count, mean spacing,
 *  and (optionally) symbol rate match the expected values. Used by FT8/
 *  FT4 (with Costas check on top), Olivia family, MFSK-16, JT9, JT65,
 *  JT4, JS8, WSPR, ALE 2G, etc. */
function detectMFSK(
  peaks: Peak[], bauds: BaudPick[],
  nTonesExp: number, spacingHz: number, baudBd: number | null,
  name: string,
  iq: { I: Float32Array; Q: Float32Array; sampleRate: number } | null = null,
  tonesTol = 4, spacingRel = 0.20, baudRel = 0.25,
): ProtocolHit {
  if (peaks.length < Math.max(2, nTonesExp - tonesTol)) {
    return { name, score: 0, details: `${peaks.length} tones (need ~${nTonesExp})` };
  }
  // Anti-PSK gate via cyclostationary baud strength. MFSK structural
  // detectors can match PSK pulse-shape sideband patterns; the
  // discriminator is whether |z|² has a real ripple at the candidate
  // symbol rate (or its expected baud). PSK63 at the JS8 candidate
  // rate 6.25 Hz has cycBaud ~ 0.08 (noise); Olivia 8/250 at 31.25 Hz
  // has cycBaud >> 0.10 (genuine). Threshold 0.15 keeps the false-
  // positive rate low.
  if (iq) {
    const effB = (baudBd !== null) ? baudBd : (spacingHz >= 1 ? spacingHz : 0);
    if (effB >= 1) {
      const cg = cyclicBaudStrength(iq.I, iq.Q, iq.sampleRate, effB);
      if (cg < 0.10) {
        return { name, score: 0, details: `cyc-baud ${(cg * 100).toFixed(1)} % < 10 % gate @ ${effB.toFixed(1)} Bd` };
      }
    }
  }
  // Filter peaks to the expected band before measuring spacing.
  const bandHalf = (nTonesExp * spacingHz) / 2 + spacingHz;
  const inBand = peaks.filter(p => Math.abs(p.hz) <= bandHalf);
  if (inBand.length < Math.max(2, nTonesExp - tonesTol)) {
    return { name, score: 0, details: `${inBand.length} in-band tones (need ~${nTonesExp})` };
  }
  // Cluster nearby peaks into tones. Real MFSK signals (Olivia,
  // fldigi MFSK) smear each tone across multiple FFT bins from
  // pulse shaping, so findIQPeaks returns 3-5 bins per actual tone.
  // We merge peaks within ±spacingHz·0.4 of each other (less than
  // half the inter-tone spacing) using magnitude-weighted centroid.
  const sorted = inBand.slice().sort((a, b) => a.hz - b.hz);
  const clusters: { hz: number; mag: number; db: number }[] = [];
  const clusterTol = spacingHz * 0.4;
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && p.hz - last.hz < clusterTol) {
      const tot = last.mag + p.mag;
      last.hz  = (last.hz * last.mag + p.hz * p.mag) / tot;
      last.mag = tot;
      last.db  = Math.max(last.db, p.db);
    } else {
      clusters.push({ hz: p.hz, mag: p.mag, db: p.db });
    }
  }
  // Keep the strongest nTonesExp + 2 clusters, then sort by Hz for
  // the spacing-regularity computation.
  const strongest = clusters.slice().sort((a, b) => b.mag - a.mag);
  const used = strongest.slice(0, Math.min(strongest.length, nTonesExp + 2))
                        .sort((a, b) => a.hz - b.hz);
  const diffs: number[] = [];
  for (let i = 1; i < used.length; i++) diffs.push(used[i].hz - used[i - 1].hz);
  const meanD = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const stdD  = Math.sqrt(diffs.reduce((s, v) => s + (v - meanD) ** 2, 0) / diffs.length);
  const tonesScore   = Math.max(0, 1 - Math.abs(used.length - nTonesExp) / tonesTol);
  const spacingScore = Math.max(0, 1 - Math.abs(meanD - spacingHz) / (spacingHz * spacingRel));
  const regularity   = spacingHz > 0 ? Math.max(0, 1 - stdD / (spacingHz * 0.5)) : 0;
  // Baud check: prefer the cyclostationary detector (|z|² ripple at
  // the symbol rate) when IQ is available and the rate is fast enough
  // (≥ 3 Hz needs ≥ 30 cycles in 10 s of clip). For slow rates the
  // detector returns ~0 because there are too few cycles; we fall
  // back to envelope autocorr which has its own problems but is the
  // only signal we have. The hard `Math.min` below ensures that an
  // unmeasurable baud (returning 0) just makes baudScore=1 — soft
  // gate, not a kill.
  let baudScore = 1;
  if (baudBd !== null) {
    if (iq && baudBd >= 3) {
      const cyc = cyclicBaudStrength(iq.I, iq.Q, iq.sampleRate, baudBd);
      // Map cyc into a 0..1 score with a soft threshold around 0.02
      // (typical noise floor for the |z|² spectrum).
      baudScore = Math.min(1, cyc / 0.02);
    } else {
      const bd = bauds[0]?.baud ?? 0;
      baudScore = bd ? Math.max(0, 1 - Math.abs(bd - baudBd) / (baudBd * baudRel)) : 1;
    }
  }
  const structuralScore = Math.min(tonesScore, spacingScore, regularity, baudScore);
  // STFT-based hopping detector (replaces the time-averaged spectrum
  // analysis above for any mode where the symbol rate is fast enough
  // to fit ≥ 8 frames in a 10-second clip). Per-frame dominance × tone-
  // bin uniformity is the canonical MFSK signature: one active tone
  // per slot, all N tones used over time.
  // STFT-based hopping detector — well-suited for MFSK at the right
  // rate but produces false positives on PSK signals at slow-MFSK
  // candidate rates (long frame spans many PSK symbols → stochastic
  // dominant bin wandering). Tried gating with cyclostationary baud
  // strength; the noise floor (~0.08) and signal level for true MFSK
  // (varies by mode) overlap too much for a single threshold to
  // cleanly separate. Disabled until a per-fingerprint feature
  // architecture lets us compare detector confidences calibrated.
  void iq;
  const score = structuralScore;
  return {
    name, score,
    details: `${used.length} tones, Δmean=${meanD.toFixed(2)} Hz (target ${spacingHz}), Δstd=${stdD.toFixed(2)}` +
             (baudBd !== null ? `, baudScore=${(baudScore * 100).toFixed(0)} % (target ${baudBd} Bd)` : ''),
  };
}

/** Generic OFDM / multi-carrier template. Confirms many narrow tones
 *  (more than a non-OFDM modem) and total bandwidth matches. Used by
 *  MT63, DRM30, HFDL, STANAG 4539, etc. */
/** OFDM-family detector (currently used by MT63 only). Each call passes
 *  the *expected* tone count and bandwidth — not a minimum. The score
 *  penalises both under-shoot AND over-shoot of the tone count, plus
 *  bandwidth mismatch, and additionally rewards regular tone spacing
 *  (true OFDM has uniformly-spaced carriers; an MFSK family signal does
 *  not). The earlier "≥ minTones" gate let any wide-MFSK signal (Olivia,
 *  fldigi MFSK) fire MT63 — which was the bug VAL surfaced. */
function detectOFDM(
  peaks: Peak[], bw20Hz: number,
  expectedTones: number, expectedBwHz: number, name: string,
  toneTol = 0.30, bwTol = 0.20,
): ProtocolHit {
  // Require at least 60 % of the expected carrier count — below that
  // it's structurally not OFDM-of-this-density.
  const minTones = Math.max(8, Math.floor(expectedTones * 0.6));
  if (peaks.length < minTones) {
    return { name, score: 0, details: `${peaks.length} tones (need ≥${minTones})` };
  }
  const toneScore = Math.max(0, 1 - Math.abs(peaks.length - expectedTones) / (expectedTones * toneTol));
  const bwScore   = Math.max(0, 1 - Math.abs(bw20Hz   - expectedBwHz)   / (expectedBwHz   * bwTol));
  // Regular-spacing reward: real MT63 carriers are uniformly spaced
  // (15.6 Hz for -500/-1000, 31.25 Hz for -2000). Compute spacing std
  // over the in-band peaks; reward small std relative to expected
  // spacing.
  const sortedHz = peaks.slice().sort((a, b) => a.hz - b.hz);
  const diffs: number[] = [];
  for (let i = 1; i < sortedHz.length; i++) diffs.push(sortedHz[i].hz - sortedHz[i - 1].hz);
  let spacingScore = 0;
  if (diffs.length >= 4) {
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const std  = Math.sqrt(diffs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / diffs.length);
    const expectedSpacing = expectedBwHz / Math.max(1, expectedTones - 1);
    const spacingErr = Math.abs(mean - expectedSpacing) / expectedSpacing;
    // Both mean spacing near expected AND low std → high score.
    const meanFit = Math.max(0, 1 - spacingErr / 0.3);
    const stdFit  = Math.max(0, 1 - std / Math.max(1, expectedSpacing));
    spacingScore = meanFit * stdFit;
  }
  // Multiplicative — every condition must hold simultaneously.
  // All three structural checks must hold simultaneously — using
  // Math.min instead of geometric mean keeps MT63 from firing on
  // FT8/FT4 samples that happen to spread noise peaks across the band.
  const score = Math.min(toneScore, bwScore, spacingScore);
  return {
    name, score,
    details: `${peaks.length} tones in ${bw20Hz.toFixed(0)} Hz (target ${expectedTones} tones / ${expectedBwHz} Hz, spacing fit ${(spacingScore * 100).toFixed(0)} %)`,
  };
}

/** Generic BPSK template (z² coherence × consecutive-symbol phase
 *  reversal rate). Used by PSK31, PSK63, PSK125, PSK250, PSK500. */
function detectBPSK(
  I: Float32Array, Q: Float32Array, sampleRate: number,
  baudBd: number, name: string, bauds: BaudPick[] = [],
  peaks: Peak[] = [],
): ProtocolHit {
  const SYM = Math.round(sampleRate / baudBd);
  if (SYM < 4) return { name, score: 0, details: 'rate too high for SR' };
  const N = I.length;
  const nSym = Math.floor(N / SYM);
  if (nSym < 64) return { name, score: 0, details: 'too few symbols' };
  const sRe = new Float32Array(nSym), sIm = new Float32Array(nSym);
  for (let s = 0; s < nSym; s++) {
    let r = 0, i = 0;
    for (let k = 0; k < SYM; k++) {
      r += I[s * SYM + k];
      i += Q[s * SYM + k];
    }
    sRe[s] = r; sIm[s] = i;
  }
  let zSqRe = 0, zSqIm = 0, zSqE = 0;
  let revCount = 0, pairTotal = 0;
  for (let s = 0; s + 1 < nSym; s++) {
    const r0 = sRe[s]     * sRe[s]     - sIm[s]     * sIm[s];
    const i0 = 2 * sRe[s] * sIm[s];
    const r1 = sRe[s + 1] * sRe[s + 1] - sIm[s + 1] * sIm[s + 1];
    const i1 = 2 * sRe[s + 1] * sIm[s + 1];
    zSqRe += r1 * r0 + i1 * i0;
    zSqIm += i1 * r0 - r1 * i0;
    zSqE  += Math.hypot(r0, i0) * Math.hypot(r1, i1);
    const dot = sRe[s] * sRe[s + 1] + sIm[s] * sIm[s + 1];
    const crx = sRe[s] * sIm[s + 1] - sIm[s] * sRe[s + 1];
    const mag2 = (sRe[s] ** 2 + sIm[s] ** 2) * (sRe[s + 1] ** 2 + sIm[s + 1] ** 2);
    if (mag2 < 1e-12) continue;
    pairTotal++;
    if (Math.abs(Math.atan2(crx, dot)) > Math.PI / 2) revCount++;
  }
  if (zSqE <= 0 || pairTotal === 0) return { name, score: 0, details: 'no energy' };
  const cohZ2 = Math.hypot(zSqRe, zSqIm) / zSqE;
  const fracRev = revCount / pairTotal;
  // cohZ² gate: distinguishes real BPSK from MFSK signals at the
  // same symbol rate. Real PSK has cohZ² > 0.6 (the squared signal
  // has a single coherent direction); MFSK has cohZ² < 0.5 (the
  // squared signal phases scatter as tones change). Olivia 8/250
  // shares PSK31's 31.25 Bd cyclic signature but its cohZ² is ~0.48.
  if (cohZ2 < 0.6) {
    return { name, score: 0, details: `BPSK z² coh ${(cohZ2 * 100).toFixed(0)} % < 60 % gate @ ${baudBd} Bd` };
  }
  void bauds;
  const cycBaud = cyclicBaudStrength(I, Q, sampleRate, baudBd);
  // Tone-concentration discriminator: PSK is a single tone at DC
  // (after centring); MFSK / Olivia have many evenly-spaced tones.
  // If the top peak has <30 % of the total peak energy, this isn't
  // a PSK signal. Penalty drops the score to 0 when concentration
  // < 0.3, full credit when ≥ 0.7.
  // Tone-concentration check disabled — for PSK signals with
  // strong pulse-shape sidebands, the top peak has < 30 % of
  // top-8 energy and this check killed the score. cycBaud already
  // discriminates PSK family from MFSK (their cyclostationary
  // signatures are at different rates).
  void peaks;
  const toneConc = 1;
  const score = cohZ2 * cohZ2 * fracRev * cycBaud * toneConc;
  return {
    name, score,
    details: `BPSK z² coh ${(cohZ2 * 100).toFixed(0)} %, rev ${(fracRev * 100).toFixed(0)} %, cyc-baud ${(cycBaud * 100).toFixed(2)} %, conc ${(toneConc * 100).toFixed(0)} % @ ${baudBd} Bd`,
  };
}


/** Generic M-PSK template (M = 4 QPSK, 8 8-PSK). Symbol-rate matched
 *  filter, coherence of z^M (collapses to a single direction for clean
 *  M-PSK), and rate of consecutive-symbol phase changes > π/M. Used
 *  for QPSK31/63/125 and 8-PSK variants. detectBPSK above is the M=2
 *  specialisation kept separate for clarity. */
function detectMPSK(
  I: Float32Array, Q: Float32Array, sampleRate: number,
  M: 4 | 8, baudBd: number, name: string, bauds: BaudPick[] = [],
  peaks: Peak[] = [],
): ProtocolHit {
  const SYM = Math.round(sampleRate / baudBd);
  if (SYM < 4) return { name, score: 0, details: 'rate too high for SR' };
  const N = I.length;
  const nSym = Math.floor(N / SYM);
  if (nSym < 64) return { name, score: 0, details: 'too few symbols' };
  const sRe = new Float32Array(nSym), sIm = new Float32Array(nSym);
  for (let s = 0; s < nSym; s++) {
    let r = 0, i = 0;
    for (let k = 0; k < SYM; k++) { r += I[s * SYM + k]; i += Q[s * SYM + k]; }
    sRe[s] = r; sIm[s] = i;
  }
  // z^M and z^(M/2) for each symbol. M-PSK has coherent z^M and a
  // *less* coherent z^(M/2) — that's the QPSK-vs-BPSK / 8PSK-vs-QPSK
  // discriminator. Compute both via repeated squaring.
  const pwRe = new Float32Array(nSym), pwIm = new Float32Array(nSym);
  const hpRe = new Float32Array(nSym), hpIm = new Float32Array(nSym);
  for (let s = 0; s < nSym; s++) {
    let r = sRe[s], i = sIm[s];
    for (let p = 1; p < M / 2; p++) {
      const nr = r * sRe[s] - i * sIm[s];
      i = r * sIm[s] + i * sRe[s];
      r = nr;
    }
    hpRe[s] = r; hpIm[s] = i;        // z^(M/2)
    const nr = r * r - i * i;
    i = 2 * r * i;
    r = nr;
    pwRe[s] = r; pwIm[s] = i;        // z^M
  }
  let cMRe = 0, cMIm = 0, cME = 0;
  let cHRe = 0, cHIm = 0, cHE = 0;
  let activity = 0, total = 0;
  for (let s = 0; s + 1 < nSym; s++) {
    cMRe += pwRe[s + 1] * pwRe[s] + pwIm[s + 1] * pwIm[s];
    cMIm += pwIm[s + 1] * pwRe[s] - pwRe[s + 1] * pwIm[s];
    cME  += Math.hypot(pwRe[s], pwIm[s]) * Math.hypot(pwRe[s + 1], pwIm[s + 1]);
    cHRe += hpRe[s + 1] * hpRe[s] + hpIm[s + 1] * hpIm[s];
    cHIm += hpIm[s + 1] * hpRe[s] - hpRe[s + 1] * hpIm[s];
    cHE  += Math.hypot(hpRe[s], hpIm[s]) * Math.hypot(hpRe[s + 1], hpIm[s + 1]);
    const dot = sRe[s] * sRe[s + 1] + sIm[s] * sIm[s + 1];
    const crx = sRe[s] * sIm[s + 1] - sIm[s] * sRe[s + 1];
    const mag2 = (sRe[s] ** 2 + sIm[s] ** 2) * (sRe[s + 1] ** 2 + sIm[s + 1] ** 2);
    if (mag2 < 1e-12) continue;
    total++;
    if (Math.abs(Math.atan2(crx, dot)) > Math.PI / M) activity++;
  }
  if (cME <= 0 || total === 0) return { name, score: 0, details: 'no energy' };
  const cohM = Math.hypot(cMRe, cMIm) / cME;
  const cohH = cHE > 0 ? Math.hypot(cHRe, cHIm) / cHE : 0;
  const fracActive = activity / total;
  // cohM gate: require z^M to have at least moderate coherence
  // (real QPSK / 8-PSK signals at the right rate give cohM > 0.5).
  // Without this, MFSK signals (Olivia, MFSK-N) get small but non-
  // zero MPSK scores at their symbol rate just because cycBaud is
  // high — and beat the actual MFSK detector when its structural
  // matcher also misses.
  if (cohM < 0.5) {
    return { name, score: 0, details: `z^${M} coh ${(cohM * 100).toFixed(0)} % < 50 % gate @ ${baudBd} Bd` };
  }
  // Penalty: if z^(M/2) is also coherent, the signal is at most M/2-PSK,
  // not M-PSK. The penalty factor goes from 1 (clean M-PSK, low cohH)
  // down to 0 (cohH≥0.7 ⇒ probably lower-order PSK).
  const orderPenalty = Math.max(0, 1 - cohH / 0.7);
  // Symbol-magnitude uniformity — same rate discriminator used by
  // detectBPSK. Correct rate gives uniform |phasor|; sub-harmonic
  // gives alternating big/small.
  void bauds;
  const cycBaud = cyclicBaudStrength(I, Q, sampleRate, baudBd);
  // Tone-concentration check disabled — for PSK signals with
  // strong pulse-shape sidebands, the top peak has < 30 % of
  // top-8 energy and this check killed the score. cycBaud already
  // discriminates PSK family from MFSK (their cyclostationary
  // signatures are at different rates).
  void peaks;
  const toneConc = 1;
  const score = cohM * cohM * fracActive * orderPenalty * cycBaud * toneConc;
  return {
    name,
    score,
    details: `z^${M} coh ${(cohM * 100).toFixed(0)} %, z^${M / 2} coh ${(cohH * 100).toFixed(0)} %, activity ${(fracActive * 100).toFixed(0)} %, cyc-baud ${(cycBaud * 100).toFixed(2)} %, conc ${(toneConc * 100).toFixed(0)} % @ ${baudBd} Bd`,
  };
}

/* ────────────  Tier-2 custom detectors (specific signatures)  ─── */

/** ICAO SELCAL: 16-tone alphabet at fixed audio frequencies. A call
 *  is two simultaneous tones for ~1 s, pause, then another pair.
 *  Detect by counting how many of the strongest spectral peaks fall
 *  on the SELCAL frequency set. */
function detectSELCAL(peaks: Peak[], env: Float32Array, sampleRate: number): ProtocolHit {
  const TONES = [312.6, 346.7, 384.6, 426.6, 473.2, 524.8, 582.1, 645.7,
                 716.1, 794.3, 881.0, 977.2, 1083.9, 1202.3, 1333.5, 1479.1];
  if (peaks.length < 2) return { name: 'SELCAL (ICAO 5-tone)', score: 0, details: 'fewer than 2 tones' };
  // Require the two STRONGEST peaks to both be SELCAL tones — a real
  // call dominates the spectrum with exactly two tones, so the loudest
  // pair must belong to the alphabet. ±8 Hz match window (was ±15)
  // tightens the acceptable mis-tuning to half the smallest SELCAL
  // interval (≈ 34 Hz) so adjacent-tone collisions are impossible.
  const matchAlphabet = (hz: number) => TONES.some(s => Math.abs(s - Math.abs(hz)) < 8);
  const top2match = matchAlphabet(peaks[0].hz) && matchAlphabet(peaks[1].hz);
  if (!top2match) {
    return { name: 'SELCAL (ICAO 5-tone)', score: 0,
      details: `top-2 peaks (${peaks[0].hz.toFixed(0)}, ${peaks[1].hz.toFixed(0)} Hz) not in SELCAL alphabet` };
  }
  // Also require the third peak (if any) to be 6 dB weaker than the
  // second — a real SELCAL transmission has exactly two strong tones,
  // not four. Many FT8 / MFSK signals have 3+ comparable peaks.
  if (peaks.length >= 3 && peaks[2].db > peaks[1].db - 6) {
    return { name: 'SELCAL (ICAO 5-tone)', score: 0,
      details: '3rd-strongest peak < 6 dB below 2nd — looks like MFSK, not 2-tone SELCAL' };
  }
  // Burst-structure check. Real SELCAL has ~1 s on / ~0.2 s pause /
  // ~1 s on, so the envelope autocorrelation at ~1.2 s lag is high
  // and the duty cycle is roughly 90 % within the burst window. A
  // continuous signal (FT8, voice, RTTY) has uniform envelope and
  // fails this test.
  const N = env.length;
  const lag = Math.round(sampleRate * 1.2);
  let burstScore = 0;
  if (lag < N) {
    let mean = 0;
    for (let i = 0; i < N; i++) mean += env[i];
    mean /= N;
    let r0 = 0, rL = 0;
    for (let i = 0; i + lag < N; i++) {
      const a = env[i] - mean, b = env[i + lag] - mean;
      r0 += a * a; rL += a * b;
    }
    burstScore = r0 > 0 ? Math.max(0, rL / r0) : 0;
  }
  // Score: top-2 alphabet match is a hard gate (already past it), then
  // multiply by burst-structure confidence.
  return {
    name: 'SELCAL (ICAO 5-tone)',
    score: Math.min(1, burstScore + 0.3),
    details: `top-2 peaks on alphabet (${peaks[0].hz.toFixed(0)} + ${peaks[1].hz.toFixed(0)} Hz), env-autocorr @ 1.2 s = ${(burstScore * 100).toFixed(0)} %`,
  };
}

/** Hellschreiber (Feld-Hell): narrow ~245 Hz OOK at 122.5 Bd. Combine
 *  narrow-band check with envelope autocorrelation at the 122.5 Bd
 *  symbol period. */
function detectHellschreiber(env: Float32Array, sampleRate: number, peaks: Peak[]): ProtocolHit {
  const N = env.length;
  if (N < 4096) return { name: 'Hellschreiber (Feld-Hell)', score: 0, details: 'clip too short' };
  const lag = Math.round(sampleRate / 122.5);
  if (lag < 4 || lag >= N) return { name: 'Hellschreiber (Feld-Hell)', score: 0, details: 'rate out of range' };
  let mean = 0;
  for (let i = 0; i < N; i++) mean += env[i];
  mean /= N;
  let r0 = 0, rL = 0;
  for (let i = 0; i + lag < N; i++) {
    const a = env[i] - mean, b = env[i + lag] - mean;
    r0 += a * a; rL += a * b;
  }
  if (r0 <= 0) return { name: 'Hellschreiber (Feld-Hell)', score: 0, details: 'flat envelope' };
  const periodicity = Math.max(0, rL / r0);
  const bw = peaks.length >= 2 ? Math.abs(peaks[0].hz - peaks[1].hz) : 0;
  const bwScore = peaks.length === 1 ? 0.8
                  : Math.max(0, 1 - Math.abs(bw - 245) / 200);
  return {
    name: 'Hellschreiber (Feld-Hell)',
    score: periodicity * bwScore,
    details: `env-autocorr @ 122.5 Bd ${(periodicity * 100).toFixed(0)} %, BW match ${(bwScore * 100).toFixed(0)} %`,
  };
}

/** Bell 202 AFSK on HF (AX.25 / APRS): 1200 Hz mark, 2200 Hz space,
 *  300 Bd on HF. Just a parameterised 2-FSK fingerprint. */
function detectAX25HF(peaks: Peak[], bauds: BaudPick[]): ProtocolHit {
  return detectFSK2(peaks, bauds, 1000, 300, 'AX.25 HF (Bell 202 AFSK)', 100, 30);
}

/** HF time stations (WWV/WWVH/CHU/RWM/BPM/JJY): strong narrow carrier
 *  with 1-pulse-per-second envelope. Detect by 1 s autocorrelation lag. */
function detectTimeStation(env: Float32Array, sampleRate: number): ProtocolHit {
  const N = env.length;
  const lag = sampleRate;
  if (lag >= N) return { name: 'Time station (WWV/CHU/RWM)', score: 0, details: 'clip too short' };
  let mean = 0;
  for (let i = 0; i < N; i++) mean += env[i];
  mean /= N;
  let r0 = 0, rL = 0;
  for (let i = 0; i + lag < N; i++) {
    const a = env[i] - mean, b = env[i + lag] - mean;
    r0 += a * a; rL += a * b;
  }
  if (r0 <= 0) return { name: 'Time station (WWV/CHU/RWM)', score: 0, details: 'flat envelope' };
  return {
    name: 'Time station (WWV/CHU/RWM)',
    score: Math.max(0, rL / r0),
    details: `1 s envelope-autocorr ${((rL / r0) * 100).toFixed(0)} % (1 pps cadence)`,
  };
}

/** WEFAX HF: 120 lpm scan = 2 Hz line rate → 500 ms envelope period.
 *  Hint via 300/2300 Hz black/white tones if present. */
function detectWEFAX(env: Float32Array, sampleRate: number, peaks: Peak[]): ProtocolHit {
  const N = env.length;
  const lag = Math.round(sampleRate * 0.5);
  if (lag >= N) return { name: 'WEFAX 120 lpm', score: 0, details: 'clip too short' };
  let mean = 0;
  for (let i = 0; i < N; i++) mean += env[i];
  mean /= N;
  let r0 = 0, rL = 0;
  for (let i = 0; i + lag < N; i++) {
    const a = env[i] - mean, b = env[i + lag] - mean;
    r0 += a * a; rL += a * b;
  }
  if (r0 <= 0) return { name: 'WEFAX 120 lpm', score: 0, details: 'flat envelope' };
  const periodicity = Math.max(0, rL / r0);
  const hasFaxTone = peaks.some(p => Math.abs(Math.abs(p.hz) - 300) < 80
                                 || Math.abs(Math.abs(p.hz) - 2300) < 80);
  return {
    name: 'WEFAX 120 lpm',
    score: periodicity * (hasFaxTone ? 1 : 0.5),
    details: `0.5 s env-autocorr ${(periodicity * 100).toFixed(0)} %, fax-tone hint ${hasFaxTone ? 'yes' : 'no'}`,
  };
}

/* ─────────────────────────  Result-panel overlay  ───────────────── */

let currentOverlay: HTMLElement | null = null;

export function clearSigOverlay(): void {
  if (currentOverlay) { currentOverlay.remove(); currentOverlay = null; }
}

/** Minimal markdown → HTML for the SID overlay and the AI panel.
 *  Handles ATX headings (`#`–`######`), blockquotes (`>`), fenced code
 *  blocks (```), bullet (`-`, `*`, `+`) and ordered (`1.`) lists, GFM
 *  pipe tables, inline `**bold**`, `*italic*`, `` `code` ``, and
 *  paragraphs. All HTML special chars are escaped before transforms;
 *  the output is then safe to assign via innerHTML. */
export function renderMarkdown(src: string): string {
  const esc = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  const lines = src.split('\n');
  const out: string[] = [];
  let inCode = false;
  let para: string[] = [];
  let listKind: 'ul' | 'ol' | null = null;
  // Pipe-table accumulator. Header row is committed once we see the
  // separator row (---).
  let tblHeader: string[] | null = null;
  let tblBody: string[][] | null = null;
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (listKind) { out.push(`</${listKind}>`); listKind = null; }
  };
  const flushTable = () => {
    if (tblHeader && tblBody) {
      const head = `<thead><tr>${tblHeader.map(c => `<th>${inline(c.trim())}</th>`).join('')}</tr></thead>`;
      const body = tblBody.map(row => `<tr>${row.map(c => `<td>${inline(c.trim())}</td>`).join('')}</tr>`).join('');
      out.push(`<table>${head}<tbody>${body}</tbody></table>`);
    }
    tblHeader = null;
    tblBody = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };
  const splitPipes = (s: string) =>
    s.replace(/^\|\s?/, '').replace(/\s?\|\s*$/, '').split(/\s*\|\s*/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.startsWith('```')) {
      flushAll();
      if (!inCode) { inCode = true; out.push('<pre><code>'); }
      else { inCode = false; out.push('</code></pre>'); }
      continue;
    }
    if (inCode) { out.push(esc(raw)); continue; }
    const line = esc(raw);
    // Pipe-table — header row is followed by a separator row matching
    // /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/. We look one
    // line ahead so the header itself isn't mistaken for a paragraph.
    if (!tblHeader && /^\s*\|.*\|.*\|?\s*$/.test(raw)
        && i + 1 < lines.length
        && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      tblHeader = splitPipes(line);
      tblBody = [];
      i++;            // skip the separator row
      continue;
    }
    if (tblHeader && /^\s*\|.*\|.*\|?\s*$/.test(raw)) {
      tblBody!.push(splitPipes(line));
      continue;
    }
    if (tblHeader) flushTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (line.startsWith('&gt; ')) {
      flushAll();
      out.push(`<blockquote>${inline(line.slice(5))}</blockquote>`);
      continue;
    }
    const ulItem = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ulItem) {
      flushPara(); flushTable();
      if (listKind !== 'ul') { flushList(); out.push('<ul>'); listKind = 'ul'; }
      out.push(`<li>${inline(ulItem[1])}</li>`);
      continue;
    }
    const olItem = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (olItem) {
      flushPara(); flushTable();
      if (listKind !== 'ol') { flushList(); out.push('<ol>'); listKind = 'ol'; }
      out.push(`<li>${inline(olItem[1])}</li>`);
      continue;
    }
    if (line.trim() === '') { flushAll(); continue; }
    flushList();
    para.push(line);
  }
  flushAll();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

export function showSigOverlay(host: HTMLElement, text: string, tag: string,
                                banner: (m: string, ms?: number) => void): void {
  clearSigOverlay();
  const div = document.createElement('div');
  div.className = 'sig-overlay';

  const body = document.createElement('div');
  body.className = 'sig-overlay-text sig-overlay-markdown';
  body.innerHTML = renderMarkdown(text);

  const bar = document.createElement('div');
  bar.className = 'sig-overlay-bar';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'sig-overlay-copy';
  copyBtn.textContent = 'copy';
  // Robust copy: try the modern async Clipboard API first, then fall
  // back to a hidden <textarea> + execCommand('copy') for environments
  // where the Clipboard API isn't available (older Android Chrome,
  // insecure contexts, PWAs without clipboard permission). Surface the
  // failure reason in the banner so the operator knows what blocked it.
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    let ok = false;
    let why = '';
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (err) {
        why = (err instanceof Error) ? err.message : String(err);
      }
    } else {
      why = window.isSecureContext ? 'no Clipboard API' : 'insecure context';
    }
    if (!ok) {
      // execCommand('copy') fallback — works without HTTPS and without
      // explicit clipboard permission, at the cost of needing a real
      // selection in the DOM for ~one tick.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (ok) {
      copyBtn.textContent = 'copied';
      banner(`${tag} — analysis copied to clipboard`, 1200);
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
    } else {
      banner(`${tag} — clipboard copy failed${why ? ': ' + why.slice(0, 60) : ''}`, 3000);
    }
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sig-overlay-close';
  closeBtn.setAttribute('aria-label', 'close analysis');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentOverlay === div) currentOverlay = null;
    div.remove();
  });

  bar.appendChild(copyBtn);
  bar.appendChild(closeBtn);
  div.appendChild(body);
  div.appendChild(bar);
  host.appendChild(div);
  currentOverlay = div;
}

// Parked detectors and STFT hopping framework — kept compiled for
// re-enablement once the multi-detector arbitration architecture lands.
// Reference them here so TypeScript doesn't error on noUnusedLocals.
void mfskHoppingScore;
void detectTimeStation;
void detectWEFAX;
// Protocol-specific detectors retained for future re-introduction of an
// optional classification mode; SID currently emits raw measurements
// only and does not invoke them.
void detectFT8; void detectFT4; void detectMFSK; void detectOFDM;
void detectBPSK; void detectMPSK; void detectFSK2;
void detectSELCAL; void detectHellschreiber; void detectAX25HF;
