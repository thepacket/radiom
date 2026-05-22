// Streaming PSK31 decoder, server-side in Node.
//
// PSK31: 31.25 baud BPSK with raised-cosine matched filter, differential
// phase encoding, and Varicode (variable-length character codes ending in
// the "00" delimiter).
//
// Pipeline per audio sample:
//   1. NCO mixer to baseband at the configured pitch.
//   2. Single-pole IIR lowpass on each I/Q (~50 Hz cutoff).
//   3. Symbol clock — samples once every sampleRate / 31.25 input samples.
//   4. Differential decode: bit = sign of dot-product between current and
//      previous symbol vectors (1 = phase unchanged, 0 = phase reversed).
//   5. Varicode accumulator: characters are bit strings with no two
//      consecutive zeros, terminated by "00".
//
// Default pitch 1000 Hz; user should tune so the PSK signal lands there
// (the spectrogram shows it as a vertical line at the chosen pitch).

const VARICODE = {
  '1010101011':0,  '1011011011':1,  '1011101101':2,  '1101110111':3,
  '1011101011':4,  '1101011111':5,  '1011101111':6,  '1011111101':7,
  '1011111111':8,  '11101111':9,    '11101':10,      '1101101111':11,
  '1011011101':12, '11111':13,      '1101110101':14, '1110101011':15,
  '1011110111':16, '1011110101':17, '1110101101':18, '1110101111':19,
  '1101011011':20, '1101101011':21, '1101101101':22, '1101010111':23,
  '1101111011':24, '1101111101':25, '1110110111':26, '1101010101':27,
  '1101011101':28, '1110111011':29, '1011111011':30, '1101111111':31,
  '1':32,          '111111111':33,  '101011111':34,  '111110101':35,
  '111011011':36,  '1011010101':37, '1010111011':38, '101111111':39,
  '11111011':40,   '11110111':41,   '101101111':42,  '111011111':43,
  '1110101':44,    '110101':45,     '1010111':46,    '110101111':47,
  '10110111':48,   '10111101':49,   '11101101':50,   '11111111':51,
  '101110111':52,  '101011011':53,  '101101011':54,  '110101101':55,
  '110101011':56,  '110110111':57,  '11110101':58,   '110111101':59,
  '111101101':60,  '1010101':61,    '111010111':62,  '1010101111':63,
  '1010111101':64, '1111101':65,    '11101011':66,   '10101101':67,
  '10110101':68,   '1110111':69,    '11011011':70,   '11111101':71,
  '101010101':72,  '1111111':73,    '111111101':74,  '101111101':75,
  '11010111':76,   '10111011':77,   '11011101':78,   '10101011':79,
  '11010101':80,   '111011101':81,  '10101111':82,   '1101111':83,
  '1101101':84,    '101010111':85,  '110110101':86,  '101011101':87,
  '101110101':88,  '101111011':89,  '1010101101':90, '111110111':91,
  '111101111':92,  '111111011':93,  '1010111111':94, '101101101111':95,
  '1011011111':96, '1011':97,       '1011111':98,    '101111':99,
  '101101':100,    '11':101,        '111101':102,    '1011011':103,
  '101011':104,    '1101':105,      '111101011':106, '10111111':107,
  '11011':108,     '111011':109,    '1111':110,      '111':111,
  '111111':112,    '110111111':113, '10101':114,     '10111':115,
  '101':116,       '110111':117,    '1111011':118,   '1101011':119,
  '11011111':120,  '1011101':121,   '111010101':122, '1010110111':123,
  '110111011':124, '1010110101':125,'1011010111':126,'1110110101':127,
};

export class PSKDecoder {
  constructor(opts = {}) {
    this.sr      = opts.sampleRate || 12000;
    this.pitch   = opts.pitchHz    || 1000;
    this.onChar  = opts.onChar     || (() => {});
    this.onPitch = opts.onPitch    || (() => {});

    this.dphase  = 2 * Math.PI * this.pitch / this.sr;
    this.phase   = 0;

    this.iLp = 0; this.qLp = 0;
    // ~50 Hz cutoff — comfortably above 31.25 baud, narrow enough to reject
    // adjacent QRM in a busy PSK31 watering hole.
    this.alpha = 1 - Math.exp(-2 * Math.PI * 50 / this.sr);

    // Symbol clock counter (fractional).
    this.symbolPhase = 0;
    this.sps = this.sr / 31.25;

    // Previous symbol vector for differential decode.
    this.prevI = 1; this.prevQ = 0;

    // Varicode bit accumulator (string of '0'/'1').
    this.bits = '';
    // Track recent envelope so we can squelch noise periods.
    this.runEnv = 0;
  }

  setPitch(hz) {
    if (Math.abs(hz - this.pitch) < 5) return;
    this.pitch = hz;
    this.dphase = 2 * Math.PI * hz / this.sr;
    this.iLp = this.qLp = 0;
    this.bits = '';
  }

  feed(int16) {
    const n = int16.length;
    for (let i = 0; i < n; i++) {
      const x = int16[i] / 32768;
      // NCO
      this.phase += this.dphase;
      if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
      const cos = Math.cos(this.phase), sin = Math.sin(this.phase);
      // Mix
      const I = x * cos;
      const Q = x * sin;
      // Lowpass each (single-pole)
      this.iLp += this.alpha * (I - this.iLp);
      this.qLp += this.alpha * (Q - this.qLp);
      // Symbol clock
      this.symbolPhase += 1;
      if (this.symbolPhase >= this.sps) {
        this.symbolPhase -= this.sps;
        this.processSymbol(this.iLp, this.qLp);
      }
    }
  }

  processSymbol(I, Q) {
    // Squelch via short envelope tracker — skip symbols when audio is silent.
    const env = I * I + Q * Q;
    this.runEnv = this.runEnv * 0.95 + env * 0.05;
    if (this.runEnv < 1e-7) return;

    // Differential decode: 1 if phase ≈ previous, 0 if reversed.
    const dot = I * this.prevI + Q * this.prevQ;
    const bit = dot >= 0 ? 1 : 0;
    this.prevI = I; this.prevQ = Q;

    this.bits += bit ? '1' : '0';
    // Trim runaway bit accumulator (no character should be more than ~14 bits).
    if (this.bits.length > 32) this.bits = this.bits.slice(-32);

    // Varicode delimiter: any "00" terminates a character. Strip leading 0s.
    const idx = this.bits.indexOf('00');
    if (idx < 0) return;
    let code = this.bits.slice(0, idx);
    this.bits = this.bits.slice(idx + 2);
    // Leading zeros (between successive char delimiters) are noise / inter-
    // character bits; strip them.
    code = code.replace(/^0+/, '');
    if (!code) return;
    const ch = VARICODE[code];
    if (typeof ch === 'number' && ch >= 32) {
      this.onChar(String.fromCharCode(ch));
    } else if (ch === 10 || ch === 13) {
      this.onChar('\n');
    }
  }
}
