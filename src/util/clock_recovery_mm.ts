// Port of GNU Radio's gr-digital clock_recovery_mm_cc block.
//
// Algorithm (matches gr-digital/lib/clock_recovery_mm_cc_impl.cc):
//   p_0T = interp(in, mu)
//   c_0T = slicer(p_0T)                    // QPSK: sign(re) + j sign(im)
//   x    = (c_0T - c_2T) * conj(p_1T)
//   y    = (p_0T - p_2T) * conj(c_1T)
//   mm   = clip(real(y - x), ±1)
//   omega += gain_omega * mm
//   omega  = clip(omega, omega_mid ± omega_lim)
//   mu    += omega + gain_mu * mm
//   ii    += floor(mu); mu -= floor(mu)
//
// Interpolator: 4-point cubic Lagrange (kept simple in TS; same continuous-
// time interpretation as GR's 8-tap MMSE FIR for the purposes of MM TED).

export interface ClockRecoveryMMOpts {
  omega: number;             // nominal samples per symbol
  gainOmega?: number;        // typical: gainMu^2 / 4
  mu?: number;               // initial fractional offset, 0..1
  gainMu?: number;           // loop gain for mu (e.g. 0.03)
  omegaRelativeLimit?: number; // typical 0.005 .. 0.02
}

export class ClockRecoveryMM {
  private omegaMid: number;
  private omega: number;
  private omegaLim: number;
  private gainOmega: number;
  private gainMu: number;
  private mu: number;

  // Two-symbol history of the (interpolated) input and slicer output.
  private p1Re = 0; private p1Im = 0;
  private p2Re = 0; private p2Im = 0;
  private c1Re = 0; private c1Im = 0;
  private c2Re = 0; private c2Im = 0;

  // Streaming input ring: holds the last (consumed - 4) samples carried over
  // to the next call so the 4-tap interpolator never reaches across a gap.
  private hist: Float32Array = new Float32Array(8); // 4 complex samples (re,im pairs)
  private histN = 0;

  constructor(o: ClockRecoveryMMOpts) {
    if (!(o.omega >= 1)) throw new Error('clock_recovery_mm: omega must be >= 1');
    this.omegaMid = o.omega;
    this.omega = o.omega;
    const rel = o.omegaRelativeLimit ?? 0.005;
    this.omegaLim = this.omegaMid * rel;
    this.gainMu = o.gainMu ?? 0.03;
    this.gainOmega = o.gainOmega ?? (this.gainMu * this.gainMu) / 4;
    this.mu = o.mu ?? 0.5;
  }

  reset() {
    this.omega = this.omegaMid;
    this.mu = 0.5;
    this.p1Re = this.p1Im = this.p2Re = this.p2Im = 0;
    this.c1Re = this.c1Im = this.c2Re = this.c2Im = 0;
    this.histN = 0;
  }

  setOmega(omega: number) {
    if (!(omega >= 1)) return;
    this.omegaMid = omega;
    this.omega = omega;
    this.omegaLim = omega * (this.omegaLim / Math.max(1e-9, this.omegaMid) || 0.005);
    this.mu = 0.5;
  }

  // Input: interleaved I/Q (real, imag) Float32. Output: recovered symbols
  // (also interleaved I/Q). Caller-supplied `out` must be large enough; the
  // returned count tells how many complex symbols were produced.
  process(inIQ: Float32Array, out: Float32Array): number {
    // Concatenate carryover history + new samples into a working buffer.
    const totalPairs = (this.histN + (inIQ.length >> 1));
    const work = new Float32Array(totalPairs * 2);
    work.set(this.hist.subarray(0, this.histN * 2), 0);
    work.set(inIQ, this.histN * 2);

    let ii = 0;          // pair index into work
    let oo = 0;          // pair index into out
    const need = 4;      // 4-tap cubic Lagrange needs 4 contiguous samples
    const maxOut = out.length >> 1;

    while (oo < maxOut && ii + need <= totalPairs) {
      // Cubic Lagrange interpolation at fractional offset mu in [0,1).
      // Use samples [ii], [ii+1], [ii+2], [ii+3] with the eye centred
      // between [ii+1] and [ii+2] (x = mu).
      const mu = this.mu;
      const x = mu;
      const w0 = -x * (x - 1) * (x - 2) / 6;
      const w1 =  (x + 1) * (x - 1) * (x - 2) / 2;
      const w2 = -(x + 1) * x       * (x - 2) / 2;
      const w3 =  (x + 1) * x       * (x - 1) / 6;
      const b = ii * 2;
      const p0Re = w0 * work[b]     + w1 * work[b + 2] + w2 * work[b + 4] + w3 * work[b + 6];
      const p0Im = w0 * work[b + 1] + w1 * work[b + 3] + w2 * work[b + 5] + w3 * work[b + 7];

      // QPSK slicer: sign of each axis (matches gr-digital default).
      const c0Re = p0Re >= 0 ? 1 : -1;
      const c0Im = p0Im >= 0 ? 1 : -1;

      // x = (c_0T - c_2T) * conj(p_1T)
      const dxRe = c0Re - this.c2Re;
      const dxIm = c0Im - this.c2Im;
      const xRe = dxRe * this.p1Re + dxIm * this.p1Im;
      // y = (p_0T - p_2T) * conj(c_1T)
      const dyRe = p0Re - this.p2Re;
      const dyIm = p0Im - this.p2Im;
      const yRe = dyRe * this.c1Re + dyIm * this.c1Im;
      let mm = yRe - xRe;
      if (mm > 1) mm = 1; else if (mm < -1) mm = -1;

      // Emit the recovered symbol.
      out[oo * 2]     = p0Re;
      out[oo * 2 + 1] = p0Im;
      oo++;

      // Shift symbol history.
      this.p2Re = this.p1Re; this.p2Im = this.p1Im;
      this.p1Re = p0Re;      this.p1Im = p0Im;
      this.c2Re = this.c1Re; this.c2Im = this.c1Im;
      this.c1Re = c0Re;      this.c1Im = c0Im;

      // Loop update.
      this.omega += this.gainOmega * mm;
      const dev = this.omega - this.omegaMid;
      if (dev >  this.omegaLim) this.omega = this.omegaMid + this.omegaLim;
      else if (dev < -this.omegaLim) this.omega = this.omegaMid - this.omegaLim;
      this.mu += this.omega + this.gainMu * mm;

      const adv = Math.floor(this.mu);
      ii += adv;
      this.mu -= adv;
    }

    // Carry over the last (need - 1) samples plus any unconsumed tail so the
    // next call's interpolator window stays coherent.
    const remainPairs = totalPairs - ii;
    const carry = Math.min(remainPairs, this.hist.length >> 1);
    if (carry > 0) {
      this.hist.set(work.subarray(ii * 2, (ii + carry) * 2), 0);
    }
    this.histN = carry;

    return oo;
  }

  get currentOmega() { return this.omega; }
  get currentMu()    { return this.mu; }
}
