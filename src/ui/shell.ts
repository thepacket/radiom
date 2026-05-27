import { KiwiClient } from '../kiwi/client';
import type { Mode } from '../kiwi/types';
import { AudioPlayer } from '../audio/player';
import { SpectrumView, PALETTES, buildLUT, type PaletteName } from './spectrum';
import { FftAverager } from './fft_average';
import { openServerList, findServerEntry, type ServerEntry } from './server-list';
import { openOwrxList, owrxWsUrl } from './openwebrx-list';
import { openRtlList } from './rtl-list';
import { RtlTcpClient } from '../rtltcp/client';
import { OpenWebRxClient } from '../openwebrx/client';
import type { AudioFrame, KiwiStatus, WaterfallFrame } from '../kiwi/types';
import { openPresetsModal } from './presets-modal';
import { openBandModal } from './band-modal';
import { openSettingsModal, loadSettings, saveSettings, LANGS_SRC, LANGS_DST, type Settings } from './settings-modal';
import { openLangModal, langLabel } from './lang-modal';
import { WhisperTranscriber } from '../transcribe/whisper';
import { Recorder, listRecordings, getRecordingBlob, deleteRecording, saveRecording, type RecordingMeta } from '../audio/recorder';
import { decodeWindow as decodeFt8Window, type Ft8Message } from '../decoders/ft8';
import { CWDecoder } from '../decoders/cw';
import { RTTYFldigiDecoder } from '../decoders/rtty-fldigi';
import { OliviaFldigiDecoder } from '../decoders/olivia-fldigi';
import { MfskFldigiDecoder, type MfskMode } from '../decoders/mfsk-fldigi';
import { Mt63FldigiDecoder, type Mt63Mode } from '../decoders/mt63-fldigi';
import { FsqFldigiDecoder } from '../decoders/fsq-fldigi';
import { ThorFldigiDecoder, type ThorMode } from '../decoders/thor-fldigi';
import { DominoexFldigiDecoder, type DominoexMode } from '../decoders/dominoex-fldigi';
import { ContestiaFldigiDecoder } from '../decoders/contestia-fldigi';
import { WwvFldigiDecoder } from '../decoders/wwv-fldigi';
import { PSKDecoder } from '../decoders/psk';
import { PSKFldigiDecoder, type PSKFldigiMode } from '../decoders/psk-fldigi';
import { ModeClassifier, type ClassifierResult } from '../decoders/classifier';
import { RsidClassifier, type RsidDetection } from '../decoders/rsid-classifier';
import { WefaxDecoder, type WefaxRow, type WefaxImageMeta } from '../decoders/wefax';
import { NAVTEXDecoder } from '../decoders/navtex';
import { PacketDecoder } from '../decoders/packet';
import { WsprDecoder, type WsprSpot } from '../decoders/wspr';
import { Wspr15Decoder } from '../decoders/wspr15';
import { Js8Decoder,  type Js8Spot  } from '../decoders/js8';
import { Jt9Decoder,  type Jt9Spot  } from '../decoders/jt9';
import { Jt65Decoder, type Jt65Spot } from '../decoders/jt65';
import { Q65Decoder,  type Q65Spot  } from '../decoders/q65';
import { Fst4wDecoder, type Fst4wSpot } from '../decoders/fst4w';
import { Stanag4285Detector, type StanagStatus } from '../decoders/stanag4285';
import { Stanag4539Detector, type Stanag4539Status } from '../decoders/stanag4539';
import { HellDecoder } from '../decoders/hell';
import { SstvDecoder, type SstvImage } from '../decoders/sstv';
import { FreedvDecoder, type FreedvMode } from '../decoders/freedv';
import { ThrobFldigiDecoder, type ThrobMode } from '../decoders/throb-fldigi';
import { Jt4Decoder, type Jt4Spot } from '../decoders/jt4';
import { SelcalDecoder, type SelcalCall } from '../decoders/selcal';
import { PocsagDecoder, type PocsagPage } from '../decoders/pocsag';
import { DsdDecoder, type DsdMode, type DsdEvent } from '../decoders/dsd';
import { MultimonDecoder, type MultimonMode, type MultimonEvent } from '../decoders/multimon';
import { VendoredDecoder } from '../decoders/vendored';
import { Fst4Decoder, type Fst4Spot } from '../decoders/fst4';
import { ALE2GDecoder } from '../decoders/ale-2g';
import { HFDLDecoder } from '../decoders/hfdl';
import { IsbDemod } from '../decoders/isb';
import { SsbFilteredDemod, type SsbSide } from '../decoders/ssb-filtered';
import { loadPresets, type Preset } from './presets';
import { findStationNear } from './stations';
import { ClockRecoveryMM } from '../util/clock_recovery_mm';
import { estimateSymbolTimingBoth } from '../util/oerder_meyr';
import { AudioConstellation, type CostasMode } from '../dsp/audio_constellation';
import { decodeWavIQ, analyzeLocalIQ, showSigOverlay, clearSigOverlay, renderMarkdown } from './signal-local-analyzer';
import { eibiLanguage, eibiTarget, eibiCountry, eibiTxSite } from './eibi-codes';
import {
  loadMemory, addChannel, updateChannel, deleteChannel,
  exportMemoryJson, importMemoryJson,
} from './memory';
import { hilbertAnalytic } from '../util/iq-filters';

interface ScanItem {
  label: string;
  freqKHz: number;
  mode?: Mode;
  lowCutHz?: number;
  highCutHz?: number;
}

interface Toggles {
  fft: boolean;
  wf: boolean;
  comp: boolean;
  adpcm: boolean;
  base: boolean;
}

const DEFAULT_PASSBANDS: Record<Mode, [number, number]> = {
  am:   [-4900, 4900],
  amn:  [-2500, 2500],
  amw:  [-6000, 6000],
  cw:   [-300, 300],
  cwn:  [-30, 30],          // ±30 Hz = 60 Hz wide narrow CW
  drm:  [-5000, 5000],
  // KiwiSDR's IQ mode delivers complex baseband; the lo/hi cuts on the
  // server side define the bandwidth of the I/Q passband. ±5 kHz is the
  // standard width for narrow-band utility decoding (HFDL, DSC, etc.).
  iq:   [-5000, 5000],
  lsb:  [-2700, 0],
  lsn:  [-2350, -350],
  nbfm: [-6000, 6000],
  wfm:  [-80000, 80000],   // WFM broadcast — 160 kHz; OWRX-only (HD audio path)
  nnfm: [-3000, 3000],
  qam:  [-4900, 4900],
  sal:  [-4900, 0],
  sam:  [-4900, 4900],
  sas:  [-4900, 4900],
  sau:  [0, 4900],
  usb:  [0, 2700],
  usn:  [350, 2350],
};

export class Shell {
  private root: HTMLElement;
  private client: KiwiClient | OpenWebRxClient | RtlTcpClient | null = null;
  private player = new AudioPlayer();
  private spectrum!: SpectrumView;
  private fftAvg!: FftAverager;

  // tunable state
  private mode: Mode = 'lsb';
  private freqKHz = 7200;
  private lowCut = -2700;
  private highCut = 0;
  private vol = 50;          // 0..100
  private sql = 0;            // 0..40 dB above noise floor (0 = off)
  /** GATE — client-side audio noise gate threshold. 0..100 maps to
   *  -100..0 dBFS. 0 = gate off (never mutes). Frame RMS below
   *  threshold mutes the output. Source-agnostic — works on Kiwi
   *  and OWRX. Persisted to localStorage. */
  private gate: number =
    Number.parseInt(localStorage.getItem('radiom.gate') ?? '0', 10) || 0;
  private wfSpeed = loadSettings().wfSpeed;  // 0..4 — Kiwi wf_speed (server averaging), persisted in Settings
  private zoom = 8;   // 32 MHz / 2^8 = 125 kHz visible window (closest to 200 kHz)
  private wfStart = 0;
  /** OpenWebRX-only: centre of the visible waterfall window (kHz). Updated
   *  by OpenWebRxClient via the `owrx_view_center_khz` kv key. Differs
   *  from `freqKHz` so the cursor can move when the dial changes within
   *  the window. Null while the source is Kiwi. */
  private owrxViewCenterKHz: number | null = null;
  /** OpenWebRX-only: full list of (SDR, profile) pairs the active server
   *  advertises. Each item: `{id, name}` where id is "sdr_id|profile_id".
   *  Drives the profile picker (long-press OWX button). */
  private owrxProfiles: Array<{ id: string; name: string }> = [];
  private owrxSelectedProfile: string | null = null;
  private bandwidthHz = 30_000_000;
  private smeterDbm = -120;
  private rxChans: number | null = null;
  private usersOnline: number | null = null;
  private cpuPct: number | null = null;
  private tempC: number | null = null;
  private gpsLocked: boolean | null = null;
  private adcOv: number | null = null;
  private memAvailKB: number | null = null;
  private droppedAudio: number | null = null;
  private droppedWf: number | null = null;
  /** Reserved for future "actual measured fps" indicator. The kiwi
   *  reports it via MSG wf_fps; we no longer surface it in the UI but
   *  the field stays so the bookkeeping in onMessage / disconnect
   *  keeps compiling. */
  // @ts-expect-error -- intentionally tracked for future use, not read now
  private wfFps: number | null = null;
  private wfFpsMax: number | null = null;
  private zoomMax: number | null = null;
  private fwVersion: string | null = null;
  private spectrumSpanKHz: number | null = null;
  /** Latest value seen for every kv key emitted by the Kiwi (no history). */
  private lastKv: Record<string, string> = {};

  // freq entry state
  private pending: string | null = null; // when user is typing digits
  private toggles: Toggles = { fft: true, wf: true, comp: false, adpcm: false, base: false };
  private nbMode = 0;  // 0=off 1=std 2=auto 3=Wild's
  /** Noise-reduction mode. 0=off; 1..3 maps to KiwiSDR's single denoiser
   *  (on/off) and to OpenWebRX's three NR algorithms (wdsp/lms/spec). */
  private nrMode = 0;
  /** Last frequency-nudge step (signed, Hz). Updated whenever any of the
   *  ±10k / ±1k / ±100 / ±10 / ±1 buttons fires, used by SRCH auto-tune. */
  private lastNudgeStepHz: number =
    +(localStorage.getItem('radiom.lastNudgeStepHz') || '') || 100;
  /** Auto-tune timer for the SRCH button. */
  private srchTimer: number | null = null;
  /** SRCH interval in ms (100 → 10 steps/s, 1000 → 1 step/s). */
  private srchIntervalMs: number =
    +(localStorage.getItem('radiom.srchIntervalMs') || '') || 500;
  /** AGC mode cycled by the AGC button: slow → med → fast → off → slow … */
  private agcMode: 'slow' | 'med' | 'fast' | 'off' =
    (localStorage.getItem('radiom.agcMode') as 'slow' | 'med' | 'fast' | 'off') || 'med';
  /** Set while WEFAX is on so we can restore the user's AGC choice when
   *  the fax panel closes. AGC's variable gain wrecks fldigi's absolute
   *  white/black amplitude thresholds, so we force OFF for the duration. */
  private agcSavedForWefax: 'slow' | 'med' | 'fast' | 'off' | null = null;
  /** Manual RF gain (dB, 0..120) used when AGC is OFF. Driven by the
   *  RF knob. Sent to the Kiwi as `manGain=`. Persisted across reloads
   *  so the user's preferred OFF gain survives. */
  private rfGain: number =
    Number.parseInt(localStorage.getItem('radiom.rfGain') ?? '50', 10) || 50;
  /** Voice-tracker boost (dB, 0..18). Drives the peaking-EQ gain in the
   *  player whenever VTRK is on. Persisted so the user's preferred
   *  intensity survives reloads. */
  private vTrackGain: number =
    (() => { const n = parseFloat(localStorage.getItem('radiom.vtg') ?? '9'); return Number.isFinite(n) ? n : 9; })();
  /** Currently-active page-5 IQ visualizer panel, or null. Only one open
   *  at a time; opening any of the 7 closes whichever was active. */
  private iq5Active: 'sfrc' | 'dopp' | 'zoom' | 'antc' | 'ppmc' | 'othr' | 'rfi' | 'wusb' | 'wlsb' | 'dlds' | 'kurt' | null = null;
  private iq5Raf: number | null = null;
  /** SFRC sferic monitor — rolling per-second strike counts. */
  private sfrcCounts: number[] = [];
  private sfrcLastImpulseTs = 0;
  private sfrcRecentMag = 0;
  /** DOPP carrier-tracking PLL state. */
  private doppPhase = 0;
  private doppFreqHz = 0;          // current locked-frequency offset (Hz)
  private doppAlpha = 0.05;        // PLL gain
  private doppHistory: Array<{ t: number; hz: number }> = [];
  /** ZOOM long-FFT ring buffer. */
  private zoomRingI = new Float32Array(32768);
  private zoomRingQ = new Float32Array(32768);
  private zoomRingW = 0;
  private zoomRingFill = 0;
  /** RFI emitter sniffer — catalogue narrow tones detected within the
   *  IQ window over time. Each entry: offset Hz, peak magnitude, last
   *  seen ts. Not persisted — emitters age out of the in-memory list. */
  private rfiCatalogue: Array<{
    hz: number;        // signed offset from dial centre, Hz
    db: number;        // most recent peak magnitude, dB
    seen: number;      // unix-ms last detected
  }> = [];
  private rfiRingI = new Float32Array(4096);
  private rfiRingQ = new Float32Array(4096);
  private rfiRingW = 0;
  private rfiRingFill = 0;
  private rfiLastScan = 0;

  /** DLDS — delay-Doppler scattering function panel.
   *
   *  Computes |A(τ, ν)|² where A is the auto-ambiguity function of the
   *  received IQ stream:
   *      A(τ, ν) = ∫ s(t) · conj(s(t+τ)) · e^(−j2π ν t) dt
   *
   *  Without a known transmit reference we treat the strongest spectral
   *  line in the channel (BFO carrier, time-station tone, beacon) as the
   *  effective reference: multipath echoes show up as ridges at non-zero
   *  delay, and Doppler spread fattens those ridges horizontally. Useful
   *  on WWV/CHU, WSPR, or any AM/CW signal that fills the channel.
   *
   *  Pipeline: 12 kHz IQ → /12 polyphase decimation → 1 kHz complex stream
   *  ring (DLDS_W samples ≈ 2 s). Every render tick we lag-product the
   *  ring with itself for τ = 0..DLDS_LAGS, FFT each lag-product, and
   *  paint a single column heatmap. */
  private readonly dldsRate    = 1000;          // post-decimation Hz
  private readonly dldsDecim   = 12;            // 12 kHz → 1 kHz
  private readonly dldsW       = 2048;          // ring length (≈ 2 s)
  private readonly dldsLags    = 64;             // 0..64 ms delay range
  private readonly dldsFftN    = 1024;           // Doppler resolution
  private readonly dldsDopHalf = 32;             // ±32 Hz visible window
  private dldsRingI = new Float32Array(2048);
  private dldsRingQ = new Float32Array(2048);
  private dldsRingW = 0;
  private dldsRingFill = 0;
  private dldsDecimPhase = 0;
  private dldsDecimAccI = 0;
  private dldsDecimAccQ = 0;
  /** Output 2-D power map: rows = delay (0..lags), cols = doppler bins
   *  (centred at 0). Stored in dB. */
  private dldsMap = new Float32Array(64 * (32 * 2 + 1));
  private dldsMaxDb = 0;
  private dldsLastRender = 0;

  /** KURT — sample kurtosis vs time. For each ~250 ms window of the 12 kHz
   *  IQ stream, compute the excess kurtosis of the magnitude
   *  (|s| = sqrt(I²+Q²)). A reference Rayleigh-distributed magnitude
   *  (i.e. complex Gaussian noise) has |s| kurtosis ≈ 3.245 (excess
   *  ≈ 0.245). Impulsive QRN pushes far above; a strong steady carrier
   *  drags it well below. We log the running history (last 5 minutes)
   *  and plot it as a scrolling line. */
  private readonly kurtWinSamples = 3000;     // 250 ms @ 12 kHz IQ
  private readonly kurtHistMax    = 1200;     // 5 min at 4 Hz update
  private kurtAccN = 0;
  private kurtAccM = 0;        // Σ |s|
  private kurtAccM2 = 0;       // Σ |s|²
  private kurtAccM3 = 0;       // Σ |s|³
  private kurtAccM4 = 0;       // Σ |s|⁴
  private kurtHistory: { t: number; k: number }[] = [];

  /** OTHR chirp-ridge tracker. Streams the 12 kHz IQ into rolling
   *  short-time FFTs (N=128 → 93.75 Hz bins, 10.7 ms frames, ~94 fps),
   *  tracks the brightest bin per frame as the chirp ridge, then derives:
   *    - sweep slope (Hz/s) by linear fit on contiguous ridge segments
   *    - sweep repetition frequency (Hz) by counting "wraps" (large jumps)
   *    - duty-cycle / ridge fill ratio (FMCW vs pulsed vs nothing) */
  private readonly othrFftN = 128;
  private readonly othrFrameRate = 12000 / 128;          // 93.75 fps
  private readonly othrSpecFrames = 256;                  // ~2.7 s history
  private othrInI = new Float32Array(128);
  private othrInQ = new Float32Array(128);
  private othrInFill = 0;
  private othrSpec = new Float32Array(256 * 128);         // magnitudes (dB)
  private othrSpecW = 0;
  private othrSpecFill = 0;
  private othrRidgeBin = new Int16Array(256);             // -1 = no ridge
  private othrRidgeSnr = new Float32Array(256);           // dB above noise floor

  /** WEAK — USB demod with background-noise reduction. Each N=1024
   *  IQ frame is FFT'd; a per-bin noise floor is tracked with
   *  minimum-statistics (snaps to the bin's recent minimum, slowly
   *  relaxes upward), and bins close to that floor are attenuated via
   *  a Wiener-like gain — so steady hiss/static drops away while
   *  transient signals (voice, CW dits, FT8 tones) pass through.
   *  After NR the LSB half is zeroed (USB demod) and iFFT'd; real
   *  part is the audio. */
  private readonly weakFftN = 512;
  private readonly weakHopN = 256;                        // 50% overlap-add
  private weakInI = new Float32Array(512);
  private weakInQ = new Float32Array(512);
  private weakInFill = 0;     // 0..weakHopN — samples since last frame
  private weakOverlap = new Float32Array(512);            // tail of previous iFFT
  private weakSpec = new Float32Array(512);               // last (post-NR) |X| for render
  private weakP        = new Float32Array(512);           // smoothed periodogram |Y|²
  private weakPMin     = new Float32Array(512);           // running per-bin min of P (window-reset)
  private weakAmpPrev  = new Float32Array(512);           // |Â| — clean amplitude, prev frame
  private weakXiSmooth = new Float32Array(512);           // ξ smoothed across bins for the gain
  private weakResetCnt = 0;                                // frames since last min-stats reset
  private weakSide: 'usb' | 'lsb' = 'usb';                // which sideband to keep
  /** Waterfall row-duplication factor (1..4). Persisted in localStorage
   *  so the operator's preference survives reloads. */
  private wfDup: number = (() => {
    const v = +(localStorage.getItem('radiom.wfDup') || '1');
    return Number.isFinite(v) && v >= 1 && v <= 8 ? Math.round(v) : 1;
  })();
  /** Auto-stretch driver. wfAutoMode picks a (low_percentile,
   *  high_percentile) pair: 0=off (manual), 1=AUTO (gentle, all noise
   *  visible), 2=DARK (noise floor pulled below threshold), 3=DARKER
   *  (aggressive — only signals well above noise are bright). */
  private wfAutoMode: number = (() => {
    const v = +(localStorage.getItem('radiom.wfAutoMode') || '0');
    return Number.isFinite(v) && v >= 0 && v <= 3 ? Math.round(v) : 0;
  })();
  private wfHist = new Uint32Array(256);
  private wfHistFrames = 0;
  private wfAutoTimer: number | null = null;

  /** Timestamp of the most-recent audio or waterfall frame from the
   *  Kiwi. Used by the no-data watchdog to surface a banner when the
   *  server stops sending. */
  private lastFrameTs = 0;
  /** Snapshot of the most recent waterfall frame for ECSS carrier-align.
   *  `lastWfBins[i]` is the byte (0..255) for bin (lastWfXBinServer + i).
   *  Cleared on disconnect so a stale buffer can't be aligned to. */
  private lastWfBins: Uint8Array | null = null;
  private lastWfXBinServer = 0;
  private noDataTimer: number | null = null;
  private weakAudioCtx: AudioContext | null = null;
  private weakSp: ScriptProcessorNode | null = null;
  private weakOutQueue: Float32Array[] = [];
  private weakOutPos = 0;


  /** PPMC clock-calibration state — long-running PLL on a known time-
   *  station carrier (the user is expected to tune to one). Each frame
   *  contributes to a running phase-error → freq-offset estimate; the
   *  panel plots the rolling 60-min ppm history. */
  private ppmcPhase = 0;
  private ppmcFreqHz = 0;
  private ppmcAlpha = 0.005;          // very slow loop, >100× slower than DOPP
  private ppmcHistory: Array<{ t: number; ppm: number }> = [];

  /** ANTC anti-carrier PLL state. Locks onto the strongest narrow tone
   *  in a 4096-sample windowed FFT every render tick, then on each IQ
   *  frame mixes that tone down, integrates over the frame, subtracts
   *  the reconstructed waveform, and re-emits the residue through a
   *  dedicated AudioBufferSource into the player's mixer. */
  /** @ts-expect-error written by renderAntc, surfaced for future audio re-injection */
  private antcCarrierHz = 0;          // current locked offset (Hz)
  private antcMagDb = -100;           // most recent peak magnitude
  private antcRingI = new Float32Array(4096);
  private antcRingQ = new Float32Array(4096);
  private antcRingW = 0;
  private antcRingFill = 0;
  /** Auto-notch state (carrier-killer on the speaker path). */
  private antchOn = false;
  private antchTimer: number | null = null;
  /** Last frequency the notch was placed on (for hysteresis — avoids
   *  retuning by < 5 Hz on noisy peak measurements). */
  private antchLastHz = 0;
  /** AMN — adaptive multi-notch (auto-comb). Up to 4 simultaneous
   *  heterodynes are tracked; each gets its own notch biquad in the
   *  player chain. Mutually exclusive with single auto-notch (NT). */
  private amnotchOn = false;
  private amnotchTimer: number | null = null;
  private amnotchLastHzs: number[] = [];
  /** Picker-driven frequency scanner. Each freq picker registers its
   *  list when opened; SCAN long-press starts cycling through the most-
   *  recently-registered list, dwelling 3 s on each entry. Short-tap
   *  pauses / resumes. Only one set is active at a time. */
  private lastFreqSet: { name: string; items: ScanItem[] } | null = null;
  private pickerScanIdx = 0;
  private pickerScanPaused = false;
  private pickerScanRunning = false;
  private pickerScanTimer: number | null = null;
  private get pickerScanDwellMs() { return this.settings.scanIntervalMs; }
  private wfBase = 130; // stretchLo — bytes below this map to dark
  private wfTop = 179;  // stretchHi (70% of 0..255) — bytes at/above this saturate
  // Palette is fixed at "kiwi" — the COLOR toggle button has been removed.
  private palette: PaletteName = 'kiwi';
  private fftLog: boolean = localStorage.getItem('radiom.fftLog') === '1';

  // power
  private powered = false;


  constructor(host: HTMLElement) {
    this.root = host;
    // Restore last session's radio state before render so the LED labels and
    // knob dials show the right values from the first paint.
    this.loadRadioState();
    this.render();
    // Single-picker invariant + waterfall anchoring: whenever a new
    // `.band-modal` is added to the body, (a) remove any others so
    // openings always replace instead of stack, and (b) pin the new
    // modal over the waterfall rect so BAND / BW / and every per-
    // decoder freq picker get the same "fit-in-waterfall, centered or
    // top-aligned" treatment as MODE / DSP / INFO / DISP / DEC{A,B}
    // without each picker function needing to opt in.
    const pickerObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (!n.classList.contains('band-modal')) continue;
          document.querySelectorAll('.band-modal').forEach((other) => {
            if (other !== n) other.remove();
          });
          this.anchorPickerOverWaterfall(n);
        }
      }
    });
    pickerObserver.observe(document.body, { childList: true });
    this.installVizCloseChip();
    this.refreshSourceButtonState();
    this.spectrum = new SpectrumView(
      this.$('fft') as HTMLCanvasElement,
      this.$('wf') as HTMLCanvasElement,
    );
    this.spectrum.setStretch(this.wfBase, this.wfTop);
    if (!PALETTES[this.palette]) this.palette = 'kiwi';
    this.spectrum.setPalette(this.palette);
    this.audioFftLut = buildLUT(PALETTES['green']);
    this.startUtcClock();
    // Show the diag chip immediately with the baseline ("no Kiwi MSG
    // yet") even before the user powers the receiver on.
    this.refreshKiwiDiag();
    // Apply persisted "show large tuning steps row" preference (Display
    // section of Settings). Default is off → the row's inline style is
    // already display:none; show it now if the user previously enabled it.
    const largeRowInit = document.getElementById('freqRowLarge');
    if (largeRowInit && this.settings.showLargeTuningRow) largeRowInit.style.display = '';
    this.spectrum.setLogMode(this.fftLog);
    // The live FFT pane is permanently hidden — skip per-frame trace
    // draws to keep the CPU profile flat at idle.
    this.spectrum.setDrawFftEnabled(false);
    this.spectrum.setFftAveraging(this.settings.fftAveraging);
    this.spectrum.setWfInterpolation(this.settings.wfInterpolate);
    this.spectrum.setWfDup(this.wfDup);
    // Time-windowed averaged-FFT strip — same palette + stretch as the
    // waterfall, default 5-second window.
    this.fftAvg = new FftAverager(this.$('fftAvg') as HTMLCanvasElement, this.palette);
    this.fftAvg.setStretch(this.wfBase, this.wfTop);
    this.fftAvg.setAvgSeconds(+(this.$('fftAvgSel') as HTMLSelectElement).value);
    (this.$('fftAvgSel') as HTMLSelectElement).addEventListener('change', (e) => {
      const s = +(e.target as HTMLSelectElement).value;
      this.fftAvg.setAvgSeconds(s);
    });
    this.bind();
    this.refresh();
    this.applyWhisper();

    // PWA install prompt — show the menu's "Install" entry only when
    // the browser tells us the app is installable.
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvent = e;
      const m = this.$('menu') as HTMLButtonElement;
      m.classList.add('installable');
    });
    window.addEventListener('appinstalled', () => {
      this.installEvent = null;
      const m = this.$('menu') as HTMLButtonElement;
      m.classList.remove('installable');
      this.banner('App installed', 1500);
    });
  }

  private $(id: string): HTMLElement { return this.root.querySelector('#' + id) as HTMLElement; }
  private $$(sel: string): NodeListOf<HTMLElement> { return this.root.querySelectorAll(sel); }

  /* ───────────── render ───────────── */

  private render() {
    this.root.innerHTML = `
      <header class="topbar">
        <button id="menu" class="menu">☰</button>
        <button id="help" class="menu" aria-label="decoder help" title="Help · all buttons / knobs reference">?</button>
        <button id="kiwiPicker" class="kpbtn source-btn" title="KiwiSDR — switch source and open the KiwiSDR server picker (mutually exclusive with OpenWebRx / RTL)" aria-label="KiwiSDR source">KiwiSDR</button>
        <button id="owrxPicker" class="kpbtn source-btn" title="OpenWebRx — switch source and open the OpenWebRx server picker (mutually exclusive with KiwiSDR / RTL)" aria-label="OpenWebRx source">OpenWebRx</button>
        <button id="rtlPicker"  class="kpbtn source-btn" title="rtl_tcp — switch source and open the rtl_tcp server picker. Connects to a remote RTL-SDR USB receiver over TCP, decimates IQ server-side, streams to the browser" aria-label="rtl_tcp source">RTL</button>
        <!-- Hidden: still used internally to hold the host:port string. -->
        <input id="server" class="server" style="display:none" value="${escapeAttr(localStorage.getItem('radiom.lastServer') || '')}" placeholder="host:port" spellcheck="false" readonly />
        <span id="connDot" class="conn-dot" data-state="off" aria-label="connection status"></span>
        <button id="power" class="power" aria-label="power" title="Power — short tap to (re)connect / disconnect the Kiwi. Long-press: hard off (closes every decoder panel and suspends the AudioContext)">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 3v9" />
            <path d="M5.6 7.5a8 8 0 1 0 12.8 0" />
          </svg>
        </button>
      </header>
      <main>
        <div class="led">
          <div class="led-status">
            <span class="led-dot"></span>
            <span id="lblMode">LSB</span>
            <span id="lblBand">40M</span>
            <span id="lblAgc">AGC MED</span>
            <span id="lblFps">FPS 13/23</span>
            <span id="lblNb2"></span>
            <span id="lblNr2"></span>
            <span id="lblNb"></span>
            <span id="lblNr"></span>
          </div>
          <div class="led-freq-row">
            <span id="ledUtc" class="led-utc" title="UTC time">--:--:--</span>
            <div id="ledFreq" class="led-freq">7200.000</div>
          </div>
          <div class="led-sub">
            <span id="lblVol">Vol 50%</span>
            <span id="lblSql">SQL 0 dB</span>
            <span id="lblLo">Lo -2700 Hz</span>
            <span id="lblHi">Hi -300 Hz</span>
            <span id="lblUsers" class="led-users"></span>
          </div>
          <div id="ledStats" class="led-stats"></div>
          <div id="kiwiDiag" class="led-diag" title="KiwiSDR connection diagnostic — decoded from the last MSG keys and the most recent WebSocket close reason."></div>
        </div>

        <div class="spectrum-wrap">
          <!-- Live FFT pane is hidden but kept in the DOM so SpectrumView
               keeps a valid canvas to attach to (the waterfall path
               sources the same FFT bins). FFT draws are skipped via
               setDrawFftEnabled(false). -->
          <div class="fft-wrap" style="display:none">
            <canvas id="fft" class="fft"></canvas>
            <div id="fftCursor" class="wf-cursor"></div>
            <div id="fftFreqLo" class="fft-freq-label fft-freq-lo"></div>
            <div id="fftFreqHi" class="fft-freq-label fft-freq-hi"></div>
          </div>
          <!-- FAXS station-bars overlay sits on top of the waterfall when
               the scan is running — moved out of the hidden .fft-wrap so
               the centre-row station name stays visible. -->
          <canvas id="faxScanBars" class="fax-scan-bars" style="display:none"></canvas>
          <div id="banner" class="banner"></div>

          <div class="fft-avg-wrap">
            <canvas id="fftAvg" class="fft-avg"></canvas>
            <select id="fftAvgSel" class="fft-avg-sel" aria-label="averaging window">
              <option value="1">1 s</option>
              <option value="5" selected>5 s</option>
              <option value="15">15 s</option>
              <option value="30">30 s</option>
              <option value="60">1 min</option>
              <option value="300">5 min</option>
              <option value="900">15 min</option>
            </select>
          </div>

          <div class="wf-wrap">
            <canvas id="wf" class="wf"></canvas>
            <div id="wfCursor" class="wf-cursor"></div>
            <div id="sigMarkerL" class="sig-marker sig-marker-l" style="display:none"></div>
            <div id="sigBwLabel" class="sig-bw-label" style="display:none"></div>
            <div id="wfFreqLo" class="wf-freq-label wf-freq-lo"></div>
            <div id="wfFreqHi" class="wf-freq-label wf-freq-hi"></div>
            <div class="wf-tools wf-tools-l">
              <button id="btnSigFc" class="knob-mini active" type="button" title="FC — master toggle for waterfall cursors. When active (default), the F (tuning) and F2 cursors are shown on the waterfall; when off, both are hidden.">FC</button>
              <button id="btnSigL" class="knob-mini" type="button" title="F2 — secondary frequency cursor. Tap to snap F2 to the current F (tuning) frequency; long-press to hide. The BW readout shows |F − F2|.">F2</button>
            </div>
            <div class="wf-tools wf-tools-r">
              <button id="btnCloseViz" class="knob-mini" type="button" style="display:none" title="Close active visualizer panel (SCOP / FMNT / OTHR / …)">×</button>
              <button id="btnSpeed" class="knob-mini" type="button" data-cmd="speedBtn" data-help-label="FPS" title="KiwiSDR waterfall frame-rate-code: 0=no waterfall, 1: 1 FPS, 2: 5 FPS, 3: 13 FPS, 4: 23 FPS.">FPS</button>
              <button id="btnWfDup" class="knob-mini" type="button" title="Waterfall row duplication (1..8)">WF1</button>
              <button id="btnWfAuto" class="knob-mini" type="button" data-help-label="AUTO/DARK/DARK+" title="Auto-stretch LoW/HiW from rolling histogram">AUTO</button>
            </div>
            <button id="wfChevL" class="wf-chev wf-chev-l" type="button" style="display:none"
                    aria-label="recenter on tuned freq (off-screen left)"></button>
            <button id="wfChevR" class="wf-chev wf-chev-r" type="button" style="display:none"
                    aria-label="recenter on tuned freq (off-screen right)"></button>
            <div id="scanLabel" class="scan-label" style="display:none"></div>
            <div id="noDataLabel" class="no-data-label" style="display:none">No data from the server</div>
          </div>

          <canvas id="audioFft" class="audio-fft" style="display:none"></canvas>
          <div id="audioFftLabel" class="audio-fft-label" style="display:none"></div>
          <button id="audioFftLabelLo" type="button" class="audio-fft-label audio-fft-label-lo" style="display:none"></button>
          <button id="audioFftLabelHi" type="button" class="audio-fft-label audio-fft-label-hi" style="display:none"></button>
          <button id="audioFftExt" class="audio-fft-ext-btn" type="button" style="display:none">ext</button>
          <button id="audioFftAuto" class="audio-fft-auto-btn" type="button" style="display:none" title="AUTO — toggle continuous histogram-based optimization of the spectrogram min / max (5th / 99th percentile, EMA-smoothed). Enabled by default.">AUTO</button>
          <div id="audioFftContrast" class="audio-fft-contrast" style="display:none">
            <button class="transcript-btn" id="audioFftMinus" type="button">−</button>
            <span id="audioFftContrastVal">C 2.0</span>
            <button class="transcript-btn" id="audioFftPlus" type="button">+</button>
          </div>
          <div id="pitchBar" class="pitch-bar" style="display:none">
            <button class="pitch-btn" id="btnPitchMinus" type="button" aria-label="cursor -1 Hz">−</button>
            <button class="pitch-btn" id="btnPitchSet" type="button" aria-label="set audio_freq_cursor">set</button>
            <button class="pitch-btn" id="btnPitchPlus" type="button" aria-label="cursor +1 Hz">+</button>
          </div>

          <div id="cwPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="cwCopy"  type="button">copy</button>
              <button class="transcript-btn" id="cwClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="cwStatus">CW listening…</div>
            <div class="ft8-lines cw-text" id="cwText"></div>
          </div>

          <div id="rttyPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="rttyCopy" type="button">copy</button>
              <button class="transcript-btn" id="rttyClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="rttyStatus">RTTY listening…</div>
            <div class="ft8-lines cw-text" id="rttyText"></div>
          </div>

          <div id="navtexPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="navtexCopy"  type="button">copy</button>
              <button class="transcript-btn" id="navtexClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="navtexStatus">NAVTEX listening…</div>
            <div class="ft8-lines cw-text" id="navtexText"></div>
          </div>

          <div id="packetPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="packetCopy"  type="button">copy</button>
              <button class="transcript-btn" id="packetClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="packetStatus">PACKET listening…</div>
            <div class="ft8-lines cw-text" id="packetText"></div>
          </div>

          <div id="wsprPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="wsprCopy"  type="button">copy</button>
              <button class="transcript-btn" id="wsprClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="wsprStatus">WSPR listening…</div>
            <div class="ft8-lines cw-text" id="wsprText"></div>
          </div>

          <div id="aiPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="aiScribe" type="button" title="Analyse the current SCRIBE transcript with OpenAI's flagship reasoning model">scribe</button>
              <button class="transcript-btn" id="aiSid"    type="button" title="Submit the most recent SID DSP measurement report to OpenAI's flagship model — get plain-language explanations of the measurements and a ranked list of candidate HF digital modes. Run SID first to capture a report.">sid</button>
              <button class="transcript-btn" id="aiCopy"   type="button">copy</button>
              <button class="transcript-btn" id="aiClear"  type="button">clear</button>
            </div>
            <div class="ft8-status" id="aiStatus"></div>
            <div class="ft8-lines cw-text" id="aiText"></div>
          </div>

          <div id="memPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="memAdd"    type="button" title="Append the current frequency / mode / passband to the log">+ add</button>
              <input  class="mem-search"     id="memSearch" type="search"   placeholder="search freq or notes…" spellcheck="false" />
              <button class="transcript-btn" id="memExport" type="button" title="Copy the entire log as JSON to the clipboard">export</button>
              <button class="transcript-btn" id="memImport" type="button" title="Replace the log from a JSON paste">import</button>
            </div>
            <div class="ft8-status" id="memStatus">0 entries</div>
            <div class="ft8-lines mem-list" id="memList"></div>
          </div>
          <div id="wspr15Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="wspr15Copy"  type="button">copy</button>
              <button class="transcript-btn" id="wspr15Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="wspr15Status">WSPR-15 listening…</div>
            <div class="ft8-lines cw-text" id="wspr15Text"></div>
          </div>
          <div id="jt9Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="jt9Copy"  type="button">copy</button>
              <button class="transcript-btn" id="jt9Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="jt9Status">JT9 listening…</div>
            <div class="ft8-lines cw-text" id="jt9Text"></div>
          </div>
          <div id="jt65Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="jt65Copy"  type="button">copy</button>
              <button class="transcript-btn" id="jt65Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="jt65Status">JT65 listening…</div>
            <div class="ft8-lines cw-text" id="jt65Text"></div>
          </div>
          <div id="q65Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="q65Copy"  type="button">copy</button>
              <button class="transcript-btn" id="q65Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="q65Status">Q65 listening…</div>
            <div class="ft8-lines cw-text" id="q65Text"></div>
          </div>
          <div id="fst4wPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="fst4wCopy"  type="button">copy</button>
              <button class="transcript-btn" id="fst4wClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="fst4wStatus">FST4W listening…</div>
            <div class="ft8-lines cw-text" id="fst4wText"></div>
          </div>
          <div id="stanagPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="stanagClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="stanagStatus">STANAG 4285 — waiting for first second of audio…</div>
            <div class="ft8-lines cw-text" id="stanagText"></div>
          </div>
          <div id="stanag4539Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="stanag4539Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="stanag4539Status">STANAG 4539 — waiting for 1.5 s of audio…</div>
            <div class="ft8-lines cw-text" id="stanag4539Text"></div>
          </div>
          <div id="hellPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="hellClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="hellStatus">Feld-Hellschreiber — tune carrier to ~1000 Hz audio</div>
            <canvas id="hellCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="sstvPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="sstvSave"  type="button" title="Download the latest SSTV image as PNG">save</button>
              <button class="transcript-btn" id="sstvClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="sstvStatus">SSTV — waiting for VIS code (tune to 14.230 MHz USB, 7.171 / 28.680 / …)</div>
            <img id="sstvImage" style="width:100%;max-height:80%;object-fit:contain;background:#111;display:block;border-radius:4px;flex:1" alt="latest SSTV image" />
          </div>
          <div id="freedvPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="freedvMode1600" type="button" title="FreeDV 1600 — classic mode, 1300 bps Codec2 in 1250 Hz OFDM">1600</button>
              <button class="transcript-btn" id="freedvMode700C" type="button" title="FreeDV 700C — older 700-bps mode (deprecated but still on the bands)">700C</button>
              <button class="transcript-btn" id="freedvMode700D" type="button" title="FreeDV 700D — modern low-SNR mode (~-4 dB)">700D</button>
              <button class="transcript-btn" id="freedvMode700E" type="button" title="FreeDV 700E — 700D variant tuned for fast fading">700E</button>
              <button class="transcript-btn" id="freedvMode2020" type="button" title="FreeDV 2020 — LPCNet 2020 bps. Requires codec2 to be built with LPCNet support; default builds omit it and will exit with 'invalid mode'.">2020</button>
            </div>
            <div class="ft8-status" id="freedvStatus">FreeDV — tune to 14.236 MHz USB and pick a mode</div>
            <div class="ft8-lines cw-text" id="freedvLog"></div>
          </div>
          <div id="jt4Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="jt4Copy"  type="button">copy</button>
              <button class="transcript-btn" id="jt4Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="jt4Status">JT4 listening…</div>
            <div class="ft8-lines cw-text" id="jt4Text"></div>
          </div>
          <div id="pocsPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="pocsCopy"  type="button">copy</button>
              <button class="transcript-btn" id="pocsClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="pocsStatus">POCSAG listening… (tune a pager channel; needs multimon-ng binary built via npm run build:selcal)</div>
            <div class="ft8-lines cw-text" id="pocsText"></div>
          </div>

          <div id="vendoredPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="vendoredCopy"  type="button">copy</button>
              <button class="transcript-btn" id="vendoredClear" type="button">clear</button>
              <button class="transcript-btn" id="vendoredImgSave" type="button" style="display:none">save image</button>
            </div>
            <div class="ft8-status" id="vendoredStatus">vendored-decoder listening…</div>
            <img id="vendoredImg" style="display:none;max-width:100%;max-height:50%;align-self:center;border-radius:4px" alt="decoded image" />
            <div class="ft8-lines cw-text" id="vendoredText"></div>
          </div>

          <div id="multimonPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="multimonCopy"  type="button">copy</button>
              <button class="transcript-btn" id="multimonClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="multimonStatus">multimon-ng listening… (needs binary built via npm run build:selcal)</div>
            <div class="ft8-lines cw-text" id="multimonText"></div>
          </div>

          <div id="dsdPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="dsdCopy"  type="button">copy</button>
              <button class="transcript-btn" id="dsdClear" type="button">clear</button>
              <button class="transcript-btn" id="dsdVolDown" type="button" title="Decrease DSD voice level">vol −</button>
              <span class="ft8-status" id="dsdVolVal" style="display:inline-block;min-width:42px;text-align:center">1.8×</span>
              <button class="transcript-btn" id="dsdVolUp"   type="button" title="Increase DSD voice level">vol +</button>
            </div>
            <div class="ft8-status" id="dsdStatus">DSD listening… (needs dsd-fme binary built via npm run build:dsd)</div>
            <div class="ft8-lines cw-text" id="dsdText"></div>
          </div>

          <div id="selcalPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="selcalCopy"  type="button">copy</button>
              <button class="transcript-btn" id="selcalClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="selcalStatus">SELCAL listening… (tune an HF aero channel — 8.891 / 5.598 / 11.336 / 13.306 MHz USB)</div>
            <div class="ft8-lines cw-text" id="selcalText"></div>
          </div>
          <div id="throbPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="throbMode1"  type="button" title="Throb 1 — 1 baud per character, narrow & robust">T1</button>
              <button class="transcript-btn" id="throbMode2"  type="button" title="Throb 2 — 2 baud, mid-speed">T2</button>
              <button class="transcript-btn" id="throbMode4"  type="button" title="Throb 4 — 4 baud, fastest base Throb">T4</button>
              <button class="transcript-btn" id="throbModeX1" type="button" title="ThrobX 1 — Throb 1 + inner FEC">X1</button>
              <button class="transcript-btn" id="throbModeX2" type="button" title="ThrobX 2 — Throb 2 + inner FEC">X2</button>
              <button class="transcript-btn" id="throbModeX4" type="button" title="ThrobX 4 — Throb 4 + inner FEC">X4</button>
              <button class="transcript-btn" id="throbCopy"   type="button">copy</button>
              <button class="transcript-btn" id="throbClear"  type="button">clear</button>
            </div>
            <div class="ft8-status" id="throbStatus">Throb — 9-tone PPM. Tune carrier ~1000 Hz audio offset</div>
            <div class="ft8-lines cw-text" id="throbText"></div>
          </div>
          <div id="js8Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="js8Copy"  type="button">copy</button>
              <button class="transcript-btn" id="js8Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="js8Status">JS8 listening…</div>
            <div class="ft8-lines cw-text" id="js8Text"></div>
          </div>
          <div id="fst4Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="fst4Copy"  type="button">copy</button>
              <button class="transcript-btn" id="fst4Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="fst4Status">FST4 listening…</div>
            <div class="ft8-lines cw-text" id="fst4Text"></div>
          </div>

          <div id="scopePanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="scopePolarity" type="button" title="Trigger polarity">↑</button>
              <input  class="scope-level" id="scopeLevel" type="range" min="-100" max="100" value="0" step="1" title="Trigger level" />
              <span   class="scope-level-readout" id="scopeLevelVal">0.00</span>
            </div>
            <div class="ft8-status" id="scopeStatus">SCOPE — trigger ↑ @ 0.00</div>
            <canvas id="scopeCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>

          <div id="thdPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="thdStatus">Audio FFT —</div>
            <canvas id="thdCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>

          <div id="qrssPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="qrssMode3"  type="button" title="QRSS3 — 3 s per Morse dot (fast scroll, ~0.25 s/col)">Q3</button>
              <button class="transcript-btn" id="qrssMode10" type="button" title="QRSS10 — 10 s per dot (~1 s/col)">Q10</button>
              <button class="transcript-btn" id="qrssMode30" type="button" title="QRSS30 — 30 s per dot (~3 s/col)">Q30</button>
              <button class="transcript-btn" id="qrssMode60" type="button" title="QRSS60 — 60 s per dot (~6 s/col)">Q60</button>
              <button class="transcript-btn" id="qrssMode120" type="button" title="QRSS120 — 120 s per dot (~12 s/col). Glacial scroll for LF/MF beacon hunting under heavy noise">Q120</button>
              <button class="transcript-btn" id="qrssDfcw"   type="button" title="DFCW — Dual-Frequency CW. Narrow ~100 Hz display centred on the strongest signal with dit / dah reference markers 5 Hz apart">DFCW</button>
              <button class="transcript-btn" id="qrssClear"  type="button" title="Wipe the grabber canvas">clear</button>
            </div>
            <div class="ft8-status" id="qrssStatus">QRSS10 — 0.73 Hz/bin · 400–1200 Hz</div>
            <canvas id="qrssCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>

          <div id="grayPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="grayStatus">GRAY-LINE</div>
            <canvas id="grayCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>

          <div id="vectPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <input  class="scope-level" id="vectDelay" type="range" min="1" max="120" value="36" step="1" title="Lissajous delay (samples)" />
              <span   class="scope-level-readout" id="vectDelayVal">36</span>
            </div>
            <div class="ft8-status" id="vectStatus">VECTOR — delay 36 samp · 3.0 ms</div>
            <canvas id="vectCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>

          <!-- Page-5 IQ visualizer panels. All require mode='iq'. -->
          <div id="sfrcPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="sfrcCopy" type="button">copy</button>
            </div>
            <div class="ft8-status" id="sfrcStatus">SFRC — sferic monitor (lightning impulses)</div>
            <canvas id="sfrcCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="doppPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="doppCopy" type="button">copy</button>
            </div>
            <div class="ft8-status" id="doppStatus">DOPP — carrier Doppler vs time</div>
            <canvas id="doppCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="zoomPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="zoomStatus">ZOOM — sub-Hz spectrogram</div>
            <canvas id="zoomCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="antcPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="antcStatus">ANTC — coherent anti-carrier (PLL nulls strongest tone)</div>
            <canvas id="antcCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="ppmcPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="ppmcStatus">PPMC — clock self-calibration via time-station carrier</div>
            <canvas id="ppmcCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="othrPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="othrStatus">OTHR — over-the-horizon radar / chirp classifier</div>
            <canvas id="othrCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="dldsPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="dldsStatus">DLDS — delay-Doppler scattering function</div>
            <canvas id="dldsCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="kurtPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="kurtStatus">KURT — sample kurtosis vs time</div>
            <canvas id="kurtCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="rfiPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="rfiCopy" type="button">copy</button>
            </div>
            <div class="ft8-status" id="rfiStatus">RFI — narrow-carrier emitter sniffer</div>
            <canvas id="rfiCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="wusbPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="wusbStatus">WUSB — USB demod with background-noise reduction</div>
            <canvas id="wusbCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>
          <div id="wlsbPanel" class="ft8-panel" style="display:none">
            <div class="ft8-status" id="wlsbStatus">WLSB — LSB demod with background-noise reduction</div>
            <canvas id="wlsbCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>

          <div id="eyePanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <select class="iq-clock-baud" id="eyeBaud" title="Symbol rate (baud)">
                <option value="31.25">31.25 (PSK31)</option>
                <option value="62.5">62.5 (PSK63)</option>
                <option value="125">125 (PSK125)</option>
                <option value="250">250 (PSK250)</option>
                <option value="500">500 (PSK500)</option>
                <option value="45.45">45.45 (RTTY-45)</option>
                <option value="50">50 (RTTY-50)</option>
                <option value="100">100 (NAVTEX)</option>
                <option value="200">200</option>
              </select>
            </div>
            <div class="ft8-status" id="eyeStatus">EYE — 31.25 bd · 384 sps</div>
            <canvas id="eyeCanvas" style="width:100%;height:100%;background:#000;display:block;border-radius:4px;flex:1"></canvas>
          </div>

          <div id="alePanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="aleCopy"  type="button">copy</button>
              <button class="transcript-btn" id="aleClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="aleStatus">ALE listening…</div>
            <div class="ft8-lines cw-text" id="aleText"></div>
          </div>

          <div id="hfdlPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="hfdlCopy"  type="button">copy</button>
              <button class="transcript-btn" id="hfdlClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="hfdlStatus">HFDL listening…</div>
            <div class="ft8-lines cw-text" id="hfdlText"></div>
          </div>

          <div id="iqViewPanel" class="ft8-panel cw-panel iq-view-panel" style="display:none">
            <div class="ft8-status" id="iqViewStatus">IQ constellation</div>
            <canvas id="iqViewCanvas" width="320" height="320"
                    style="display:block;margin:8px auto;background:#000;border:1px solid var(--border);max-width:100%;max-height:calc(100% - 32px);width:auto;height:auto;aspect-ratio:1/1;align-self:center;flex:0 1 auto;min-height:0"></canvas>
            <div class="ft8-actions iq-view-actions">
              <button class="transcript-btn" id="iqClockBtn" type="button" title="Symbol-rate clock recovery (Mueller–Müller)">CLK</button>
              <select class="iq-clock-baud" id="iqClockBaud" title="Symbol rate (baud)">
                <option value="0">AUTO (Oerder-Meyr)</option>
                <option value="31.25">31.25 (PSK31)</option>
                <option value="62.5">62.5 (PSK63)</option>
                <option value="125">125 (PSK125)</option>
                <option value="250">250 (PSK250)</option>
                <option value="500">500 (PSK500)</option>
                <option value="45.45">45.45 (RTTY-45)</option>
                <option value="50">50 (RTTY-50)</option>
                <option value="100">100 (NAVTEX)</option>
                <option value="200">200</option>
              </select>
              <button class="transcript-btn" id="iqViewExt" type="button">ext</button>
            </div>
          </div>

          <div id="aconPanel" class="ft8-panel cw-panel acon-panel" style="display:none">
            <div class="ft8-status" id="aconStatus">Audio constellation</div>
            <canvas id="aconCanvas" width="320" height="320"
                    style="display:block;margin:8px auto;background:#000;border:1px solid var(--border);max-width:100%;max-height:calc(100% - 32px);width:auto;height:auto;aspect-ratio:1/1;align-self:center;flex:0 1 auto;min-height:0"></canvas>
            <div class="ft8-actions acon-actions">
              <select class="acon-preset" id="aconPreset" title="Pick a modulation preset — sets BW and LOCK for the chosen mode. f₀ stays where you have it.">
                <option value="custom">Custom</option>
                <optgroup label="BPSK">
                  <option value="psk31">PSK31</option>
                  <option value="psk63">PSK63</option>
                  <option value="psk125">PSK125</option>
                  <option value="psk250">PSK250</option>
                  <option value="psk500">PSK500</option>
                  <option value="psk1000">PSK1000</option>
                  <option value="hfdl">HFDL</option>
                </optgroup>
                <optgroup label="QPSK">
                  <option value="qpsk31">QPSK31</option>
                  <option value="qpsk63">QPSK63</option>
                  <option value="qpsk125">QPSK125</option>
                  <option value="qpsk250">QPSK250</option>
                  <option value="qpsk500">QPSK500</option>
                </optgroup>
                <optgroup label="8-PSK">
                  <option value="8psk125">8PSK125</option>
                  <option value="8psk250">8PSK250</option>
                  <option value="8psk500">8PSK500</option>
                  <option value="8psk1000">8PSK1000</option>
                </optgroup>
                <optgroup label="FSK">
                  <option value="rtty45-170">RTTY-45 / 170 Hz</option>
                  <option value="rtty75-170">RTTY-75 / 170 Hz</option>
                  <option value="rtty100-170">RTTY-100 / 170 Hz</option>
                  <option value="rtty45-850">RTTY-45 / 850 Hz</option>
                  <option value="navtex">NAVTEX / SITOR</option>
                  <option value="pocsag1200">POCSAG 1200</option>
                </optgroup>
                <optgroup label="MFSK">
                  <option value="mfsk16">MFSK16</option>
                  <option value="mfsk32">MFSK32</option>
                  <option value="mfsk64">MFSK64</option>
                </optgroup>
                <optgroup label="Olivia">
                  <option value="olivia8-500">Olivia 8/500</option>
                  <option value="olivia16-1000">Olivia 16/1000</option>
                  <option value="olivia32-1000">Olivia 32/1000</option>
                </optgroup>
                <optgroup label="OFDM">
                  <option value="mt63-500">MT63-500</option>
                  <option value="mt63-1000">MT63-1000</option>
                  <option value="mt63-2000">MT63-2000</option>
                </optgroup>
                <optgroup label="AM">
                  <option value="am-tone">AM carrier</option>
                </optgroup>
              </select>
              <button class="transcript-btn" id="aconLockBtn" type="button"
                      title="LOCK — BPSK Costas loop. Polishes off the residual frequency / phase offset so the constellation stops tilting and per-loop rotation goes away.">LOCK</button>
              <span class="acon-label">f₀</span>
              <input  class="acon-input" id="aconCenter" type="number"
                      min="0" max="5500" step="50" value="1500"
                      title="Audio carrier frequency (Hz). Set to the audio tone of the signal you want to view.">
              <span class="acon-label">BW</span>
              <input  class="acon-input" id="aconBw" type="number"
                      min="50" max="5000" step="50" value="500"
                      title="Post-mix LPF bandwidth (Hz). Roughly 2× the symbol rate.">
              <button class="transcript-btn" id="aconExt" type="button">ext</button>
            </div>
          </div>

          <div id="sPlotPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-status" id="sPlotStatus">S-meter — last 60 s</div>
            <div class="ft8-actions">
              <button class="transcript-btn" id="sPlotCopy" type="button">copy</button>
            </div>
            <div style="flex:1 1 0;min-height:0;display:flex;padding:8px 0">
              <canvas id="sPlotCanvas" width="640" height="180"
                      style="display:block;background:#000;border:1px solid var(--border);width:100%;height:100%"></canvas>
            </div>
          </div>

          <div id="fmntPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-status" id="fmntStatus">FMNT — voice formant tracker (F1/F2/F3 vs time)</div>
            <div style="flex:1 1 0;min-height:0;display:flex;padding:8px 0">
              <canvas id="fmntCanvas" width="640" height="240"
                      style="display:block;background:#000;border:1px solid var(--border);width:100%;height:100%"></canvas>
            </div>
          </div>

          <div id="sDialPanel" class="ft8-panel cw-panel" style="display:none">
            <canvas id="sDialCanvas" width="640" height="320"
                    style="display:block;margin:8px auto;background:#000;border:1px solid var(--border);max-width:100%;height:auto;width:100%"></canvas>
          </div>

          <div id="driftPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-status" id="driftStatus">Carrier drift — listening…</div>
            <div class="ft8-actions">
              <button class="transcript-btn" id="driftCopy" type="button">copy</button>
            </div>
            <div style="flex:1 1 0;min-height:0;display:flex;padding:8px 0">
              <canvas id="driftCanvas" width="640" height="200"
                      style="display:block;background:#000;border:1px solid var(--border);width:100%;height:100%"></canvas>
            </div>
          </div>

          <div id="sitorPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="sitorCopy"  type="button">copy</button>
              <button class="transcript-btn" id="sitorClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="sitorStatus">SITOR-B listening…</div>
            <div class="ft8-lines cw-text" id="sitorText"></div>
          </div>

          <div id="wwvPanel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="wwvZoom" type="button">zoom</button>
            </div>
            <div class="ft8-status" id="wwvStatus">WWV listening…</div>
            <canvas id="wwvCanvas" style="width:100%;height:240px;background:#000;display:block;border-radius:4px"></canvas>
          </div>

          <div id="autoPanel" class="auto-panel" style="display:none">
            <div class="ft8-status" id="autoStatus">AUTO classifier idle</div>
            <div class="ft8-lines cw-text" id="autoText"></div>
          </div>

          <div id="pskPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="pskCopy" type="button">copy</button>
              <button class="transcript-btn" id="pskClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="pskStatus">PSK31 listening…</div>
            <div class="ft8-lines cw-text" id="pskText"></div>
          </div>

          <div id="psk31bPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="psk31bCopy"  type="button">copy</button>
              <button class="transcript-btn" id="psk31bClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="psk31bStatus">PSK31B listening…</div>
            <div class="ft8-lines cw-text" id="psk31bText"></div>
          </div>

          <div id="oliviaPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="oliviaCopy" type="button">copy</button>
              <button class="transcript-btn" id="oliviaClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="oliviaStatus">OLIVIA listening…</div>
            <div class="ft8-lines cw-text" id="oliviaText"></div>
          </div>

          <div id="mfskPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="mfskCopy"  type="button">copy</button>
              <button class="transcript-btn" id="mfskClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="mfskStatus">MFSK listening…</div>
            <div class="ft8-lines cw-text" id="mfskText"></div>
          </div>

          <div id="mt63Panel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="mt63Copy"  type="button">copy</button>
              <button class="transcript-btn" id="mt63Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="mt63Status">MT63 listening…</div>
            <div class="ft8-lines cw-text" id="mt63Text"></div>
          </div>

          <div id="fsqPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="fsqCopy"  type="button">copy</button>
              <button class="transcript-btn" id="fsqClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="fsqStatus">FSQ listening…</div>
            <div class="ft8-lines cw-text" id="fsqText"></div>
          </div>

          <div id="thorPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="thorCopy"  type="button">copy</button>
              <button class="transcript-btn" id="thorClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="thorStatus">THOR listening…</div>
            <div class="ft8-lines cw-text" id="thorText"></div>
          </div>

          <div id="dominoexPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="dominoexCopy"  type="button">copy</button>
              <button class="transcript-btn" id="dominoexClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="dominoexStatus">DominoEX listening…</div>
            <div class="ft8-lines cw-text" id="dominoexText"></div>
          </div>

          <div id="contestiaPanel" class="ft8-panel cw-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="contestiaCopy"  type="button">copy</button>
              <button class="transcript-btn" id="contestiaClear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="contestiaStatus">Contestia listening…</div>
            <div class="ft8-lines cw-text" id="contestiaText"></div>
          </div>

          <div id="wefaxPanel" class="ft8-panel wefax-panel" style="display:none">
            <div class="ft8-status" id="wefaxStatus">WEFAX idle</div>
            <div class="wefax-canvas-wrap">
              <canvas id="wefaxCanvas" class="wefax-canvas"></canvas>
              <div class="wefax-actions-overlay">
                <button class="transcript-btn" id="wefaxExt"   type="button">ext</button>
                <button class="transcript-btn" id="wefaxClear" type="button">clear</button>
                <button class="transcript-btn" id="wefaxSave"  type="button">save</button>
              </div>
            </div>
          </div>

          <div id="ft8Panel" class="ft8-panel" style="display:none">
            <div class="ft8-actions">
              <button class="transcript-btn" id="ft8Copy" type="button">copy</button>
              <button class="transcript-btn" id="ft8Clear" type="button">clear</button>
            </div>
            <div class="ft8-status" id="ft8Status">FT8 idle</div>
            <div class="ft8-lines" id="ft8Lines"></div>
          </div>

          <div id="transcript" class="transcript" style="display:none">
            <div class="transcript-actions">
              <button class="transcript-btn" id="transcriptCopy" type="button">copy</button>
              <button class="transcript-btn" id="transcriptClear" type="button">clear</button>
            </div>
            <div class="transcript-status" id="transcriptStatus">…</div>
            <div class="transcript-lines" id="transcriptLines"></div>
          </div>
        </div>

        <div class="freq-row kprow" id="freqRowLarge" style="display:none">
          <button class="kpbtn c" data-cmd="f-50000"   title="Tune −50 kHz">-50k</button>
          <button class="kpbtn c" data-cmd="f+50000"   title="Tune +50 kHz">+50k</button>
          <button class="kpbtn c" data-cmd="f-25000"   title="Tune −25 kHz">-25k</button>
          <button class="kpbtn c" data-cmd="f+25000"   title="Tune +25 kHz">+25k</button>
          <button class="kpbtn c" data-cmd="f-12500"   title="Tune −12.5 kHz">-12.5k</button>
          <button class="kpbtn c" data-cmd="f+12500"   title="Tune +12.5 kHz">+12.5k</button>
        </div>

        <div class="freq-row kprow">
          <button class="kpbtn c" data-cmd="f-10000" title="Tune −10 kHz">-10k</button>
          <button class="kpbtn c" data-cmd="f+10000" title="Tune +10 kHz">+10k</button>
          <button class="kpbtn c" data-cmd="f-5000" title="Tune −5 kHz">-5k</button>
          <button class="kpbtn c" data-cmd="f+5000" title="Tune +5 kHz">+5k</button>
          <button class="kpbtn c" data-cmd="f-1000" title="Tune −1 kHz">-1k</button>
          <button class="kpbtn c" data-cmd="f+1000" title="Tune +1 kHz">+1k</button>
          <button class="kpbtn" id="btnAudioFft" style="display:none" title="SPEC — audio FFT spectrum analyzer for the demodulated signal (0–6 kHz). High-resolution inline display below the waterfall with auto-stretch contrast (5th/99th percentile EMA).">SPEC</button>
          <button class="kpbtn" id="btnThd" style="display:none" title="AFFT — high-resolution (16384 pt) audio FFT 0–6 kHz of the demodulated signal. Finer frequency resolution than SPEC for analyzing narrow tones, harmonics, and THD.">AFFT</button>
          <!-- DSD (dsd-fme) digital-voice decoders. Hidden stash; the
               DEC list picker is the only access path. Each button
               drives the same DsdDecoder with a different mode flag. -->
          <button class="kpbtn" id="btnDstar"   style="display:none" title="D-STAR digital voice (Icom DV). 4800 baud GMSK. Decodes header callsigns + per-frame TX/RX IDs via dsd-fme. Needs npm run build:dsd.">D-STAR</button>
          <button class="kpbtn" id="btnDmr"     style="display:none" title="DMR digital voice (ETSI TS-102-361). 4-FSK TDMA, two timeslots per 12.5 kHz channel. Single-slot mode (dsd-fme -ft) — decodes whichever slot is active at any moment. Color code + TG/SRC IDs in panel.">DMR</button>
          <button class="kpbtn" id="btnDmrs"    style="display:none" title="DMR stereo — decodes BOTH TDMA slots simultaneously (dsd-fme -fs). Slot 1 → left audio channel, slot 2 → right. Use to monitor both halves of a busy DMR repeater concurrently instead of seeing just whichever slot was first to sync.">DMR-S</button>
          <button class="kpbtn" id="btnNxdn48"  style="display:none" title="NXDN 4800 (Kenwood/Icom narrowband, 6.25 kHz channel). 4-FSK, decodes RAN + IDs via dsd-fme.">NXDN-48</button>
          <button class="kpbtn" id="btnNxdn96"  style="display:none" title="NXDN 9600 (12.5 kHz channel). 4-FSK, decodes RAN + IDs via dsd-fme.">NXDN-96</button>
          <button class="kpbtn" id="btnYsf"     style="display:none" title="YSF / C4FM (Yaesu System Fusion). 4-FSK, 9600 baud. Decodes DSQ + callsigns via dsd-fme.">YSF</button>
          <button class="kpbtn" id="btnDpmr"    style="display:none" title="dPMR / dPMR446 (EU narrowband 6.25 kHz). 4-FSK, decodes calling IDs via dsd-fme.">dPMR</button>
          <button class="kpbtn" id="btnM17"     style="display:none" title="M17 open digital voice. 4-FSK 4800 baud, callsigns in clear. Decodes SRC/DST via dsd-fme.">M17</button>
          <button class="kpbtn" id="btnP25p1"   style="display:none" title="P25 Phase 1 (APCO Project 25 FDMA). C4FM / CQPSK, 12.5 kHz. Decodes NAC + SRC + TG via dsd-fme/OP25.">P25-P1</button>
          <button class="kpbtn" id="btnP25p2"   style="display:none" title="P25 Phase 2 (TDMA). H-DQPSK, 12.5 kHz / two slots. Decodes NAC + SRC + TG via dsd-fme.">P25-P2</button>
          <!-- multimon-ng extra modes (FLEX/ERMES/DTMF/ZVEI/AFSK1200/X10/EAS).
               Hidden stash; the DEC list picker is the only access path. -->
          <button class="kpbtn" id="btnFlex"     style="display:none" title="FLEX paging (929/931 MHz US, 169 MHz EU). 1600/3200/6400 bps 2/4-FSK. Decodes CAP-codes + alphanumeric messages via multimon-ng.">FLEX</button>
          <button class="kpbtn" id="btnFlexNext" style="display:none" title="FLEX_NEXT — Motorola's revised FLEX (~2010+) with extra frame types and tighter error correction. multimon-ng's FLEX_NEXT demod catches packets plain FLEX would miss in noisy conditions. Same 929/931 MHz US / 169 MHz EU dial; just a different mode flag.">FLEX-N</button>
          <!-- ERMES retired: multimon-ng has no ERMES demod and the
               protocol itself is decommissioned across Europe since
               ~2010. Keep the comment so future readers don't try to
               re-add a button against the dead protocol. -->
          <button class="kpbtn" id="btnErmes"    style="display:none" data-retired="1" title="ERMES paging is retired — no working decoder.">ERMES</button>
          <button class="kpbtn" id="btnDtmf"     style="display:none" title="DTMF touch-tone decoder. Useful for phone-patch signalling on amateur repeaters. multimon-ng -a DTMF.">DTMF</button>
          <button class="kpbtn" id="btnZvei"     style="display:none" title="ZVEI 5-tone selective calling. EU EMS / fire dispatch. multimon-ng tries ZVEI1/2/3 dialects.">ZVEI</button>
          <button class="kpbtn" id="btnAfsk1200" style="display:none" title="Bell-202 AFSK 1200 bps. Generic narrowband modem (APRS, weather sondes, etc.). multimon-ng -a AFSK1200.">AFSK1200</button>
          <button class="kpbtn" id="btnUfsk1200" style="display:none" title="UFSK1200 — Universal FSK at 1200 baud (multimon-ng -a UFSK1200). Generic 2-FSK demodulator catching non-AX.25 packet traffic: vehicle telematics, industrial telemetry, legacy paging links. Output is raw hex frames; no protocol-specific parsing.">UFSK1200</button>
          <button class="kpbtn" id="btnAfsk2400" style="display:none" title="AFSK2400 — three tone-pair variants run concurrently (multimon-ng -a AFSK2400 -a AFSK2400_2 -a AFSK2400_3). Catches 2400 bps Bell-202 / V.23 modem traffic on utility and data links. Multimon-ng decodes whichever variant the signal uses; output is raw hex frames.">AFSK2400</button>
          <button class="kpbtn" id="btnHapn4800" style="display:none" title="HAPN4800 — Hong Kong Amateur Packet Network 4800 bps FSK (multimon-ng -a HAPN4800). Originally regional HK packet; the demod is useful for any 4800 bps FSK variant on UHF business / amateur bands. Output is raw hex frames.">HAPN4800</button>
          <button class="kpbtn" id="btnFsk9600" style="display:none" title="FSK9600 — generic 9600 bps NRZ FSK (multimon-ng -a FSK9600). Pre-G3RUH packet networks on VHF/UHF. Direct FSK on audio (not AFSK); multimon-ng handles internal resampling so 22050 Hz stdin is sufficient.">FSK9600</button>
          <button class="kpbtn" id="btnDpzvei" style="display:none" title="DZVEI / PZVEI — German + Polish ZVEI 5-tone selcall dialects bundled (multimon-ng -a DZVEI -a PZVEI). Different stop-tone behaviour from ZVEI1/2/3. Used on regional EU dispatch / fire / industrial alarm networks.">DZ/PZVEI</button>
          <button class="kpbtn" id="btnCwm" style="display:none" title="CWM — multimon-ng's native Morse decoder (-a MORSE_CW). Separate from the fldigi-based CW button (which gives richer output via narrower filter + speed-tracking). Useful as a cross-check / sanity validator against fldigi.">CWM</button>
          <button class="kpbtn" id="btnClipFsk" style="display:none" title="CLIPFSK — Bellcore / ETSI Caller-ID (V.23 FSK 1200 baud). Decodes calling number + name + timestamp from the silent gap between rings on a POTS line. Niche on radio; useful when audio source is coupled to a telephone pair. multimon-ng -a CLIPFSK.">CLIPFSK</button>
          <button class="kpbtn" id="btnFmsFsk" style="display:none" title="FMSFSK — German FMS Funkmeldesystem (1200 bps BFSK). Status-code signalling used by police, fire, EMS, civil defence on DE / AT / CH-DE emergency-services VHF/UHF bands (4 m / 2 m / 70 cm). Decodes BOS-ID + 4-bit status code + optional short message. multimon-ng -a FMSFSK.">FMSFSK</button>
          <button class="kpbtn" id="btnX10"      style="display:none" title="X10 home-automation RF (310 MHz). Decodes ON/OFF/dim commands for housecode/unit. multimon-ng -a X10.">X10</button>
          <button class="kpbtn" id="btnEas"      style="display:none" title="EAS — Emergency Alert System SAME header. FSK 520 / 1041 / 1562 Hz on NOAA weather radio (162 MHz). multimon-ng -a EAS.">EAS</button>
          <!-- Vendored binary decoders (MSK144/AIS/ACARS/TETRAPOL/OP25/LRPT).
               All share a single text-out panel via VendoredDecoder. -->
          <button class="kpbtn" id="btnMsk144"   style="display:none" title="MSK144 (WSJT-X meteor scatter, 144 baud MSK, 15 s slots). Needs npm run build:msk144.">MSK144</button>
          <button class="kpbtn" id="btnAis"      style="display:none" title="AIS marine vessel tracking (rtl-ais aisdecoder, 161.975/162.025 MHz GMSK). Outputs NMEA-0183. Needs npm run build:ais.">AIS</button>
          <button class="kpbtn" id="btnAcars"    style="display:none" title="ACARS VHF (TLeconte/acarsdec, 131 MHz MSK 2400 bps). JSON-formatted aircraft messages. Needs npm run build:acars.">ACARS</button>
          <!-- TETRAPOL retired from the keypad: tetrapol_dump only
               decodes pre-demodulated bits, not audio, and the
               upstream demod is a GR-Python flowgraph we don't ship.
               Voice traffic is encrypted on most active deployments
               anyway. Button stays in markup with display:none +
               data-retired so the page-cycle logic skips it. -->
          <button class="kpbtn" id="btnTetrapol" style="display:none" data-retired="1" title="TETRAPOL not wired — needs an upstream GR-Python demodulator (not shipped).">TETRAPOL</button>
          <button class="kpbtn" id="btnOp25"     style="display:none" title="P25 trunking + control channel (osmocom/op25). Talkgroup names, NACs, encryption status. Needs npm run build:op25.">OP25</button>
          <button class="kpbtn" id="btnLrpt"     style="display:none" title="LRPT — Meteor M2 weather satellite (137 MHz, satdump). Writes PNG images. Requires IQ-capable OWRX backend.">LRPT</button>
          <button class="kpbtn" id="btnHrpt"     style="display:none" title="HRPT — NOAA/MetOp high-resolution weather satellite (1.7 GHz, satdump). Same binary as LRPT, different pipeline.">HRPT</button>
          <button class="kpbtn" id="btnApt"      style="display:none" title="APT — NOAA analog weather satellite (137 MHz, satdump). Slow-scan image format.">APT</button>
          <button class="kpbtn" id="btnAdsb"     style="display:none" title="ADS-B — 1090 MHz aircraft transponder (dump1090, UC8 IQ in). Decodes Mode-S extended squitter with position/altitude.">ADS-B</button>
          <button class="kpbtn" id="btnVdl2"     style="display:none" title="VDL Mode 2 — 136.7–136.95 MHz aircraft data link (dumpvdl2, UC8 IQ in). ACARS-over-D8PSK.">VDL-2</button>
          <button class="kpbtn" id="btnUat"      style="display:none" title="UAT 978 MHz — US ADS-B for general aviation (dump978, UC8 IQ in).">UAT</button>
          <!-- WMBus retired: wmbusmeters is a frame parser, not an IQ
     demodulator. Decoding IQ → wmbus would need rtl_wmbus as an
     intermediate stage (~OP25-scale build). rtl_433 already does
     basic wmbus decoding via its built-in protocol filters — point
     it at 868.300 MHz and use the rtl_433 button instead. -->
<button class="kpbtn" id="btnWmbus"    style="display:none" data-retired="1" title="WMBus not wired — use the rtl_433 button at 868.300 MHz for basic wmbus decoding.">WMBus</button>
          <button class="kpbtn" id="btnRds"      style="display:none" title="RDS — FM-broadcast 57 kHz subcarrier (redsea). PS / PTY / radiotext / alt freqs. Needs raw MPX (RTL-SDR IQ).">RDS</button>
          <button class="kpbtn" id="btnDsc"      style="display:none" title="DSC — Marine Digital Selective Calling (ITU-R M.493). VHF Ch 70 (156.525 MHz) and HF guard channels (2187.5/4207.5/6312/8414.5/12577/16804.5 kHz). Server-side jbirby/DSC-Codec (Python).">DSC</button>
          <button class="kpbtn" id="btnJaero"    style="display:none" title="JAERO — Inmarsat AERO Classic decoder (L-band 1.5 GHz, aircraft satcom). A-BPSK / OQPSK / SOQPSK. Audio 48 kHz int16 from a SAM/USB demod.">AERO</button>
          <button class="kpbtn" id="btnCospas"   style="display:none" title="Cospas-Sarsat 406 MHz ELT/EPIRB — emergency-beacon decoder. 144-bit BPSK 400 baud bursts. Decodes country code + beacon ID + GPS position when present.">CSPAS</button>
          <button class="kpbtn" id="btnStdc"     style="display:none" title="Inmarsat STD-C — SOLAS maritime safety messaging (1.5 GHz L-band, BPSK 600 bps). Decodes NCS Common Channel + LES TDM forward link. Ship-to-shore traffic, EGC broadcasts, GMDSS distress alerts.">STD-C</button>
          <!-- multimon-ng 5-tone selective-calling family (paging-adjacent).
               All share the same multimon-ng binary as POCSAG/FLEX. -->
          <button class="kpbtn" id="btnCcir"  style="display:none" title="CCIR — 5-tone ITU-R paging selective calling (originally Italian dispatch / fire). multimon-ng -a CCIR.">CCIR</button>
          <button class="kpbtn" id="btnCcitt" style="display:none" title="CCITT — 5-tone selective calling, ITU-T variant. multimon-ng -a CCITT.">CCITT</button>
          <button class="kpbtn" id="btnEea"   style="display:none" title="EEA — European emergency-alert 5-tone variant. multimon-ng -a EEA.">EEA</button>
          <button class="kpbtn" id="btnEia"   style="display:none" title="EIA — European industrial-alert 5-tone variant. multimon-ng -a EIA.">EIA</button>
          <button class="kpbtn" id="btnEuro"  style="display:none" title="EURO — generic EU 5-tone selective calling. multimon-ng -a EURO.">EURO</button>
          <!-- IoT / telemetry. -->
          <button class="kpbtn" id="btnRtl433" style="display:none" title="rtl_433 — ~200 ISM-band protocols (weather stations, TPMS, water/gas meters, smoke alarms, garage remotes, smart plugs). UC8 IQ in, JSON out. Default centre 433.92 MHz.">rtl_433</button>
          <button class="kpbtn" id="btnSonde"  style="display:none" title="Radiosonde — weather-balloon decoder (rs1729's rs41mod by default). 400 MHz GFSK. Decodes position / altitude / P / T / RH / GPS. Audio 48 kHz int16 from NBFM demod.">SONDE</button>
          <button class="kpbtn" id="btnLora"   style="display:none" title="LoRa — chirp-spread-spectrum IoT (gr-lora_sdr). EU 868 / US 915 / AS 433 MHz. Default config BW=125 kHz, SF=7, CR=4/5. Decodes raw LoRa frames; LoRaWAN MAC decode is downstream / not done here.">LoRa</button>
          <button class="kpbtn" id="btnLtr"    style="display:none" title="LTR / LTR-Net — Logic Trunked Radio (GopherTrunk). US business UHF 400 / 800 MHz dominant trunking format pre-P25. Decodes control-channel: LCN / talkgroup / unit ID / channel grants.">LTR</button>
          <!-- TIME-signal decoder retired: dokutan/dcf77-decode takes
     pre-decoded bit lines, not audio. The AM-envelope + pulse-width
     demod layer that would turn 77.5 kHz LF audio into bits doesn't
     exist in radiom. Stations are also extremely range-limited
     (~2000 km), narrowing the practical use. The btnTimeStations
     frequency picker (also labeled TIME, different button) keeps
     working for manual tuning to WWV/WWVH/CHU/RWM/JJY/BPM/HLA. -->
<button class="kpbtn" id="btnTimesig" style="display:none" data-retired="1" title="Time-signal decoder retired — use the TIME frequency picker (btnTimeStations) to manually tune and listen.">TIME</button>
        </div>

        <div class="freq-row kprow">
          <button class="kpbtn c" data-cmd="f-100" title="Tune −100 Hz">-100</button>
          <button class="kpbtn c" data-cmd="f+100" title="Tune +100 Hz">+100</button>
          <button class="kpbtn c" data-cmd="f-10" title="Tune −10 Hz">-10</button>
          <button class="kpbtn c" data-cmd="f+10" title="Tune +10 Hz">+10</button>
          <button class="kpbtn c" data-cmd="f-1" title="Tune −1 Hz">-1</button>
          <button class="kpbtn c" data-cmd="f+1" title="Tune +1 Hz">+1</button>
          <button class="kpbtn" id="btnAcon" style="display:none" title="ACON — audio-derived constellation. Quadrature-mixes the current demod's audio at f₀ Hz, lowpasses at BW/2, and plots the complex baseband as a constellation. Costas-lock optional (BPSK/QPSK/8PSK). Works in any demod mode.">ACON</button>
        </div>

        <div class="fnrow">
          <button class="fnbtn" id="btnSPlot" style="display:none" title="SPLT — S-meter plot. RSSI (dBm) vs time chart for the last 60 s. Full-session capture available via the copy button for export.">SPLT</button>
          <button class="fnbtn" data-cmd="cent" title="CENTER — recenter the waterfall on the tuned frequency">&gt;&nbsp;&nbsp;|&nbsp;&nbsp;&lt;</button>
          <button class="fnbtn" data-cmd="zoomIn" title="Zin — zoom waterfall in one step. Long-press to jump to max zoom (Z14)">Zin</button>
          <button class="fnbtn" data-cmd="zoomOut" title="Zout — zoom waterfall out one step">Zout</button>
          <button class="fnbtn" data-cmd="panL" title="&lt;&lt;&lt; — pan waterfall view left">&lt;&lt;&lt;</button>
          <button class="fnbtn" data-cmd="panR" title="&gt;&gt;&gt; — pan waterfall view right">&gt;&gt;&gt;</button>
          <button class="fnbtn" id="btnSrch" title="STEP — auto-tune by the last selected frequency step (default 500 ms interval). Tap to start, tap again to stop. Frequency stays where it stops.">STEP</button>
        </div>

        <div class="knobs">
          ${(() => {
            const labels = ['VOL','SQL','GATE','RF','LoF','HiF','LoW','HiW','VTG'];
            const slugs  = ['vol','sql','gate','rf','lof','hif','wlo','whi','vtg'];
            const titles: Record<string, string> = {
              VOL: 'VOL — speaker output level (0–100%)',
              SQL: 'SQL — squelch threshold (S-units above noise floor). Audio mutes when RSSI falls below this',
              GATE:'GATE — audio noise gate. 0 = off; otherwise mutes the speaker when the per-frame audio RMS falls below the threshold. Knob value maps linearly to −100…0 dBFS',
              RF:  'RF — server-side RF gain. Cycles SLOW / MED / FAST / OFF via the MED button; this knob is the manual override when AGC is OFF',
              LoF: 'LoF — low-cut frequency of the audio passband (Hz)',
              HiF: 'HiF — high-cut frequency of the audio passband (Hz)',
              LoW: 'LoW — waterfall colour-map floor (dB). Anything quieter shows as black',
              HiW: 'HiW — waterfall colour-map ceiling (dB). Anything louder saturates',
              VTG: 'VTG — voice-tracker gain (dB). Only active when VTRK is on',
            };
            return labels.map((k, i) =>
              `<div class="knob" data-knob="${slugs[i]}" title="${titles[k] ?? ''}">
                 <div class="knob-label">${k}</div>
                 <div class="knob-dial"><div class="knob-line"></div></div>
               </div>`).join('');
          })()}
          <button id="btnFlush" class="knob-mini" type="button" style="display:none" title="FLUSH — hidden">FLUSH</button>
        </div>

        <!-- Every button on this row has been moved to a picker; hide
             the wrapper so the row doesn't leave an empty band between
             the knobs and the keypad. The hidden buttons stay in the
             DOM so picker dispatches keep working. -->
        <div class="fnrow fnrow-half fnrow-half-8" style="display:none">
          <button class="fnbtn" id="btnAgc" style="display:none" title="AGC — moved to DSP panel">AGC</button>
          <button class="fnbtn" data-toggle="comp" style="display:none" title="CP — moved to DSP panel">CP</button>
          <button class="fnbtn" id="btnNb2" style="display:none" title="NB2 — moved to DSP panel">NB2</button>
          <button class="fnbtn" id="btnAmnotch" style="display:none" title="NT2 — moved to DSP panel">NT2</button>
          <button class="fnbtn" id="btnRfw" style="display:none" title="NR2 — moved to DSP panel">NR2</button>
          <button class="fnbtn" id="btnVtrk3" style="display:none" title="VT — moved to DSP panel">VT</button>
          <button class="fnbtn" id="btnAfrm" style="display:none" title="AFF — moved to DSP panel">AFF</button>
          <button class="fnbtn" id="btnEq" style="display:none" title="EQ — moved to DSP panel">EQ</button>
          <button class="fnbtn" id="btnLists" style="display:none" title="SRCH — search across every aggregated frequency list. Type a frequency, label, mode, or list name and matching rows surface in real time; the closest row to your current tune is highlighted on open.">SRCH</button>
        </div>
        <!-- Hidden stash for NB / NT / NR. They used to live in the
             keypad mode column; the DSP panel dispatches clicks via
             [data-cmd] / [data-toggle] selectors, so the buttons must
             stay in the DOM (just not visible). -->
        <div style="display:none" aria-hidden="true">
          <button data-cmd="nb" id="kpNbStash">NB</button>
          <button data-cmd="antch" id="kpNtStash">NT</button>
          <button data-cmd="nr" id="kpNrStash">NR</button>
        </div>

        <div class="fnrow fnrow-half fnrow-half-8" style="display:none">
          <button class="fnbtn" id="btnMute" style="display:none" title="AUX — drops the live Kiwi audio so an INS test sample becomes the sole input">AUX</button>
          <button class="fnbtn" id="btnVtrk" style="display:none" title="VT — voice-tracking bandpass (dominant speech-band energy)">VT</button>
          <button class="fnbtn" id="btnVtrk2" style="display:none" title="VT2 — three-band peaking EQ steered by formant tracker (F1/F2/F3)">VT2</button>
          <button class="fnbtn" id="btnModes" style="display:none" title="GEN — moved to keypad">GEN</button>
          <button class="fnbtn" id="btnSigId2" style="display:none" title="SID — moved to keypad">SID</button>
          <button class="fnbtn" id="btnLsb2" style="display:none" title="LSB2 — client-side LSB demodulator fed by the IQ-domain cleanup chain (NB → DCK → Passband + Notch → Wiener NR). Plays the filtered IQ stream as LSB audio so you can A/B against Kiwi's server-side LSB.">LSB2</button>
          <button class="fnbtn" id="btnUsb2" style="display:none" title="USB2 — client-side USB demodulator fed by the IQ-domain cleanup chain (NB → DCK → Passband + Notch → Wiener NR). Plays the filtered IQ stream as USB audio so you can A/B against Kiwi's server-side USB.">USB2</button>
          <button class="fnbtn" id="btnSigVal" style="display:none" title="VAL — validate the SID classifier against the bundled labeled signal corpus (PSK, RTTY, FT8, NAVTEX, Olivia, etc.). For each sample: Hilbert-transforms the audio to analytic IQ, runs the same analyzeLocalIQ pipeline SID uses, and compares the top protocol fingerprint to the known label. Produces an accuracy summary and a list of misclassifications.">VAL</button>
          <!-- EIBI / PSKR / NET / WNET / GRAY now live only in the
               INFO panel (tap INFO on the keypad). Kept here, hidden,
               so the INFO-panel dispatches keep working. -->
          <button class="fnbtn" id="btnEibi" style="display:none" title="EIBI — moved to INFO panel">EIBI</button>
          <button class="fnbtn" id="btnPskr" style="display:none" title="PSKR — moved to INFO panel">PSKR</button>
          <button class="fnbtn" id="btnNets" style="display:none" title="NET — moved to INFO panel">NET</button>
          <button class="fnbtn" id="btnDx" style="display:none" title="DX — real-time DX cluster spots (requires RADIOM_DX_CALLSIGN env var on the server).">DX</button>
          <button class="fnbtn" id="btnWnet" style="display:none" title="WNET — moved to INFO panel">WNET</button>
          <button class="fnbtn" id="btnGray" style="display:none" title="GRAY — moved to INFO panel">GRAY</button>
          <button class="fnbtn" id="btnZoom" style="display:none" title="ZOOM — sub-Hz spectrogram. High-resolution narrow-band slice of the waterfall around the cursor for resolving carriers, drift, and weak tones below the main waterfall bin width.">ZOOM</button>
          <button class="fnbtn" id="btnMem" style="display:none" title="MEM — moved to keypad">MEM</button>
        </div>

        <div class="keypad" id="keypadNum">
          ${(() => {
            const titles: Record<string, string> = {
              AM:   'AM — double-sideband full-carrier broadcast demod (≈ 10 kHz BW)',
              AMN:  'AMN — narrow AM (≈ 5 kHz BW), for crowded SW conditions',
              AMW:  'AMW — wide AM (≈ 12 kHz BW), for hi-fi local broadcasts',
              CW:   'CW — Morse demod with adjustable BFO pitch (≈ 600 Hz BW)',
              CWN:  'CWN — narrow CW (~60 Hz BW), for weak-signal DX',
              DRM:  'DRM30 — Digital Radio Mondiale broadcast voice mode (10 kHz channel, COFDM)',
              IQ:   'IQ — complex baseband (no demod). Required by HFDL / ISB / page-5 IQ visualizers',
              LSB:  'LSB — lower-sideband voice / data demod (≈ 2.7 kHz BW)',
              LSN:  'LSN — narrow LSB (≈ 2 kHz BW), sharper for weak SSB',
              NBFM: 'NBFM — narrow FM (≈ 12 kHz BW), for HF mil / utility FM links',
              NNFM: 'NNFM — narrower NFM (≈ 6 kHz BW)',
              QAM:  'QAM — quadrature AM (experimental kiwi mode, ±4.9 kHz)',
              SAL:  'SAL — synchronous AM, lower sideband only (PLL). Picks the clean side on crowded SW',
              SAM:  'SAM — synchronous AM demod (PLL carrier recovery). Cleaner than plain AM under selective fading',
              SAS:  'SAS — synchronous AM, both sidebands explicit (PLL)',
              SAU:  'SAU — synchronous AM, upper sideband only (PLL). Picks the clean side on crowded SW',
              USB:  'USB — upper-sideband voice / data demod (≈ 2.7 kHz BW)',
              USN:  'USN — narrow USB (≈ 2 kHz BW), sharper for weak SSB',
              EQ:   'EQ — 5-band audio output equaliser (150 / 400 / 1k / 2.5k / 5k Hz, ±15 dB)',
              NB:   'NB — noise blanker. Cycles OFF / Type-1 / Type-2 impulse suppressors (server-side)',
              NT:   'NT — auto-notch. Snapshots spectrum every 200 ms and nulls the strongest narrow carrier in 200–3000 Hz',
              NR:   'NR — noise reduction (server-side adaptive de-noise)',
              PAGE: 'PAGE — cycle the keypad through pages 1–9 (numeric, decoder grids, IQ visualizers, freq pickers, …)',
              BAND: 'BAND — open the band-jump picker (160 m / 80 m / 40 m / … / 10 m)',
              BW:   'BW — open the passband-width picker',
              SCAN: 'SCAN — picker-driven scanner. Tap to cycle the last-opened freq list; long-press to start auto-scan',
              SET:  'SET — long-press behaviour: store current dial as a preset',
              DEL:  'DEL — delete the last digit of frequency entry',
              MODE: 'MODE — open the demodulation-mode picker (list filtered by the active server: KiwiSDR vs OpenWebRX)',
              DSP:  'DSP — open the signal-processor matrix (AGC, NB, NT, NR, CP, NB2, NT2, NR2, VT, AFF, EQ)',
              INFO: 'INFO — open the live / derived lookup matrix: EIBI shortwave schedule, PSKR PSKReporter spots, NETS active ham nets, WNET WSPRnet, GRAY gray-line propagation, SRCH search-all-frequency-lists, SID signal-ID lookup.',
              FREQ: 'FREQ — open the frequency-list picker: every curated static dial-frequency list (BCON, NDB, VLFB, MILV, MARN, AERO, VOLM, TIME, SCI, NUM, DXCL, DGPS, GMDS, HFDM, MEPT, MWDX, CB, LW, AFRC, ASIA, LATM, SWBC, CLND, DIPL, PIRA, AIDR, CAP, TNET, ECOM, SKYN, HFGC, MARS, MRSE, RUSM, MPAC, CSTV, CSCW).',
              VIEW: 'VIEW — open the visualization matrix (ANTC, DLDS, DOPP, EYE, FMNT, IQV, KURT, METR, OTHR, PPMC, RFI, SCOP, SFRC, VECT, ACON, SPEC, AFFT, ZOOM, SPLT)',
              DECO: 'DECO — full decoder list (CW, RTTY, PSK, MFSK, WSJT-X, military & utility — everything in one scrollable help-style list). Tap a row to toggle; long-press for sub-mode/freq picker.',
              GEN:  'GEN — inject a test sample for offline mode validation (moved to the DSP picker)',
              SID:  'SID — record 20 s of IQ and run the local DSP measurement pass',
              MEM:  'MEM — channel memory manager. Tap to open; long-press to save the current dial as a new memory channel.',
              kHz:  'kHz — submit the typed digits as a frequency in kHz',
              MHz:  'MHz — submit the typed digits as a frequency in MHz (×1000 → kHz)',
              BACK: 'BACK — close whatever is in the foreground of the waterfall area (picker panel or visualizer overlay)',
            };
            // Cols 4-7 = numeric keypad / system controls (one full-height
            // button per cell).
            // 6-col layout: 2 picker cols on the left + 4-col numeric
            // pad on the right (digits + . / SET / DEL). PAGE used to
            // live in the right column but is gone — there are no more
            // multi-page decoders here; the old pages 2-10 remain in
            // the DOM but display:none until their per-decoder pickers
            // land.
            // Column 3 reordering: GEN moved into the DSP picker;
            // MEM bumped up to GEN's former slot; SET renamed to kHz
            // and placed where MEM was; new MHz button (kHz × 1000)
            // takes the bottom slot. DEL slides left into the cell
            // SET used to occupy.
            const sideRows: string[][] = [
              ['k:1:1','k:2:2','k:3:3','c:back:BACK'],
              ['k:4:4','k:5:5','k:6:6','c:mem:MEM'],
              ['k:7:7','k:8:8','k:9:9','c:set:kHz'],
              ['k:.:.','k:0:0','c:del:DEL','c:mhz:MHz'],
            ];
            // Cols 0-1: picker buttons. Per-mode shortcuts removed in
            // favour of the unified MODE / DSP / INFO matrix pickers.
            const modeRows: string[][] = [
              ['t:band:BAND',       'c:decAPicker:DECO' ],
              ['c:modePicker:MODE', 'c:freqPicker:FREQ' ],
              ['c:filter:BW',       'c:dispPicker:VIEW' ],
              ['c:dspPicker:DSP',   'c:infoPicker:INFO' ],
            ];
            const renderCell = (spec: string): string => {
              const [type, key, label] = spec.split(':');
              if (type === 'x') {
                return `<button class="kpbtn kpbtn-aux" id="btnAux${key}" tabindex="-1" title="Reserved — future analog-DSP / mode feature">·</button>`;
              }
              if (type === 'i') {
                const t = titles[label];
                const titleAttr = t ? ` title="${t}"` : '';
                return `<button class="kpbtn"${titleAttr} id="btn${key}">${label}</button>`;
              }
              const attr = type === 'm' ? `data-mode="${key}"`
                         : type === 'k' ? `data-key="${key}"`
                         : type === 't' ? `data-toggle="${key}"`
                         : `data-cmd="${key}"`;
              const t = titles[label];
              const titleAttr = t ? ` title="${t}"` : '';
              return `<button class="kpbtn ${type}"${titleAttr} ${attr}>${label}</button>`;
            };
            return sideRows.map((sideRow, rowIdx) => {
              const modeCells = modeRows[rowIdx].map(renderCell).join('');
              const sideCells = sideRow.map(renderCell).join('');
              // Default .kprow grid = 6 cols, which matches 2 picker
              // cols + 4 numeric cols. No more kprow-7 here.
              return `<div class="kprow">${modeCells}${sideCells}</div>`;
            }).join('');
          })()}
        </div>

        <!-- Decoders are split across 4 sequential pages alphabetically.
             Same buttons available via the DECOD picker in the top bar. -->

        <!-- Page 2 — decoders (1/4). Buttons sorted alphabetically
             across pages 2 → 5. -->
        <div class="keypad" id="keypadDec" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnStanag" title="STANAG 4285 signal detector — recognises NATO 8-PSK 2400 baud on 1800 Hz audio carrier with periodic sync. Reports lock/SNR, not decoded content">4285</button>
            <button class="kpbtn" id="btnStanag4539" title="STANAG 4539 detector — high-rate NATO HF data modem (75-12800 bps). Same 1800 Hz carrier + 2400 baud as 4285 but 287-symbol preamble. Reports lock, not decoded content">4539</button>
            <button class="kpbtn" id="btnAle" title="Automatic Link Establishment (MIL-STD-188-141B 2G). Listens for incoming linking calls on government / mil HF nets. Long-press for sub-band freq picker">ALE</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnContestia" title="Faster contest-oriented variant of Olivia. fldigi-vendored. Long-press for sub-mode picker">CTSA</button>
            <button class="kpbtn" id="btnCw" title="Morse code decoder. Tone detector with adjustable speed / pitch / bandwidth. Long-press for sub-band freq picker">CW</button>
            <button class="kpbtn" id="btnDominoex" title="18-tone IFK+ multi-path robust keyboard chat. fldigi-vendored. Long-press for sub-mode picker">DOMI</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnEcss" title="ECSS — finds the strongest carrier near the cursor and aligns the SSB passband to it">ECSS</button>
            <button class="kpbtn" id="btnWefax" title="Analog HF weather-fax image decoder. Long-press for station picker (DWD / NOAA / JMH / …)">FAX</button>
            <button class="kpbtn" id="btnFreedv" title="Open-source HF digital voice (Codec2). 1600/700D/700E/2020 modes auto-detected. Server decodes via codec2's freedv_rx binary and streams decoded voice back to the speakers">FDV</button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn" id="btnFsq" title="Fast Simple QSO. Low-baud-rate IFK+ chat for NVIS / EMCOMM. fldigi-vendored. Long-press for sub-mode picker">FSQ</button>
            <button class="kpbtn" id="btnFst4" title="Modern WSJT weak-signal QSO mode (4-GFSK, 60-1800 s slots). Replaces JT9 on LF/MF DX. Long-press for freq picker">FST4</button>
            <button class="kpbtn" id="btnFst4w" title="Modern WSPR replacement. fst4d -W with configurable 60/120/300/900/1800 s slots. Default FST4W-120 on 14.0956 MHz USB">FST4W</button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 3 — decoders (2/4). -->
        <div class="keypad" id="keypadDec3" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnFt4" title="Fast contest variant of FT8 (4-GFSK, 7.5 s slots). Long-press for freq picker">FT4</button>
            <button class="kpbtn" id="btnFt8" title="8-GFSK weak-signal QSO mode (15 s slots, ~-21 dB SNR). The dominant HF digital mode today. Long-press for freq picker">FT8</button>
            <button class="kpbtn" id="btnHell" title="Feld-Hellschreiber — vintage (1929) image-based text mode. 122.5 baud AM-keyed pixels, decoded by eye like a slow fax. Tune the carrier to ~1000 Hz audio">HELL</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnHfdl" title="Aeronautical HF Data Link decoder via dumphfdl (KiwiSDR IQ-mode path). Decodes aircraft position / ACARS over HF. Long-press for ground-station freq picker">HFDL</button>
            <button class="kpbtn" id="btnIsb" title="Independent Sideband — splits LSB → left speaker, USB → right">iSB</button>
            <button class="kpbtn" id="btnJs8" title="Keyboard chat over an FT8-derived OFDM waveform. Slow/Normal/Fast/Turbo sub-modes. Long-press for freq picker">JS8</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnJt4" title="Original WSJT EME / weak-tropo mode. 4-FSK, 1-min UTC slots, ~-23 dB SNR. Same jt9 binary with -4 flag">JT4</button>
            <button class="kpbtn" id="btnJt65" title="Classic WSJT multi-tone (65-FSK) mode. 1-minute UTC slots, ~-25 dB SNR threshold, historic EME/HF DX mode; defaults to 14.076 MHz USB">JT65</button>
            <button class="kpbtn" id="btnJt9" title="Original WSJT-X narrowband mode. 1-minute UTC slots, 9-FSK, ~-27 dB SNR; defaults to 30 m sub-band">JT9</button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn" id="btnMcw" title="Modulated CW. Morse keyed on an audio tone and transmitted via AM. Flips mode to AM and routes audio through the existing CW decoder">MCW</button>
            <button class="kpbtn" id="btnMfsk" title="Fldigi MFSK family decoder (MFSK4 through MFSK128). Robust keyboard chat. Long-press for sub-mode picker">MFSK</button>
            <button class="kpbtn" id="btnMt63" title="64-tone OFDM keyboard chat. 500 / 1000 / 2000 Hz sub-modes. Multi-path resistant. fldigi-vendored. Long-press for sub-mode picker">MT63</button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 4 — decoders (3/4). -->
        <div class="keypad" id="keypadDec7" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnNavtex" title="Maritime SITOR-B FEC broadcasts (518 kHz / 490 kHz / 4209.5 kHz). Long-press for station picker">NTEX</button>
            <button class="kpbtn" id="btnOlivia" title="Multi-tone MFSK robust keyboard chat. fldigi-vendored. Long-press for sub-mode picker (4/125, 8/250, 16/500, 32/1000, etc.)">OLIV</button>
            <button class="kpbtn" id="btnPacket" title="AX.25 / APRS HF decoder via direwolf. 300 baud AFSK on 30 m. Long-press for freq picker. Decodes APRS payloads (position, weather, status, message, object, item) and telemetry (T# / PARM / UNIT / EQNS / BITS) directly in the panel. While active, AGWPE TCP 8000 also exposes raw frames to external apps (APRSIS32 / UI-View / Xastir, RX-only).">PKT</button>
            <button class="kpbtn" id="btnPacketVhf" style="display:none" title="AX.25 / APRS VHF packet via direwolf. 1200 baud Bell-202 (1200/2200 Hz AFSK) — dominant on 144 MHz APRS. Default 144.390 MHz US / 144.800 MHz EU; long-press for freq picker. NBFM. Decodes position, weather, telemetry (T# / PARM / UNIT / EQNS / BITS), messages, objects. AGWPE TCP 8000 active while running.">VPKT</button>
            <button class="kpbtn" id="btnPacket9600" style="display:none" title="9600 baud G3RUH packet (direct FSK, scrambled NRZ). Used on FOX cubesats (435 MHz downlinks) and some 70 cm UHF terrestrial. Needs wideband NBFM audio (≥24 kHz Nyquist); Kiwi sources are bandwidth-limited and won't decode. Long-press for sat freq picker. AGWPE TCP 8000 active while running.">9PKT</button>
            <button class="kpbtn" id="btnPacketIl2p" style="display:none" title="IL2P framing (Nino Carrillo's Reed-Solomon FEC layer on top of AX.25). VHF 1200 baud Bell-202 carrier with FEC frames — decodes through QRM/QSB that plain AX.25 misses. Same dial frequencies as VPKT; long-press for picker. AGWPE TCP 8000 active while running.">ILP</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnPocs" title="POCSAG pager decoder via multimon-ng. Decodes 512 / 1200 / 2400 baud pager messages (address, function, alpha / numeric / tone). Requires npm run build:selcal to build the multimon-ng binary first.">POCS</button>
            <button class="kpbtn" id="btnPsk31b" title="Phase-shift-keying chat decoder (BPSK31, QPSK31, BPSK63, etc.). fldigi-vendored. Long-press for sub-mode picker">PSK</button>
            <button class="kpbtn" id="btnQ65" title="Modern WSJT-X weak-signal mode (2021). 65-FSK + Reed-Solomon, 1-min slots, ~-25 dB SNR; defaults to 14.080 MHz USB">Q65</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnQrss" title="Slow-CW grabber. Sub-Hz audio FFT with very slow time scroll for visual decoding of QRP beacons">QRSS</button>
            <button class="kpbtn" id="btnRtty" title="Radioteletype FSK decoder. Configurable baud / shift (45/50/75/100 bd, 170/425/850 Hz). fldigi-vendored. Long-press for preset picker">RTTY</button>
            <button class="kpbtn" id="btnSelcal" title="Aviation HF selective-calling decoder via multimon-ng. 2-of-16 tone-pair codes. Tune an HF aero channel (8.891 / 5.598 / 11.336 / 13.306 MHz USB)">SELC</button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn" id="btnSstv" title="Analog Slow-Scan TV via slowrxd. Robot/Scottie/Martin/PD modes auto-detected from VIS code. Defaults to 14.230 MHz USB (20 m SSTV calling)">SSTV</button>
            <button class="kpbtn" id="btnSitor" title="Maritime FEC broadcast decoder (sibling protocol to NAVTEX). 100 baud / 170 Hz FSK. Long-press for station picker">SITOR-B</button>
            <button class="kpbtn" id="btnThor" title="IFK+ multi-path robust chat (DominoEX sibling tuned for HF). fldigi-vendored. Long-press for sub-mode picker">THOR</button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 5 — decoders (4/4). -->
        <div class="keypad" id="keypadDec8" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnThrob" title="9-tone pulse-position modulation chat mode. T1/T2/T4 base + X1/X2/X4 with FEC. fldigi-vendored decoder">THRB</button>
            <button class="kpbtn" id="btnWspr15" title="15-minute period WSPR variant for LF/MF (137/475 kHz). UTC-aligned :00/:15/:30/:45 boundaries; tap to start standby">W15</button>
            <button class="kpbtn" id="btnWspr" title="Weak Signal Propagation Reporter. 2-min UTC slots, 4-FSK, ~-29 dB SNR. Decodes CALL + GRID + dBm beacon spots via wsprd. Long-press for freq picker">WSPR</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnWwv" title="Time-station decoder (WWV / WWVH on 2.5 / 5 / 10 / 15 / 20 MHz). Decodes the BCD time-code on the 100 Hz sub-carrier">WWV</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 6 — visualizers (1/2). Buttons sorted alphabetically
             across pages 6 → 7. -->
        <div class="keypad" id="keypadDec4" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnAntc" title="ANTC — anti-carrier visualizer. Shows the residual carrier offset after the SAM PLL has locked (useful for tuning ECSS-style)">ANTC</button>
            <button class="kpbtn" id="btnDlds" title="Delay-Doppler scattering function — HF channel sounder">DLDS</button>
            <button class="kpbtn" id="btnDopp" title="DOPP — Doppler tracker. Displays frequency-drift slope of the strongest in-band signal vs time (HF DX rising / falling fade)">DOPP</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnEye" title="EYE — eye-diagram visualizer for the IQ symbol stream (requires IQ mode)">EYE</button>
            <button class="kpbtn" id="btnFmnt" title="Voice formant tracker (F1/F2/F3 vs time)">FMNT</button>
            <button class="kpbtn" id="btnIqView" title="IQ VIEW — complex-baseband constellation plot (I vs Q scatter). Requires IQ mode">IQV</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnKurt" title="Sample kurtosis vs time — Gaussian noise ≈ 3, impulsive QRN ≫ 3, tone-dominated &lt; 3">KURT</button>
            <button class="kpbtn" id="btnSDial" title="METR — analog-style S-meter dial reading the smoothed RSSI">METR</button>
            <button class="kpbtn" id="btnOthr" title="OTHR — over-the-horizon radar visualizer. Slow waterfall tuned to expose the periodic FMCW / pulsed sweeps of Russian Container / US ROTHR / Aussie JORN systems">OTHR</button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn" id="btnPpmc" title="PPMC — Kiwi ppm-clock visualizer. Measures the receiver's local-oscillator drift against a known reference carrier">PPMC</button>
            <button class="kpbtn" id="btnRfi" title="RFI — RFI sleuth. Long-term cumulative spectrum that exposes constantly-on local interference (PLT, switch-mode PSU, plasma TV…)">RFI</button>
            <button class="kpbtn" id="btnScope" title="SCOP — audio oscilloscope on the demodulated signal. Triggered, with adjustable level and polarity">SCOP</button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 7 — visualizers (2/2). -->
        <div class="keypad" id="keypadDec5" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnSfrc" title="SFRC — sferic / lightning visualizer. Detects and counts wideband impulse spikes characteristic of distant thunderstorms">SFRC</button>
            <button class="kpbtn" id="btnVect" title="VECT — vector / Lissajous scope: x vs delayed-x on the audio. Reveals modulation symmetry / periodicity">VECT</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <!-- WLSB / WUSB are conditionally surfaced by the IQ-domain
                 cleanup chain; kept inline (display:none) so the
                 existing show/hide code paths still find them. They
                 don't occupy grid columns until display flips on. -->
            <button class="kpbtn" id="btnWlsb" style="display:none">WLSB</button>
            <button class="kpbtn" id="btnWusb" style="display:none">WUSB</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 8 — frequency-list pickers (1/4). Buttons sorted
             alphabetically across pages 8 → 11. -->
        <div class="keypad" id="keypadDec6" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnStanag3g" title="3GAL — STANAG 4538 (3G ALE) network frequencies. Distinct from the 2G ALE list.">3GAL</button>
            <button class="kpbtn" id="btnAero" title="AERO — non-VOLMET oceanic aviation HF voice (NAT/CAR/CWP/SAM/INO).">AERO</button>
            <button class="kpbtn" id="btnAfricaBc" title="AFRC — African regional SW broadcasters (TWR Africa, Channel Africa, Voice of Nigeria, BBC Africa relay).">AFRC</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnAirdrill" title="AIDR — NATO / USAF HF exercise nets (Cope Tiger / Red Flag / Bold Quest, etc.).">AIDR</button>
            <button class="kpbtn" id="btnAmtor" title="Amateur AMTOR / SITOR FEC nets (mostly historical, occasionally still active on 20 m).">AMTOR</button>
            <button class="kpbtn" id="btnAsiaBc" title="ASIA — Asian regional SW broadcasters (VOV, Thai NBT, AIR World Service, PBC, TRT).">ASIA</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnBeacons" title="BCON — frequency picker for NCDXF / IBP beacons (14.100 / 18.110 / 21.150 / 24.930 / 28.200 MHz round-robin)">BCON</button>
            <button class="kpbtn" id="btnCap" title="CAP — US Civil Air Patrol HF (auxiliary USAF, cadet / emergency / SAR).">CAP</button>
            <button class="kpbtn" id="btnCb" title="CB — 27 MHz Citizens Band core channels + freebander stretches.">CB</button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn" id="btnClandestine" title="CLND — clandestine SW broadcasters (Sound of Hope, Voice of Tibet, Echo of Hope, Voice of Korea, etc.).">CLND</button>
            <button class="kpbtn" id="btnCoast" title="CSTV — coastal-station HF voice broadcasts (USCG NMN / NMG / NMC / NOJ weather and safety bulletins).">CSTV</button>
            <button class="kpbtn" id="btnCoastcw" title="CSCW — museum / special-event commercial coastal CW (KSM Pt. Reyes, K6KPH).">CSCW</button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 9 — frequency-list pickers (2/4). -->
        <div class="keypad" id="keypadDec9" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnDgps" title="DGPS — LF/MF Differential GPS reference beacons (~283.5–325 kHz, MSK-encoded). Overlaps the NDB band.">DGPS</button>
            <button class="kpbtn" id="btnDrm" title="DRM — Digital Radio Mondiale broadcasters (AIR / Romania / Vatican / KTWR / WINB). Listen with the DRM demod.">DRM</button>
            <button class="kpbtn" id="btnDxcluster" title="DXCL — DX cluster voice / CW calling frequencies (CW DX centers and SSB DX windows by band).">DXCL</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnEmbassy" title="DIPL — diplomatic / state-department HF carriers (Russian / Chinese / Iranian MFA RTTY and data).">DIPL</button>
            <button class="kpbtn" id="btnEmcomm" title="ECOM — formal emergency / disaster nets (IARU emergency channels, RACES, Red Cross, SATERN).">ECOM</button>
            <button class="kpbtn" id="btnGmdss" title="GMDS — Global Maritime Distress and Safety System (distress / DSC / medico channels).">GMDS</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnHfdm" title="HFDM — HF data-modem fixed-station carriers (MIL-STD-188-110/141C, French Navy, Russian Smerch, etc.).">HFDM</button>
            <button class="kpbtn" id="btnHfgcs" title="HFGC — USAF HF Global Communications System (4724/6739/8992/11175/13200/15016 USB).">HFGC</button>
            <button class="kpbtn" id="btnLatamBc" title="LATM — Latin American SW broadcasters (R. Habana Cuba, R. Aparecida, R. Verdad, RAE Argentina).">LATM</button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn" id="btnLw" title="LW — European longwave broadcast (153–279 kHz). BBC R4, Romanian Antena Satelor, Algerian Chaîne 1, etc.">LW</button>
            <button class="kpbtn" id="btnMars" title="MARS — US Army/Navy/AF MARS + Canadian CFARS military auxiliary networks.">MARS</button>
            <button class="kpbtn" id="btnMarsEu" title="MRSE — European MARS-equivalent amateur radio societies (RNARS, RAFARS, BARS, DARS, NARS).">MRSE</button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 10 — frequency-list pickers (3/4). -->
        <div class="keypad" id="keypadDec10" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnMept" title="MEPT — Manned Experimental Propagation Test QRPp / QRSS beacon windows on each band.">MEPT</button>
            <button class="kpbtn" id="btnMilv" title="MILV — frequency picker for military / government voice nets (US Air Force HF-GCS, NATO, Russian VOLMET-style)">MILV</button>
            <button class="kpbtn" id="btnMarpac" title="MPAC — Pacific-specific maritime nets and coast stations (AMSA Charleville / Wiluna, NZ Maritime, JCS Tokyo).">MPAC</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnMaritime" title="MARN — frequency picker for maritime voice / weather / DSC channels">MARN</button>
            <button class="kpbtn" id="btnMwdx" title="MWDX — clear-channel medium-wave DX targets (NA Class A, marquee EU and Asian MW stations).">MWDX</button>
            <button class="kpbtn" id="btnNdb" title="NDB — LF/MF aviation non-directional beacons (200–500 kHz, slow Morse idents). Classic SWL hobby.">NDB</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnNumbers" title="NUM — Priyom-catalogued numbers / clandestine stations (E07/E11/G06/M14/V07/HM01/etc.).">NUM</button>
            <button class="kpbtn" id="btnPactor" title="Listenable Winlink / Pactor message-gateway HF calling channels.">PACTOR</button>
            <button class="kpbtn" id="btnPirate" title="PIRA — informal European pirate and US freebander stretches (3.9 / 4.95 / 6.2 / 6.9 MHz).">PIRA</button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn" id="btnRusmil" title="RUSM — Russian strategic / fleet military HF networks (Briz, Akula, Krug, Sviaz). Distinct from NATO-centric MILV.">RUSM</button>
            <button class="kpbtn" id="btnScien" title="SCI — frequency picker for scientific / propagation-research stations (ionosondes, riometers, OTH calibrators)">SCI</button>
            <button class="kpbtn" id="btnSitorA" title="Maritime SITOR-A interactive (ARQ) calling channels, distinct from broadcast SITOR-B in NAVTEX.">SITOR-A</button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>

        <!-- Page 11 — frequency-list pickers (4/4). -->
        <div class="keypad" id="keypadDec11" style="display:none">
          <div class="kprow kprow-7">
            <button class="kpbtn c" data-cmd="modePicker" title="Pick demodulation mode — list filtered by the active server (Kiwi vs OpenWebRX)">MODE</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn" id="btnSkynet" title="SKYN — RAF / NATO Skynet UK military HF (3.146 / 4.742 / 6.733 / 9.031 / 14.353 MHz USB).">SKYN</button>
            <button class="kpbtn" id="btnStanag2" title="STAN — known persistent MIL-STD-188-110 / STANAG 4285 / 4539 NATO HF data carriers.">STAN</button>
            <button class="kpbtn" id="btnSwbroad" title="SWBC — marquee shortwave broadcasters (BBC, VOA, RFI, CRI, RRI, KBS, NHK, Vatican, WRMI, WBCQ, WWCR).">SWBC</button>
            <button class="kpbtn c" data-cmd="dec">PAGE</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nb">NB</button>
            <button class="kpbtn" id="btnTimeStations" title="TIME — frequency picker for time stations (WWV/WWVH/CHU/RWM/JJY/BPM/HLA)">TIME</button>
            <button class="kpbtn" id="btnTrafnets" title="TNET — amateur traffic / maritime / mobile nets (MMSN, SATERN, ARES, etc.).">TNET</button>
            <button class="kpbtn" id="btnVlfb" title="VLFB — frequency picker for VLF/LF beacons and submarine broadcast stations (16.4 / 18.1 / 19.6 / 21.4 kHz and friends)">VLFB</button>
            <button class="kpbtn t" data-toggle="band">BAND</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="antch">NT</button>
            <button class="kpbtn" id="btnVolmet" title="VOLM — frequency picker for VOLMET aviation-weather broadcasts (NY / Gander / Shannon / Karachi / etc.)">VOLM</button>
            <button class="kpbtn" id="btnWfax" title="WFAX — weather-fax broadcast schedules (DWD/NOAA/JMH/Bracknell/Northwood).">WFAX</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn c" data-cmd="filter">BW</button>
          </div>
          <div class="kprow kprow-7">
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn kpbtn-aux" tabindex="-1" title="Use MODE picker">·</button>
            <button class="kpbtn c" data-cmd="nr">NR</button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn kpbtn-empty" aria-hidden="true" tabindex="-1"></button>
            <button class="kpbtn c" data-cmd="scan">SCAN</button>
          </div>
        </div>


        <div class="fnrow fnrow-8">
          <button class="fnbtn" id="btnRec" style="grid-column: span 1" title="REC — toggle recording of the current audio to a local WAV (saved on stop)">REC</button>
          <button class="fnbtn" id="btnRecordings" style="grid-column: span 1" title="PLAY — open the saved-recordings library">PLAY</button>
          <button class="fnbtn" id="btnTranscribe" style="grid-column: span 1" title="SCRIBE — toggle speech-to-text transcription on the demodulated audio">SCRIBE</button>
          <button class="fnbtn" id="btnLangFrom" style="grid-column: span 2" data-help-hide="1" title="Speech-to-text source language (Auto-detect available)"></button>
          <button class="fnbtn" id="btnLangTo" style="grid-column: span 3" data-help-hide="1" title="Translation target language for the transcribed text"></button>
          <button class="fnbtn" id="btnScribeAi" style="grid-column: span 1" title="AI — feed the current SCRIBE transcript to OpenAI's flagship reasoning model. Reconstructs intent from radio-noise garbling and Whisper hallucinations; extracts callsigns, locations, names, events, times, frequencies — open-source intelligence summary.">AI</button>
        </div>

      </main>
    `;
  }

  /* ───────────── bind ───────────── */

  private bind() {
    // Power: short tap = (re)connect / disconnect Kiwi only. Long-press =
    // hard off — also closes every open decoder/visualizer panel and
    // suspends the AudioContext so the page sits at ~0 % CPU.
    this.bindFtxLongPress(this.$('power'),
      () => this.togglePower(),
      () => this.powerOffHard());
    this.$('menu').addEventListener('click', () => this.openSettings());
    this.$('help').addEventListener('click', () => this.openHelpModal());
    this.$('btnTranscribe').addEventListener('click', () => this.toggleTranscribe());
    this.$('btnScribeAi').addEventListener('click', () => this.toggleAiPanel());
    this.bindFtxLongPress(
      this.$('btnMem') as HTMLElement,
      () => this.toggleMemPanel(),
      () => this.memorySaveCurrent(),
    );
    this.$('memAdd').addEventListener('click', (e) => { e.stopPropagation(); this.memorySaveCurrent(); });
    this.$('memExport').addEventListener('click', (e) => { e.stopPropagation(); this.memoryExport(); });
    this.$('memImport').addEventListener('click', (e) => { e.stopPropagation(); this.memoryImport(); });
    const memSearch = this.$('memSearch') as HTMLInputElement;
    memSearch.addEventListener('input', () => {
      this.memSearchQuery = memSearch.value;
      this.renderMemoryList();
    });
    this.$('aiScribe').addEventListener('click', (e) => {
      e.stopPropagation();
      this.runScribeAi();
    });
    this.$('aiSid').addEventListener('click', (e) => {
      e.stopPropagation();
      this.runSidAi();
    });
    this.$('aiCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('aiText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('AI report copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('aiClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('aiText').textContent = '';
    });
    this.$('btnRec').addEventListener('click', () => this.toggleRecord());
    this.$('btnRecordings').addEventListener('click', () => this.openRecordings());
    this.$('btnAudioFft').addEventListener('click', () => this.toggleAudioFft());
    this.bindFtxLongPress(this.$('btnFt8'), () => { this.exclusiveActivate('ftx'); this.toggleFtx('FT8'); }, () => this.openFtxFreqPicker('FT8'));
    this.bindFtxLongPress(this.$('btnFt4'), () => { this.exclusiveActivate('ftx'); this.toggleFtx('FT4'); }, () => this.openFtxFreqPicker('FT4'));
    this.bindFtxLongPress(this.$('btnCw'),
      () => { this.exclusiveActivate('cw'); this.toggleCw(); },
      () => this.openCwFreqPicker());
    // Picker-style buttons: tap-when-active deactivates instead of
    // re-opening the picker; tap-when-idle opens the picker as usual.
    this.bindFtxLongPress(this.$('btnRtty'),
      () => { if (this.rttyOn) { this.toggleRtty(); return; }
              this.exclusiveActivate('rtty'); this.openRttyPresetPicker(); },
      () => this.openRttyFreqPicker());
    this.bindFtxLongPress(this.$('btnOlivia'),
      () => { if (this.oliviaOn) { this.toggleOlivia(); return; }
              this.exclusiveActivate('olivia'); this.openOliviaPresetPicker(); },
      () => this.openOliviaFreqPicker());
    this.bindFtxLongPress(this.$('btnMt63'),
      () => { if (this.mt63On) { this.toggleMt63(); return; }
              this.exclusiveActivate('mt63'); this.openMt63ModePicker(); },
      () => this.openMt63FreqPicker());
    this.bindFtxLongPress(this.$('btnFsq'),
      () => { if (this.fsqOn) { this.toggleFsq(); return; }
              this.exclusiveActivate('fsq'); this.openFsqModePicker(); },
      () => this.openFsqFreqPicker());
    this.bindFtxLongPress(this.$('btnThor'),
      () => { if (this.thorOn) { this.toggleThor(); return; }
              this.exclusiveActivate('thor'); this.openThorModePicker(); },
      () => this.openThorFreqPicker());
    this.bindFtxLongPress(this.$('btnDominoex'),
      () => { if (this.dominoexOn) { this.toggleDominoex(); return; }
              this.exclusiveActivate('dominoex'); this.openDominoexModePicker(); },
      () => this.openDominoexFreqPicker());
    this.$('dominoexCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('dominoexText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('DominoEX copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('dominoexClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('dominoexText').textContent = '';
    });
    this.bindFtxLongPress(this.$('btnContestia'),
      () => { if (this.contestiaOn) { this.toggleContestia(); return; }
              this.exclusiveActivate('contestia'); this.openContestiaModePicker(); },
      () => this.openContestiaFreqPicker());
    this.$('contestiaCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('contestiaText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('Contestia copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('contestiaClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('contestiaText').textContent = '';
    });
    this.$('thorCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('thorText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('THOR copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('thorClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('thorText').textContent = '';
    });
    this.$('fsqCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('fsqText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('FSQ copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('fsqClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('fsqText').textContent = '';
    });
    this.$('mt63Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('mt63Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('MT63 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('mt63Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('mt63Text').textContent = '';
    });
    this.bindFtxLongPress(this.$('btnPsk31b'),
      () => { if (this.psk31bOn) { this.togglePsk31b(); return; }
              this.openPskFldigiModePicker(); },
      () => this.openPskBandPicker());
    this.bindFtxLongPress(this.$('btnMfsk'),
      () => { if (this.mfskOn) { this.toggleMfsk(); return; }
              this.exclusiveActivate('mfsk'); this.openMfskModePicker(); },
      () => this.openMfskFreqPicker());
    this.$('mfskCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('mfskText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('MFSK copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('mfskClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('mfskText').textContent = '';
    });
    this.$('btnModes').addEventListener('click', () => this.openModesPicker());
    this.$('btnAgc').addEventListener('click', () => this.cycleAgc());
    this.$('btnAmnotch').addEventListener('click', () => this.toggleAmnotch());
    this.$('btnSigId2').addEventListener('click', () => this.runSigIdentifyLocal());
    this.$('btnSigVal').addEventListener('click', () => this.runSigValidation());
    this.$('btnPskr').addEventListener('click', () => this.runPskReporter());
    this.$('btnEibi').addEventListener('click', () => this.runEibi());
    // Tap EQ → open the 5-band equalizer picker.
    this.$('btnEq').addEventListener('click', () => this.openEqPicker());
    this.$('btnNets').addEventListener('click', () => this.runNets());
    this.$('btnDx').addEventListener('click', () => this.runDxSpots());
    this.$('btnWnet').addEventListener('click', () => this.runWspr());
    this.bindF2Button();
    this.refreshF2Button();
    this.bindFcButton();
    this.$('btnFlush').addEventListener('click', () => {
      const keep = this.settings.flushKeepMs;
      this.player.flush(keep);
      this.banner(`Audio flushed — kept ${keep} ms`, 800);
    });
    this.$('btnVtrk').addEventListener('click', () => {
      const on = !this.player.isVoiceTrackEnabled();
      this.setVtrkExclusive(on ? 1 : 0);
      this.banner(on ? 'VT on — tracking voice' : 'VT off', 1200);
    });
    this.$('btnVtrk2').addEventListener('click', () => {
      const on = !this.player.isVoiceTrack2Enabled();
      this.setVtrkExclusive(on ? 2 : 0);
      this.banner(on ? 'VT2 on — formant-driven (F1/F2/F3)' : 'VT2 off', 1200);
    });
    this.$('btnVtrk3').addEventListener('click', () => {
      const on = !this.player.isVoiceTrack3Enabled();
      this.setVtrkExclusive(on ? 3 : 0);
      this.banner(on ? 'VT on — LPC formant tracker' : 'VT off', 1200);
    });
    this.$('btnAfrm').addEventListener('click', () => {
      const on = !this.player.isVoiceTrackAntiFormantEnabled();
      this.player.setVoiceTrackAntiFormantEnabled(on);
      (this.$('btnAfrm') as HTMLElement).classList.toggle('active', on);
      this.banner(on ? 'AF on — anti-formant valley notches' : 'AF off', 1200);
    });
    // DCK (Hampel de-clicker) was removed. Force-disable and clean the
    // persisted keys in case an older build had it on.
    this.player.setDeclickerEnabled(false);
    try {
      localStorage.removeItem('radiom.dckOn');
      localStorage.removeItem('radiom.dckK');
    } catch { /* ignored */ }

    // NB2 cycles: OFF → soft (K=3) → med (K=5) → hard (K=7) → OFF.
    // Lower K = more aggressive; the adaptive reference tracks the
    // signal envelope so K is multiples of the running noise floor.
    const nb2Steps  = [3, 5, 7];
    const nb2Labels = ['SOFT', 'MED', 'HARD'];
    const btnNb2 = this.$('btnNb2') as HTMLElement;
    const updateNb2Btn = () => {
      const on = this.player.isNb2Enabled();
      const k = this.player.getNb2Strength();
      btnNb2.classList.toggle('active', on);
      btnNb2.textContent = 'NB2';
      const lbl = this.$('lblNb2') as HTMLElement | null;
      if (lbl) {
        if (on) {
          const idx = nb2Steps.findIndex(s => Math.abs(s - k) < 0.5);
          lbl.textContent = idx >= 0 ? `NB2 ${nb2Labels[idx]}` : 'NB2';
        } else {
          lbl.textContent = '';
        }
      }
    };
    btnNb2.addEventListener('click', () => {
      const on = this.player.isNb2Enabled();
      const cur = this.player.getNb2Strength();
      if (!on) {
        this.player.setNb2Strength(nb2Steps[0]);
        this.player.setNb2Enabled(true);
        this.banner(`NB2 ${nb2Labels[0]} (K=${nb2Steps[0]})`, 1200);
      } else {
        const idx = nb2Steps.findIndex(s => Math.abs(s - cur) < 0.5);
        const next = idx >= 0 && idx < nb2Steps.length - 1 ? idx + 1 : -1;
        if (next < 0) {
          this.player.setNb2Enabled(false);
          this.banner('NB2 OFF', 1000);
        } else {
          this.player.setNb2Strength(nb2Steps[next]);
          this.banner(`NB2 ${nb2Labels[next]} (K=${nb2Steps[next]})`, 1200);
        }
      }
      localStorage.setItem('radiom.nb2On', String(this.player.isNb2Enabled()));
      localStorage.setItem('radiom.nb2K',  String(this.player.getNb2Strength()));
      updateNb2Btn();
    });
    updateNb2Btn();
    // Restore last NB2 state.
    try {
      const wasOn = localStorage.getItem('radiom.nb2On') === 'true';
      const k = parseFloat(localStorage.getItem('radiom.nb2K') || '');
      if (Number.isFinite(k)) this.player.setNb2Strength(k);
      if (wasOn) this.player.setNb2Enabled(true);
      updateNb2Btn();
    } catch { /* ignored */ }
    // RFW cycles: OFF → 20% → 40% → 60% → 80% → 100% → OFF
    // Strength is the wet/dry mix; lower = more original signal preserved.
    const rfwSteps = [0.2, 0.4, 0.6, 0.8, 1.0];
    const btnRfw = this.$('btnRfw') as HTMLButtonElement;
    const updateRfwBtn = () => {
      const on = this.player.isRFWhisperEnabled();
      btnRfw.classList.toggle('active', on);
      // Percentage moved to the LED panel's `#lblNr2` label; the button
      // itself just shows the mode name.
      btnRfw.textContent = 'NR2';
      const lbl = this.$('lblNr2') as HTMLElement | null;
      if (lbl) {
        lbl.textContent = on
          ? `NR2 ${Math.round(this.player.getRFWhisperStrength() * 100)}%`
          : '';
      }
    };
    btnRfw.addEventListener('click', () => {
      const on = this.player.isRFWhisperEnabled();
      const cur = this.player.getRFWhisperStrength();
      if (!on) {
        this.player.setRFWhisperStrength(rfwSteps[0]);
        this.player.setRFWhisperEnabled(true);
        this.banner('RFW 20% — gentle noise reduction', 1400);
      } else {
        const idx = rfwSteps.findIndex(s => Math.abs(s - cur) < 0.05);
        const next = idx >= 0 && idx < rfwSteps.length - 1 ? idx + 1 : -1;
        if (next < 0) {
          this.player.setRFWhisperEnabled(false);
          this.banner('RFW off', 1200);
        } else {
          this.player.setRFWhisperStrength(rfwSteps[next]);
          this.banner(`RFW ${rfwSteps[next] * 100 | 0}% — ${rfwSteps[next] < 0.5 ? 'gentle' : rfwSteps[next] < 0.9 ? 'medium' : 'full'} noise reduction`, 1400);
        }
      }
      updateRfwBtn();
    });
    updateRfwBtn();
    // WF row-duplication cycle button (1 → 2 → 3 → 4 → 1).
    const btnWfDup = this.$('btnWfDup') as HTMLButtonElement;
    btnWfDup.textContent = `WF${this.wfDup}`;
    btnWfDup.addEventListener('click', () => {
      this.wfDup = (this.wfDup % 8) + 1;
      this.spectrum.setWfDup(this.wfDup);
      btnWfDup.textContent = `WF${this.wfDup}`;
      localStorage.setItem('radiom.wfDup', String(this.wfDup));
    });
    // Auto-stretch cycle button: OFF → AUTO → DARK → DARKER → OFF.
    const btnWfAuto = this.$('btnWfAuto') as HTMLButtonElement;
    const updateAutoBtn = () => {
      const labels = ['AUTO', 'AUTO', 'DARK', 'DARK+'];
      btnWfAuto.textContent = labels[this.wfAutoMode];
      btnWfAuto.classList.toggle('active', this.wfAutoMode > 0);
    };
    updateAutoBtn();
    btnWfAuto.addEventListener('click', () => {
      this.wfAutoMode = (this.wfAutoMode + 1) % 4;
      updateAutoBtn();
      localStorage.setItem('radiom.wfAutoMode', String(this.wfAutoMode));
      this.wfHist.fill(0); this.wfHistFrames = 0;
      this.startWfAutoTimer();
    });
    if (this.wfAutoMode > 0) this.startWfAutoTimer();
    // Off-screen chevrons → one-tap recenter on the tuned freq.
    // SCAN buttons (one per non-numeric keypad page) — short tap is
    // routed through the document-level keypad handler → command('scan');
    // long-press starts the picker scanner using whatever frequency list
    // was last opened. onTap is a no-op so we don't toggle pause twice
    // (once here + once via the document handler).
    this.$$('button[data-cmd="scan"]').forEach(b => {
      this.bindFtxLongPress(b as HTMLElement, () => {}, () => this.startPickerScan());
    });
    this.$('wfChevL').addEventListener('click', () => { this.recenter(); this.refresh(); });
    this.$('wfChevR').addEventListener('click', () => { this.recenter(); this.refresh(); });
    // Push the persisted AGC mode to the button label on first paint;
    // the actual `setAgcMode` call is deferred until connect() opens
    // the SND socket (Kiwi rejects SET commands before that).
    this.refreshAgcButton();
    this.$('btnMute').addEventListener('click', () => this.toggleAux());
    this.$('psk31bCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('psk31bText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('PSK31B copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('psk31bClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('psk31bText').textContent = '';
    });
    this.bindFtxLongPress(this.$('btnWefax'), () => { this.exclusiveActivate('wefax'); this.toggleWefax(); }, () => this.openWefaxStationPicker());
    this.bindFtxLongPress(this.$('btnNavtex'),() => { this.exclusiveActivate('navtex');this.toggleNavtex(); }, () => this.openNavtexStationPicker());
    this.bindFtxLongPress(this.$('btnSitor'),
      () => { if (this.sitorOn) { this.toggleSitor(); return; }
              this.exclusiveActivate('sitor'); this.toggleSitor(); },
      () => this.openSitorStationPicker());
    this.bindFtxLongPress(this.$('btnPacket'),
      () => { if (this.packetOn) { this.togglePacket(); return; }
              this.exclusiveActivate('packet'); this.togglePacket(); },
      () => this.openPacketFreqPicker());
    this.bindFtxLongPress(this.$('btnPacketVhf'),
      () => { if (this.packetVhfOn) { this.togglePacketVhf(); return; }
              this.exclusiveActivate('packet-vhf'); this.togglePacketVhf(); },
      () => this.openPacketVhfFreqPicker());
    this.bindFtxLongPress(this.$('btnPacket9600'),
      () => { if (this.packet9600On) { this.togglePacket9600(); return; }
              this.exclusiveActivate('packet-9600'); this.togglePacket9600(); },
      () => this.openPacket9600FreqPicker());
    this.bindFtxLongPress(this.$('btnPacketIl2p'),
      () => { if (this.packetIl2pOn) { this.togglePacketIl2p(); return; }
              this.exclusiveActivate('packet-il2p'); this.togglePacketIl2p(); },
      // IL2P shares the VHF freq set — same Bell-202 carrier.
      () => this.openPacketVhfFreqPicker());
    this.bindFtxLongPress(this.$('btnWspr'),
      () => { if (this.wsprOn) { this.toggleWspr(); return; }
              this.exclusiveActivate('wspr'); this.toggleWspr(); },
      () => this.openWsprFreqPicker());
    this.bindFtxLongPress(this.$('btnJs8'),
      () => { if (this.js8On) { this.toggleJs8(); return; }
              this.exclusiveActivate('js8'); this.toggleJs8(); },
      () => this.openJs8FreqPicker());
    this.bindFtxLongPress(this.$('btnFst4'),
      () => { if (this.fst4On) { this.toggleFst4(); return; }
              this.exclusiveActivate('fst4'); this.toggleFst4(); },
      () => this.openFst4FreqPicker());
    this.$('btnScope').addEventListener('click', () => {
      if (this.scopeOn) { this.toggleScope(); return; }
      this.exclusiveActivate('scope');
      this.toggleScope();
    });
    this.$('btnThd').addEventListener('click', () => {
      if (this.thdOn) { this.toggleThd(); return; }
      this.exclusiveActivate('thd');
      this.toggleThd();
    });
    this.$('btnGray').addEventListener('click', () => {
      if (this.grayOn) { this.toggleGray(); return; }
      this.closeAllInfoTools('btnGray');
      this.exclusiveActivate('gray');
      this.toggleGray();
    });
    this.$('btnVect').addEventListener('click', () => {
      if (this.vectOn) { this.toggleVect(); return; }
      this.exclusiveActivate('vect');
      this.toggleVect();
    });
    this.$('btnEye').addEventListener('click', () => {
      if (this.iqEyeOn) { this.toggleIqEye(); return; }
      this.exclusiveActivate('eye');
      this.toggleIqEye();
    });
    this.$('eyeBaud').addEventListener('change', (e) => {
      e.stopPropagation();
      const v = parseFloat((e.target as HTMLSelectElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.iqEyeBaud = v;
        this.iqEyeSPS = 12000 / v;
        this.iqEyePhase = 0;
        this.iqEyePending = [];
        this.iqEyeNextDrawIdx = 0;
        this.updateEyeStatus();
      }
    });
    this.$('vectDelay').addEventListener('input', (e) => {
      e.stopPropagation();
      this.vectDelay = +(e.target as HTMLInputElement).value;
      this.updateVectStatus();
    });
    this.$('scopePolarity').addEventListener('click', (e) => {
      e.stopPropagation();
      this.scopeTriggerRising = !this.scopeTriggerRising;
      (this.$('scopePolarity') as HTMLElement).textContent = this.scopeTriggerRising ? '↑' : '↓';
      this.updateScopeStatus();
    });
    this.$('scopeLevel').addEventListener('input', (e) => {
      e.stopPropagation();
      const v = +(e.target as HTMLInputElement).value;
      this.scopeTriggerLevel = v / 100;        // -1..1
      this.updateScopeStatus();
    });
    this.$('wsprCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('wsprText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('WSPR copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('wsprClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('wsprText').textContent = '';
    });
    this.$('js8Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('js8Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('JS8 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('js8Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('js8Text').textContent = '';
    });
    this.$('fst4Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('fst4Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('FST4 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('fst4Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('fst4Text').textContent = '';
    });
    this.$('packetCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('packetText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('PACKET copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('packetClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('packetText').textContent = '';
    });
    this.bindFtxLongPress(this.$('btnWwv'),
      () => { if (this.wwvOn) { this.toggleWwv(); return; }
              this.exclusiveActivate('wwv'); this.toggleWwv(); },
      () => this.openWwvFreqPicker());
    this.$('wwvZoom').addEventListener('click', (e) => {
      e.stopPropagation();
      this.wwvZoomed = !this.wwvZoomed;
      this.wwvHistory.length = 0;
      this.drawWwv();
    });
    this.$('sitorCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('sitorText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('SITOR-B copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('sitorClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('sitorText').textContent = '';
    });
    this.$('navtexCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('navtexText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('NAVTEX copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('navtexClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('navtexText').textContent = '';
    });
    this.bindFtxLongPress(this.$('btnAle'),
      () => { this.exclusiveActivate('ale'); this.toggleAle(); },
      () => this.openAleFreqPicker());
    // HFDL: tap → toggle the decoder (tunes to the most-active HFDL
    // channel and switches to IQ mode if we were off; turns it back off
    // on a second tap). Long-press → list of all HFDL ground-station
    // frequencies; tapping a row switches channel without re-toggling.
    this.bindFtxLongPress(this.$('btnHfdl'),
      () => { this.exclusiveActivate('hfdl'); this.toggleHfdl(); },
      () => this.openHfdlFreqPicker());
    // iSB (Independent Sideband) — pure client-side IQ demod that
    // splits LSB → left speaker, USB → right. Requires the receiver
    // to be in 'iq' mode; toggleIsb flips it for us.
    this.$('btnIsb').addEventListener('click', () => {
      this.exclusiveActivate('isb');
      this.toggleIsb();
    });
    // LSB2 / USB2 — client-side SSB demodulators fed by the IQ-domain
    // cleanup chain. Provide a direct A/B against Kiwi's server-side
    // LSB / USB audio paths. Re-tapping the same side turns it off; the
    // other side hot-swaps without restarting the chain.
    this.$('btnLsb2').addEventListener('click', () => {
      this.exclusiveActivate('ssbf');
      this.toggleSsbFiltered('L');
    });
    this.$('btnUsb2').addEventListener('click', () => {
      this.exclusiveActivate('ssbf');
      this.toggleSsbFiltered('U');
    });
    // ECSS — one-shot carrier-align. Reads the latest waterfall frame,
    // finds the strongest peak within ±300 Hz of the cursor, retunes so
    // that peak sits ~30 Hz inside the SSB passband edge, and picks
    // USB/LSB based on which side has more audio-band energy.
    this.$('btnEcss').addEventListener('click', () => this.doEcssAlign());
    // WSPR-15 — long-period sibling of WSPR. Tap toggles standby; the
    // decoder waits for the next UTC :00/:15/:30/:45 boundary before
    // capturing. There's no freq picker — the 15-min variant lives
    // almost entirely on 137 / 475 kHz, so we default the dial there
    // on activation if the user isn't already on an LF/MF frequency.
    this.$('btnWspr15').addEventListener('click', () => {
      if (this.wspr15On) { this.toggleWspr15(); return; }
      this.exclusiveActivate('wspr15');
      this.toggleWspr15();
    });
    this.$('wspr15Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('wspr15Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('WSPR-15 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('wspr15Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('wspr15Text').textContent = '';
    });
    // JT9 — tap toggles standby; the decoder waits for the next UTC
    // minute boundary, then captures 50 s of audio and shells out to
    // the jt9 binary. Defaults the dial to 14.078 MHz USB (the busiest
    // JT9 sub-band, sharing 20 m with FT8 but offset 2 kHz) if the
    // operator isn't already in a typical JT9 spot.
    this.$('btnJt9').addEventListener('click', () => {
      if (this.jt9On) { this.toggleJt9(); return; }
      this.exclusiveActivate('jt9');
      this.toggleJt9();
    });
    this.$('jt9Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('jt9Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('JT9 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('jt9Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('jt9Text').textContent = '';
    });
    // JT65 — sibling of JT9, decoded by the same `jt9` binary with the
    // `-65` flag. Same UTC-minute alignment, slightly different audio
    // sub-band by convention (2 kHz higher than the JT9 dial spots).
    this.$('btnJt65').addEventListener('click', () => {
      if (this.jt65On) { this.toggleJt65(); return; }
      this.exclusiveActivate('jt65');
      this.toggleJt65();
    });
    this.$('jt65Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('jt65Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('JT65 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('jt65Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('jt65Text').textContent = '';
    });
    // Q65 — modern WSJT-X mode (2021). Same `jt9` binary, `-q -p 60`
    // for Q65-60 (1-min slots, the standard HF submode).
    this.$('btnQ65').addEventListener('click', () => {
      if (this.q65On) { this.toggleQ65(); return; }
      this.exclusiveActivate('q65');
      this.toggleQ65();
    });
    this.$('q65Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('q65Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('Q65 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('q65Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('q65Text').textContent = '';
    });
    // FST4W — beacon protocol on the FST4 modulation; modern WSPR
    // replacement. Same `fst4d` binary as FST4 with the extra `-W` flag.
    this.$('btnFst4w').addEventListener('click', () => {
      if (this.fst4wOn) { this.toggleFst4w(); return; }
      this.exclusiveActivate('fst4w');
      this.toggleFst4w();
    });
    this.$('fst4wCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('fst4wText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('FST4W copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('fst4wClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('fst4wText').textContent = '';
    });
    // STANAG 4285 — *detector*, not a decoder. The text log
    // accumulates lock-state transitions; clear wipes the history.
    this.$('btnStanag').addEventListener('click', () => {
      if (this.stanagOn) { this.toggleStanag(); return; }
      this.exclusiveActivate('stanag');
      this.toggleStanag();
    });
    this.$('stanagClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('stanagText').textContent = '';
    });
    // STANAG 4539 — sibling detector. Same carrier + symbol-rate
    // signature as 4285 but the preamble is 3.5× longer, so a strong
    // preamble lock is a cleaner mode-distinguishing fingerprint.
    this.$('btnStanag4539').addEventListener('click', () => {
      if (this.stanag4539On) { this.toggleStanag4539(); return; }
      this.exclusiveActivate('stanag4539');
      this.toggleStanag4539();
    });
    this.$('stanag4539Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('stanag4539Text').textContent = '';
    });
    // Feld-Hellschreiber — visual decode only. The canvas scrolls
    // left one column per pixel-clock tick (~8 ms per column), so a
    // single character takes ~50 columns and the canvas typically
    // shows the last 5-10 seconds of received text.
    this.$('btnHell').addEventListener('click', () => {
      if (this.hellOn) { this.toggleHell(); return; }
      this.exclusiveActivate('hell');
      this.toggleHell();
    });
    this.$('hellClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearHellCanvas();
    });
    // SSTV — analog (Robot/Scottie/Martin/PD/Pasokon/Wraase). Server
    // spawns slowrxd; each completed image arrives as a base64 PNG
    // that we drop straight into an <img>. The SAVE button downloads
    // the current image to disk.
    this.$('btnSstv').addEventListener('click', () => {
      if (this.sstvOn) { this.toggleSstv(); return; }
      this.exclusiveActivate('sstv');
      this.toggleSstv();
    });
    this.$('sstvSave').addEventListener('click', (e) => {
      e.stopPropagation();
      this.saveSstvImage();
    });
    this.$('sstvClear').addEventListener('click', (e) => {
      e.stopPropagation();
      (this.$('sstvImage') as HTMLImageElement).src = '';
      this.sstvLastImage = null;
    });
    // MCW — Modulated CW. The existing CW decoder runs on whatever
    // audio comes out of the demod chain, so MCW is just "AM mode +
    // CW decoder on." Tapping the button arranges both; tapping again
    // tears CW down and leaves the AM mode (operator can switch from
    // there). Reuses #cwPanel since the output is the same dits/dahs.
    this.$('btnMcw').addEventListener('click', () => {
      this.exclusiveActivate('cw');
      this.toggleMcw();
    });
    // FreeDV — open-source HF digital voice. Server spawns the codec2
    // `freedv_rx` modem, decodes the OFDM signal, and streams decoded
    // 8 kHz speech back to the client AudioContext. Mode buttons in
    // the panel switch submodes by restarting freedv_rx with the new
    // flag (freedv_rx is mode-pinned at startup).
    this.bindFtxLongPress(this.$('btnFreedv'),
      () => {
        if (this.freedvOn) { this.toggleFreedv(); return; }
        this.exclusiveActivate('freedv');
        this.toggleFreedv();
      },
      () => this.openFreedvFreqPicker());
    for (const [id, mode] of [
      ['freedvMode1600', '1600'],
      ['freedvMode700C', '700C'],
      ['freedvMode700D', '700D'],
      ['freedvMode700E', '700E'],
      ['freedvMode2020', '2020'],
    ] as const) {
      this.$(id).addEventListener('click', () => this.setFreedvMode(mode));
    }
    // Throb — fldigi-vendored 9-tone PPM chat mode. Submode buttons
    // restart the decoder pointed at the new flag.
    this.$('btnThrob').addEventListener('click', () => {
      if (this.throbOn) { this.toggleThrob(); return; }
      this.exclusiveActivate('throb');
      this.toggleThrob();
    });
    for (const [id, mode] of [
      ['throbMode1',  'throb1'],
      ['throbMode2',  'throb2'],
      ['throbMode4',  'throb4'],
      ['throbModeX1', 'throbx1'],
      ['throbModeX2', 'throbx2'],
      ['throbModeX4', 'throbx4'],
    ] as const) {
      this.$(id).addEventListener('click', () => this.setThrobMode(mode));
    }
    this.$('throbCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('throbText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('Throb copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('throbClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('throbText').textContent = '';
    });
    // JT4 — original WSJT 4-FSK weak-signal mode. UTC-minute slots,
    // same `jt9` binary as JT9/JT65/Q65 with the `-4` flag.
    this.$('btnJt4').addEventListener('click', () => {
      if (this.jt4On) { this.toggleJt4(); return; }
      this.exclusiveActivate('jt4');
      this.toggleJt4();
    });
    this.$('jt4Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('jt4Text').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('JT4 copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('jt4Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('jt4Text').textContent = '';
    });
    // SELCAL — aviation HF selective-calling decoder via multimon-ng.
    // Aero HF channels are USB; the decoder demodulates the 2-of-16
    // tone codes used to alert specific aircraft on shared HF nets.
    this.$('btnPocs').addEventListener('click', () => {
      if (this.pocsOn) { this.togglePocs(); return; }
      this.exclusiveActivate('pocs');
      this.togglePocs();
    });
    // DSD — one binary, seven UI buttons. Each handler engages
    // the same decoder with a different `mode` flag; re-tapping the
    // active mode toggles it off. Switching from one mode to another
    // tears down the current DsdDecoder and spawns a fresh one.
    const wireDsd = (btnId: string, mode: DsdMode) => {
      this.$(btnId).addEventListener('click', () => {
        if (this.dsdOn && this.dsdMode === mode) { this.toggleDsd(mode); return; }
        if (this.dsdOn) this.toggleDsd(this.dsdMode);
        this.exclusiveActivate('dsd');
        this.toggleDsd(mode);
      });
    };
    wireDsd('btnDstar',  'dstar');
    wireDsd('btnDmr',    'dmr');
    wireDsd('btnDmrs',   'dmrs');
    wireDsd('btnNxdn48', 'nxdn48');
    wireDsd('btnNxdn96', 'nxdn96');
    wireDsd('btnYsf',    'ysf');
    wireDsd('btnDpmr',   'dpmr');
    wireDsd('btnM17',    'm17');
    wireDsd('btnP25p1',  'p25p1');
    wireDsd('btnP25p2',  'p25p2');
    // multimon-ng extra modes — same toggle pattern as DSD, single
    // decoder, swap mode on activation.
    const wireMulti = (btnId: string, mode: MultimonMode) => {
      this.$(btnId).addEventListener('click', () => {
        if (this.multimonOn && this.multimonMode === mode) { this.toggleMultimon(mode); return; }
        if (this.multimonOn) this.toggleMultimon(this.multimonMode);
        this.exclusiveActivate('multimon');
        this.toggleMultimon(mode);
      });
    };
    wireMulti('btnFlex',     'flex');
    wireMulti('btnFlexNext', 'flex_next');
    // ERMES intentionally not wired — multimon-ng has no ERMES demod
    // and the protocol is decommissioned. Button stays hidden.
    wireMulti('btnDtmf',     'dtmf');
    wireMulti('btnZvei',     'zvei');
    wireMulti('btnAfsk1200', 'afsk1200');
    wireMulti('btnUfsk1200', 'ufsk1200');
    wireMulti('btnClipFsk',  'clipfsk');
    wireMulti('btnFmsFsk',   'fmsfsk');
    wireMulti('btnAfsk2400', 'afsk2400');
    wireMulti('btnHapn4800', 'hapn4800');
    wireMulti('btnFsk9600',  'fsk9600');
    wireMulti('btnDpzvei',   'dpzvei');
    wireMulti('btnCwm',      'morse');
    wireMulti('btnX10',      'x10');
    wireMulti('btnEas',      'eas');
    this.$('multimonCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('multimonText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('multimon log copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('multimonClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('multimonText').textContent = '';
    });
    // Vendored decoders — wire 6 buttons through one shared helper.
    const wireVendored = (btnId: string,
                         kind: 'msk144'|'ais'|'acars'|'tetrapol'|'op25'|'lrpt',
                         endpoint: string,
                         sink: 'onMsk144'|'onAis'|'onAcars'|'onTetrapol'|'onOp25'|'onLrpt') => {
      this.$(btnId).addEventListener('click', () => {
        if (this.vendoredOn && this.vendoredKind === kind) { this.toggleVendored(kind, endpoint, sink); return; }
        if (this.vendoredOn && this.vendoredKind)
          this.toggleVendored(this.vendoredKind,
            this.vendoredEndpointFor(this.vendoredKind),
            this.vendoredSinkFor(this.vendoredKind));
        this.exclusiveActivate('vendored');
        this.toggleVendored(kind, endpoint, sink);
      });
    };
    wireVendored('btnMsk144',  'msk144',  '/ws/decode/msk144',   'onMsk144');
    wireVendored('btnAis',     'ais',     '/ws/decode/ais',      'onAis');
    wireVendored('btnAcars',   'acars',   '/ws/decode/acars',    'onAcars');
    // TETRAPOL intentionally not wired — tetrapol_dump needs a
    // separate demodulator (GR Python flowgraph) we don't ship.
    // OP25 needs IQ (cs16 interleaved I,Q) — not audio — so it routes
    // through the 'lrpt' kind (the existing IQ-in plumbing used by
    // ADS-B / JAERO / rtl_433 / sonde / etc.) instead of an audio
    // sink. Endpoint stays /ws/decode/op25 so the bridge can pick
    // its OP25-specific args.
    wireVendored('btnOp25',    'lrpt',    '/ws/decode/op25',     'onLrpt');
    // LRPT goes through the existing wire helper but with RF auto-set.
    this.$('btnLrpt').addEventListener('click', () => {
      if (!(this.vendoredOn && this.vendoredKind === 'lrpt')) applyRfProfile('btnLrpt');
      if (this.vendoredOn && this.vendoredKind === 'lrpt') { this.toggleVendored('lrpt', '/ws/decode/lrpt', 'onLrpt'); return; }
      if (this.vendoredOn && this.vendoredKind)
        this.toggleVendored(this.vendoredKind,
          this.vendoredEndpointFor(this.vendoredKind),
          this.vendoredSinkFor(this.vendoredKind));
      this.exclusiveActivate('vendored');
      this.toggleVendored('lrpt', '/ws/decode/lrpt', 'onLrpt');
    });
    // satdump pipeline variants — same kind/endpoint as LRPT but the
    // client appends ?pipeline= to the WS URL so the bridge runs the
    // right satdump pipeline. Reused 'lrpt' kind because the bridge
    // is unchanged. RF auto-set first.
    this.$('btnHrpt').addEventListener('click', () => { applyRfProfile('btnHrpt'); this.toggleSatdump('hrpt'); });
    this.$('btnApt') .addEventListener('click', () => { applyRfProfile('btnApt');  this.toggleSatdump('apt');  });
    // IQ-input vendored binaries — same pattern as LRPT (route through
    // player.onIq, not an audio sink). Each entry describes the dial
    // freq (kHz), the IQ output rate the bridge should emit, the WS
    // output format (UC8 for dump978; int16 for the rest), and whether
    // the active source must be rtl_tcp (Kiwi can't reach GHz bands).
    type RfProfile = { freqKHz: number; outHz: number; fmt: 'uc8' | 'int16'; rtlOnly: boolean };
    const ironRfProfile: Record<string, RfProfile> = {
      btnAdsb:   { freqKHz: 1_090_000, outHz: 2_000_000, fmt: 'int16', rtlOnly: true  },
      btnVdl2:   { freqKHz:   136_975, outHz: 1_050_000, fmt: 'int16', rtlOnly: true  },
      btnUat:    { freqKHz:   978_000, outHz: 2_083_334, fmt: 'uc8',   rtlOnly: true  },
      btnWmbus:  { freqKHz:   868_950, outHz: 1_600_000, fmt: 'int16', rtlOnly: true  },
      btnRds:    { freqKHz:   100_000, outHz:   240_000, fmt: 'int16', rtlOnly: true  },
      btnHrpt:   { freqKHz: 1_700_000, outHz: 3_000_000, fmt: 'int16', rtlOnly: true  },
      btnApt:    { freqKHz:   137_500, outHz:    50_000, fmt: 'int16', rtlOnly: false },
      btnLrpt:   { freqKHz:   137_900, outHz:   150_000, fmt: 'int16', rtlOnly: false },
      btnJaero:  { freqKHz: 1_545_000, outHz: 1_000_000,  fmt: 'int16', rtlOnly: true  }, // IQ-in via inmarsat-sniffer fifo
      btnCospas: { freqKHz:   406_025, outHz: 0,          fmt: 'int16', rtlOnly: true  }, // audio-in
      btnStdc:   { freqKHz: 1_537_700, outHz: 1_000_000, fmt: 'int16', rtlOnly: true  }, // IQ-in via inmarsat-sniffer fifo (shares the JAERO binary)
      btnRtl433: { freqKHz:   433_920, outHz:   250_000,  fmt: 'uc8',   rtlOnly: true  }, // IQ-in
      btnSonde:  { freqKHz:   403_000, outHz: 0,          fmt: 'int16', rtlOnly: true  }, // audio-in (NBFM demod)
      btnLora:   { freqKHz:   868_100, outHz:   500_000,  fmt: 'int16', rtlOnly: true  }, // EU868 LoRaWAN CH0
      btnLtr:    { freqKHz:   851_000, outHz:    24_000,  fmt: 'int16', rtlOnly: true  }, // 851 MHz US business UHF default
      btnTimesig:{ freqKHz:        77.5, outHz: 0,        fmt: 'int16', rtlOnly: false }, // DCF77 LF — works on Kiwi
    };
    const applyRfProfile = (btnId: string) => {
      const p = ironRfProfile[btnId];
      if (!p) return;
      if (p.rtlOnly && !this.isRtlSource()) {
        this.banner(`${btnId.replace('btn','').toUpperCase()} needs an rtl_tcp source — switch RTL.`, 3500);
        return;
      }
      // Auto-tune the dial. setFreqKHz on the active client takes effect
      // immediately; the dial readout follows on the next refresh().
      this.freqKHz = p.freqKHz;
      this.client?.setFreqKHz?.(p.freqKHz);
      // Tell the rtl_tcp bridge to emit at the rate the decoder wants.
      const rtl = this.client as RtlTcpClient | null;
      if (rtl && typeof rtl.setOutRate === 'function') {
        if (p.outHz > 0) rtl.setOutRate(p.outHz);
        rtl.setOutFormat(p.fmt);
      }
      this.refresh();
    };
    const wireVendoredRf = (btnId: string, kind: 'lrpt'|'msk144', endpoint: string,
                            sink: 'onMsk144'|'onLrpt') => {
      this.$(btnId).addEventListener('click', () => {
        if (!(this.vendoredOn && this.vendoredKind === kind)) {
          applyRfProfile(btnId);
        }
        if (this.vendoredOn && this.vendoredKind === kind) { this.toggleVendored(kind, endpoint, sink); return; }
        if (this.vendoredOn && this.vendoredKind)
          this.toggleVendored(this.vendoredKind,
            this.vendoredEndpointFor(this.vendoredKind),
            this.vendoredSinkFor(this.vendoredKind));
        this.exclusiveActivate('vendored');
        this.toggleVendored(kind, endpoint, sink);
      });
    };
    wireVendoredRf('btnAdsb',  'lrpt', '/ws/decode/adsb',  'onLrpt');
    wireVendoredRf('btnVdl2',  'lrpt', '/ws/decode/vdl2',  'onLrpt');
    wireVendoredRf('btnUat',   'lrpt', '/ws/decode/uat',   'onLrpt');
    // WMBus retired — wmbusmeters needs pre-demodulated telegrams,
    // not raw IQ. Use rtl_433 at 868.300 MHz for wmbus traffic instead.
    wireVendoredRf('btnRds',   'lrpt', '/ws/decode/rds',   'onLrpt');
    // DSC reuses the multimon-ng bridge.
    wireMulti('btnDsc', 'dsc');
    // 5-tone selective-calling family — same multimon-ng pipeline.
    wireMulti('btnCcir',  'ccir');
    wireMulti('btnCcitt', 'ccitt');
    wireMulti('btnEea',   'eea');
    wireMulti('btnEia',   'eia');
    wireMulti('btnEuro',  'euro');
    // JAERO + Cospas-Sarsat — audio-in vendored binaries. Use the
    // 'msk144' kind (audio-routed via the sink) with dedicated
    // endpoints so the toggle state machine knows to send PCM samples
    // through the player's onMsk144 hook into the decoder bridge.
    this.$('btnJaero').addEventListener('click', () => {
      applyRfProfile('btnJaero');
      // inmarsat-sniffer is IQ-in, not audio-in — switch routing to
      // the IQ branch (kind='lrpt' is the IQ-routing flag).
      if (this.vendoredOn && this.vendoredKind === 'lrpt') this.toggleVendored('lrpt', '/ws/decode/jaero', 'onLrpt');
      else { this.exclusiveActivate('vendored'); this.toggleVendored('lrpt', '/ws/decode/jaero', 'onLrpt'); }
    });
    this.$('btnCospas').addEventListener('click', () => {
      applyRfProfile('btnCospas');
      if (this.vendoredOn && this.vendoredKind === 'msk144') this.toggleVendored('msk144', '/ws/decode/cospas', 'onMsk144');
      else { this.exclusiveActivate('vendored'); this.toggleVendored('msk144', '/ws/decode/cospas', 'onMsk144'); }
    });
    // STD-C now uses inmarsat-sniffer (the JAERO binary) with
    // --mode=stdc. That's IQ-in (cs16 over fifo), so route via the
    // 'lrpt' kind which carries cs16 IQ from rtl_tcp/OWRX, not the
    // 'msk144' kind which carries audio.
    this.$('btnStdc').addEventListener('click', () => {
      applyRfProfile('btnStdc');
      if (this.vendoredOn && this.vendoredKind === 'lrpt') this.toggleVendored('lrpt', '/ws/decode/stdc', 'onLrpt');
      else { this.exclusiveActivate('vendored'); this.toggleVendored('lrpt', '/ws/decode/stdc', 'onLrpt'); }
    });
    // rtl_433 — IQ-in (routes through player.onIq via the 'lrpt' kind).
    this.$('btnRtl433').addEventListener('click', () => {
      applyRfProfile('btnRtl433');
      if (this.vendoredOn && this.vendoredKind === 'lrpt') this.toggleVendored('lrpt', '/ws/decode/rtl433', 'onLrpt');
      else { this.exclusiveActivate('vendored'); this.toggleVendored('lrpt', '/ws/decode/rtl433', 'onLrpt'); }
    });
    // SONDE — audio-in. Default sub-mode is rs41 (most common globally).
    this.$('btnSonde').addEventListener('click', () => {
      applyRfProfile('btnSonde');
      if (this.vendoredOn && this.vendoredKind === 'msk144') this.toggleVendored('msk144', '/ws/decode/sonde?sub=rs41', 'onMsk144');
      else { this.exclusiveActivate('vendored'); this.toggleVendored('msk144', '/ws/decode/sonde?sub=rs41', 'onMsk144'); }
    });
    // LoRa — IQ-in. Default params: BW=125k, SF=7, CR=4/5, EU868 CH0.
    this.$('btnLora').addEventListener('click', () => {
      applyRfProfile('btnLora');
      const ep = '/ws/decode/lora?bw=125000&sf=7&cr=1&rate=500000';
      if (this.vendoredOn && this.vendoredKind === 'lrpt') this.toggleVendored('lrpt', ep, 'onLrpt');
      else { this.exclusiveActivate('vendored'); this.toggleVendored('lrpt', ep, 'onLrpt'); }
    });
    // LTR — IQ-in via GopherTrunk. Decimated to 24 kHz for the
    // sub-audible signalling decode.
    this.$('btnLtr').addEventListener('click', () => {
      applyRfProfile('btnLtr');
      if (this.vendoredOn && this.vendoredKind === 'lrpt') this.toggleVendored('lrpt', '/ws/decode/ltr', 'onLrpt');
      else { this.exclusiveActivate('vendored'); this.toggleVendored('lrpt', '/ws/decode/ltr', 'onLrpt'); }
    });
    // TIME-signal decoder retired — no AM-envelope/pulse-width demod
    // layer to turn LF audio into bits for dokutan/dcf77-decode.
    // Use btnTimeStations (frequency picker) for manual time-station
    // listening; no automated decoding for now.
    this.$('vendoredCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('vendoredText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('log copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('vendoredClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('vendoredText').textContent = '';
    });
    this.$('vendoredImgSave').addEventListener('click', (e) => {
      e.stopPropagation();
      const img = this.$('vendoredImg') as HTMLImageElement;
      const url = img.dataset.blobUrl;
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = img.dataset.fileName || 'lrpt.png';
      a.click();
    });
    this.$('dsdCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('dsdText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('DSD log copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('dsdClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('dsdText').textContent = '';
    });
    // DSD output gain — persistent across mode switches via
    // localStorage. Visible in the panel as "<gain>×". Active only
    // when a DSD decoder is up; clamped 0..6.
    const setDsdGain = (g: number) => {
      const clamped = Math.max(0, Math.min(6, g));
      this.dsdGain = clamped;
      localStorage.setItem('radiom.dsdGain', String(clamped));
      const lbl = this.$('dsdVolVal');
      if (lbl) lbl.textContent = `${clamped.toFixed(1)}×`;
      this.dsdDecoder?.setGain(clamped);
    };
    this.$('dsdVolDown').addEventListener('click', (e) => { e.stopPropagation(); setDsdGain(this.dsdGain - 0.2); });
    this.$('dsdVolUp').addEventListener('click',   (e) => { e.stopPropagation(); setDsdGain(this.dsdGain + 0.2); });
    // Restore persisted gain at boot so the readout matches reality.
    const persisted = parseFloat(localStorage.getItem('radiom.dsdGain') ?? '1.8');
    if (Number.isFinite(persisted)) {
      this.dsdGain = persisted;
      this.$('dsdVolVal').textContent = `${persisted.toFixed(1)}×`;
    }
    this.$('pocsCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('pocsText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('POCSAG copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('pocsClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('pocsText').textContent = '';
    });
    this.$('btnSelcal').addEventListener('click', () => {
      if (this.selcalOn) { this.toggleSelcal(); return; }
      this.exclusiveActivate('selcal');
      this.toggleSelcal();
    });
    this.$('selcalCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('selcalText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('SELCAL copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('selcalClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('selcalText').textContent = '';
    });
    // QRSS — slow-CW grabber. Tap toggles the panel; speed buttons inside
    // the panel switch Q3 / Q10 / Q30 / Q60 by changing the column-emit
    // period. Long-press → 30 m sub-band quick-tune (10.140 MHz USB).
    this.bindFtxLongPress(this.$('btnQrss'),
      () => { this.exclusiveActivate('qrss'); this.toggleQrss(); },
      () => this.tuneQrssBand());
    this.$('qrssMode3') .addEventListener('click', () => this.setQrssMode('q3'));
    this.$('qrssMode10').addEventListener('click', () => this.setQrssMode('q10'));
    this.$('qrssMode30').addEventListener('click', () => this.setQrssMode('q30'));
    this.$('qrssMode60').addEventListener('click', () => this.setQrssMode('q60'));
    this.$('qrssMode120').addEventListener('click', () => this.setQrssMode('q120'));
    this.$('qrssDfcw').addEventListener('click', () => this.toggleQrssDfcw());
    this.$('qrssClear').addEventListener('click', () => this.clearQrssCanvas());
    this.$('hfdlCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('hfdlText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('HFDL copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('hfdlClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('hfdlText').textContent = '';
    });
    this.$('btnIqView').addEventListener('click', () => this.toggleIqView());
    this.$('iqViewExt').addEventListener('click', (e) => { e.stopPropagation(); this.toggleIqViewExt(); });
    this.$('btnAcon').addEventListener('click', () => this.toggleAcon());
    this.$('aconExt').addEventListener('click', (e) => { e.stopPropagation(); this.toggleAconExt(); });
    this.$('aconLockBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.aconLockOn = !this.aconLockOn;
      (this.$('aconLockBtn') as HTMLElement).classList.toggle('active', this.aconLockOn);
      this.aconBridge?.setCostas(this.aconLockOn);
      this.updateAconStatus();
    });
    this.$('aconPreset').addEventListener('change', (e) => {
      e.stopPropagation();
      this.applyAconPreset((e.target as HTMLSelectElement).value);
    });
    this.$('aconCenter').addEventListener('change', (e) => {
      e.stopPropagation();
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v >= 0) {
        this.aconCenterHz = v;
        this.aconBridge?.setCenter(v);
        this.updateAconStatus();
      }
    });
    this.$('aconBw').addEventListener('change', (e) => {
      e.stopPropagation();
      const v = parseFloat((e.target as HTMLInputElement).value);
      if (Number.isFinite(v) && v > 0) {
        this.aconBwHz = v;
        this.aconBridge?.setBandwidth(v);
        this.updateAconStatus();
      }
    });
    this.$('iqClockBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.iqClockOn = !this.iqClockOn;
      (this.$('iqClockBtn') as HTMLElement).classList.toggle('active', this.iqClockOn);
      if (this.iqClockOn) this.rebuildIqClockMM();
      else this.iqClockMM = null;
      this.updateIqClockStatus();
    });
    this.$('iqClockBaud').addEventListener('change', (e) => {
      e.stopPropagation();
      const v = parseFloat((e.target as HTMLSelectElement).value);
      if (!Number.isFinite(v) || v < 0) return;
      if (v === 0) {
        // AUTO mode — defer omega until OM gives us a first estimate.
        this.iqAutoOn = true;
        this.iqAutoRingW = 0;
        this.iqAutoRingFill = 0;
        this.iqAutoLastRs = 0;
        this.iqAutoLastConf = 0;
        this.iqAutoLastCandRs = 0;
        this.iqAutoLastCandConf = 0;
        this.iqAutoLastEstAt = 0;
        // Seed the MM block at a plausible mid-band rate so it can run
        // until the first estimate lands (~0.7 s of accumulated IQ).
        this.iqClockBaud = 100;
        this.iqClockSPS = 12000 / 100;
        if (this.iqClockOn) this.rebuildIqClockMM();
      } else {
        this.iqAutoOn = false;
        this.iqClockBaud = v;
        this.iqClockSPS = 12000 / v;
        if (this.iqClockOn) this.rebuildIqClockMM();
      }
      this.updateIqClockStatus();
    });
    this.$('btnBeacons').addEventListener('click', () => this.openBeaconsFreqPicker());
    this.$('btnVlfb').addEventListener('click', () => this.openVlfbFreqPicker());
    this.$('btnTimeStations').addEventListener('click', () => this.openTimeStationsPicker());
    this.$('btnVolmet').addEventListener('click', () => this.openVolmetPicker());
    this.$('btnMaritime').addEventListener('click', () => this.openMaritimePicker());
    this.$('btnMilv').addEventListener('click', () => this.openMilvPicker());
    this.$('btnScien').addEventListener('click', () => this.openScienPicker());
    this.$('btnNdb').addEventListener('click',     () => this.openNdbPicker());
    this.$('btnNumbers').addEventListener('click', () => this.openNumbersPicker());
    this.$('btnHfgcs').addEventListener('click',   () => this.openHfgcsPicker());
    this.$('btnAero').addEventListener('click',    () => this.openAeroPicker());
    this.$('btnGmdss').addEventListener('click',   () => this.openGmdssPicker());
    this.$('btnPirate').addEventListener('click',  () => this.openPiratePicker());
    this.$('btnMars').addEventListener('click',    () => this.openMarsPicker());
    this.$('btnWfax').addEventListener('click',    () => this.openWfaxPicker());
    this.$('btnStanag2').addEventListener('click', () => this.openStanagPicker());
    this.$('btnCb').addEventListener('click',      () => this.openCbPicker());
    this.$('btnDrm').addEventListener('click',     () => this.openDrmPicker());
    this.$('btnMwdx').addEventListener('click',    () => this.openMwdxPicker());
    this.$('btnLw').addEventListener('click',      () => this.openLwPicker());
    this.$('btnDgps').addEventListener('click',    () => this.openDgpsPicker());
    this.$('btnSwbroad').addEventListener('click', () => this.openSwbroadPicker());
    this.$('btnTrafnets').addEventListener('click',() => this.openTrafnetsPicker());
    // PACTOR has no open-source decoder (proprietary SCS waveform);
    // the button is purely a tuning aid. Single tap explains that;
    // long-press surfaces the freq list.
    this.bindFtxLongPress(this.$('btnPactor'),
      () => this.banner('PACTOR — no FOSS decoder. Long-press for freq list.', 2500),
      () => this.openPactorPicker());
    this.$('btnStanag3g').addEventListener('click',() => this.openStanag3gPicker());
    this.$('btnCoast').addEventListener('click',   () => this.openCoastPicker());
    this.$('btnEmcomm').addEventListener('click',  () => this.openEmcommPicker());
    this.$('btnEmbassy').addEventListener('click', () => this.openEmbassyPicker());
    this.$('btnClandestine').addEventListener('click', () => this.openClandestinePicker());
    this.$('btnRusmil').addEventListener('click',  () => this.openRusmilPicker());
    this.$('btnCap').addEventListener('click',     () => this.openCapPicker());
    this.$('btnMept').addEventListener('click',    () => this.openMeptPicker());
    this.$('btnCoastcw').addEventListener('click', () => this.openCoastcwPicker());
    this.$('btnSkynet').addEventListener('click',  () => this.openSkynetPicker());
    this.$('btnDxcluster').addEventListener('click',() => this.openDxclusterPicker());
    this.$('btnAirdrill').addEventListener('click',() => this.openAirdrillPicker());
    this.$('btnAfricaBc').addEventListener('click',() => this.openAfricaBcPicker());
    this.$('btnAsiaBc').addEventListener('click',  () => this.openAsiaBcPicker());
    this.$('btnLatamBc').addEventListener('click', () => this.openLatamBcPicker());
    this.$('btnMarpac').addEventListener('click',  () => this.openMarpacPicker());
    this.$('btnMarsEu').addEventListener('click',  () => this.openMarsEuPicker());
    this.$('btnHfdm').addEventListener('click',    () => this.openHfdmPicker());
    // SITOR-A is half-duplex ARQ — undecodable as a passive listener.
    // Same pattern as PACTOR: explain on tap, freq list on long-press.
    this.bindFtxLongPress(this.$('btnSitorA'),
      () => this.banner('SITOR-A — ARQ, undecodable passively. Long-press for freq list.', 2500),
      () => this.openSitorAPicker());
    // AMTOR re-uses the SITOR-B decoder under the hood. Short tap →
    // toggle SITOR-B (so the user actually hears/sees a decode rather
    // than landing in a freq list); long-press → AMTOR freq picker.
    this.bindFtxLongPress(this.$('btnAmtor'),
      () => { if (this.sitorOn) { this.toggleSitor(); return; }
              this.exclusiveActivate('sitor'); this.toggleSitor(); },
      () => this.openAmtorPicker());
    this.$('btnLists').addEventListener('click',   () => this.openListsPicker());
    this.$('btnSPlot').addEventListener('click', () => this.toggleSPlot());
    this.bindFtxLongPress(
      this.$('btnSrch') as HTMLElement,
      () => this.toggleSrch(),
      () => this.openSrchPicker(),
    );
    this.$('btnFmnt').addEventListener('click', () => this.toggleFmnt());
    this.$('sPlotCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const samples = this.sPlotAllSamples;
      if (!samples.length) { this.banner('No samples to copy', 1200); return; }
      // CSV: ISO timestamp + dBm. Header line first so spreadsheets / pandas
      // pick up column names automatically.
      const lines = ['time_iso,dbm'];
      for (const s of samples) {
        lines.push(`${new Date(s.t).toISOString()},${s.dbm.toFixed(2)}`);
      }
      const text = lines.join('\n');
      this.copyText(text).then(
        () => this.banner(`S-meter ${samples.length} samples copied`, 1500),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('btnSDial').addEventListener('click', () => this.toggleSDial());
// Page-5 IQ visualizers — single state machine, one panel open at a time.
    for (const k of ['sfrc','dopp','zoom','antc','ppmc','rfi','wusb','wlsb','dlds','kurt'] as const) {
      const btn = this.root.querySelector('#btn' + k.charAt(0).toUpperCase() + k.slice(1));
      btn?.addEventListener('click', () => this.toggleIq5(k));
    }
    // OTHR — short tap toggles the panel; long press opens the OTHR
    // frequency picker (known over-the-horizon-radar centre frequencies).
    this.bindFtxLongPress(this.$('btnOthr'),
      () => this.toggleIq5('othr'),
      () => this.openOthrFreqPicker());
    // RFI canvas tap → label / delete the row under the click.
    // SFRC copy button → CSV-style snapshot of the rolling 60-sec strike
    // counts to the clipboard.
    this.$('sfrcCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const total = this.sfrcCounts.reduce((s, v) => s + v, 0);
      const peak  = Math.max(0, ...this.sfrcCounts);
      const ts    = new Date().toISOString();
      const csv   = [
        `# radiom SFRC snapshot ${ts}`,
        `# total=${total}  peak=${peak}/s  noise=${this.sfrcRecentMag.toFixed(2)}`,
        `# 60 columns = strikes per second, oldest first`,
        this.sfrcCounts.join(','),
      ].join('\n');
      this.copyText(csv).then(
        () => this.banner('SFRC snapshot copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    // DOPP copy button → CSV of carrier-Doppler history.
    this.$('doppCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const ts = new Date().toISOString();
      const hist = this.doppHistory;
      const cur = hist.length ? hist[hist.length - 1].hz : 0;
      const lines = [
        `# radiom DOPP snapshot ${ts}`,
        `# current Δf=${cur.toFixed(3)} Hz · samples=${hist.length}`,
        `# epoch_ms,delta_hz`,
      ];
      for (const p of hist) lines.push(`${p.t},${p.hz.toFixed(4)}`);
      this.copyText(lines.join('\n')).then(
        () => this.banner('DOPP snapshot copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    // RFI copy button → CSV snapshot of the emitter catalogue.
    this.$('rfiCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const ts = new Date().toISOString();
      const sorted = this.rfiCatalogue.slice().sort((a, b) => a.hz - b.hz);
      const lines = [
        `# radiom RFI catalogue ${ts}`,
        `# dial=${this.freqKHz.toFixed(3)} kHz · ${sorted.length} emitter${sorted.length === 1 ? '' : 's'}`,
        `# offset_hz,abs_khz,peak_db,age_seconds`,
      ];
      const now = Date.now();
      for (const c of sorted) {
        const age = Math.round((now - c.seen) / 1000);
        const absKHz = (this.freqKHz + c.hz / 1000).toFixed(3);
        lines.push(`${c.hz.toFixed(0)},${absKHz},${c.db.toFixed(1)},${age}`);
      }
      this.copyText(lines.join('\n')).then(
        () => this.banner('RFI catalogue copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('driftCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const samples = this.driftAllSamples;
      if (!samples.length) { this.banner('No samples to copy', 1200); return; }
      // CSV: ISO timestamp, audio peak Hz, dial freq kHz, demod mode,
      // signal freq kHz (LCD ± offset). Header row first.
      const lines = ['time_iso,audio_peak_hz,dial_khz,mode,signal_khz'];
      for (const s of samples) {
        const sign = s.mode === 'lsb' ? -1 : 1;
        const sigKHz = s.freqKHz + sign * s.hz / 1000;
        lines.push(`${new Date(s.t).toISOString()},${s.hz.toFixed(3)},${s.freqKHz.toFixed(3)},${s.mode},${sigKHz.toFixed(6)}`);
      }
      const text = lines.join('\n');
      this.copyText(text).then(
        () => this.banner(`Drift ${samples.length} samples copied`, 1500),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('aleCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('aleText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('ALE copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('aleClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('aleText').textContent = '';
    });
    this.$('wefaxClear').addEventListener('click', (e) => { e.stopPropagation(); this.clearWefaxCanvas(); });
    this.$('wefaxSave').addEventListener('click',  (e) => { e.stopPropagation(); this.saveWefaxCanvas(); });
    this.$('wefaxExt').addEventListener('click',   (e) => { e.stopPropagation(); this.toggleWefaxExt(); });
    this.$('wefaxCanvas').addEventListener('click', (e) => this.onWefaxCanvasClick(e as MouseEvent));
    this.$('faxScanBars').addEventListener('click', () => this.toggleFaxScanPause());
    this.bindRepeatPress(this.$('btnPitchMinus'), () => this.movePitchCursor(-1));
    this.bindRepeatPress(this.$('btnPitchPlus'),  () => this.movePitchCursor(+1));
    this.$('btnPitchSet').addEventListener('click',   () => this.setPitchFromCursor());
    // The AUTO trigger button has been removed from the waterfall.
    // toggleAuto / autoPanel are kept in place in case the trigger is
    // reinstated later. Tapping the panel itself still dismisses it.
    this.$('autoPanel').addEventListener('click', () => { if (this.autoOn) this.toggleAuto(); });
    this.$('pskCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('pskText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('PSK copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('pskClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('pskText').textContent = '';
    });
    this.$('oliviaCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('oliviaText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('OLIVIA copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('oliviaClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('oliviaText').textContent = '';
      this.oliviaDecoder?.clear();
    });
    this.$('rttyCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('rttyText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('RTTY copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('rttyClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('rttyText').textContent = '';
    });
    // (BW filter picker is now opened from the keypad's BW button via the
    //  'filter' case in the cmd-dispatch switch.)
    this.$('cwCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const text = this.$('cwText').textContent || '';
      if (!text) return;
      this.copyText(text).then(
        () => this.banner('CW copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('cwClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('cwText').textContent = '';
    });
    this.$('ft8Copy').addEventListener('click', (e) => {
      e.stopPropagation();
      const lines = Array.from(this.$('ft8Lines').children)
        .map((el) => (el as HTMLElement).textContent || '')
        .join('\n');
      if (!lines) return;
      this.copyText(lines).then(
        () => this.banner(`${this.ft8Mode} copied`, 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('ft8Clear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('ft8Lines').innerHTML = '';
    });
    (this.$('audioFft') as HTMLCanvasElement).addEventListener('pointerdown', (e) => this.onAudioFftClick(e));
    this.bindRepeatPress(this.$('audioFftMinus'), () => this.adjustAudioFftContrast(-0.2));
    this.bindRepeatPress(this.$('audioFftPlus'),  () => this.adjustAudioFftContrast(+0.2));
    this.$('audioFftExt').addEventListener('click', (e) => { e.stopPropagation(); this.toggleAudioFftExt(); });
    this.$('audioFftAuto').addEventListener('click', (e) => { e.stopPropagation(); this.toggleAudioFftAuto(); });
    this.$('audioFftLabelLo').addEventListener('click', (e) => { e.stopPropagation(); this.tuneToCursorOffset(-1); });
    this.$('audioFftLabelHi').addEventListener('click', (e) => { e.stopPropagation(); this.tuneToCursorOffset(+1); });
    this.$('transcriptCopy').addEventListener('click', (e) => {
      e.stopPropagation();
      const lines = Array.from(this.$('transcriptLines').children)
        .map((el) => (el as HTMLElement).textContent || '')
        .join('\n');
      if (!lines) return;
      this.copyText(lines).then(
        () => this.banner('Transcript copied', 1200),
        () => this.banner('Copy failed', 1500),
      );
    });
    this.$('transcriptClear').addEventListener('click', (e) => {
      e.stopPropagation();
      this.$('transcriptLines').innerHTML = '';
    });
    this.$('btnLangFrom').addEventListener('click', () => {
      openLangModal(LANGS_SRC, this.settings.whisperSourceLang, (code) => {
        this.settings = { ...this.settings, whisperSourceLang: code };
        saveSettings(this.settings);
        this.applyWhisper();
        this.refreshLangButtons();
      });
    });
    this.$('btnLangTo').addEventListener('click', () => {
      openLangModal(LANGS_DST, this.settings.whisperTargetLang, (code) => {
        this.settings = { ...this.settings, whisperTargetLang: code };
        saveSettings(this.settings);
        this.applyWhisper();
        this.refreshLangButtons();
      });
    });
    this.refreshLangButtons();
    // KiwiSDR / OpenWebRx — mutually exclusive source buttons in the
    // top bar. A single tap (a) switches the active source to that
    // button and (b) opens that source's server picker so the operator
    // can choose where to connect. Visual `.active` highlight follows
    // `radiom.activeSource`.
    this.$('kiwiPicker').addEventListener('click', () => {
      localStorage.setItem('radiom.activeSource', 'kiwi');
      this.refreshSourceButtonState();
      openServerList((url, entry) => {
        (this.$('server') as HTMLInputElement).value = url;
        localStorage.setItem('radiom.lastServer', url);
        if (this.powered) this.disconnect();
        this.seedUsersFromEntry(entry);
        if (this.powered) this.connect();
        this.refresh();
      });
    });
    // OpenWebRx: short tap → server picker; long-press while already
    // connected → profile picker for the active server.
    {
      const btn = this.$('owrxPicker');
      let pressTimer: number | null = null;
      let longFired = false;
      const cancel = () => { if (pressTimer != null) { clearTimeout(pressTimer); pressTimer = null; } };
      const shortTap = () => {
        localStorage.setItem('radiom.activeSource', 'owrx');
        this.refreshSourceButtonState();
        openOwrxList((url, entry) => {
          localStorage.setItem('radiom.lastOwrxServer', url);
          (this.$('server') as HTMLInputElement).value = url;
          if (this.powered) this.disconnect();
          if (this.powered) this.connect();
          const name = entry?.name ? ` — ${entry.name.slice(0, 50)}` : '';
          this.banner(`OpenWebRX: ${url}${name}`, 2500);
        });
      };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        longFired = false;
        cancel();
        pressTimer = setTimeout(() => {
          pressTimer = null;
          longFired = true;
          this.openOwrxProfilePicker();
        }, 550) as unknown as number;
      });
      btn.addEventListener('pointerup',     () => { cancel(); if (!longFired) shortTap(); });
      btn.addEventListener('pointercancel', cancel);
      btn.addEventListener('pointerleave',  cancel);
    }
    // rtl_tcp source — open picker on tap, switch source, reconnect.
    this.$('rtlPicker').addEventListener('click', () => {
      localStorage.setItem('radiom.activeSource', 'rtl');
      this.refreshSourceButtonState();
      openRtlList((url, entry) => {
        localStorage.setItem('radiom.lastRtlServer', url);
        (this.$('server') as HTMLInputElement).value = url;
        if (this.powered) this.disconnect();
        if (this.powered) this.connect();
        const name = entry?.name ? ` — ${entry.name.slice(0, 50)}` : '';
        this.banner(`rtl_tcp: ${url}${name}`, 2500);
      });
    });

    // Keypad
    this.root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!t) return;
      const m = t.getAttribute('data-mode');
      const k = t.getAttribute('data-key');
      const c = t.getAttribute('data-cmd');
      const tg = t.getAttribute('data-toggle');
      const bw = t.getAttribute('data-bw');
      // Toggle-off: tapping a picker-opening button while its matching
      // panel is already on screen closes the panel instead of reopening.
      // Each picker tags its modal with data-picker-id so we can match
      // here without coupling to the picker's internals.
      const CMD_TO_PICKER_ID: Record<string, string> = {
        modePicker: 'mode', dspPicker: 'dsp', infoPicker: 'info',
        dispPicker: 'disp', decAPicker: 'dec-A', decBPicker: 'dec-B',
        freqPicker: 'freq',
        filter: 'bw',
      };
      const pickerId = (c && CMD_TO_PICKER_ID[c]) || (tg === 'band' ? 'band' : null);
      if (pickerId) {
        const existing = document.querySelector(`.band-modal[data-picker-id="${pickerId}"]`);
        if (existing) { existing.remove(); return; }
      }
      if (bw) { this.applyBandwidth(+bw); return; }
      if (m) this.setMode(m as Mode);
      else if (k) this.appendDigit(k);
      else if (c) this.command(c);
      else if (tg === 'band') openBandModal(this.freqKHz, (b) => {
        const center = Math.round((b.loKHz + b.hiKHz) / 2);
        this.freqKHz = center;
        this.mode = b.mode;
        const pb = defaultPassbandFor(b.mode);
        this.lowCut = pb.lowCut; this.highCut = pb.highCut;
        this.client?.setTune({ mode: b.mode, freqKHz: center, lowCutHz: pb.lowCut, highCutHz: pb.highCut });
        // Re-assert the squelch after a band/mode change. Without this,
        // the Kiwi keeps a stale squelch state across the mode swap and
        // the audio chops every few seconds until the operator jiggles
        // the SQL knob to retrigger setSquelch.
        this.client?.setSquelch(this.sql);
        this.player.setSquelchGate(this.sql > 0 ? -111 + this.sql : null);
        this.recenter();
        this.refresh();
        this.banner(`${b.name}: ${b.loKHz}–${b.hiKHz} kHz ${b.mode.toUpperCase()}`, 2500);
      });
      else if (tg) this.toggle(tg as keyof Toggles);
    });

    // Knobs (drag vertically)
    this.$$('.knob').forEach(el => {
      const id = el.dataset.knob as 'vol' | 'sql' | 'gate' | 'rf' | 'lof' | 'hif' | 'wlo' | 'whi' | 'vtg';
      this.bindKnob(el, id);
    });


    // Tap / drag on waterfall to tune.
    this.bindWaterfallTune();

    // Long-press on + → zoom to max.
    this.bindZoomMax();

    // Long-press on FFT → toggle log mode.
    this.bindFftLogToggle();

    // Hold a frequency-offset button to auto-repeat every 1 s.
    this.bindFreqRepeat();
  }

  private bindFreqRepeat() {
    const wire = (el: HTMLElement, step: () => void, intervalMs: number) => {
      let timer: number | null = null;
      let acted = false;
      const cancel = () => { if (timer != null) { clearInterval(timer); timer = null; } };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        acted = true;
        step();
        timer = setInterval(step, intervalMs) as unknown as number;
      });
      el.addEventListener('pointerup',     cancel);
      el.addEventListener('pointerleave',  cancel);
      el.addEventListener('pointercancel', cancel);
      // Prevent the global click handler from re-firing the action.
      el.addEventListener('click', (e) => {
        if (acted) { e.stopImmediatePropagation(); acted = false; }
      }, true);
    };

    this.root.querySelectorAll('button[data-cmd^="f-"], button[data-cmd^="f+"]').forEach((btn) => {
      const el = btn as HTMLElement;
      const offsetHz = +el.dataset.cmd!.slice(1);
      wire(el, () => this.nudgeFreq(offsetHz), 200);
    });
    // Pan buttons auto-repeat at 1 s — slower than the tuning nudges
    // because each pan jumps a half-window and walking too quickly
    // outruns the WF data the server is sending back.
    const panL = this.root.querySelector('button[data-cmd="panL"]') as HTMLElement | null;
    const panR = this.root.querySelector('button[data-cmd="panR"]') as HTMLElement | null;
    if (panL) wire(panL, () => this.panBy(-512), 1000);
    if (panR) wire(panR, () => this.panBy(+512), 1000);
  }

  private bindFftLogToggle() {
    const btn = this.root.querySelector('button[data-toggle="fft"]') as HTMLElement | null;
    if (!btn) return;
    let timer: number | null = null;
    let longFired = false;
    const cancel = () => { if (timer != null) { clearTimeout(timer); timer = null; } };
    btn.addEventListener('pointerdown', () => {
      longFired = false;
      timer = setTimeout(() => {
        longFired = true;
        this.fftLog = !this.fftLog;
        this.spectrum.setLogMode(this.fftLog);
        localStorage.setItem('radiom.fftLog', this.fftLog ? '1' : '0');
        this.banner(`FFT scale: ${this.fftLog ? 'log' : 'linear'}`, 1500);
        timer = null;
      }, 1000) as unknown as number;
    });
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('click', (e) => {
      // If long-press fired, swallow the click so we don't also toggle FFT visibility.
      if (longFired) { e.stopImmediatePropagation(); longFired = false; }
    }, true);
  }

  private bindZoomMax() {
    const btn = this.root.querySelector('button[data-cmd="zoomIn"]') as HTMLElement | null;
    if (!btn) return;
    let timer: number | null = null;
    let longFired = false;
    const cancel = () => { if (timer != null) { clearTimeout(timer); timer = null; } };
    btn.addEventListener('pointerdown', () => {
      longFired = false;
      timer = setTimeout(() => {
        longFired = true;
        this.zoom = 14;
        this.recenter();
        this.refresh();
        this.banner('Max zoom (Z14)', 1500);
        timer = null;
      }, 1000) as unknown as number;
    });
    btn.addEventListener('pointerup', cancel);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    // If long-press already happened, swallow the trailing click so we don't
    // also do a +1 zoom on top of the max-zoom.
    btn.addEventListener('click', (e) => {
      if (longFired) { e.stopImmediatePropagation(); longFired = false; }
    }, true);
  }

  private bindWaterfallTune() {
    this.bindTuneOnElement(this.$('wf') as HTMLCanvasElement);
    this.bindTuneOnElement(this.$('fft') as HTMLCanvasElement);
  }

  /** True when the active receiver source is an OpenWebRX server. The
   *  picker writes this localStorage key. Waterfall geometry (tune-from-
   *  click, cursor placement, freq labels) needs a different model for
   *  OWRX because the bins arriving from OpenWebRxClient are already a
   *  client-side slice centred on the tune freq. */
  private isOwrxSource(): boolean {
    return localStorage.getItem('radiom.activeSource') === 'owrx';
  }
  /** Symmetric helper alongside isOwrxSource() — used by future
   *  per-source UI branches. Currently only referenced for symmetry. */
  isRtlSource(): boolean {
    return localStorage.getItem('radiom.activeSource') === 'rtl';
  }

  /** Source buttons are mutually exclusive — apply the `.active`
   *  class to whichever matches the persisted source. Called whenever
   *  the source is switched (picker callbacks + initial render). */
  private refreshSourceButtonState(): void {
    const src = localStorage.getItem('radiom.activeSource') ?? 'kiwi';
    const ids: Array<[string, string]> = [
      ['kiwiPicker', 'kiwi'],
      ['owrxPicker', 'owrx'],
      ['rtlPicker',  'rtl'],
    ];
    for (const [id, kind] of ids) {
      const el = this.$(id) as HTMLElement | null;
      el?.classList.toggle('active', src === kind);
    }
  }


  /** Open one half of the decoder matrix. DECA = analog / narrow-band
   *  digital / imagery / NDB-class beacons. DECB = weak-signal /
   *  WSJT-X / military / utility. Same band-modal theme as the other
   *  pickers; cells dispatch to the canonical decoder button on its
   *  now-hidden decoder page, so the existing open / toggle / long-press
   *  logic is reused unchanged. */
  private openDecPicker(_half: 'A' | 'B'): void {
    this.closeAllBandModals();
    const PICKER_ID = 'dec';
    // DEC is the merged former DECA + DECB — one scrollable list. The
    // signature still takes the half argument so existing call sites
    // keep compiling; both halves resolve to the same combined list.
    const DEC_A: Array<{ label: string; selector: string }> = [
      // Demod-adjacent
      { label: 'FreeDV', selector: '#btnFreedv' },
      // Digital text (narrow-band keyboard / utility modes)
      { label: 'CW',     selector: '#btnCw' },
      { label: 'RTTY',   selector: '#btnRtty' },
      { label: 'PSK',    selector: '#btnPsk31b' },
      { label: 'MFSK',   selector: '#btnMfsk' },
      { label: 'OLIVIA', selector: '#btnOlivia' },
      { label: 'Contestia', selector: '#btnContestia' },
      { label: 'DominoEX',  selector: '#btnDominoex' },
      { label: 'THOR',   selector: '#btnThor' },
      { label: 'THROB',  selector: '#btnThrob' },
      { label: 'FSQ',    selector: '#btnFsq' },
      { label: 'MT63',   selector: '#btnMt63' },
      { label: 'AMTOR',  selector: '#btnAmtor' },
      { label: 'PACTOR', selector: '#btnPactor' },
      { label: 'NAVTEX', selector: '#btnNavtex' },
      { label: 'SITOR-B',selector: '#btnSitor' },
      { label: 'SITOR-A',selector: '#btnSitorA' },
      { label: 'SELCAL', selector: '#btnSelcal' },
      { label: 'HF Packet', selector: '#btnPacket' },
      { label: 'VHF Packet', selector: '#btnPacketVhf' },
      { label: '9600 Packet', selector: '#btnPacket9600' },
      { label: 'IL2P Packet', selector: '#btnPacketIl2p' },
      // Imagery
      { label: 'WEFAX', selector: '#btnWefax' },
    ];
    const DEC_B: Array<{ label: string; selector: string }> = [
      // Beacon / weak-signal decoders (true decoders only; pure freq
      // pickers like BCON / MEPT / DGPS moved to the INFO panel).
      { label: 'QRSS', selector: '#btnQrss' },
      { label: 'WWV',  selector: '#btnWwv' },
      { label: 'POCSAG', selector: '#btnPocs' },
      // WSJT-X family
      { label: 'FT8',  selector: '#btnFt8' },
      { label: 'FT4',  selector: '#btnFt4' },
      { label: 'JT4',  selector: '#btnJt4' },
      { label: 'JT65', selector: '#btnJt65' },
      { label: 'JT9',  selector: '#btnJt9' },
      { label: 'Q65',  selector: '#btnQ65' },
      { label: 'JS8',  selector: '#btnJs8' },
      { label: 'FST4', selector: '#btnFst4' },
      { label: 'FST4W',selector: '#btnFst4w' },
      { label: 'WSPR', selector: '#btnWspr' },
      { label: 'WSPR-15', selector: '#btnWspr15' },
      // Military / utility
      { label: 'ALE',  selector: '#btnAle' },
      { label: 'HFDL', selector: '#btnHfdl' },
      // VHF/UHF digital voice (dsd-fme). Single binary, 9 modes.
      { label: 'D-STAR',  selector: '#btnDstar' },
      { label: 'DMR',     selector: '#btnDmr' },
      { label: 'DMR-stereo', selector: '#btnDmrs' },
      { label: 'NXDN-48', selector: '#btnNxdn48' },
      { label: 'NXDN-96', selector: '#btnNxdn96' },
      { label: 'YSF',     selector: '#btnYsf' },
      { label: 'dPMR',    selector: '#btnDpmr' },
      { label: 'M17',     selector: '#btnM17' },
      { label: 'P25-P1',  selector: '#btnP25p1' },
      { label: 'P25-P2',  selector: '#btnP25p2' },
      // multimon-ng extras (binary already vendored for POCSAG/SELCAL).
      { label: 'FLEX',     selector: '#btnFlex' },
      { label: 'FLEX_NEXT', selector: '#btnFlexNext' },
      // ERMES retired — multimon-ng has no ERMES demod, protocol
      // decommissioned. Button stays hidden.
      { label: 'DTMF',     selector: '#btnDtmf' },
      { label: 'ZVEI',     selector: '#btnZvei' },
      { label: 'AFSK1200', selector: '#btnAfsk1200' },
      { label: 'UFSK1200', selector: '#btnUfsk1200' },
      { label: 'AFSK2400', selector: '#btnAfsk2400' },
      { label: 'HAPN4800', selector: '#btnHapn4800' },
      { label: 'FSK9600',  selector: '#btnFsk9600' },
      { label: 'DZ/PZVEI', selector: '#btnDpzvei' },
      { label: 'CWM',      selector: '#btnCwm' },
      { label: 'CLIPFSK',  selector: '#btnClipFsk' },
      { label: 'FMSFSK',   selector: '#btnFmsFsk' },
      { label: 'X10',      selector: '#btnX10' },
      { label: 'EAS',      selector: '#btnEas' },
      // Vendored binaries (separate build stages).
      { label: 'MSK144',   selector: '#btnMsk144' },
      { label: 'AIS',      selector: '#btnAis' },
      { label: 'ACARS',    selector: '#btnAcars' },
      // TETRAPOL retired — needs upstream demod we don't ship.
      { label: 'OP25',     selector: '#btnOp25' },
      { label: 'LRPT',     selector: '#btnLrpt' },
      { label: 'HRPT',     selector: '#btnHrpt' },
      { label: 'APT',      selector: '#btnApt' },
      { label: 'ADS-B',    selector: '#btnAdsb' },
      { label: 'VDL-2',    selector: '#btnVdl2' },
      { label: 'UAT',      selector: '#btnUat' },
      // WMBus retired — use rtl_433 at 868.300 MHz.
      { label: 'RDS',      selector: '#btnRds' },
      { label: 'DSC',      selector: '#btnDsc' },
      { label: 'AERO',     selector: '#btnJaero' },
      { label: 'CSPAS',    selector: '#btnCospas' },
      { label: 'STD-C',    selector: '#btnStdc' },
      // 5-tone selective-calling family.
      { label: 'CCIR',     selector: '#btnCcir' },
      { label: 'CCITT',    selector: '#btnCcitt' },
      { label: 'EEA',      selector: '#btnEea' },
      { label: 'EIA',      selector: '#btnEia' },
      { label: 'EURO',     selector: '#btnEuro' },
      { label: 'rtl_433',  selector: '#btnRtl433' },
      { label: 'SONDE',    selector: '#btnSonde' },
      { label: 'LoRa',     selector: '#btnLora' },
      { label: 'LTR',      selector: '#btnLtr' },
      // TIME-signal decoder retired (btnTimesig); btnTimeStations
      // picker still works for manual tuning.
    ];
    // Merge both halves and sort by the visible protocol name (the
    // description text pulled from the source button's `title`
    // attribute). The label column is hidden, so sorting by label
    // would produce a list that looked unordered to the operator.
    // Description always begins with the protocol name (e.g.
    // "FT8 — ...") so a localeCompare on the description sorts
    // alphabetically by protocol.
    type DecEntry = { label: string; selector: string; title: string };
    const ENTRIES: DecEntry[] = [...DEC_A, ...DEC_B].map(e => ({
      ...e,
      title: document.querySelector<HTMLElement>(e.selector)?.getAttribute('title') ?? e.label,
    }));
    // Sort by protocol name (the short label) — case-insensitive so
    // "Olivia" / "Thor" / "Throb" mix naturally with the all-caps
    // labels (FT8, JT9, …).
    ENTRIES.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    // Use the same row template as the frequency pickers (rtty-list /
    // rtty-row / rtty-row-name / rtty-row-meta). Label sits on top, the
    // help description sits below as the meta line — matches the look
    // and feel of every freq/sub-mode picker in the app.
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker dec-picker';
    root.dataset.pickerId = PICKER_ID;
    root.innerHTML = `
      <div class="rtty-list">
        ${ENTRIES.map(e => {
          const active = !!document.querySelector<HTMLElement>(e.selector)?.classList.contains('active');
          return `
            <button class="rtty-row ${active ? 'active' : ''}" data-sel="${escapeAttr(e.selector)}">
              <div class="rtty-row-name">${escapeAttr(e.label)}</div>
              <div class="rtty-row-meta">${escapeAttr(e.title)}</div>
            </button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    this.anchorPickerOverWaterfall(root);
    // Scroll the active row into view (if any decoder is currently on).
    // Defer to the next frame so the modal has its final size from
    // anchorPickerOverWaterfall before scrollIntoView measures it.
    requestAnimationFrame(() => {
      const activeRow = root.querySelector<HTMLElement>('.rtty-row.active');
      if (activeRow) activeRow.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
    this.bindPickerLongPress(root, (src) => {
      // Long-press: dispatch the canonical button's long-press handler
      // (exposed by bindFtxLongPress as `__longPress`) — usually opens
      // the decoder's sub-mode / freq picker. Decoders without a
      // long-press hook (AMTOR, ECSS, …) fall back to firing a normal
      // click so a long-press never silently no-ops.
      const lp = (src as HTMLElement & { __longPress?: () => void }).__longPress;
      if (lp) lp(); else src.click();
    });
  }

  /** Wire pointerdown/up on each `.band-btn` inside a picker so the
   *  underlying decoder button's tap vs long-press behaviour is
   *  preserved when reached through the matrix. Short tap → `.click()`.
   *  Long-press (≥500 ms) → `onLongPress(src)`. */
  private bindPickerLongPress(root: HTMLElement,
                              onLongPress: (src: HTMLElement) => void): void {
    // Accept three picker row types:
    //  - .band-btn  → matrix pickers (MODE / DSP / INFO / DISP / band)
    //  - .help-row  → legacy DEC list (kept for safety, unused now)
    //  - .rtty-row  → DEC list (matches the frequency-picker format)
    root.querySelectorAll<HTMLElement>('button.band-btn[data-sel],.help-row[data-sel],button.rtty-row[data-sel]').forEach((tile) => {
      let timer: number | null = null;
      let longFired = false;
      const cancel = () => { if (timer != null) { clearTimeout(timer); timer = null; } };
      tile.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        longFired = false;
        cancel();
        timer = setTimeout(() => {
          timer = null;
          longFired = true;
          const sel = tile.dataset.sel!;
          const src = document.querySelector<HTMLElement>(sel);
          // Close the picker first so the freq-picker (or whatever
          // the long-press surfaces) lands in the empty waterfall
          // area rather than stacking under the list.
          root.remove();
          if (src) onLongPress(src);
        }, 500) as unknown as number;
      });
      tile.addEventListener('pointerup',     cancel);
      tile.addEventListener('pointerleave',  cancel);
      tile.addEventListener('pointercancel', cancel);
      tile.addEventListener('click', (e) => {
        if (longFired) { e.stopImmediatePropagation(); longFired = false; return; }
        const sel = tile.dataset.sel!;
        const src = document.querySelector<HTMLElement>(sel);
        // Single tap: dismiss the list immediately, then trigger the
        // underlying decoder button. Its click handler either opens
        // the decoder's panel or its sub-mode/sub-band picker — both
        // need the waterfall area clear of the DEC list to render.
        root.remove();
        src?.click();
      });
    });
    // Tap outside any tile (on the modal backdrop) dismisses.
    root.addEventListener('click', (ev) => {
      if (ev.target === root) root.remove();
    });
  }

  /** Open the visualization-panel matrix. Same band-modal theme as the
   *  DSP / INFO pickers. Each cell dispatches to the canonical button
   *  (which is on a now-hidden decoder page) so each visualization
   *  retains its existing open/close/toggle logic. */
  private openDispPicker(): void {
    this.closeAllBandModals();
    const PICKER_ID = 'disp';
    const ENTRIES: Array<{ label: string; selector: string }> = [
      { label: 'ANTC', selector: '#btnAntc' },
      { label: 'DLDS', selector: '#btnDlds' },
      { label: 'DOPP', selector: '#btnDopp' },
      { label: 'EYE',  selector: '#btnEye' },
      { label: 'FMNT', selector: '#btnFmnt' },
      { label: 'IQV',  selector: '#btnIqView' },
      { label: 'KURT', selector: '#btnKurt' },
      { label: 'METR', selector: '#btnSDial' },
      { label: 'OTHR', selector: '#btnOthr' },
      { label: 'PPMC', selector: '#btnPpmc' },
      { label: 'RFI',  selector: '#btnRfi' },
      { label: 'SCOP', selector: '#btnScope' },
      { label: 'SFRC', selector: '#btnSfrc' },
      { label: 'VECT', selector: '#btnVect' },
      { label: 'ACON', selector: '#btnAcon' },
      { label: 'SPEC', selector: '#btnAudioFft' },
      { label: 'AFFT', selector: '#btnThd' },
      { label: 'ZOOM', selector: '#btnZoom' },
      { label: 'SPLT', selector: '#btnSPlot' },
    ];
    // Same shape as openDecPicker: rtty-row layout with label on top
    // and the source button's `title` (help text) as the meta line,
    // sorted alphabetically, scroll-to-active, long-press passthrough.
    // We piggyback on the existing .dec-picker CSS so the fullscreen
    // layout overrides apply (it just adjusts max-width / overflow).
    type DispEntry = { label: string; selector: string; title: string };
    const decorated: DispEntry[] = ENTRIES.map(e => ({
      ...e,
      title: document.querySelector<HTMLElement>(e.selector)?.getAttribute('title') ?? e.label,
    }));
    decorated.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker dec-picker disp-picker';
    root.dataset.pickerId = PICKER_ID;
    root.innerHTML = `
      <div class="rtty-list">
        ${decorated.map(e => {
          const active = !!document.querySelector<HTMLElement>(e.selector)?.classList.contains('active');
          return `
            <button class="rtty-row ${active ? 'active' : ''}" data-sel="${escapeAttr(e.selector)}">
              <div class="rtty-row-name">${escapeAttr(e.label)}</div>
              <div class="rtty-row-meta">${escapeAttr(e.title)}</div>
            </button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    this.anchorPickerOverWaterfall(root);
    // Scroll the active row (if any visualizer is on) into view, same
    // deferred-to-next-frame trick as the DEC picker.
    requestAnimationFrame(() => {
      const activeRow = root.querySelector<HTMLElement>('.rtty-row.active');
      if (activeRow) activeRow.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
    this.bindPickerLongPress(root, (src) => {
      // Long-press: dispatch the canonical button's long-press handler
      // (e.g. SCOP / FMNT have sub-mode pickers). Fall back to a normal
      // click for buttons that have no long-press binding.
      const lp = (src as HTMLElement & { __longPress?: () => void }).__longPress;
      if (lp) lp(); else src.click();
    });
  }

  /** Open the lookups / info matrix. Same shape as the DSP picker:
   *  each cell dispatches to the canonical button (now hidden) so the
   *  underlying open-modal / fetch logic stays in one place. */
  private openInfoPicker(): void {
    this.closeAllBandModals();
    const PICKER_ID = 'info';
    // INFO is now reserved for live / derived / search tools only.
    // Every "pure frequency picker" (a static curated list of dial
    // frequencies for a service or band) moved to the FREQ picker.
    const ENTRIES: Array<{ label: string; selector: string }> = [
      { label: 'EIBI', selector: '#btnEibi' },     // live shortwave schedule
      { label: 'PSKR', selector: '#btnPskr' },     // PSKReporter spots
      { label: 'NETS', selector: '#btnNets' },     // active ham nets
      { label: 'WNET', selector: '#btnWnet' },     // WSPRnet
      { label: 'GRAY', selector: '#btnGray' },     // gray-line propagation
      { label: 'SRCH', selector: '#btnLists' },    // search across all freqs
      { label: 'SID',  selector: '#btnSigId2' },   // signal-ID lookup
    ];
    const root = document.createElement('div');
    root.className = 'band-modal';
    root.dataset.pickerId = PICKER_ID;
    root.innerHTML = `
      <div class="band-grid">
        ${ENTRIES.map(e => {
          const src = document.querySelector<HTMLElement>(e.selector);
          const active = !!src?.classList.contains('active');
          return `<button class="band-btn ${active ? 'active' : ''}" data-sel="${escapeAttr(e.selector)}">${escapeAttr(e.label)}</button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    this.anchorPickerOverWaterfall(root);
    root.addEventListener('click', (ev) => {
      const t = (ev.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
      if (t) {
        const sel = t.dataset.sel;
        if (sel) document.querySelector<HTMLElement>(sel)?.click();
        // Most INFO buttons open their own modal — close this picker on
        // selection so the new one isn't covered.
        root.remove();
        return;
      }
      if (ev.target === root) root.remove();
    });
  }

  /** Open the FREQ picker — every "pure frequency-list" picker (a
   *  curated static list of dial frequencies for a service / band)
   *  lives here. Live and derived lookups (EIBI / PSKR / NETS /
   *  WNET / GRAY / SRCH / SID) stay in the INFO picker.
   *
   *  Same band-grid layout + matrix-click dispatch as INFO. Each
   *  cell re-dispatches a click on the underlying hidden button so
   *  the freq-picker overlay it spawns lives in one place. */
  private openFreqPicker(): void {
    this.closeAllBandModals();
    const PICKER_ID = 'freq';
    const ENTRIES: Array<{ label: string; selector: string }> = [
      // Amateur / utility freq pickers
      { label: 'BCON', selector: '#btnBeacons' },
      { label: 'NDB',  selector: '#btnNdb' },
      { label: 'VLFB', selector: '#btnVlfb' },
      { label: 'MILV', selector: '#btnMilv' },
      { label: 'MARN', selector: '#btnMaritime' },
      { label: 'AERO', selector: '#btnAero' },
      { label: 'VOLM', selector: '#btnVolmet' },
      { label: 'TIME', selector: '#btnTimeStations' },
      { label: 'SCI',  selector: '#btnScien' },
      { label: 'NUM',  selector: '#btnNumbers' },
      { label: 'DXCL', selector: '#btnDxcluster' },
      { label: 'DGPS', selector: '#btnDgps' },
      { label: 'GMDS', selector: '#btnGmdss' },
      { label: 'HFDM', selector: '#btnHfdm' },
      { label: 'MEPT', selector: '#btnMept' },
      { label: 'MWDX', selector: '#btnMwdx' },
      // Broadcast freq pickers
      { label: 'CB',   selector: '#btnCb' },
      { label: 'LW',   selector: '#btnLw' },
      { label: 'AFRC', selector: '#btnAfricaBc' },
      { label: 'ASIA', selector: '#btnAsiaBc' },
      { label: 'LATM', selector: '#btnLatamBc' },
      { label: 'SWBC', selector: '#btnSwbroad' },
      { label: 'CLND', selector: '#btnClandestine' },
      { label: 'DIPL', selector: '#btnEmbassy' },
      { label: 'PIRA', selector: '#btnPirate' },
      { label: 'AIDR', selector: '#btnAirdrill' },
      // Military / nets freq pickers
      { label: 'CAP',  selector: '#btnCap' },
      { label: 'TNET', selector: '#btnTrafnets' },
      { label: 'ECOM', selector: '#btnEmcomm' },
      { label: 'SKYN', selector: '#btnSkynet' },
      { label: 'HFGC', selector: '#btnHfgcs' },
      { label: 'MARS', selector: '#btnMars' },
      { label: 'MRSE', selector: '#btnMarsEu' },
      { label: 'RUSM', selector: '#btnRusmil' },
      { label: 'MPAC', selector: '#btnMarpac' },
      { label: 'CSTV', selector: '#btnCoast' },
      { label: 'CSCW', selector: '#btnCoastcw' },
    ];
    const root = document.createElement('div');
    root.className = 'band-modal';
    root.dataset.pickerId = PICKER_ID;
    root.innerHTML = `
      <div class="band-grid">
        ${ENTRIES.map(e => {
          const src = document.querySelector<HTMLElement>(e.selector);
          const active = !!src?.classList.contains('active');
          return `<button class="band-btn ${active ? 'active' : ''}" data-sel="${escapeAttr(e.selector)}">${escapeAttr(e.label)}</button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    this.anchorPickerOverWaterfall(root);
    root.addEventListener('click', (ev) => {
      const t = (ev.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
      if (t) {
        const sel = t.dataset.sel;
        if (sel) document.querySelector<HTMLElement>(sel)?.click();
        // Most FREQ buttons open their own freq-list overlay — close
        // this picker on selection so the new one isn't covered.
        root.remove();
        return;
      }
      if (ev.target === root) root.remove();
    });
  }

  /** Open the signal-processor matrix as a band-modal-style picker.
   *  Each cell re-dispatches a click on the canonical processor button
   *  elsewhere in the UI, so toggle / cycle logic stays in one place
   *  and the active-state highlight stays in sync. */
  private openDspPicker(): void {
    this.closeAllBandModals();
    const PICKER_ID = 'dsp';
    const ENTRIES: Array<{ label: string; selector: string }> = [
      { label: 'AGC', selector: '#btnAgc' },
      { label: 'NB',  selector: '[data-cmd="nb"]' },
      { label: 'NT',  selector: '[data-cmd="antch"]' },
      { label: 'NR',  selector: '[data-cmd="nr"]' },
      { label: 'CP',  selector: '[data-toggle="comp"]' },
      { label: 'NB2', selector: '#btnNb2' },
      { label: 'NT2', selector: '#btnAmnotch' },
      { label: 'NR2', selector: '#btnRfw' },
      { label: 'VT',  selector: '#btnVtrk3' },
      { label: 'AFF', selector: '#btnAfrm' },
      { label: 'EQ',  selector: '#btnEq' },
      { label: 'GEN', selector: '#btnModes' },
    ];

    const root = document.createElement('div');
    root.className = 'band-modal';
    root.dataset.pickerId = PICKER_ID;
    root.innerHTML = `
      <div class="band-grid">
        ${ENTRIES.map(e => {
          const src = document.querySelector<HTMLElement>(e.selector);
          const active = !!src?.classList.contains('active');
          return `<button class="band-btn ${active ? 'active' : ''}" data-sel="${escapeAttr(e.selector)}">${escapeAttr(e.label)}</button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    this.anchorPickerOverWaterfall(root);
    root.addEventListener('click', (ev) => {
      const t = (ev.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
      if (t) {
        const sel = t.dataset.sel;
        if (sel) {
          const src = document.querySelector<HTMLElement>(sel);
          src?.click();
          // Reflect the post-toggle active state without closing.
          setTimeout(() => {
            const after = document.querySelector<HTMLElement>(sel);
            t.classList.toggle('active', !!after?.classList.contains('active'));
          }, 0);
        }
        return;
      }
      if (ev.target === root) root.remove();
    });
  }

  /** Demodulation-mode picker. The list is filtered by the active
   *  receiver source — Kiwi exposes a different set of demod modes than
   *  mainline OpenWebRX (no SAM/SAL/SAU/IQ on OWRX, NBFM aliases to NFM).
   *  Picking a mode is equivalent to tapping the old per-mode keypad
   *  shortcuts. */
  private openModePicker(): void {
    this.closeAllBandModals();
    const PICKER_ID = 'mode';
    const isOwrx = this.isOwrxSource();
    type Entry = { mode: Mode; label: string; hint?: string };
    const KIWI_MODES: Entry[] = [
      { mode: 'am',   label: 'AM',   hint: 'Amplitude modulation' },
      { mode: 'sam',  label: 'SAM',  hint: 'Synchronous AM (both sidebands)' },
      { mode: 'sal',  label: 'SAL',  hint: 'Synchronous AM (lower sideband only)' },
      { mode: 'sau',  label: 'SAU',  hint: 'Synchronous AM (upper sideband only)' },
      { mode: 'nbfm', label: 'NBFM', hint: 'Narrowband FM' },
      { mode: 'cw',   label: 'CW',   hint: 'Continuous wave / Morse' },
      { mode: 'lsb',  label: 'LSB',  hint: 'Lower sideband SSB' },
      { mode: 'usb',  label: 'USB',  hint: 'Upper sideband SSB' },
      { mode: 'iq',   label: 'IQ',   hint: 'Raw complex baseband (Kiwi-only)' },
    ];
    // OpenWebRX mainline: nfm/wfm/am/lsb/usb/cw plus dmr/dstar/etc which
    // radiom doesn't have client decoders for. NBFM is radiom's name for
    // nfm; pick that. WFM has no current radiom equivalent, expose as
    // its own slot (maps via OpenWebRxClient — falls back to nfm if
    // unmapped). SAM is server-side on OpenWebRX (mode "am" already
    // includes sync-style envelope detection).
    const OWRX_MODES: Entry[] = [
      { mode: 'nbfm', label: 'NFM',  hint: 'Narrowband FM' },
      { mode: 'wfm',  label: 'WFM',  hint: 'Wideband FM (broadcast). Uses HD audio (48 kHz)' },
      { mode: 'am',   label: 'AM',   hint: 'Amplitude modulation' },
      { mode: 'lsb',  label: 'LSB',  hint: 'Lower sideband' },
      { mode: 'usb',  label: 'USB',  hint: 'Upper sideband' },
      { mode: 'cw',   label: 'CW',   hint: 'Morse — narrow USB' },
    ];
    const list = isOwrx ? OWRX_MODES : KIWI_MODES;
    const current = this.mode;

    const root = document.createElement('div');
    // Reuse the band-modal theme: compact grid of labelled buttons, one
    // per mode. Matches the look of BAND / BW / other quick-pick modals
    // rather than the server-list cards used elsewhere.
    root.className = 'band-modal';
    root.dataset.pickerId = PICKER_ID;
    root.innerHTML = `
      <div class="band-grid">
        ${list.map(e => `
          <button class="band-btn ${e.mode === current ? 'active' : ''}" data-mode="${escapeAttr(e.mode)}" title="${escapeAttr(e.hint ?? '')}">${escapeAttr(e.label)}</button>
        `).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
      if (t) {
        const m = t.dataset.mode as Mode | undefined;
        if (m) { this.setMode(m); root.remove(); return; }
      }
      if (e.target === root) root.remove();
    });
  }

  /** The visualizer-toggle buttons that the DISP picker dispatches
   *  through. When any of them carries `.active`, the corresponding
   *  visualizer panel is on top of the waterfall — we surface a small
   *  × chip in the top-right of the waterfall so the operator can
   *  dismiss the overlay without re-opening the DISP picker. */
  // Every button listed in the DISP picker. The BACK key (and the ×
  // close chip) iterate this list and click any with .active to
  // tear them down. Keep this in lock-step with the DISP picker
  // entries — anything new added to DISP must land here too, or
  // BACK won't close it.
  private static readonly VIZ_BUTTON_IDS = [
    'btnAntc','btnDlds','btnDopp','btnEye','btnFmnt','btnIqView','btnKurt',
    'btnSDial','btnOthr','btnPpmc','btnRfi','btnScope','btnSfrc','btnVect',
    'btnAcon','btnAudioFft','btnThd','btnZoom','btnSPlot',
  ];

  /** Every decoder button reachable from DECA / DECB. Used by the BACK
   *  button and the × chip so an active decoder panel can be closed
   *  the same way visualizer overlays are. */
  private static readonly DECODER_BUTTON_IDS = [
    'btnEcss','btnMcw','btnFreedv','btnIsb',
    'btnCw','btnRtty','btnPsk31b','btnMfsk','btnOlivia','btnContestia',
    'btnDominoex','btnThor','btnThrob','btnFsq','btnMt63','btnAmtor',
    'btnPactor','btnNavtex','btnSitor','btnSitorA','btnHell','btnSelcal',
    'btnPacket','btnPacketVhf','btnPacket9600','btnPacketIl2p','btnWefax','btnWfax','btnSstv',
    'btnQrss','btnWwv','btnPocs',
    'btnFt8','btnFt4','btnJt4','btnJt65','btnJt9','btnQ65','btnJs8',
    'btnFst4','btnFst4w','btnWspr','btnWspr15',
    'btnStanag','btnStanag4539','btnStanag3g','btnStanag2',
    'btnAle','btnHfdl','btnDrm',
    // DSD digital-voice family (D-STAR / DMR / NXDN / YSF / dPMR / M17 / P25).
    'btnDstar','btnDmr','btnDmrs','btnNxdn48','btnNxdn96','btnYsf','btnDpmr',
    'btnM17','btnP25p1','btnP25p2',
    // multimon-ng extras.
    'btnFlex','btnFlexNext','btnDtmf','btnZvei','btnAfsk1200','btnUfsk1200','btnAfsk2400','btnHapn4800','btnFsk9600','btnDpzvei','btnCwm','btnClipFsk','btnFmsFsk','btnX10','btnEas',
    // Vendored binaries (MSK144 / AIS / ACARS / TETRAPOL / OP25 / LRPT).
    'btnMsk144','btnAis','btnAcars','btnOp25','btnLrpt',
    // Batch 7 additions (HRPT / APT / ADS-B / VDL-2 / UAT / WMBus / RDS / DSC).
    'btnHrpt','btnApt','btnAdsb','btnVdl2','btnUat','btnRds','btnDsc',
    // Aviation: JAERO (Inmarsat AERO) + Cospas-Sarsat 406 MHz.
    'btnJaero','btnCospas',
    // Maritime: Inmarsat STD-C (SOLAS messaging).
    'btnStdc',
    // Paging-adjacent 5-tone selective calling.
    'btnCcir','btnCcitt','btnEea','btnEia','btnEuro',
    // IoT / telemetry.
    'btnRtl433','btnSonde','btnLora',
    // Trunked / dispatch.
    'btnLtr',
    // Time-signal decoder retired — no demod layer.
  ];

  /** What the BACK keypad button + the × chip on the waterfall both do.
   *  Removes whatever is in the foreground of the waterfall area, in
   *  priority order: open picker matrix → active visualizer overlay →
   *  active decoder panel. Each "active" decoder/visualizer button is
   *  click()-ed to toggle it off through its existing handler. */
  private closeForegroundOverlay(): void {
    const modal = document.querySelector('.band-modal');
    if (modal) { modal.remove(); return; }
    let closedAny = false;
    for (const id of Shell.VIZ_BUTTON_IDS) {
      const el = document.getElementById(id);
      if (el && el.classList.contains('active')) { el.click(); closedAny = true; }
    }
    if (closedAny) return;
    for (const id of Shell.DECODER_BUTTON_IDS) {
      const el = document.getElementById(id);
      if (el && el.classList.contains('active')) el.click();
    }
  }

  private installVizCloseChip(): void {
    const chip = this.$('btnCloseViz') as HTMLElement | null;
    if (!chip) return;
    const visibleSelector =
      [...Shell.VIZ_BUTTON_IDS, ...Shell.DECODER_BUTTON_IDS]
        .map((id) => `#${id}.active`).join(',');
    const refresh = () => {
      chip.style.display = document.querySelector(visibleSelector) ? '' : 'none';
    };
    // Initial state.
    refresh();
    // Observe class changes on each visualizer button so we don't need
    // to hook each toggle path individually.
    const cb = () => refresh();
    const mo = new MutationObserver(cb);
    for (const id of [...Shell.VIZ_BUTTON_IDS, ...Shell.DECODER_BUTTON_IDS]) {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    // Tap → close whatever's in the foreground (same as the BACK
    // keypad button).
    chip.addEventListener('click', () => {
      this.closeForegroundOverlay();
      refresh();
    });
  }

  /** Close every band-modal picker currently on screen. Used as a
   *  guard at the entry of each picker so opening a new panel always
   *  replaces (not stacks) the previous one in a single click. */
  private closeAllBandModals(): void {
    document.querySelectorAll('.band-modal').forEach((el) => el.remove());
  }

  /** Anchor a band-modal picker over the waterfall area (instead of
   *  the full viewport) so it doesn't cover the LED status bar or the
   *  knobs/keypad below. The modal's flex `safe center` alignment
   *  centers the grid when it fits and falls back to start-alignment
   *  with scrolling when there are too many tiles to show at once.
   *  Also lays the grid out roughly square (cols ≈ rows) so big
   *  pickers don't sprawl as a long, narrow strip. */
  private anchorPickerOverWaterfall(root: HTMLElement): void {
    const wf = this.$('wf') as HTMLElement | null;
    if (!wf) return;
    const r = wf.getBoundingClientRect();
    root.style.inset = 'auto';
    root.style.left = `${r.left}px`;
    root.style.top = `${r.top}px`;
    root.style.width = `${r.width}px`;
    root.style.height = `${r.height}px`;
    // Square-ish column count. The default CSS uses auto-fit which
    // packs as many columns as fit horizontally — but for a 44-tile
    // INFO picker on a wide screen that's still a long, low rectangle.
    // ceil(sqrt(N)) is a good "square" target; for small grids it
    // naturally stays compact.
    const grid = root.querySelector<HTMLElement>('.band-grid');
    if (grid) {
      const n = grid.querySelectorAll('.band-btn').length;
      if (n > 0) {
        const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      }
    }
  }

  /** Modal listing every (SDR, profile) advertised by the connected
   *  OpenWebRX server. Tap an entry → `selectprofile` is sent to the
   *  client; the server retunes the hardware and pushes a new config. */
  private openOwrxProfilePicker(): void {
    if (!this.isOwrxSource()) {
      this.banner('Switch to an OpenWebRX server first', 2000);
      return;
    }
    if (!this.owrxProfiles.length) {
      this.banner('No profiles yet — connect first', 2000);
      return;
    }
    const sel = this.owrxSelectedProfile;
    const root = document.createElement('div');
    root.className = 'modal';
    root.innerHTML = `
      <div class="modal-card">
        <div class="modal-bar">
          <div style="flex:1; font-weight:600; padding:0 8px;">Receivers &amp; profiles</div>
          <button class="btn-close" aria-label="close">✕</button>
        </div>
        <div class="srv-list">
          ${this.owrxProfiles.map(p => `
            <div class="srv-row" data-pid="${escapeAttr(p.id)}">
              <div class="srv-meta">
                <div class="srv-title">${escapeAttr(p.name || p.id)} ${p.id === sel ? '· <span style="color:#0a0">active</span>' : ''}</div>
                <div class="srv-sub">${escapeAttr(p.id)}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const close = () => root.remove();
    root.querySelector('.btn-close')?.addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.querySelectorAll('.srv-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = (row as HTMLElement).dataset.pid;
        if (!id) return;
        const client = this.client as OpenWebRxClient | null;
        client?.selectProfileById?.(id);
        this.banner(`Profile: ${id}`, 2200);
        close();
      });
    });
  }

  /** Apply Vol × (RF for OWRX only) to the player. OpenWebRX has
   *  server-side AGC and no client RF gain control, so the RF knob is
   *  repurposed as a post-decode preamp (0..120 → ×0..×4 on top of Vol;
   *  50 is unity). Kiwi keeps RF as the hardware-side manGain it
   *  already controls; here we only adjust the audio output. */
  private applyOutputGain(): void {
    let g = (this.vol / 100) * 2.5;
    if (this.isOwrxSource()) g *= Math.max(0, this.rfGain) / 50;
    this.player.setGain(g);
  }

  private bindTuneOnElement(el: HTMLElement) {
    let active = false;
    let lastSent = 0;
    let trailingTimer: number | null = null;
    let lastEvent: PointerEvent | null = null;
    const MIN_INTERVAL = 250;  // ≤ 4 updates / sec

    const tuneFromEvent = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width - 1, e.clientX - r.left));
      const frac = x / r.width;
      let f: number;
      if (this.isOwrxSource()) {
        // OpenWebRX model: the rendered waterfall covers `bandwidthHz`
        // centred on `owrxViewCenterKHz` (a separate value from the dial
        // freq — the view only moves when the dial walks outside the
        // window, so the cursor can actually track the dial inside it).
        const spanKHz = this.bandwidthHz / 1000;
        const centreKHz = this.owrxViewCenterKHz ?? this.freqKHz;
        const loKHz = centreKHz - spanKHz / 2;
        f = Math.round((loKHz + frac * spanKHz) * 10) / 10;
      } else {
        const totalBins = 1024 * (1 << this.zoom);
        const binAt = this.wfStart + frac * 1024;
        const freqHz = binAt * (this.bandwidthHz / totalBins);
        f = Math.round(freqHz / 100) / 10; // round to 0.1 kHz
      }
      if (f <= 0) return;
      if (Math.abs(f - this.freqKHz) >= 0.05) {
        this.freqKHz = f;
        this.client?.setFreqKHz(f);
        this.refreshCursor();
        this.refresh();
      }
    };

    const throttledTune = (e: PointerEvent) => {
      lastEvent = e;
      const now = performance.now();
      const since = now - lastSent;
      if (since >= MIN_INTERVAL) {
        lastSent = now;
        tuneFromEvent(e);
      } else if (trailingTimer == null) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          if (lastEvent) { lastSent = performance.now(); tuneFromEvent(lastEvent); }
        }, MIN_INTERVAL - since) as unknown as number;
      }
    };

    el.addEventListener('pointerdown', (e) => {
      active = true;
      el.setPointerCapture(e.pointerId);
      lastSent = 0;
      tuneFromEvent(e);
      lastSent = performance.now();
    });
    el.addEventListener('pointermove', (e) => { if (active) throttledTune(e); });
    const stop = () => {
      active = false;
      if (trailingTimer != null) { clearTimeout(trailingTimer); trailingTimer = null; }
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  /** Place the FFT *and* waterfall cursors at the column for the tuned freq. */
  private refreshCursor() {
    let tRaw: number;
    let loKHz: number;
    let hiKHz: number;
    if (this.isOwrxSource()) {
      // OpenWebRX renders a window of `bandwidthHz` centred on
      // owrxViewCenterKHz. Cursor position is the dial freq's offset
      // within that window — moves as the dial moves, only snaps to
      // centre when the dial walks outside the window and the client
      // re-anchors.
      const spanKHz = this.bandwidthHz / 1000;
      const centreKHz = this.owrxViewCenterKHz ?? this.freqKHz;
      loKHz = centreKHz - spanKHz / 2;
      hiKHz = centreKHz + spanKHz / 2;
      tRaw = spanKHz > 0 ? (this.freqKHz - loKHz) / spanKHz : 0.5;
    } else {
      const totalBins = 1024 * (1 << this.zoom);
      const binAtFreq = (this.freqKHz * 1000 / this.bandwidthHz) * totalBins;
      tRaw = (binAtFreq - this.wfStart) / 1024;
      const hzPerBin = this.bandwidthHz / totalBins;
      loKHz = (this.wfStart * hzPerBin) / 1000;
      hiKHz = ((this.wfStart + 1024) * hzPerBin) / 1000;
    }
    const inView = tRaw >= 0 && tRaw <= 1;
    const t = Math.max(0, Math.min(1, tRaw));
    this.spectrum.setCursor(null);
    // Hide the cursor entirely while the picker scanner is running —
    // the freq is changing every 3 s and the cursor flicker is noise.
    const visible = inView && !this.pickerScanRunning && this.cursorsVisible;
    const setCursor = (id: string) => {
      const el = this.$(id) as HTMLElement;
      el.style.left = (t * 100) + '%';
      el.style.display = visible ? 'block' : 'none';
    };
    setCursor('fftCursor');
    setCursor('wfCursor');

    const labelLo = formatLabelKHz(loKHz);
    const labelHi = formatLabelKHz(hiKHz);
    this.$('fftFreqLo').textContent = labelLo;
    this.$('fftFreqHi').textContent = labelHi;
    this.$('wfFreqLo').textContent  = labelLo;
    this.$('wfFreqHi').textContent  = labelHi;
    this.spectrumSpanKHz = hiKHz - loKHz;
    this.refreshSigMarkers(loKHz, hiKHz);

    // Off-screen tuning chevrons: show a direction + distance hint when
    // the freq cursor would fall outside the visible waterfall window.
    // Tap-to-recenter is wired separately at app init.
    const chL = this.$('wfChevL') as HTMLElement;
    const chR = this.$('wfChevR') as HTMLElement;
    if (inView) {
      chL.style.display = 'none';
      chR.style.display = 'none';
    } else if (tRaw < 0) {
      chL.style.display = 'block';
      chR.style.display = 'none';
      chL.textContent = `◀ ${(loKHz - this.freqKHz).toFixed(3)} kHz`;
    } else {
      chL.style.display = 'none';
      chR.style.display = 'block';
      chR.textContent = `${(this.freqKHz - hiKHz).toFixed(3)} kHz ▶`;
    }
  }

  /** Step the audio-spectrum horizontal cursor by ±1 Hz. Initializes the
   *  cursor at the audio_freq_cursor default if no click has placed it yet. */
  private movePitchCursor(deltaHz: number) {
    if (this.audioFftCursorHz == null) this.audioFftCursorHz = this.audio_freq_cursor;
    this.audioFftCursorHz += deltaHz;
    const lbl = this.$('audioFftLabel');
    if (lbl) lbl.style.display = '';
  }

  private setPitchFromCursor() {
    if (this.audioFftCursorHz != null) this.audio_freq_cursor = Math.round(this.audioFftCursorHz);
    this.banner(`Pitch set to ${this.audio_freq_cursor}`, 1500);
  }


  private bindKnob(el: HTMLElement, id: 'vol' | 'sql' | 'gate' | 'rf' | 'lof' | 'hif' | 'wlo' | 'whi' | 'vtg') {
    let startY = 0, startVal = 0, active = false;
    const sens = id === 'vol'   ? 0.5
               : id === 'sql'   ? 0.5
               : id === 'gate'  ? 0.5    // 0..100 over the gate's threshold range
               : id === 'rf'    ? 0.6    // dB per pixel (0..120)
               : id === 'wlo'   ? 0.6    // bytes (0..255) per pixel
               : id === 'whi'   ? 0.6
               : id === 'vtg'   ? 0.15   // dB per pixel (0..18)
               : 20;            // Hz per pixel for passband (lof/hif)
    const onMove = (e: PointerEvent) => {
      if (!active) return;
      const dy = startY - e.clientY; // up = positive
      const next = startVal + dy * sens;
      this.setKnob(id, next);
    };
    const onUp = () => {
      active = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    el.addEventListener('pointerdown', (e) => {
      active = true;
      startY = e.clientY;
      startVal = this.getKnob(id);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  private getKnob(id: 'vol' | 'sql' | 'gate' | 'rf' | 'lof' | 'hif' | 'wlo' | 'whi' | 'vtg'): number {
    return id === 'vol'   ? this.vol
         : id === 'sql'   ? this.sql
         : id === 'gate'  ? this.gate
         : id === 'rf'    ? this.rfGain
         : id === 'lof'   ? this.lowCut
         : id === 'hif'   ? this.highCut
         : id === 'wlo'   ? this.wfBase
         : id === 'whi'   ? this.wfTop
         : this.vTrackGain;
  }

  private setKnob(id: 'vol' | 'sql' | 'gate' | 'rf' | 'lof' | 'hif' | 'wlo' | 'whi' | 'vtg', v: number) {
    if (id === 'vol') {
      this.vol = clamp(v, 0, 100);
      // 0..100 → 0..2.5× gain (unity at ~40%, +8 dB at max).
      this.applyOutputGain();
    } else if (id === 'sql') {
      this.sql = clamp(v, 0, 40);
      this.client?.setSquelch(this.sql);
      // Stock Kiwi firmware silently drops `SET squelch=…`, so we mute
      // the speaker path client-side based on the frame RSSI. Map the
      // 0..40 knob onto a dBm threshold above the noise floor (~-110).
      // 0 = gate fully open.
      this.player.setSquelchGate(this.sql > 0 ? -111 + this.sql : null);
    } else if (id === 'gate') {
      this.gate = clamp(Math.round(v), 0, 100);
      localStorage.setItem('radiom.gate', String(this.gate));
      // 0 = gate off (null threshold). 1..100 → -100..-1 dBFS.
      const dbfs = this.gate > 0 ? -100 + this.gate : null;
      this.player.setNoiseGate(dbfs);
    } else if (id === 'rf') {
      this.rfGain = clamp(Math.round(v), 0, 120);
      localStorage.setItem('radiom.rfGain', String(this.rfGain));
      // Push the new gain immediately if AGC is currently OFF; in any
      // other AGC mode the value is held for the next time the user
      // cycles to OFF.
      if (this.agcMode === 'off') this.client?.setAgc(false, this.rfGain);
      // OpenWebRX has server-side AGC and no client RF gain control.
      // Repurpose the RF knob as a client-side preamp so the operator
      // can compensate for quiet receivers.
      if (this.isOwrxSource()) this.applyOutputGain();
    } else if (id === 'lof') {
      this.lowCut = clamp(Math.round(v), -8000, this.highCut - 50);
      this.applyPassband();
    } else if (id === 'hif') {
      this.highCut = clamp(Math.round(v), this.lowCut + 50, 8000);
      this.applyPassband();
    } else if (id === 'wlo') {
      this.wfBase = clamp(Math.round(v), 0, 255);
      this.spectrum.setStretch(this.wfBase, this.wfTop);
      this.fftAvg.setStretch(this.wfBase, this.wfTop);
    } else if (id === 'whi') {
      this.wfTop = clamp(Math.round(v), 0, 255);
      this.spectrum.setStretch(this.wfBase, this.wfTop);
      this.fftAvg.setStretch(this.wfBase, this.wfTop);
    } else if (id === 'vtg') {
      this.vTrackGain = clamp(v, 0, 18);
      this.player.setVoiceTrackGain(this.vTrackGain);
      this.player.setVoiceTrack2Gain(this.vTrackGain);
      this.player.setVoiceTrack3Gain(this.vTrackGain);
      this.player.setVoiceTrack3Gain(this.vTrackGain);
      localStorage.setItem('radiom.vtg', String(this.vTrackGain));
    }
    this.refresh();
  }

  private applyPassband() {
    this.client?.setPassband(this.lowCut, this.highCut);
  }

  /** Accumulate a waterfall row's bytes into the rolling histogram. */
  private feedWfHist(bins: Uint8Array) {
    const h = this.wfHist;
    for (let i = 0; i < bins.length; i++) h[bins[i]]++;
    this.wfHistFrames++;
  }

  /** Start (or restart) the 1 Hz timer that recomputes wfBase/wfTop
   *  from the rolling histogram and EMA-smooths the result into the
   *  spectrum-view's stretch. */
  private startWfAutoTimer() {
    if (this.wfAutoTimer != null) { clearInterval(this.wfAutoTimer); this.wfAutoTimer = null; }
    if (this.wfAutoMode === 0) return;
    this.wfAutoTimer = setInterval(() => this.applyAutoStretch(), 1000) as unknown as number;
  }

  private applyAutoStretch() {
    if (this.wfAutoMode === 0) return;
    if (this.wfHistFrames < 4) return;     // wait for enough samples
    const h = this.wfHist;
    let total = 0;
    for (let i = 0; i < 256; i++) total += h[i];
    if (total === 0) return;
    // Per-mode percentile picks. Higher low-percentile pulls the noise
    // floor below threshold so the background goes dark; the high-
    // percentile is held near saturation so peaks remain visible.
    const lowPct = [0.05, 0.05, 0.30, 0.55][this.wfAutoMode];
    const hiPct  = [0.99, 0.99, 0.99, 0.995][this.wfAutoMode];
    const loCut = total * lowPct;
    const hiCut = total * hiPct;
    let cum = 0, pLo = 0, pHi = 255;
    let foundLo = false, foundHi = false;
    for (let i = 0; i < 256; i++) {
      cum += h[i];
      if (!foundLo && cum >= loCut) { pLo = i; foundLo = true; }
      if (!foundHi && cum >= hiCut) { pHi = i; foundHi = true; break; }
    }
    // Enforce a minimum span so the band doesn't go all-or-nothing
    // when activity is low.
    let targetLo = pLo;
    let targetHi = Math.max(pHi, targetLo + 30);
    // EMA-smooth toward the targets to avoid flicker.
    const alpha = 0.3;
    const newLo = Math.round(this.wfBase * (1 - alpha) + targetLo * alpha);
    const newHi = Math.round(this.wfTop  * (1 - alpha) + targetHi * alpha);
    if (newLo !== this.wfBase || newHi !== this.wfTop) {
      this.wfBase = newLo;
      this.wfTop  = newHi;
      this.spectrum.setStretch(this.wfBase, this.wfTop);
      this.fftAvg.setStretch(this.wfBase, this.wfTop);
      this.refresh();
    }
    // Decay the histogram so old samples lose weight (≈ 5 s window
    // with 0.7 retention per sec at typical 5-10 fps).
    for (let i = 0; i < 256; i++) h[i] = (h[i] * 0.7) | 0;
    this.wfHistFrames = (this.wfHistFrames * 0.7) | 0;
  }

  /** Cycle the waterfall speed 0→1→2→3→4→0; mirrors the SPEED knob. */
  private cycleSpeed() {
    // Cycle 0→1→2→3→4→0. wfSpeed=0 disables the waterfall (kiwi sends
    // no W/F frames at all); the LCD shows "FPS 0/23" so the user sees
    // when they're in the disabled state.
    this.wfSpeed = (this.wfSpeed + 1) % 5;
    this.client?.setWfSpeed(this.wfSpeed);
    this.refresh();
  }

  /** Cycle AGC: slow → med → fast → off → slow … Pushes the new mode
   *  to the Kiwi (if connected), updates the button label, and persists
   *  the choice across reloads. */
  private cycleAgc() {
    const order: Array<typeof this.agcMode> = ['slow', 'med', 'fast', 'off'];
    const i = order.indexOf(this.agcMode);
    this.agcMode = order[(i + 1) % order.length];
    localStorage.setItem('radiom.agcMode', this.agcMode);
    this.client?.setAgcMode(this.agcMode, this.rfGain);
    this.refreshAgcButton();
    // OpenWebRX has server-side AGC and exposes no client knob. Use the
    // RF knob as the preamp gain instead — the button just shows a hint.
    if (this.isOwrxSource()) {
      this.banner('AGC server-side on OWRX — use RF knob for level', 2200);
    } else {
      this.banner(`AGC: ${this.agcMode.toUpperCase()}`, 1200);
    }
  }

  private refreshAgcButton() {
    const btn = this.root.querySelector('#btnAgc') as HTMLElement | null;
    if (btn) {
      btn.textContent = 'AGC';
      btn.classList.toggle('active', this.agcMode !== 'off');
    }
    const lbl = this.root.querySelector('#lblAgc') as HTMLElement | null;
    if (lbl) lbl.textContent = `AGC ${this.agcMode.toUpperCase()}`;
  }

  /** F2 cursor — secondary frequency marker. The user taps the F2
   *  button to snap the F2 cursor to whatever the current tuning
   *  frequency (F) is. Long-press hides the cursor. The BW readout on
   *  the waterfall shows |F − F2| while F2 is visible. */
  private sigLeftKHz:   number | null = null;     // F2 frequency
  private sigLeftActive = false;                  // F2 visible?
  /** Master cursor-visibility toggle (FC button). When false, both the
   *  F (tuning) cursor and the F2 cursor are forced hidden regardless
   *  of their individual visibility state, and the BW readout is
   *  suppressed. Default on. */
  private cursorsVisible = true;

  private bindFcButton(): void {
    const btn = this.$('btnSigFc') as HTMLElement;
    btn.addEventListener('click', () => {
      this.cursorsVisible = !this.cursorsVisible;
      btn.classList.toggle('active', this.cursorsVisible);
      this.refreshCursor();
    });
  }

  private refreshF2Button(): void {
    const el = this.$('btnSigL') as HTMLElement;
    el.classList.toggle('active', this.sigLeftActive);
  }

  private bindF2Button(): void {
    const btn = this.$('btnSigL') as HTMLElement;
    let longFired = false;
    let timer: number | null = null;
    btn.addEventListener('pointerdown', () => {
      longFired = false;
      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        longFired = true;
        this.sigLeftActive = false;
        this.refreshF2Button();
        this.refreshCursor();
        this.banner('F2 hidden', 1000);
      }, 600);
    });
    const cancel = () => { if (timer != null) { clearTimeout(timer); timer = null; } };
    btn.addEventListener('pointerup',     cancel);
    btn.addEventListener('pointerleave',  cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('click', (e) => {
      if (longFired) { e.stopImmediatePropagation(); longFired = false; return; }
      // Snap F2 to the current F (tuning) frequency and show it.
      this.sigLeftKHz   = this.freqKHz;
      this.sigLeftActive = true;
      this.refreshF2Button();
      this.refreshCursor();
    });
  }

  /** SID — record 10 s of the raw IQ stream (complex baseband from the
   *  receiver's IQ mode) and run the full local DSP analysis on the
   *  complex signal: two-sided spectrum, AMC features, higher-order
   *  cumulants, cepstrum, autocorrelation-based baud estimate, cyclic
   *  spectrum, modulation fingerprinting. No network call. Requires
   *  the receiver to be in IQ mode. */
  private sigBusy = false;
  private static SID_CAPTURE_SECONDS = 20;
  private async runSigIdentifyLocal(): Promise<void> {
    if (this.sigBusy) return;
    if (!this.player.iqMode) {
      this.banner('SID — switch the receiver to IQ mode first', 2500);
      return;
    }
    clearSigOverlay();
    const btn = this.$('btnSigId2') as HTMLElement;
    btn.classList.add('busy');
    const totalSec = Shell.SID_CAPTURE_SECONDS;
    this.sigBusy = true;
    let secondsLeft = totalSec;
    btn.textContent = `● SID ${secondsLeft}`;
    this.banner(`SID — recording IQ baseband · ${secondsLeft} s remaining`, 1100);
    const tick = window.setInterval(() => {
      secondsLeft--;
      if (secondsLeft >= 0) {
        btn.textContent = `● SID ${secondsLeft}`;
        // Banner ms is set just over 1 s so it never blinks out between
        // ticks; the next banner() call replaces the previous text in
        // place.
        this.banner(`SID — recording IQ baseband · ${secondsLeft} s remaining`, 1100);
      }
    }, 1000);
    try {
      const freq = this.freqKHz;
      const mode = this.mode;
      const blob = await this.captureIq(totalSec);
      if (!blob) { this.banner('SID — no IQ data captured', 2000); return; }
      btn.textContent = '● SID';
      this.banner('SID — running local DSP analysis…', 1500);
      const { I, Q, sampleRate } = await decodeWavIQ(blob);
      // SID runs on the *raw* IQ baseband from the Kiwi — no NB / DCK /
      // passband / notch / NR cleanup. The measurements report on what
      // the receiver actually sees, not on a filtered view.
      const report = analyzeLocalIQ({
        I, Q, sampleRate, freqKHz: freq, mode,
      });
      // Cache the report (plus the RX state at capture time) so the AI
      // panel's "sid" button can feed it to the model without re-running
      // analyzeLocalIQ.
      this.lastSidReport = report;
      this.lastSidFreqKHz = freq;
      this.lastSidMode = mode;
      this.lastSidAt = Date.now();
      showSigOverlay(
        this.$('wf').parentElement as HTMLElement,
        report,
        'SID',
        (m, ms) => this.banner(m, ms),
      );
    } catch (err) {
      const msg = (err instanceof Error) ? err.message : String(err);
      this.banner(`SID — ${msg.slice(0, 80)}`, 4000);
    } finally {
      clearInterval(tick);
      this.sigBusy = false;
      btn.classList.remove('busy');
      btn.textContent = 'SID';
    }
  }

  /** VAL — run the SID classifier against the server-hosted labeled
   *  fingerprint table (`/api/fingerprints`). Each fingerprint entry
   *  has a `samples` URL list; for each sample we Hilbert-transform
   *  the audio to analytic IQ, run `analyzeLocalIQ`, parse the top
   *  protocol fingerprint from the report, and check whether it
   *  matches the fingerprint's expected name or id (case-insensitive
   *  substring on tokens). */

  /** PSKR — fetch PSK Reporter reception reports around the cursor
   *  frequency over the last 15 minutes. Displays the result in the
   *  SID overlay as a sorted list of senders + modes + SNR. Useful
   *  to answer "what's on this frequency right now?" even when the
   *  SID classifier can't fingerprint the signal. */
  private pskrBusy = false;
  private async runPskReporter(): Promise<void> {
    if (this.pskrBusy) return;
    this.pskrBusy = true;
    const btn = this.$('btnPskr') as HTMLElement;
    btn.classList.add('busy');
    clearSigOverlay();
    const lines: string[] = [];
    try {
      const freqKHz = this.freqKHz;
      this.banner(`PSKR — querying reports near ${freqKHz.toFixed(3)} kHz…`, 1500);
      const url = `/api/pskreporter?freqKHz=${freqKHz.toFixed(3)}&halfBandKHz=5&windowMin=15`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as {
        reports: { when: number; senderCallsign: string; senderLocator: string;
                   receiverCallsign: string; receiverLocator: string;
                   freqHz: number; mode: string; snr: number }[];
      };
      const reports = data.reports || [];
      lines.push(`# PSK Reporter — reception reports`);
      lines.push('');
      lines.push(`**Frequency:** ${freqKHz.toFixed(3)} kHz ± 5 kHz · **Window:** last 15 min · **Reports:** ${reports.length}`);
      if (reports.length === 0) {
        lines.push('');
        lines.push(`*(no reports in window — frequency is quiet on PSK Reporter)*`);
      } else {
        // Per-mode summary.
        const byMode: Record<string, number> = {};
        for (const r of reports) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
        lines.push('');
        lines.push(`## Modes`);
        lines.push('');
        lines.push('```');
        for (const m of Object.keys(byMode).sort((a, b) => byMode[b] - byMode[a])) {
          lines.push(`  ${m.padEnd(8)} ${byMode[m]}`);
        }
        lines.push('```');
        // Unique senders.
        const senders = new Map<string, { count: number; bestSnr: number; modes: Set<string>; locator: string }>();
        for (const r of reports) {
          const e = senders.get(r.senderCallsign) ?? { count: 0, bestSnr: -99, modes: new Set<string>(), locator: r.senderLocator };
          e.count++;
          if (r.snr > e.bestSnr) e.bestSnr = r.snr;
          e.modes.add(r.mode);
          if (!e.locator) e.locator = r.senderLocator;
          senders.set(r.senderCallsign, e);
        }
        lines.push('');
        lines.push(`## Senders — ${senders.size} unique`);
        lines.push('');
        lines.push('```');
        const sorted = Array.from(senders.entries())
          .sort((a, b) => b[1].count - a[1].count);
        lines.push(`Call         Loc      Modes              Reports  Best SNR`);
        for (const [call, info] of sorted) {
          const m = Array.from(info.modes).join(',');
          lines.push(`${call.padEnd(12)} ${info.locator.padEnd(8)} ${m.padEnd(18)} ${String(info.count).padEnd(7)} ${(info.bestSnr >= 0 ? '+' : '') + info.bestSnr} dB`);
        }
        lines.push('```');
      }
    } catch (err) {
      lines.push(`**PSKR — error:** ${(err as Error).message}`);
    } finally {
      showSigOverlay(
        this.$('wf').parentElement as HTMLElement,
        lines.join('\n'),
        'PSKR',
        (m, ms) => this.banner(m, ms),
      );
      this.pskrBusy = false;
      btn.classList.remove('busy');
    }
  }

  /** WNET — WSPR beacon transmitters heard near the cursor freq
   *  over the last hour. Source: db1.wspr.live (public ClickHouse
   *  mirror of WSPRnet, no login required). */
  private wsprBusy = false;
  private async runWspr(): Promise<void> {
    if (this.wsprBusy) return;
    this.wsprBusy = true;
    const btn = this.$('btnWnet') as HTMLElement;
    btn.classList.add('busy');
    clearSigOverlay();
    const lines: string[] = [];
    try {
      const freqKHz = this.freqKHz;
      this.banner(`WNET — querying WSPR spots near ${freqKHz.toFixed(3)} kHz…`, 1500);
      const url = `/api/wsprnet?freqKHz=${freqKHz.toFixed(3)}&halfBandKHz=10&windowMin=60`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as {
        total: number; windowMin: number;
        freqKHz: number; halfBandKHz: number;
        transmitters: { tx_sign: string; tx_loc: string; hits: number;
                        bestSnr: number; maxDistanceKm: number;
                        lastHeardAgoSec: number; freqHz: number }[];
      };
      lines.push(`# WSPRnet beacon activity`);
      lines.push('');
      lines.push(`**Frequency:** ${freqKHz.toFixed(3)} kHz ± ${data.halfBandKHz} kHz · **Window:** last ${data.windowMin} min · **Source:** db1.wspr.live (public WSPRnet mirror)`);
      lines.push('');
      lines.push(`**Spots:** ${data.total} total · **Unique transmitters:** ${data.transmitters.length}`);
      if (data.transmitters.length === 0) {
        lines.push('');
        lines.push(`*(no WSPR transmitters heard in window — try tuning to a WSPR band freq: 0.4742, 1.8366, 3.5686, 5.2872, 5.3645, 7.0386, 10.1387, 14.0956, 18.1046, 21.0946, 24.9246, 28.1246, 50.293 MHz)*`);
      } else {
        lines.push('');
        lines.push('## Transmitters');
        lines.push('');
        lines.push('```');
        lines.push(`Call         Loc      Hits   Best SNR  Max km  Freq Hz   Last heard`);
        for (const t of data.transmitters) {
          const ageMin = Math.round(t.lastHeardAgoSec / 60);
          const ageStr = ageMin <= 0 ? 'now' : `${ageMin}m ago`;
          lines.push(`${t.tx_sign.padEnd(12)} ${t.tx_loc.padEnd(8)} ${String(t.hits).padStart(4)}   ${(t.bestSnr >= 0 ? '+' : '') + t.bestSnr} dB   ${String(t.maxDistanceKm).padStart(5)}  ${String(t.freqHz).padStart(8)}  ${ageStr}`);
        }
        lines.push('```');
      }
    } catch (err) {
      lines.push(`**WNET — error:** ${(err as Error).message}`);
    } finally {
      showSigOverlay(
        this.$('wf').parentElement as HTMLElement,
        lines.join('\n'),
        'WNET',
        (m, ms) => this.banner(m, ms),
      );
      this.wsprBusy = false;
      btn.classList.remove('busy');
    }
  }

  /** DX — real-time DX cluster spots around the cursor frequency.
   *  Server holds a persistent telnet connection to a public node and
   *  parses every "DX de SPOTTER: FREQ CALL COMMENT TIMEZ" line into
   *  a ring buffer. This button queries that buffer filtered by freq
   *  window + age. */
  private dxBusy = false;
  private async runDxSpots(): Promise<void> {
    if (this.dxBusy) return;
    this.dxBusy = true;
    const btn = this.$('btnDx') as HTMLElement;
    btn.classList.add('busy');
    clearSigOverlay();
    const lines: string[] = [];
    try {
      const freqKHz = this.freqKHz;
      this.banner(`DX — querying cluster spots near ${freqKHz.toFixed(3)} kHz…`, 1500);
      const url = `/api/dxspots?freqKHz=${freqKHz.toFixed(3)}&halfBandKHz=10&windowMin=30`;
      const r = await fetch(url, { cache: 'no-store' });
      if (r.status === 503) {
        const j = await r.json();
        throw new Error(j.error || 'DX cluster disabled');
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as {
        connected: boolean;
        bufferSize: number;
        windowMin: number;
        spots: { when: number; spotter: string; freqKHz: number;
                 callsign: string; comment: string }[];
      };
      lines.push(`# DX cluster spots`);
      lines.push('');
      lines.push(`**Frequency:** ${freqKHz.toFixed(3)} kHz ± 10 kHz · **Window:** last ${data.windowMin} min`);
      lines.push('');
      lines.push(`**Status:** ${data.connected ? 'connected' : 'disconnected / connecting'} · **Buffered:** ${data.bufferSize} spots · **Matches:** ${data.spots.length}`);
      if (data.spots.length === 0) {
        lines.push('');
        lines.push(data.connected
          ? `*(no spots in window at this frequency — try widening the band with another click after a while, or check the live status)*`
          : `*(cluster not yet connected — wait a few seconds and retry)*`);
      } else {
        lines.push('');
        lines.push('## Spots');
        lines.push('');
        lines.push('```');
        lines.push(`Time UTC   Freq      Callsign       Spotter        Comment`);
        const now = Date.now();
        for (const s of data.spots) {
          const age = Math.round((now - s.when) / 60_000);
          const ageStr = age <= 0 ? 'now' : `${age}m ago`;
          lines.push(`${ageStr.padEnd(8)}   ${s.freqKHz.toFixed(1).padStart(8)}  ${s.callsign.padEnd(14)} ${s.spotter.padEnd(14)} ${s.comment}`);
        }
        lines.push('```');
      }
    } catch (err) {
      lines.push(`**DX — error:** ${(err as Error).message}`);
    } finally {
      showSigOverlay(
        this.$('wf').parentElement as HTMLElement,
        lines.join('\n'),
        'DX',
        (m, ms) => this.banner(m, ms),
      );
      this.dxBusy = false;
      btn.classList.remove('busy');
    }
  }

  /** NETS — aggregate amateur HF activity reported on PSK Reporter
   *  across all HF ham bands in the last 15 minutes. Useful for
   *  finding "where amateurs are active right now" — a band-by-band
   *  snapshot, not a frequency-specific query. */
  private netsBusy = false;
  private async runNets(): Promise<void> {
    if (this.netsBusy) return;
    this.netsBusy = true;
    const btn = this.$('btnNets') as HTMLElement;
    btn.classList.add('busy');
    clearSigOverlay();
    const lines: string[] = [];
    try {
      this.banner(`NETS — aggregating amateur activity…`, 1500);
      const r = await fetch('/api/nets?windowMin=15', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as {
        windowMin: number;
        bands: { band: string; loMHz: number; hiMHz: number;
                 reports: number; uniqueSenders: number;
                 modes: { mode: string; count: number }[] }[];
        voiceNets?: { name: string; freqKHz: number; mode: string;
                      startUTC: number; endUTC: number; days: string;
                      region: string; notes: string }[];
        stale?: boolean;
        upstreamError?: string;
      };
      lines.push(`# Amateur HF activity & voice nets`);
      if (data.stale) {
        lines.push('');
        lines.push(`> ⚠ PSK Reporter unreachable (${data.upstreamError ?? 'unknown'}) — showing last good snapshot`);
      }
      lines.push('');
      lines.push(`## Live activity — PSK Reporter, last ${data.windowMin} min`);
      if (data.bands.length === 0) {
        lines.push('');
        lines.push(`*(no amateur activity reported on any HF band)*`);
      } else {
        const totalReports = data.bands.reduce((s, b) => s + b.reports, 0);
        const totalSenders = data.bands.reduce((s, b) => s + b.uniqueSenders, 0);
        lines.push('');
        lines.push(`**Total:** ${totalReports} reports · ${totalSenders} senders across ${data.bands.length} active bands`);
        lines.push('');
        lines.push('```');
        lines.push(`Band      Range MHz       Reports  Senders  Top modes`);
        for (const b of data.bands) {
          const range = `${b.loMHz.toFixed(3)}-${b.hiMHz.toFixed(3)}`;
          const modes = b.modes.slice(0, 5)
            .map(m => `${m.mode}(${m.count})`).join(' ');
          lines.push(`${b.band.padEnd(8)} ${range.padEnd(15)} ${String(b.reports).padStart(7)}  ${String(b.uniqueSenders).padStart(7)}  ${modes}`);
        }
        lines.push('```');
      }
      const voiceNets = data.voiceNets || [];
      lines.push('');
      lines.push(`## Voice nets active now — curated list`);
      if (voiceNets.length === 0) {
        lines.push('');
        lines.push(`*(no scheduled voice net active at this UTC time)*`);
      } else {
        lines.push('');
        lines.push('```');
        lines.push(`Freq      Mode  Time UTC   Days     Net                                  Region`);
        for (const n of voiceNets) {
          const sh = String(Math.floor(n.startUTC / 100)).padStart(2, '0');
          const sm = String(n.startUTC % 100).padStart(2, '0');
          const eh = String(Math.floor(n.endUTC / 100)).padStart(2, '0');
          const em = String(n.endUTC % 100).padStart(2, '0');
          const days = (n.days || '').trim() || '-';
          lines.push(`${n.freqKHz.toFixed(0).padStart(6)}   ${n.mode.padEnd(4)}  ${sh}${sm}-${eh}${em}   ${days.padEnd(7)}  ${n.name.slice(0, 36).padEnd(36)}  ${n.region}${n.notes ? '  // ' + n.notes : ''}`);
        }
        lines.push('```');
      }
    } catch (err) {
      lines.push(`**NETS — error:** ${(err as Error).message}`);
    } finally {
      showSigOverlay(
        this.$('wf').parentElement as HTMLElement,
        lines.join('\n'),
        'NETS',
        (m, ms) => this.banner(m, ms),
      );
      this.netsBusy = false;
      btn.classList.remove('busy');
    }
  }

  /** EIBI — look up the EiBi shortwave broadcast schedule for the
   *  cursor frequency at the current UTC time. Shows scheduled
   *  broadcasters within ±10 kHz whose time window covers now. */
  private eibiBusy = false;
  private async runEibi(): Promise<void> {
    if (this.eibiBusy) return;
    this.eibiBusy = true;
    const btn = this.$('btnEibi') as HTMLElement;
    btn.classList.add('busy');
    clearSigOverlay();
    const lines: string[] = [];
    try {
      const freqKHz = this.freqKHz;
      this.banner(`EIBI — querying schedule near ${freqKHz.toFixed(3)} kHz…`, 1500);
      const url = `/api/eibi?freqKHz=${freqKHz.toFixed(3)}&windowKHz=10`;
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as {
        total: number;
        matches: number;
        utc: { hhmm: number; day: number };
        entries: { freqKHz: number; startUTC: number; endUTC: number;
                   days: string; country: string; station: string;
                   language: string; target: string; txSite: string;
                   remarks: string }[];
      };
      const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][data.utc.day];
      const hh = Math.floor(data.utc.hhmm / 100).toString().padStart(2, '0');
      const mm = (data.utc.hhmm % 100).toString().padStart(2, '0');
      lines.push(`# EIBI shortwave broadcast schedule`);
      lines.push('');
      lines.push(`**Frequency:** ${freqKHz.toFixed(3)} kHz ± 10 kHz · **UTC time:** ${hh}:${mm} ${dayName}`);
      lines.push('');
      lines.push(`**Source:** eibispace.de/dx/sked-a26.csv (${data.total} total entries) · **Matches:** ${data.matches}`);
      if (data.entries.length === 0) {
        lines.push('');
        lines.push(`*(no scheduled broadcast at this frequency / time)*`);
      } else {
        lines.push('');
        lines.push('## Scheduled broadcasts');
        for (const e of data.entries) {
          const sh = String(Math.floor(e.startUTC / 100)).padStart(2, '0');
          const sm = String(e.startUTC % 100).padStart(2, '0');
          const eh = String(Math.floor(e.endUTC / 100)).padStart(2, '0');
          const em = String(e.endUTC % 100).padStart(2, '0');
          const country  = eibiCountry(e.country);
          const language = eibiLanguage(e.language);
          const target   = eibiTarget(e.target);
          const txSite   = eibiTxSite(e.txSite);
          lines.push('');
          lines.push(`### ${e.freqKHz.toFixed(0)} kHz · ${sh}${sm}–${eh}${em} UTC · ${e.station}`);
          lines.push('');
          if (country)  lines.push(`- **Country:** ${country}${e.country && country !== e.country ? ` (\`${e.country}\`)` : ''}`);
          if (language) lines.push(`- **Language:** ${language}${e.language && language !== e.language ? ` (\`${e.language}\`)` : ''}`);
          if (target)   lines.push(`- **Target:** ${target}${e.target && target !== e.target ? ` (\`${e.target}\`)` : ''}`);
          if (txSite)   lines.push(`- **Transmitter site:** ${txSite}${e.txSite && txSite !== e.txSite ? ` (\`${e.txSite}\`)` : ''}`);
          if (e.days)   lines.push(`- **Days:** ${e.days}`);
          if (e.remarks) lines.push(`- **Remarks:** ${e.remarks}`);
        }
      }
    } catch (err) {
      lines.push(`**EIBI — error:** ${(err as Error).message}`);
    } finally {
      showSigOverlay(
        this.$('wf').parentElement as HTMLElement,
        lines.join('\n'),
        'EIBI',
        (m, ms) => this.banner(m, ms),
      );
      this.eibiBusy = false;
      btn.classList.remove('busy');
    }
  }

  private sigValBusy = false;
  private async runSigValidation(): Promise<void> {
    if (this.sigValBusy) return;
    this.sigValBusy = true;
    const btn = this.$('btnSigVal') as HTMLElement;
    btn.classList.add('busy');
    clearSigOverlay();
    const lines: string[] = [];
    try {
      // ── Fetch the fingerprint table from the server.
      const fpResp = await fetch('/api/fingerprints', { cache: 'no-store' });
      if (!fpResp.ok) throw new Error(`fingerprints fetch HTTP ${fpResp.status}`);
      const fpData = await fpResp.json() as {
        version: number;
        fingerprints: { id: string; name: string; family: string;
                        matcher: string; params: Record<string, unknown>;
                        samples: string[] }[];
      };

      // Flatten (fingerprint × samples) into individual test cases.
      type Case = { fpId: string; fpName: string; family: string; url: string };
      const cases: Case[] = [];
      for (const fp of fpData.fingerprints) {
        for (const s of fp.samples) {
          cases.push({ fpId: fp.id, fpName: fp.name, family: fp.family, url: s });
        }
      }

      lines.push('# SID classifier validation against server fingerprint table');
      lines.push('');
      lines.push(`**Fingerprints:** ${fpData.fingerprints.length} · **Test cases:** ${cases.length} samples`);
      lines.push('');
      lines.push('## Per-sample results');
      lines.push('');
      lines.push('`✓` = top fingerprint matches expected name/id · `✗` = mismatch · `!` = decode error');
      lines.push('');
      lines.push('```');

      let ok = 0, fail = 0, errors = 0;
      const byFamily: Record<string, { ok: number; total: number }> = {};
      const fails: { truth: string; got: string }[] = [];
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        byFamily[c.family] ??= { ok: 0, total: 0 };
        byFamily[c.family].total++;
        this.banner(`VAL ${i + 1}/${cases.length} — ${c.fpName}`, 1500);
        try {
          const mono = await decodeMonoFloat32(c.url, 12000);
          const { I, Q } = hilbertAnalytic(mono);
          const report = analyzeLocalIQ({ I, Q, sampleRate: 12000, freqKHz: 0, mode: 'iq' });
          const top = extractTopFingerprint(report);
          const passed = fingerprintNameMatches(top, c.fpName, c.fpId);
          if (passed) { ok++; byFamily[c.family].ok++; lines.push(`✓  ${c.fpName.padEnd(28)} → ${top}`); }
          else        { fail++; fails.push({ truth: c.fpName, got: top });
                       lines.push(`✗  ${c.fpName.padEnd(28)} → ${top}`); }
        } catch (err) {
          errors++;
          lines.push(`!  ${c.fpName.padEnd(28)} → ERROR: ${(err as Error).message?.slice(0, 60)}`);
        }
        await new Promise(r => setTimeout(r, 10));
      }

      lines.push('```');
      const total = ok + fail + errors;
      lines.push('');
      lines.push('## Summary');
      lines.push('');
      lines.push('```');
      lines.push(`Total   : ${total}`);
      lines.push(`Correct : ${ok}  (${total > 0 ? (100 * ok / total).toFixed(1) : '0'} %)`);
      lines.push(`Wrong   : ${fail}`);
      lines.push(`Errors  : ${errors}`);
      lines.push('```');

      lines.push('');
      lines.push('## Per-family');
      lines.push('');
      lines.push('```');
      for (const fam of Object.keys(byFamily).sort()) {
        const f = byFamily[fam];
        const pct = f.total > 0 ? (100 * f.ok / f.total).toFixed(0) : '0';
        lines.push(`${fam.padEnd(12)} ${f.ok}/${f.total}  (${pct} %)`);
      }
      lines.push('```');

      if (fails.length) {
        lines.push('');
        lines.push('## Misclassifications');
        lines.push('');
        lines.push('```');
        for (const f of fails) lines.push(`${f.truth.padEnd(28)} → ${f.got}`);
        lines.push('```');
      }
    } catch (err) {
      lines.push(`**ERROR:** ${(err as Error).message}`);
    } finally {
      showSigOverlay(
        this.$('wf').parentElement as HTMLElement,
        lines.join('\n'),
        'VAL',
        (m, ms) => this.banner(m, ms),
      );
      this.sigValBusy = false;
      btn.classList.remove('busy');
    }
  }

  /** Capture `durationSec` seconds of the raw IQ stream as a stereo
   *  WAV blob (L=I, R=Q at 12 kHz, BE int16 from Kiwi → native LE).
   *  Chains onto the existing onIqRecord sink so the manual REC button
   *  in IQ mode stays usable in parallel. */
  private captureIq(durationSec: number): Promise<Blob | null> {
    return new Promise((resolve) => {
      const tmp = new Recorder();
      tmp.start(2);
      const sink = (b: Uint8Array): void => {
        // Kiwi delivers IQ as big-endian int16 pairs; convert to native.
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const out = new Int16Array(b.byteLength >> 1);
        for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, false);
        tmp.feed(out);
      };
      const prev = this.player.onIqRecord;
      this.player.onIqRecord = (b) => { prev?.(b); sink(b); };
      setTimeout(() => {
        this.player.onIqRecord = prev;
        resolve(tmp.stop());
      }, durationSec * 1000);
    });
  }

  /** Position the SL / SR vertical markers inside the waterfall. Called
   *  from refreshCursor() so the marker frequency stays fixed in kHz
   *  while the operator zooms / pans the view. Also updates the
   *  top-centre "bw = X kHz" label when both markers are set. */
  private refreshSigMarkers(loKHz: number, hiKHz: number): void {
    const el = this.$('sigMarkerL') as HTMLElement;
    const showF2 = this.cursorsVisible && this.sigLeftActive && this.sigLeftKHz != null;
    if (!showF2) {
      el.style.display = 'none';
    } else {
      const t = (this.sigLeftKHz! - loKHz) / (hiKHz - loKHz);
      if (t < 0 || t > 1) {
        el.style.display = 'none';
      } else {
        el.style.left = (t * 100) + '%';
        el.style.display = 'block';
      }
    }
    // BW readout: |F − F2| while F2 is visible (suppressed when FC is off).
    const bw = this.$('sigBwLabel') as HTMLElement;
    if (showF2) {
      const bwKHz = Math.abs(this.freqKHz - this.sigLeftKHz!);
      bw.textContent = `bw=${bwKHz.toFixed(3)}`;
      bw.style.display = 'block';
    } else {
      bw.style.display = 'none';
    }
  }

  /** Toggle the auto-notch: starts/stops a 200 ms periodic carrier
   *  detector that snapshots the pre-notch spectrum, finds the strongest
   *  narrow peak (single-bin spike well above its local floor — the
   *  signature of an unmodulated carrier / heterodyne whistle), and
   *  retunes the inline biquad notch to that frequency. */
  private toggleAntch() {
    this.antchOn = !this.antchOn;
    this.$$('[data-cmd="antch"]').forEach(b => b.classList.toggle('active', this.antchOn));
    this.player.setNotchEnabled(this.antchOn);
    if (this.antchOn) {
      // Disable AMN — only one notch strategy at a time.
      if (this.amnotchOn) this.toggleAmnotch();
      this.antchLastHz = 0;
      this.antchTimer = window.setInterval(() => this.tickAntch(), 200);
      this.banner('Auto-notch ON', 1200);
    } else {
      if (this.antchTimer != null) { clearInterval(this.antchTimer); this.antchTimer = null; }
      this.antchLastHz = 0;
      this.banner('Auto-notch OFF', 1200);
    }
  }

  /** One detector tick. Snapshot pre-notch spectrum, find the loudest
   *  narrow peak in the audio passband (200..3000 Hz), and retune the
   *  notch to it. A "narrow peak" is a single-bin spike whose magnitude
   *  is ≥ NARROW_DB above the median of its ±10-bin neighbourhood AND
   *  whose ±2-bin neighbours drop by ≥ NARROW_DROP_DB — the signature
   *  of a steady carrier vs. voice / noise. */
  private tickAntch() {
    const snap = this.player.getPreNotchSpectrum();
    if (!snap) return;
    const { mag, sampleRate, fftSize } = snap;
    const N = mag.length;
    const binHz = sampleRate / fftSize;
    const lo = Math.floor(200 / binHz);
    const hi = Math.min(N - 3, Math.floor(3000 / binHz));
    if (hi <= lo + 6) return;

    const NARROW_DB = 14;       // peak vs local-median height
    const NARROW_DROP = 6;      // drop from peak to ±2-bin neighbours
    let bestBin = -1, bestScore = 0;

    // Median of an N-window is overkill in JS; use a sort over a small
    // sliding window. Window radius = 10 bins ≈ 50 Hz at 5 Hz/bin.
    const R = 10;
    const tmp = new Float32Array(2 * R);
    for (let i = lo + R; i < hi - R; i++) {
      const v = mag[i];          // 0..255 — analyser maps minDb..maxDb here
      // Skip unless the centre bin dominates its immediate neighbours
      // (cheap filter before the heavier median calc).
      if (v <= mag[i - 1] || v <= mag[i + 1]) continue;
      // Drop test: ±2 bins must be NARROW_DROP_DB below the peak.
      const peakDb  = byteToDb(v);
      const sideDb  = Math.max(byteToDb(mag[i - 2]), byteToDb(mag[i + 2]));
      if (peakDb - sideDb < NARROW_DROP) continue;
      // Local-median (excluding the bin itself + its immediate neighbours).
      let k = 0;
      for (let j = i - R; j <= i + R; j++) {
        if (Math.abs(j - i) <= 1) continue;
        tmp[k++] = byteToDb(mag[j]);
      }
      const sorted = tmp.subarray(0, k).slice().sort();
      const med = sorted[k >> 1];
      const score = peakDb - med;
      if (score >= NARROW_DB && score > bestScore) {
        bestScore = score;
        bestBin = i;
      }
    }
    if (bestBin < 0) return;
    const hz = bestBin * binHz;
    if (Math.abs(hz - this.antchLastHz) < 5) return;
    this.antchLastHz = hz;
    this.player.setNotchFreq(hz);
  }

  /** Toggle the adaptive multi-notch (AMN / auto-comb). Mutually
   *  exclusive with the single auto-notch (NT). */
  private toggleAmnotch() {
    this.amnotchOn = !this.amnotchOn;
    const btn = this.$('btnAmnotch') as HTMLElement;
    btn.classList.toggle('active', this.amnotchOn);
    if (this.amnotchOn) {
      // Disable single auto-notch — AMN owns the notch chain.
      if (this.antchOn) this.toggleAntch();
      this.amnotchLastHzs = [];
      this.amnotchTimer = window.setInterval(() => this.tickAmnotch(), 200);
      this.banner('Adaptive multi-notch ON', 1200);
    } else {
      if (this.amnotchTimer != null) { clearInterval(this.amnotchTimer); this.amnotchTimer = null; }
      this.amnotchLastHzs = [];
      this.player.parkAllNotches();
      this.banner('Adaptive multi-notch OFF', 1200);
    }
  }

  /** AMN detector tick. Snapshot the pre-notch spectrum, find up to 4
   *  narrow carriers (same single-bin spike test as NT) and route them
   *  into the four notch biquads. Spacing rule: each picked peak must
   *  be ≥ 80 Hz from any peak already chosen, so 4 slots cover 4
   *  distinct carriers rather than crowding around one. */
  private tickAmnotch() {
    const snap = this.player.getPreNotchSpectrum();
    if (!snap) return;
    const { mag, sampleRate, fftSize } = snap;
    const N = mag.length;
    const binHz = sampleRate / fftSize;
    const lo = Math.floor(200 / binHz);
    const hi = Math.min(N - 3, Math.floor(3000 / binHz));
    if (hi <= lo + 6) return;
    // Lowered from (14, 6) to (8, 4) — the original thresholds only
    // caught very loud heterodynes; on real bands most whistles sit
    // 8-12 dB above the spectral median, not 14+, and a single bin
    // drop of 4 dB at ±2 bins is enough to identify a narrow tone
    // against post-demod noise. Result: AMN now actually fires on
    // typical SW heterodynes instead of doing nothing.
    const NARROW_DB = 8, NARROW_DROP = 4, R = 10;
    const tmp = new Float32Array(2 * R);
    type Hit = { bin: number; score: number };
    const hits: Hit[] = [];
    for (let i = lo + R; i < hi - R; i++) {
      const v = mag[i];
      if (v <= mag[i - 1] || v <= mag[i + 1]) continue;
      const peakDb  = byteToDb(v);
      const sideDb  = Math.max(byteToDb(mag[i - 2]), byteToDb(mag[i + 2]));
      if (peakDb - sideDb < NARROW_DROP) continue;
      let k = 0;
      for (let j = i - R; j <= i + R; j++) {
        if (Math.abs(j - i) <= 1) continue;
        tmp[k++] = byteToDb(mag[j]);
      }
      const sorted = tmp.subarray(0, k).slice().sort();
      const med = sorted[k >> 1];
      const score = peakDb - med;
      if (score >= NARROW_DB) hits.push({ bin: i, score });
    }
    if (hits.length === 0) {
      this.player.parkAllNotches();
      this.amnotchLastHzs = [];
      return;
    }
    // Greedy pick: strongest first, then enforce ≥ 80 Hz spacing.
    hits.sort((a, b) => b.score - a.score);
    const minSepBins = Math.max(1, Math.round(80 / binHz));
    const picked: number[] = [];
    for (const h of hits) {
      if (picked.every(p => Math.abs(p - h.bin) >= minSepBins)) {
        picked.push(h.bin);
        if (picked.length >= 4) break;
      }
    }
    const hzs = picked.map(b => b * binHz);
    // Stable order so visible peaks don't shuffle slots between ticks
    // (prevents tiny click-inducing retunes when ranking flutters).
    hzs.sort((a, b) => a - b);
    // Apply hysteresis: skip retune if every slot is within 5 Hz of
    // the previous assignment.
    if (this.amnotchLastHzs.length === hzs.length
        && hzs.every((h, i) => Math.abs(h - this.amnotchLastHzs[i]) < 5)) {
      return;
    }
    this.amnotchLastHzs = hzs;
    this.player.setMultiNotchFreqs(hzs);
  }

  /** Resize the passband to a target width (kHz). SSB modes anchor at the
   *  carrier (USB→[0,+w], LSB→[-w,0]) so widening BW never drags the
   *  filter onto the opposite sideband. All other modes (AM/SAM/NBFM/CW)
   *  resize symmetrically about the carrier. */
  private applyBandwidth(kHz: number) {
    const widthHz = Math.round(kHz * 1000);
    let lo: number, hi: number;
    // Cap raised from 8 → 12 kHz so the new 9k / 10k presets actually
    // produce the requested passband. Kiwi accepts up to ±12 kHz cuts.
    const MAX = 12_000;
    if (this.mode === 'usb') {
      lo = 0;
      hi = clamp(widthHz, 50, MAX);
    } else if (this.mode === 'lsb') {
      hi = 0;
      lo = clamp(-widthHz, -MAX, -50);
    } else {
      const half = Math.round(widthHz / 2);
      lo = clamp(-half, -MAX, 0);
      hi = clamp(half, 0, MAX);
    }
    if (hi - lo < 50) return;
    this.lowCut = lo;
    this.highCut = hi;
    this.activeBwPreset = kHz;
    this.applyPassband();
    this.refresh();
    this.banner(`Bandwidth ${kHz} kHz`, 1200);
  }

  /** Center the waterfall on the tuned frequency. Updates local wfStart so
   *  the cursor calculation in refreshCursor() matches what the server will
   *  send (centered on freqKHz). */
  private recenter() {
    if (this.isOwrxSource()) {
      // OWRX: the client-side slice owns view geometry; just re-anchor
      // the visible window on the dial freq.
      this.client?.setZoom(this.zoom, this.freqKHz);
      this.refreshCursor();
      return;
    }
    const totalBins = 1024 * (1 << this.zoom);
    const binAtFreq = (this.freqKHz * 1000 / this.bandwidthHz) * totalBins;
    this.wfStart = Math.max(0, Math.min(totalBins - 1024, Math.round(binAtFreq - 512)));
    this.client?.setZoom(this.zoom, this.freqKHz);
    this.refreshCursor();
  }

  /** Pan the waterfall window left/right by half its width. If the pan
   *  would push the tuned frequency outside the new visible range, the
   *  dial is clamped to the closer edge (with a ~5 % margin so the
   *  cursor stays comfortably inside the canvas) and retuned. The user
   *  ends up with the cursor "sticking" to the edge they're panning
   *  toward — the most natural behaviour for scanning across a band. */
  private panBy(deltaBins: number) {
    let loKHz: number, hiKHz: number;
    if (this.isOwrxSource()) {
      // OWRX path: bandwidthHz is the *visible window*, not the SDR's
      // full span, so the Kiwi-style 1024*(1<<zoom) accounting collapses.
      // Pan by the same fraction of the visible window (deltaBins is in
      // 1024-pixel canvas units, so deltaBins/1024 is the pan ratio).
      const spanKHz = this.bandwidthHz / 1000;
      const currentCentreKHz = this.owrxViewCenterKHz ?? this.freqKHz;
      const newCentreKHz = currentCentreKHz + (deltaBins / 1024) * spanKHz;
      this.client?.setZoom(this.zoom, newCentreKHz);
      loKHz = newCentreKHz - spanKHz / 2;
      hiKHz = newCentreKHz + spanKHz / 2;
    } else {
      const totalBins = 1024 * (1 << this.zoom);
      this.wfStart = Math.max(0, Math.min(totalBins - 1024, this.wfStart + deltaBins));
      const centerBin = this.wfStart + 512;
      const centerKHz = (centerBin / totalBins) * (this.bandwidthHz / 1000);
      this.client?.setZoom(this.zoom, centerKHz);
      const hzPerBin = this.bandwidthHz / totalBins;
      loKHz = (this.wfStart * hzPerBin) / 1000;
      hiKHz = ((this.wfStart + 1024) * hzPerBin) / 1000;
    }
    const margin = (hiKHz - loKHz) * 0.05;
    let clamped = this.freqKHz;
    if (clamped < loKHz + margin) clamped = loKHz + margin;
    else if (clamped > hiKHz - margin) clamped = hiKHz - margin;
    if (Math.abs(clamped - this.freqKHz) > 1e-6) {
      this.freqKHz = clamped;
      this.client?.setTune({
        mode: this.mode,
        freqKHz: this.freqKHz,
        lowCutHz: this.lowCut,
        highCutHz: this.highCut,
      });
      this.refresh();
    }
    this.refreshCursor();
  }

  /* ───────────── actions ───────────── */

  /** Short-tap behavior: just (re)connect or disconnect the Kiwi link.
   *  Audio context, decoder panels, and rAF loops stay as-is so anything
   *  the user had running keeps running across the disconnect. For the
   *  full nuke-everything path see `powerOffHard`. */
  private togglePower() {
    this.powered = !this.powered;
    // Green = connected, yellow = Kiwi disconnected but audio + panels
    // still alive (light off). Hard off (powerOffHard) clears the colour.
    (this.$('power') as HTMLElement).style.color = this.powered ? '#2ecc71' : '#e9a83a';
    if (this.powered) {
      this.player.resume();
      this.restoreEqGains();
      this.setLedDot('connecting');
      // Wipe the previous session's close info + cached MSG keys so the
      // diag chip doesn't show stale "closed at … (code …)" from the
      // last disconnect while we reconnect.
      this.lastCloseInfo = null;
      this.lastKv = {};
      this.refreshKiwiDiag();
      this.connect();
    } else {
      this.disconnect();
    }
  }

  /** Long-press behavior: hard off. Closes every open decoder/visualizer
   *  panel, drops the Kiwi link, and suspends the AudioContext so the
   *  page sits at ~0 % CPU. No-op if already powered off and nothing is
   *  running. */
  private powerOffHard() {
    this.shutdownAllPanels();
    if (this.powered) {
      this.powered = false;
      this.disconnect();
    }
    this.setLedDot('off');
    (this.$('power') as HTMLElement).style.color = '';
    this.player.suspend();
    this.banner('hard off — audio + decoders suspended', 1500);
  }

  /** Close every decoder/visualizer panel that's currently open. Used by
   *  the hard power-off path — leaves the UI in the same state as a
   *  fresh load (no rAF loops, no WS connections, no decoders running). */
  private shutdownAllPanels() {
    if (this.aiPanelOn)    this.toggleAiPanel();
    if (this.memPanelOn)   this.toggleMemPanel();
    if (this.cwOn)         this.toggleCw();
    if (this.rttyOn)       this.toggleRtty();
    if (this.pskOn)        this.togglePsk();
    if (this.psk31bOn)     this.togglePsk31b();
    if (this.oliviaOn)     this.toggleOlivia();
    if (this.mfskOn)       this.toggleMfsk();
    if (this.mt63On)       this.toggleMt63();
    if (this.fsqOn)        this.toggleFsq();
    if (this.thorOn)       this.toggleThor();
    if (this.dominoexOn)   this.toggleDominoex();
    if (this.contestiaOn)  this.toggleContestia();
    if (this.wefaxOn)      this.toggleWefax();
    if (this.navtexOn)     this.toggleNavtex();
    if (this.sitorOn)      this.toggleSitor();
    if (this.wwvOn)        this.toggleWwv();
    if (this.aleOn)        this.toggleAle();
    if (this.hfdlOn)       this.toggleHfdl();
    if (this.isbOn)        this.toggleIsb();
    if (this.ssbfOn)       this.toggleSsbFiltered(this.ssbfSide);
    if (this.qrssOn)       this.toggleQrss();
    if (this.packetOn)     this.togglePacket();
    if (this.packetVhfOn)  this.togglePacketVhf();
    if (this.packet9600On) this.togglePacket9600();
    if (this.packetIl2pOn) this.togglePacketIl2p();
    if (this.wsprOn)       this.toggleWspr();
    if (this.wspr15On)     this.toggleWspr15();
    if (this.jt9On)        this.toggleJt9();
    if (this.jt65On)       this.toggleJt65();
    if (this.q65On)        this.toggleQ65();
    if (this.fst4wOn)      this.toggleFst4w();
    if (this.stanagOn)     this.toggleStanag();
    if (this.stanag4539On) this.toggleStanag4539();
    if (this.hellOn)       this.toggleHell();
    if (this.sstvOn)       this.toggleSstv();
    if (this.freedvOn)     this.toggleFreedv();
    if (this.throbOn)      this.toggleThrob();
    if (this.jt4On)        this.toggleJt4();
    if (this.selcalOn)     this.toggleSelcal();
    if (this.pocsOn)       this.togglePocs();
    if (this.dsdOn)        this.toggleDsd(this.dsdMode);
    if (this.multimonOn)   this.toggleMultimon(this.multimonMode);
    if (this.vendoredOn && this.vendoredKind)
      this.toggleVendored(this.vendoredKind,
        this.vendoredEndpointFor(this.vendoredKind),
        this.vendoredSinkFor(this.vendoredKind));
    if (this.mcwOn)        this.toggleMcw();
    if (this.js8On)        this.toggleJs8();
    if (this.fst4On)       this.toggleFst4();
    if (this.autoOn)       this.toggleAuto();
    if (this.ft8On)        this.toggleFtx(this.ft8Mode);
    if (this.faxScanOn)    this.stopFaxScan();
    if (this.audioFftOn)   this.toggleAudioFft();
    if (this.iqViewOn)     this.toggleIqView();
    if (this.sPlotOn)      this.toggleSPlot();
    if (this.fmntOn)       this.toggleFmnt();
    if (this.sDialOn)      this.toggleSDial();
    if (this.driftOn)      this.toggleDrift();
    if (this.scopeOn)      this.toggleScope();
    if (this.thdOn)        this.toggleThd();
    if (this.grayOn)       this.toggleGray();
    if (this.vectOn)       this.toggleVect();
    if (this.iqEyeOn)      this.toggleIqEye();
  }

  /** Update the connection-status indicator in the topbar. */
  private setLedDot(state: 'off' | 'connecting' | 'on') {
    const el = this.$('connDot') as HTMLElement | null;
    if (el) el.dataset.state = state;
  }

  private async connect() {
    const source = (localStorage.getItem('radiom.activeSource') as 'kiwi' | 'owrx' | 'rtl') || 'kiwi';
    this.client?.disconnect();

    try {
      const sr = await this.player.start((s) => this.log(s));
      this.applyOutputGain();
      this.player.setVoiceTrackGain(this.vTrackGain);
      this.player.setVoiceTrack2Gain(this.vTrackGain);
      this.player.setVoiceTrack3Gain(this.vTrackGain);
      this.log(`audio ready @ ${sr} Hz`);
    } catch (e) {
      this.log('audio start FAILED: ' + (e as Error).message);
    }

    // Shared handler bundle — both sources adapt their wire format into
    // Kiwi-shaped AudioFrame / WaterfallFrame / kv messages, so the same
    // closures work for either. KV keys that only one source emits (e.g.
    // Kiwi's `audio_rate`, OpenWebRX's `clients`) just fall through the
    // ifs for the other source.
    const handlers = {
      onStatus: (s: KiwiStatus) => {
        if (!this.powered) { this.setLedDot('off'); return; }
        this.setLedDot(s.connected ? 'on' : 'connecting');
      },
      onMessage: this.makeKvHandler(),
      onAudio: (f: AudioFrame) => {
        this.lastFrameTs = Date.now();
        this.player.pushAudio(f);
        const a = 0.2;
        this.smeterDbm = this.smeterDbm * (1 - a) + f.rssiDbm * a;
        if (this.sPlotOn) this.sPlotPushSample(f.rssiDbm);
      },
      onWaterfall: (f: WaterfallFrame) => {
        this.lastFrameTs = Date.now();
        this.lastWfBins = f.bins;
        this.lastWfXBinServer = f.xBinServer;
        this.spectrum.pushFrame(f);
        if (this.wfAutoMode > 0) this.feedWfHist(f.bins);
      },
      onError: (e: Error) => { this.log('ERR ' + e.message); this.captureCloseDiag(e.message); this.refreshKiwiDiag(); },
      onClose: () => { this.log('socket closed'); this.refreshKiwiDiag(); },
    } as const;

    let originLabel: string;
    if (source === 'owrx') {
      const url = localStorage.getItem('radiom.lastOwrxServer') || '';
      if (!url) { this.log('no OpenWebRX server picked'); return; }
      // Pick an output rate that's an integer divisor of the player's
      // AudioContext sample rate so the upsample is exactly ×N (no
      // fractional resampling). Same algorithm the native OWRX page
      // uses. Apply to the player BEFORE the first audio frame arrives.
      const ctxSR = this.player.getAudioRate?.() ?? 48000;
      const outRate = OpenWebRxClient.pickOutputRate(ctxSR, 8000, 12000) ?? 12000;
      this.player.setInputRate(outRate);
      this.log(`owrx output_rate=${outRate} (ctxSR=${ctxSR})`);
      this.refresh();
      this.client = new OpenWebRxClient(
        {
          url: owrxWsUrl(url),
          ident: this.settings.callSign,
          audioOutRate: outRate,
          ctxSampleRate: ctxSR,
        },
        handlers,
      );
      originLabel = `OpenWebRX ${url}`;
    } else if (source === 'rtl') {
      const url = localStorage.getItem('radiom.lastRtlServer') || (this.$('server') as HTMLInputElement).value.trim();
      if (!url || !/^[\w.-]+:\d+$/.test(url)) {
        this.log('no rtl_tcp server picked (expecting host:port)');
        return;
      }
      // rtl_tcp is pure IQ. We don't get audio frames — the player's
      // existing IQ pipeline (HFDL / ISB / etc.) handles whatever the
      // user picks for demod. Set the input rate hint to the decimated
      // output (250 kS/s default).
      this.player.setInputRate(250_000);
      this.refresh();
      const rtlClient = new RtlTcpClient(
        { url, centerHz: Math.round(this.freqKHz * 1000) },
        {
          onMessage: handlers.onMessage,
          onError:   handlers.onError,
          onClose:   handlers.onClose,
          onStatus:  (s) => handlers.onStatus?.({
            connected: s.connected, sampleRate: 250_000,
            centerFreq: Math.round(this.freqKHz * 1000), bandwidth: 250_000,
          } as KiwiStatus),
          // RTL emits IQ samples directly — route to player.onIq so the
          // existing IQ-consuming decoders (HFDL/ISB/SSBf/LRPT) work.
          onIq: (iq) => { this.player.onIq?.(iq); },
        },
      );
      // The wrapper exposes connect()/setTune() shape the shell expects.
      // RtlTcpClient already opens its WS in the constructor; the
      // shell's `this.client.connect()` below is a no-op for it.
      this.client = rtlClient;
      originLabel = `rtl_tcp ${url}`;
    } else {
      const raw = (this.$('server') as HTMLInputElement).value.trim();
      const [host, portStr] = raw.split(':');
      const port = +(portStr || '8073');
      if (!host) return;
      localStorage.setItem('radiom.lastServer', raw);
      if (this.rxChans == null) this.seedUsersFromEntry(findServerEntry(raw));
      this.refresh();
      originLabel = `${host}:${port}`;
      this.client = new KiwiClient(
        { host, port, ident: this.settings.callSign, geoLocation: this.settings.geoLocation },
        handlers,
      );
    }
    this.client.connect();
    // Hide any leftover no-data banner from a previous session.
    const ndlInit = this.root.querySelector('#noDataLabel') as HTMLElement | null;
    if (ndlInit) ndlInit.style.display = 'none';
    // No-data watchdog: when no audio/wf frame arrives for >12 s, surface
    // a banner and tear down the connection.
    this.lastFrameTs = Date.now();
    if (this.wfAutoMode > 0) this.startWfAutoTimer();
    if (this.noDataTimer != null) clearInterval(this.noDataTimer);
    this.noDataTimer = setInterval(() => {
      const stale = this.lastFrameTs > 0 && (Date.now() - this.lastFrameTs) > 12_000;
      if (stale) {
        const ndl = this.root.querySelector('#noDataLabel') as HTMLElement | null;
        if (ndl) ndl.style.display = '';
        this.disconnect();
      }
    }, 1000) as unknown as number;
    // Apply current state once connected. OpenWebRxClient's no-op stubs
    // (NR/ADPCM/NB/AGC/WfSpeed) make the unconditional calls safe for
    // either source.
    this.client.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
    this.client.setSquelch(this.sql);
    this.player.setSquelchGate(this.sql > 0 ? -111 + this.sql : null);
    this.player.setNoiseGate(this.gate > 0 ? -100 + this.gate : null);
    this.client.setNoiseReduction(this.nrMode);
    this.client.setAdpcm(this.toggles.adpcm);
    this.client.setWfSpeed(this.wfSpeed);
    if (this.nbMode > 0) this.client.setNoiseBlanker(this.nbMode);
    if (this.agcMode !== 'med') this.client.setAgcMode(this.agcMode, this.rfGain);
    this.player.setCompressor(this.toggles.comp);
    this.applyOutputGain();
    this.recenter();
    this.log(`connecting to ${originLabel}`);
  }

  /** Factored kv-message handler so both KiwiClient and OpenWebRxClient
   *  can share the same closure. Keys an OpenWebRX never emits (rx_chans,
   *  user_cb, stats_cb, etc.) just fall through their ifs harmlessly. */
  private makeKvHandler(): (kv: Record<string, string>) => void {
    return (kv) => {
      if (kv._debug) { this.log(kv._debug); return; }
      this.lastFrameTs = Date.now();
      for (const k in kv) this.lastKv[k] = kv[k];
      this.refreshKiwiDiag();
      if (kv.audio_rate) this.player.setInputRate(+kv.audio_rate);
      if (kv.sample_rate) this.player.setInputRate(+kv.sample_rate);
      if (kv.bandwidth) {
        const bw = +kv.bandwidth;
        if (bw > 0 && bw !== this.bandwidthHz) {
          this.bandwidthHz = bw;
          this.recenter();
        }
      }
      if (kv.rx_chans != null) {
        const n = +kv.rx_chans;
        if (n > 0) { this.rxChans = n; this.refresh(); }
      }
      if (kv.user_cb && kv.user_cb.startsWith('[')) {
        try {
          const arr = JSON.parse(kv.user_cb);
          if (Array.isArray(arr)) {
            this.usersOnline = arr.filter((u: { i?: number }) => u && u.i != null).length;
            this.refresh();
          }
        } catch { /* malformed JSON */ }
      }
      if (kv.stats_cb && kv.stats_cb.startsWith('{')) {
        try {
          const s = JSON.parse(kv.stats_cb) as {
            ci?: number[]; ga?: number;
          };
          if (Array.isArray(s.ci) && s.ci.length > 0) {
            this.cpuPct = Math.max(0, Math.min(100, 100 - s.ci[0]));
          }
          if (s.ga != null) this.gpsLocked = s.ga > 0;
          this.refresh();
        } catch { /* malformed JSON */ }
      }
      if (kv.cpu_pct != null) { this.cpuPct = +kv.cpu_pct; this.refresh(); }
      if (kv.temp_c != null) { this.tempC = +kv.temp_c; this.refresh(); }
      if (kv.mem_avail != null) { this.memAvailKB = +kv.mem_avail; this.refresh(); }
      if (kv.adc_ov != null) { this.adcOv = +kv.adc_ov; this.refresh(); }
      if (kv.audio_dropped_samples != null) { this.droppedAudio = +kv.audio_dropped_samples; this.refresh(); }
      if (kv.wf_dropped_frames != null) { this.droppedWf = +kv.wf_dropped_frames; this.refresh(); }
      if (kv.wf_fps != null) { this.wfFps = +kv.wf_fps; this.refresh(); }
      if (kv.wf_fps_max != null) { this.wfFpsMax = +kv.wf_fps_max; this.refresh(); }
      if (kv.zoom_max != null) { this.zoomMax = +kv.zoom_max; this.refresh(); }
      if (kv.version_maj != null || kv.version_min != null) {
        const maj = kv.version_maj ?? this.fwVersion?.split('.')[0]?.replace(/^v/, '') ?? '?';
        const min = kv.version_min ?? this.fwVersion?.split('.')[1] ?? '?';
        this.fwVersion = `v${maj}.${min}`;
        this.refresh();
      }
      if (kv.gps_locked != null) { this.gpsLocked = kv.gps_locked === '1' || kv.gps_locked.toLowerCase() === 'true'; this.refresh(); }
      if (kv.gps_good != null) { this.gpsLocked = +kv.gps_good > 0; this.refresh(); }
      if (kv.users != null && /^\d+$/.test(kv.users)) {
        this.usersOnline = +kv.users;
        this.refresh();
      }
      // OpenWebRX-only key: server-side listener count.
      if (kv.clients != null && /^\d+$/.test(kv.clients)) {
        this.usersOnline = +kv.clients;
        this.refresh();
      }
      // OpenWebRX: full profile list (one entry per SDR + per band
       // preset on the server). Cached so the long-press picker can show
       // them without re-querying.
      if (kv.owrx_profiles_json) {
        try {
          const arr = JSON.parse(kv.owrx_profiles_json) as Array<{ id: string; name: string }>;
          if (Array.isArray(arr)) this.owrxProfiles = arr;
        } catch { /* ignore malformed */ }
      }
      if (kv.owrx_selected_profile != null) {
        this.owrxSelectedProfile = kv.owrx_selected_profile || null;
      }
      // OWRX: when the operator picks a profile via the picker, the
      // client snaps the dial to the new band's centre. Mirror that on
      // the shell so the LED dial, cursor, and decoder freq stay in sync.
      if (kv.owrx_dial_freq_khz != null && /^-?\d/.test(kv.owrx_dial_freq_khz)) {
        const f = parseFloat(kv.owrx_dial_freq_khz);
        if (Number.isFinite(f) && f > 0) {
          this.freqKHz = f;
          this.owrxViewCenterKHz = f;
          this.refresh();
          this.refreshCursor();
        }
      }
      // OpenWebRX-only key: centre of the currently rendered FFT slice.
      // Cursor + click-to-tune math reads this so the cursor tracks the
      // dial within the visible window.
      // Allow a leading '-' — VLF/LF profiles centred near 0 Hz produce
      // negative clamped view-centres when the visible window spans the
      // origin (e.g. centre=10 kHz, span=20 kHz → window lo = -10 kHz).
      if (kv.owrx_view_center_khz != null && /^-?\d/.test(kv.owrx_view_center_khz)) {
        const v = parseFloat(kv.owrx_view_center_khz);
        if (Number.isFinite(v) && v !== this.owrxViewCenterKHz) {
          // If the view-centre jumped further than the visible span
          // (i.e. the dial walked outside the window and the client
          // re-anchored), the historical rows currently on the
          // waterfall canvas are now misaligned — they show old
          // bins under a freq scale that no longer matches. Clear so
          // the new range scrolls in on a fresh canvas. Matches how
          // KiwiSDR feels when the view auto-recenters.
          const spanKHz = this.bandwidthHz / 1000;
          if (this.owrxViewCenterKHz != null && spanKHz > 0 &&
              Math.abs(v - this.owrxViewCenterKHz) > spanKHz) {
            this.spectrum.clearWaterfall();
          }
          this.owrxViewCenterKHz = v;
          this.refreshCursor();
        }
      }
      const parts = Object.entries(kv).map(([k, v]) => {
        if (!v) return k;
        const short = v.length > 80 ? v.slice(0, 77) + '…' : v;
        return `${k}=${short}`;
      });
      this.log('MSG ' + parts.join(' '));
    };
  }

  private disconnect() {
    if (this.noDataTimer != null) { clearInterval(this.noDataTimer); this.noDataTimer = null; }
    if (this.wfAutoTimer != null) { clearInterval(this.wfAutoTimer); this.wfAutoTimer = null; }
    this.lastFrameTs = 0;
    // Note: leave #noDataLabel display alone — the watchdog may have
    // just set it visible before calling us; the next connect() hides it.
    this.client?.disconnect(); this.client = null;
    // player.stop() now only tears down the Kiwi-side source — the shared
    // mixer + SPEC analyser stay alive, so any TEST sample in progress
    // keeps playing through the same audio graph.
    this.player.stop();
    this.setLedDot('off');
    this.rxChans = null;
    this.usersOnline = null;
    this.cpuPct = null;
    this.tempC = null;
    this.memAvailKB = null;
    this.gpsLocked = null;
    this.adcOv = null;
    this.droppedAudio = null;
    this.droppedWf = null;
    this.wfFps = null;
    this.wfFpsMax = null;
    this.zoomMax = null;
    this.fwVersion = null;
    this.refresh();
    this.log('disconnected');
  }

  /** Seed the U x/y label from the public-list snapshot (e.g. "2/4") so it
   *  shows immediately, before the Kiwi pushes its own stats. */
  private seedUsersFromEntry(entry?: ServerEntry) {
    if (!entry?.users) return;
    const m = entry.users.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) return;
    this.usersOnline = +m[1];
    this.rxChans = +m[2];
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    [this.lowCut, this.highCut] = DEFAULT_PASSBANDS[mode];
    this.client?.setTune({ mode, lowCutHz: this.lowCut, highCutHz: this.highCut });
    // Drop the audio queue so the new mode starts playing within a
    // frame instead of after the buffered old-mode audio drains. The
    // ring can balloon to several seconds on slow / congested networks;
    // without this flush, mode changes felt like 8 s of latency.
    this.player.flush(this.settings.flushKeepMs ?? 0);
    // IQ mode flips the player into stereo-frame parsing. Switching away
    // from IQ flips it back. The decoder consuming onIq (HFDL) is wired
    // independently via toggleHfdl().
    this.player.setIqMode(mode === 'iq');
    this.refresh();
  }

  private appendDigit(d: string) {
    if (this.pending == null) this.pending = '';
    if (this.pending.length >= 9) return;
    this.pending += d;
    this.refresh();
  }

  private command(c: string) {
    switch (c) {
      case 'set':
        if (this.pending) {
          const f = parseFloat(this.pending);
          if (Number.isFinite(f) && f > 0) {
            this.freqKHz = f;
            this.client?.setFreqKHz(f);
            this.recenter();
          }
          this.pending = null;
        }
        break;
      case 'mhz':
        // Same as 'set' but the typed digits are interpreted as MHz —
        // multiply by 1000 to get kHz. Lets the operator type "144"
        // for 144 000 kHz (2 m) or "14.180" for 14 180 kHz (20 m USB)
        // without spelling out every digit.
        if (this.pending) {
          const f = parseFloat(this.pending);
          if (Number.isFinite(f) && f > 0) {
            this.freqKHz = f * 1000;
            this.client?.setFreqKHz(this.freqKHz);
            this.recenter();
          }
          this.pending = null;
        }
        break;
      case 'del':
        if (this.pending && this.pending.length > 0) {
          this.pending = this.pending.slice(0, -1) || null;
        } else this.pending = null;
        break;
      case 'zoomIn':  this.zoom = clamp(this.zoom + 1, 0, 14); this.recenter(); break;
      case 'zoomOut': this.zoom = clamp(this.zoom - 1, 0, 14); this.recenter(); break;
      case 'panL': this.panBy(-512); break;
      case 'panR': this.panBy(+512); break;
      case 'mem':
        openPresetsModal({
          current: { freqKHz: this.freqKHz, mode: this.mode, lowCut: this.lowCut, highCut: this.highCut },
          onPick: (p) => this.applyPreset(p),
        });
        break;
      case 'scan':
        // Short tap → pause/resume the picker scanner. Long-press
        // (handled separately) starts scanning the most-recently-opened
        // freq list. Old preset-driven scan was preserved as a no-op
        // hint for users who haven't opened a freq list yet.
        if (this.pickerScanRunning) this.pauseResumePickerScan();
        else this.banner('SCAN — long-press to start (open a freq list first)', 2500);
        break;
      case 'seek': this.seek(); break;
      case 'filter': this.openFilterPicker(); break;
      case 'modePicker': this.openModePicker(); break;
      case 'dspPicker':  this.openDspPicker();  break;
      case 'infoPicker': this.openInfoPicker(); break;
      case 'dispPicker': this.openDispPicker(); break;
      case 'decAPicker': this.openDecPicker('A'); break;
      case 'decBPicker': this.openDecPicker('B'); break;
      case 'freqPicker': this.openFreqPicker(); break;
      // Proxy commands — these click the canonical button (which is now
      // hidden in the topbar fnrow). Keeps the existing open-modal /
      // toggle logic in one place.
      case 'gen': document.querySelector<HTMLElement>('#btnModes')?.click(); break;
      case 'sid': document.querySelector<HTMLElement>('#btnSigId2')?.click(); break;
      case 'back': this.closeForegroundOverlay(); break;
      // NOTE: 'mem' is handled by the openPresetsModal case earlier in
      // this switch — the proxy form duplicates that case and never runs.
      case 'dec': this.toggleKeypadDec(); break;
      case 'speedBtn': this.cycleSpeed(); break;
      case 'cent':
        this.recenter();
        this.spectrum.clearWaterfall();
        this.banner(`Centered on ${formatFreqKHz(this.freqKHz)} kHz`, 1500);
        break;
      case 'antch': this.toggleAntch(); break;
      case 'nb': {
        this.nbMode = (this.nbMode + 1) % 4;
        this.client?.setNoiseBlanker(this.nbMode);
        const names = ['off', 'std', 'auto', "Wild's"];
        this.banner(`NB: ${names[this.nbMode]}`, 1500);
        break;
      }
      case 'nr': {
        // Source-aware cycle: KiwiSDR's NR has always been a boolean
        // toggle (preserve that behaviour exactly). OpenWebRX exposes a
        // 4-position enum (off/wdsp/lms/spec).
        const N = this.isOwrxSource() ? 4 : 2;
        this.nrMode = (this.nrMode + 1) % N;
        this.client?.setNoiseReduction(this.nrMode);
        const names = this.isOwrxSource()
          ? ['off', 'wdsp', 'lms', 'spec']
          : ['off', 'on'];
        const label = this.isOwrxSource()
          ? `NR: ${names[this.nrMode]}`
          : `NR ${names[this.nrMode]} (server-side; some Kiwis ignore)`;
        this.banner(label, 1500);
        this.$$('button[data-cmd="nr"]').forEach(b => b.classList.toggle('active', this.nrMode > 0));
        break;
      }
      default:
        // Frequency-nudge buttons: data-cmd = "f<sign><Hz>" (e.g. f-10000,
        // f+5000, f+1). Click events generally don't reach this fallback
        // because bindFreqRepeat's pointerdown handler stops propagation,
        // but it's the safety net for environments that don't fire
        // pointerdown (some touch corners).
        if (/^f[-+]\d+$/.test(c)) this.nudgeFreq(+c.slice(1));
        break;
    }
    this.refresh();
  }

  private applyPreset(p: Preset) {
    this.freqKHz = p.freqKHz;
    this.mode = p.mode;
    this.lowCut = p.lowCut;
    this.highCut = p.highCut;
    this.client?.setTune({ mode: p.mode, freqKHz: p.freqKHz, lowCutHz: p.lowCut, highCutHz: p.highCut });
    this.recenter();
    this.refresh();
  }

  /** Called by every freq picker when it opens. Records the displayed
   *  list as the candidate set for the next long-press of SCAN. */
  private registerScanSet(name: string, items: ScanItem[]) {
    if (!items.length) return;
    this.lastFreqSet = { name, items: items.slice() };
  }

  /** Long-press SCAN handler. Starts cycling through `lastFreqSet`,
   *  dwelling `pickerScanDwellMs` on each entry. */
  private startPickerScan() {
    if (!this.lastFreqSet || !this.lastFreqSet.items.length) {
      this.banner('SCAN — no list. Long-press a band button (FAX, WSPR, OTHR…) first', 3500);
      return;
    }
    if (this.pickerScanRunning) { this.stopPickerScan(); return; }
    this.pickerScanRunning = true;
    this.pickerScanPaused = false;
    this.pickerScanIdx = 0;
    this.banner(`SCAN: ${this.lastFreqSet.name} · ${this.lastFreqSet.items.length} freqs · ${(this.pickerScanDwellMs/1000).toFixed(0)} s each`, 2500);
    this.tickPickerScan();
    this.refreshScanButtons();
  }

  private stopPickerScan() {
    this.pickerScanRunning = false;
    this.pickerScanPaused = false;
    if (this.pickerScanTimer != null) { clearTimeout(this.pickerScanTimer); this.pickerScanTimer = null; }
    this.setScanLabel(null);
    this.banner('SCAN stopped', 1200);
    this.refreshScanButtons();
    this.refreshCursor();
  }

  private pauseResumePickerScan() {
    if (!this.pickerScanRunning) return;
    this.pickerScanPaused = !this.pickerScanPaused;
    this.banner(this.pickerScanPaused ? 'SCAN paused' : 'SCAN resumed', 1000);
    this.refreshScanButtons();
    if (!this.pickerScanPaused) {
      // Re-arm dwell timer so resume immediately continues from current freq.
      if (this.pickerScanTimer != null) clearTimeout(this.pickerScanTimer);
      this.pickerScanTimer = setTimeout(() => {
        this.pickerScanIdx++;
        this.tickPickerScan();
      }, this.pickerScanDwellMs) as unknown as number;
    } else if (this.pickerScanTimer != null) {
      clearTimeout(this.pickerScanTimer); this.pickerScanTimer = null;
    }
  }

  private tickPickerScan() {
    if (!this.pickerScanRunning || !this.lastFreqSet) return;
    const items = this.lastFreqSet.items;
    const item = items[this.pickerScanIdx % items.length];
    const mode = item.mode ?? this.mode;
    const pb = (item.lowCutHz != null && item.highCutHz != null)
      ? { lowCut: item.lowCutHz, highCut: item.highCutHz }
      : defaultPassbandFor(mode);
    this.freqKHz = item.freqKHz;
    this.mode = mode;
    this.lowCut = pb.lowCut; this.highCut = pb.highCut;
    this.client?.setTune({ mode, freqKHz: item.freqKHz, lowCutHz: pb.lowCut, highCutHz: pb.highCut });
    this.recenter();
    this.refresh();
    this.setScanLabel(`${this.lastFreqSet.name} · ${item.label} · ${item.freqKHz.toFixed(3)} kHz`);
    if (this.pickerScanPaused) return;
    this.pickerScanTimer = setTimeout(() => {
      this.pickerScanIdx++;
      this.tickPickerScan();
    }, this.pickerScanDwellMs) as unknown as number;
  }

  private setScanLabel(text: string | null) {
    const el = this.root.querySelector('#scanLabel') as HTMLElement | null;
    if (!el) return;
    if (text == null) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = '';
    const tag = this.pickerScanPaused ? '⏸ ' : '';
    el.textContent = tag + text;
  }

  private refreshScanButtons() {
    this.$$('button[data-cmd="scan"]').forEach(b => {
      b.classList.toggle('active', this.pickerScanRunning && !this.pickerScanPaused);
      b.classList.toggle('paused', this.pickerScanRunning && this.pickerScanPaused);
    });
  }


  /** Step the tuned frequency by `offsetHz` (signed) and snap the result to
   *  the nearest multiple of |offsetHz|. So +10Hz from 7234.567 kHz lands on
   *  7234.580 kHz, while -1kHz from 7234.567 kHz lands on 7234.000 kHz. */
  private nudgeFreq(offsetHz: number): void {
    const stepKHz = Math.abs(offsetHz) / 1000;
    if (stepKHz <= 0) return;
    const target = this.freqKHz + offsetHz / 1000;
    const snapped = Math.round(target / stepKHz) * stepKHz;
    const f = +snapped.toFixed(3);
    this.freqKHz = f;
    this.client?.setFreqKHz(f);
    // Remember the signed step so SRCH can replay the same direction + magnitude.
    this.lastNudgeStepHz = offsetHz;
    localStorage.setItem('radiom.lastNudgeStepHz', String(this.lastNudgeStepHz));
    // No auto-recenter on nudge — when the cursor walks off-screen the
    // refreshCursor pass below pops up the appropriate edge chevron
    // (tap to recenter on demand).
    this.refreshCursor();
    this.refresh();
  }

  /** Toggle the SRCH auto-tune. Each tick (srchIntervalMs) nudges by the
   *  last selected (signed) frequency step. Deactivating stops in place —
   *  the current frequency is not modified on the stop transition. */
  private toggleSrch(): void {
    if (this.srchTimer != null) {
      clearInterval(this.srchTimer);
      this.srchTimer = null;
    } else {
      this.srchTimer = window.setInterval(
        () => this.nudgeFreq(this.lastNudgeStepHz),
        this.srchIntervalMs,
      );
    }
    this.refreshSrchButton();
  }

  private refreshSrchButton(): void {
    const btn = this.root.querySelector('#btnSrch') as HTMLElement | null;
    if (btn) btn.classList.toggle('active', this.srchTimer != null);
  }

  /** Long-press picker: choose SRCH speed between 1 and 10 steps/s. Picks
   *  apply immediately — if SRCH is already running, the timer is
   *  restarted at the new interval. */
  private openSrchPicker(): void {
    const root = document.createElement('div');
    root.className = 'band-modal srch-picker';
    const stepsPerSec = [20, 10, 5, 2.5, 1];
    const current = Math.round(10000 / this.srchIntervalMs) / 10;
    root.innerHTML = `
      <div class="band-grid">
        ${stepsPerSec.map(n => `
          <button class="band-btn" data-sps="${n}"${Math.abs(n - current) < 0.01 ? ' style="outline:2px solid #ff0"' : ''}>${n}/s</button>
        `).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
      if (t) {
        const sps = +t.dataset.sps!;
        this.srchIntervalMs = Math.round(1000 / sps);
        localStorage.setItem('radiom.srchIntervalMs', String(this.srchIntervalMs));
        if (this.srchTimer != null) {
          clearInterval(this.srchTimer);
          this.srchTimer = window.setInterval(
            () => this.nudgeFreq(this.lastNudgeStepHz),
            this.srchIntervalMs,
          );
        }
        this.banner(`SRCH ${sps} step${sps !== 1 ? 's' : ''}/s`, 1200);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openSettings() {
    openSettingsModal({
      current: this.settings,
      getStats: () => ({ ...this.lastKv }),
      onChange: (s) => {
        this.settings = s;
        this.applySettings();
      },
      // Always provide the handler; tryInstall() handles all platform cases.
      onInstallTry: () => this.tryInstall(),
      fetchKiwiUsers: (cb) => {
        if (!this.client) { cb(null); return; }
        this.client.getUsers((users) => cb(users));
      },
    });
  }

  /** Push relevant settings into the runtime systems. */
  private applySettings(): void {
    const s = this.settings;
    this.spectrum.setFftAveraging(s.fftAveraging);
    this.spectrum.setWfInterpolation(s.wfInterpolate);
    void s.callSign;
    this.refreshKiwiDiag();
    this.applyWhisper();
    // Large-tuning-steps row visibility (Settings → Display).
    const largeRow = document.getElementById('freqRowLarge');
    if (largeRow) largeRow.style.display = s.showLargeTuningRow ? '' : 'none';
    // Waterfall FPS — moved from the (now-hidden) FPS button to Settings.
    if (Number.isFinite(s.wfSpeed) && s.wfSpeed !== this.wfSpeed) {
      this.wfSpeed = s.wfSpeed;
      this.client?.setWfSpeed(this.wfSpeed);
    }
    // Decoder parameters — propagate to live decoders + restart where the
    // change can't be hot-applied (PSK passband follows pitch, retune via
    // toggle).
    // CW: any param change → restart the active decoder so it picks up the
    // new progdefaults at construction.
    if (this.cwOn) { this.toggleCw(); this.toggleCw(); }

    if (this.pskPitch !== s.pskPitch) this.pskPitch = s.pskPitch;
    if (this.psk31bOn) {
      const m = this.psk31bMode;
      this.togglePsk31b();
      this.togglePsk31b(m);
    }

    if (this.oliviaCarrierHz !== s.oliviaCarrierHz) {
      this.oliviaCarrierHz = s.oliviaCarrierHz;
    }
    if (this.oliviaOn) {
      // smargin/sinteg are CLI-time only — restart the decoder to apply.
      this.toggleOlivia();
      this.toggleOlivia();
    }
    if (this.rttyOn)  { this.toggleRtty();  this.toggleRtty();  }
    if (this.navtexOn){ this.toggleNavtex();this.toggleNavtex();}
    if (this.sitorOn) { this.toggleSitor(); this.toggleSitor(); }
    if (this.mfskOn)  {
      const m = this.mfskMode;
      this.toggleMfsk();
      this.toggleMfsk(m);
    }
    if (this.mt63On)  {
      const m = this.mt63Mode;
      this.toggleMt63();
      this.toggleMt63(m);
    }
    if (this.fsqOn) { this.toggleFsq(); this.toggleFsq(); }
    if (this.thorOn) {
      const m = this.thorMode;
      this.toggleThor();
      this.toggleThor(m);
    }
    if (this.dominoexOn) {
      const m = this.dominoexMode;
      this.toggleDominoex();
      this.toggleDominoex(m);
    }
    if (this.contestiaOn) {
      this.toggleContestia();
      this.toggleContestia();
    }
  }

  private applyWhisper(): void {
    const s = this.settings;
    const panel = this.$('transcript') as HTMLElement;
    if (s.whisperEnabled && s.whisperApiKey) {
      panel.style.display = '';
      if (!this.transcriber) {
        this.transcriber = new WhisperTranscriber({
          apiKey: s.whisperApiKey,
          sourceLang: s.whisperSourceLang,
          targetLang: s.whisperTargetLang,
          chunkSeconds: s.whisperChunkSeconds,
          onText: (line) => {
            const lines = this.$('transcriptLines');
            const div = document.createElement('div');
            div.className = 'transcript-line';
            div.textContent = line;
            lines.appendChild(div);
            while (lines.children.length > 30) lines.removeChild(lines.firstChild!);
            lines.scrollTop = lines.scrollHeight;
          },
          onError: (e) => {
            console.error('[whisper]', e);
            const lines = this.$('transcriptLines');
            const div = document.createElement('div');
            div.className = 'transcript-line transcript-error';
            const stamp = new Date().toLocaleTimeString();
            div.textContent = `[${stamp}] ${e.message}`;
            lines.appendChild(div);
            while (lines.children.length > 30) lines.removeChild(lines.firstChild!);
            lines.scrollTop = lines.scrollHeight;
          },
          onStatus: (st) => {
            (this.$('transcriptStatus') as HTMLElement).textContent =
              st === 'sending' ? 'transcribing…'
            : st === 'recording' ? 'listening…'
            : st === 'error' ? 'error — see line below'
            : 'idle';
          },
        });
        this.player.onRawSamples = (samples) => this.transcriber?.feed(samples);
      } else {
        this.transcriber.setOptions({
          apiKey: s.whisperApiKey,
          sourceLang: s.whisperSourceLang,
          targetLang: s.whisperTargetLang,
          chunkSeconds: s.whisperChunkSeconds,
        });
      }
    } else {
      panel.style.display = 'none';
      this.player.onRawSamples = null;
      this.transcriber?.flush();
      this.transcriber = null;
    }
  }

  private async tryInstall() {
    if (!this.installEvent) {
      // Either already installed, or the browser doesn't support install prompts (iOS Safari).
      const isStandalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        // @ts-expect-error iOS-only
        window.navigator.standalone === true;
      if (isStandalone) {
        this.banner('Already installed', 1500);
      } else {
        this.banner('Use your browser\'s "Add to Home Screen"', 3000);
      }
      return;
    }
    try {
      await this.installEvent.prompt();
      const { outcome } = await this.installEvent.userChoice;
      this.banner(outcome === 'accepted' ? 'Installing…' : 'Install cancelled', 1500);
    } catch {}
    this.installEvent = null;
  }

  private seek() {
    const presets = loadPresets();
    const closestPreset = presets
      .map(p => ({ p, d: Math.abs(p.freqKHz - this.freqKHz) }))
      .filter(x => x.d <= 10)
      .sort((a, b) => a.d - b.d)[0]?.p;
    const station = findStationNear(this.freqKHz);
    // Prefer preset (user-saved) over built-in station list.
    if (closestPreset) {
      this.applyPreset(closestPreset);
      this.banner(`SEEK: ${closestPreset.name || formatFreqKHz(closestPreset.freqKHz)} (preset)`, 3000);
    } else if (station) {
      this.applyPreset({
        freqKHz: station.kHz, mode: station.mode,
        ...defaultPassbandFor(station.mode),
        name: station.name,
      });
      this.banner(`SEEK: ${station.name} @ ${station.kHz} kHz ${station.mode.toUpperCase()}`, 4000);
    } else {
      this.banner(`SEEK: no station within range of ${this.freqKHz} kHz`, 3000);
    }
  }

  /** beforeinstallprompt event, captured so a button can later trigger it. */
  private installEvent: any = null;
  private bannerTimer: number | null = null;
  private settings: Settings = loadSettings();
  private transcriber: WhisperTranscriber | null = null;
  private transcribeTimer: number | null = null;
  private recorder = new Recorder();
  private recTickTimer: number | null = null;
  private audioFftOn = false;
  private audioFftExt = false;
  private audioFftRaf: number | null = null;
  private audioFftCursorHz: number | null = null;
  private audioFftLut = buildLUT(PALETTES['green']);
  /** Contrast (gamma applied to byte before LUT lookup). 1 = neutral; >1
   *  suppresses weak signals; <1 boosts them. Adjustable via on-canvas
   *  +/- buttons. */
  private audioFftGamma = 2.0;
  /** Backing pixel buffer for the spectrogram, sized to canvas pixels. We
   *  scroll this left in JS each frame and putImageData the whole thing —
   *  cheaper and more reliable than drawImage(canvas, …) on mobile Safari. */
  private audioFftBuf: Uint32Array | null = null;
  private audioFftBufW = 0;
  private audioFftBufH = 0;
  private audioFftImgData: ImageData | null = null;
  private audioFftLastMaxHz = 0;
  /** Rolling 256-bin histogram of recent AUDIO-spectrogram byte
   *  magnitudes. A 1 Hz timer reads the histogram, picks 5th and 99th
   *  percentiles, and updates `audioFftBase` / `audioFftTop`. The draw
   *  loop stretches each bin from [base..top] to [0..255] before
   *  gamma + LUT, so the visible contrast matches actual activity
   *  rather than the analyser's raw -100..-20 dB mapping. */
  private audioFftHist = new Uint32Array(256);
  private audioFftHistFrames = 0;
  private audioFftBase = 0;
  private audioFftTop  = 255;
  /** AUTO-button driven temporary auto-stretch timer + countdown.
   *  Each tap restarts a 5-second 1 Hz tick that EMA-smooths
   *  base/top toward the 5th/99th percentiles. After 5 ticks the
   *  timer self-clears, leaving the last value in place. */
  private audioFftAutoTimer: number | null = null;
  private audioFftAutoOn = true;

  private lastCloseInfo: { code: number; reason: string; lifeMs: number; ts: number } | null = null;

  /** Parse the close-error string from KiwiClient.openSocket's onclose
   *  hook ("SND closed after 30123ms code=1006 reason="…" clean=false").
   *  Used to drive the diagnostic chip. */
  private captureCloseDiag(msg: string): void {
    const m = /closed after (\d+)ms code=(\d+) reason="([^"]*)"/.exec(msg);
    if (!m) return;
    this.lastCloseInfo = { lifeMs: +m[1], code: +m[2], reason: m[3], ts: Date.now() };
  }

  /** Decode the last MSG kv + WebSocket close into a one-line operator
   *  message. Hides the chip when nothing is wrong. */
  private refreshKiwiDiag(): void {
    const el = document.getElementById('kiwiDiag');
    if (!el) return;
    if (!this.settings.showKiwiDiag) {
      el.textContent = '';
      el.className = 'led-diag';
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const kv = this.lastKv;
    const parts: string[] = [];
    let level: 'err' | 'warn' | 'info' = 'info';
    const setLvl = (l: 'err' | 'warn' | 'info') => {
      if (l === 'err' || (l === 'warn' && level === 'info')) level = l;
    };
    if (kv.kiwi_limits_enabled === '1') {
      parts.push('owner enabled time limits — expect short sessions');
      setLvl('warn');
    }
    if (kv.too_busy === '1') { parts.push('server full (too_busy=1)'); setLvl('err'); }
    if (kv.down === '1')     { parts.push('server marked down'); setLvl('err'); }
    if (kv.access_passwd === '1' || kv.access_password === '1') {
      parts.push('password required'); setLvl('warn');
    }
    if (kv.private_ip === '1' || kv.private === '1') { parts.push('private receiver'); setLvl('err'); }
    if (kv.redirect)         { parts.push(`redirect → ${kv.redirect}`); setLvl('warn'); }
    if (kv.badp === '1')     { parts.push('IP locked (badp): too many bad passwords'); setLvl('err'); }
    const tl = +kv.time_limit;
    if (Number.isFinite(tl) && tl > 0) {
      parts.push(`time limit: ${tl}s`);
      setLvl(tl <= 60 ? 'warn' : 'info');
    }
    const ito = +kv.inactivity_timeout;
    if (Number.isFinite(ito) && ito > 0) {
      parts.push(`inactivity timeout: ${ito}s`);
      setLvl('warn');
    }
    const ci = this.lastCloseInfo;
    if (ci && Date.now() - ci.ts < 60_000) {
      const life = ci.lifeMs < 1000 ? `${ci.lifeMs}ms` : `${(ci.lifeMs / 1000).toFixed(1)}s`;
      // WS close-code legend:
      //   1000  clean application close
      //   1005  "no status received" — TCP-level RST / no close frame
      //   1006  abnormal close — TCP dropped without close handshake
      // Kiwi never sends an application-level close, so 1005 / 1006 is
      // the norm; what matters is the lifetime + the last MSG keys.
      let why = '';
      let lvl: 'err' | 'warn' | 'info' = 'err';
      if (ci.lifeMs < 1500) {
        if (ci.code === 1005) {
          why = 'instant TCP-RST (code 1005) — no MSG received; likely password-required, slot-full or per-IP limit';
        } else if (ci.code === 1006) {
          why = 'instant abnormal close (code 1006) — likely too_busy or badp lockout';
        } else if (ci.code === 1000) {
          why = 'instant clean close — server refused';
        } else {
          why = `instant close code=${ci.code}`;
        }
      } else if (ci.lifeMs >= 8_000 && ci.lifeMs <= 13_000) {
        // Common Kiwi `WS_TIMEOUT` / audio-loop watchdog: ~10 s.
        why = `closed at ${life} (code ${ci.code}) — likely Kiwi 10-s audio-watchdog (slot was accepted but never delivered audio)`;
        lvl = 'warn';
      } else if (ci.lifeMs >= 25_000 && ci.lifeMs <= 35_000) {
        why = `closed at ${life} (code ${ci.code}) — likely Kiwi 30-s anonymous time limit`;
        lvl = 'warn';
      } else if (ci.lifeMs >= 295_000 && ci.lifeMs <= 305_000) {
        why = `closed at ${life} (code ${ci.code}) — likely Kiwi 5-min anonymous time limit`;
        lvl = 'warn';
      } else {
        why = `closed at ${life}, code=${ci.code}${ci.reason ? ` reason="${ci.reason}"` : ''}`;
        lvl = 'warn';
      }
      // Only push if no higher-priority MSG-based diagnostic already
      // explains the close (e.g. too_busy=1).
      if (parts.length === 0) { parts.push(why); setLvl(lvl); }
    }
    // Healthy baseline: surface what would matter if the connection
    // dies next, so the operator sees the diag chip even when nothing
    // is wrong yet.
    if (parts.length === 0) {
      const baseline: string[] = [];
      if (kv.version_maj && kv.version_min) baseline.push(`v${kv.version_maj}.${kv.version_min}`);
      if (kv.rx_chans) {
        const used = kv.users ?? '?';
        baseline.push(`${used}/${kv.rx_chans} slots`);
      }
      if (kv.audio_rate) baseline.push(`${(+kv.audio_rate / 1000).toFixed(1)} kHz audio`);
      // OpenWebRX coverage — current profile's centre ± samp_rate/2,
      // formatted server-side by OpenWebRxClient. Shown so the operator
      // knows the tunable range without trial-and-error.
      if (kv.owrx_coverage_label) baseline.push(kv.owrx_coverage_label);
      if (Object.keys(kv).length === 0) baseline.push('no Kiwi MSG yet');
      else baseline.push('OK');
      el.textContent = baseline.join(' · ');
      el.className = 'led-diag info';
      return;
    }
    el.textContent = parts.join(' · ');
    const cls: string = level;
    el.className = `led-diag ${cls === 'err' ? '' : cls}`.trim();
  }

  private startUtcClock() {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      const ss = String(d.getUTCSeconds()).padStart(2, '0');
      const el = document.getElementById('ledUtc');
      if (el) el.textContent = `${hh}:${mm}:${ss}`;
    };
    tick();
    setInterval(tick, 1000);
  }
  // FT8 / FT4 decoder state.
  private ft8On = false;
  private ft8Mode: 'FT8' | 'FT4' = 'FT8';
  /** Rolling Float32 buffer of the most recent ~16 s of audio at the
   *  player's sample rate. Sized lazily on first sample. */
  private ft8Buf: Float32Array | null = null;
  private ft8Idx = 0; // write position in ft8Buf
  private ft8Rate = 0; // samples per second (≈12k from Kiwi PCM)
  private ft8LastDecode = 0; // last UTC-second boundary we've decoded
  private ft8Decoding = false;
  private ft8Tick: number | null = null;
  // CW decoder state.
  private cwOn = false;
  private cwDecoder: CWDecoder | null = null;
  private rttyOn = false;
  private rttyDecoder: RTTYFldigiDecoder | null = null;
  private rttyPreset: RttyPreset = RTTY_PRESETS[0];
  private oliviaOn = false;
  private oliviaDecoder: OliviaFldigiDecoder | null = null;
  private oliviaPreset: OliviaPreset = OLIVIA_PRESETS[10]; // default 16/500
  private oliviaCarrierHz = loadSettings().oliviaCarrierHz;
  private mfskOn = false;
  private mfskDecoder: MfskFldigiDecoder | null = null;
  private mfskMode: MfskMode = loadSettings().mfskMode;
  private mt63On = false;
  private mt63Decoder: Mt63FldigiDecoder | null = null;
  private mt63Mode: Mt63Mode = loadSettings().mt63Mode;
  private fsqOn = false;
  private fsqDecoder: FsqFldigiDecoder | null = null;
  private thorOn = false;
  private thorDecoder: ThorFldigiDecoder | null = null;
  private thorMode: ThorMode = loadSettings().thorMode;
  private dominoexOn = false;
  private dominoexDecoder: DominoexFldigiDecoder | null = null;
  private dominoexMode: DominoexMode = loadSettings().dominoexMode;
  private contestiaOn = false;
  private contestiaDecoder: ContestiaFldigiDecoder | null = null;
  private pskOn = false;
  private pskDecoder: PSKDecoder | null = null;
  private pskPitch = loadSettings().pskPitch;
  private psk31bOn = false;
  private psk31bDecoder: PSKFldigiDecoder | null = null;
  private psk31bMode: PSKFldigiMode = loadSettings().psk31bMode;
  private aleOn = false;
  private aleDecoder: ALE2GDecoder | null = null;
  private hfdlOn = false;
  private hfdlDecoder: HFDLDecoder | null = null;
  private isbOn = false;
  private isbDemod: IsbDemod | null = null;
  private ssbfOn = false;
  private ssbfSide: SsbSide = 'L';
  private ssbfDemod: SsbFilteredDemod | null = null;
  private iqViewOn = false;
  // Optional symbol-rate clock recovery for the IQ constellation. When
  // enabled, only one decision per symbol period is plotted (on top of
  // a slowly-fading canvas) — pure constellation, no inter-symbol smear.
  // Phase is locked by a Mueller-Müller-style timing error detector with
  // a small loop gain so the eye snaps shut even at low SNR.
  private iqClockOn = false;
  private iqClockBaud = 31.25;
  private iqClockSPS = 12000 / 31.25;     // samples per symbol (12 kHz complex)
  // Faithful port of GNU Radio's clock_recovery_mm_cc, instantiated when CLK
  // is engaged. Sits at the front of the IQ View pipeline: every IQ buffer
  // that arrives from the receiver is fed through this block first, and the
  // recovered symbols are what get plotted.
  private iqClockMM: ClockRecoveryMM | null = null;
  private iqClockInBuf: Float32Array | null = null;
  private iqClockOutBuf: Float32Array | null = null;
  private iqClockStatusTick = 0;
  // AUTO baud mode: when iqClockBaud === 0, accumulate IQ in a power-of-two
  // ring and re-run Oerder-Meyr estimation every refresh window. The
  // recovered symbol rate is pushed into the MM block via setOmega() so the
  // existing tracking loop handles fine-grain drift.
  private iqAutoOn = false;
  private iqAutoRing = new Float32Array(8192 * 2);  // 8192 complex samples
  private iqAutoRingW = 0;
  private iqAutoRingFill = 0;
  private iqAutoLastRs = 0;
  private iqAutoLastConf = 0;
  private iqAutoLastEstAt = 0;
  // Candidate (latest best peak, even when below the lock threshold). Lets
  // the status line confirm the estimator is alive on weak signals.
  private iqAutoLastCandRs = 0;
  private iqAutoLastCandConf = 0;
  private iqAutoLastKind: 'sq' | 'dm' = 'sq';
  // ACON — audio-derived constellation. Quadrature-mixes the current
  // demod's mono audio at `aconCenterHz`, low-passes at `aconBwHz`/2, and
  // plots the complex baseband on its own dedicated canvas. Lives entirely
  // outside the IQ-View plumbing so it works in any demod mode.
  private aconOn = false;
  private aconBridge: AudioConstellation | null = null;
  private aconCenterHz = 1500;
  private aconBwHz = 500;
  private aconLockOn = false;
  private aconLockMode: CostasMode = 'bpsk';
  private aconMaxAbs = 1;
  private iqViewExt = false;
  private iqViewMaxAbs = 1;   // running peak for auto-scale
  private sPlotOn = false;
  /** Ring of (epoch ms, dBm) covering the last SPLOT_WINDOW_MS. Pruned on
   *  insert; oldest samples drop off the left edge of the plot. */
  private sPlotHistory: { t: number; dbm: number }[] = [];
  /** Full-session capture: every sample since toggleSPlot turned the panel
   *  on. Used by the "copy" button to export the whole capture as CSV.
   *  Cleared on toggle-off so the next session doesn't start with stale
   *  data. Wall-clock epoch ms (Date.now()) for usable timestamps. */
  private sPlotAllSamples: { t: number; dbm: number }[] = [];
  private sPlotRaf: number | null = null;
  /** FMNT — formant tracker. Reads the audio analyser FFT each render
   *  tick, picks peaks of the cepstrally-smoothed spectral envelope in
   *  the F1 / F2 / F3 search bands, and pushes them to a rolling history
   *  drawn as three coloured trajectories scrolling left. */
  private fmntOn = false;
  private fmntRaf: number | null = null;
  private readonly fmntHistMs = 8000;     // rolling 8-second window
  private fmntHistory: { t: number; f1: number; f2: number; f3: number; voiced: boolean }[] = [];

  private sDialOn = false;
  /** Damped needle position (in dBm) used by the analog meter. Driven
   *  toward smeterDbm each animation frame with a fast-attack /
   *  slow-decay envelope, like a real D'Arsonval movement. */
  private sDialDbm = -120;
  private sDialRaf: number | null = null;
  private driftOn = false;
  /** Ring of (epoch ms, audio peak Hz). audio peak Hz IS the signal's
   *  offset from the LCD frequency (the receiver demodulates audio to
   *  baseband relative to the dial), so the plot directly shows where
   *  the carrier sits in the passband and how it moves over time. */
  private driftHistory: { t: number; hz: number }[] = [];
  /** Full-session capture for the copy button: every sample since
   *  toggleDrift turned the panel on, with wall-clock timestamps for
   *  usable CSV export. */
  private driftAllSamples: { t: number; hz: number; freqKHz: number; mode: Mode }[] = [];
  private driftRaf: number | null = null;
  private driftLastSampleAt = 0;
  /** Persistent state for the TEST picker — the active sample keeps playing
   *  and (optionally) feeding decoders even after the modal is closed.
   *  Re-opening the picker re-highlights `testActiveUrl`; tapping it again
   *  stops; tapping a different tile switches. */
  private testAudio: HTMLAudioElement | null = null;
  private testFeed:  { stop: () => void } | null = null;
  private testActiveUrl: string | null = null;
  /** AUX mode: when true, Kiwi audio is blocked at the player and TEST
   *  samples (when one is loaded) become the sole input to the audio graph
   *  and all decoders / SPEC. Does NOT silence the speaker. */
  private aux = false;
  /** Committed audio-frequency cursor (Hz). Updated only when the user taps
   *  the "set" overlay button on the audio spectrum. Independent of any
   *  decoder — the spec window is fully decoupled from PSK. */
  private audio_freq_cursor = 1000;
  private autoOn = false;
  private autoClassifier: ModeClassifier | null = null;
  private rsidClassifier: RsidClassifier | null = null;
  private autoFinalizeTimer: number | null = null;
  private navtexOn = false;
  private navtexDecoder: NAVTEXDecoder | null = null;
  private packetOn = false;
  private packetVhfOn = false;
  private packetVhfDecoder: PacketDecoder | null = null;
  private packet9600On = false;
  private packet9600Decoder: PacketDecoder | null = null;
  private packetIl2pOn = false;
  private packetIl2pDecoder: PacketDecoder | null = null;
  private packetDecoder: PacketDecoder | null = null;
  private wsprOn = false;
  private wsprDecoder: WsprDecoder | null = null;
  private wspr15On = false;
  private wspr15Decoder: Wspr15Decoder | null = null;
  private jt9On = false;
  private jt9Decoder: Jt9Decoder | null = null;
  private jt65On = false;
  private jt65Decoder: Jt65Decoder | null = null;
  private q65On = false;
  private q65Decoder: Q65Decoder | null = null;
  private fst4wOn = false;
  private fst4wDecoder: Fst4wDecoder | null = null;
  private stanagOn = false;
  private stanagDetector: Stanag4285Detector | null = null;
  private stanag4539On = false;
  private stanag4539Detector: Stanag4539Detector | null = null;
  private hellOn = false;
  private hellDecoder: HellDecoder | null = null;
  private sstvOn = false;
  private sstvDecoder: SstvDecoder | null = null;
  /** MCW is just AM-mode + CW decoder; the button tracks "we entered
   *  via the MCW shortcut" so we can restore mode when the user taps
   *  it off. The actual decoder instance is the shared CW one. */
  private mcwOn = false;
  private freedvOn = false;
  private freedvDecoder: FreedvDecoder | null = null;
  private freedvMode: FreedvMode = '700D';
  private throbOn = false;
  private throbDecoder: ThrobFldigiDecoder | null = null;
  private throbMode: ThrobMode = 'throb1';
  private jt4On = false;
  private jt4Decoder: Jt4Decoder | null = null;
  private selcalOn = false;
  private selcalDecoder: SelcalDecoder | null = null;
  private pocsOn = false;
  private pocsDecoder: PocsagDecoder | null = null;
  /** DSD digital-voice metadata decoder. Single instance — mode flag
   *  switches between D-STAR / DMR / NXDN / YSF / dPMR / M17 / P25. */
  private dsdOn = false;
  private dsdMode: DsdMode = 'dmr';
  private dsdDecoder: DsdDecoder | null = null;
  /** Operator-adjustable gain for the decoded DSD voice (multiplier
   *  applied to the per-decoder GainNode). 1.8× default to compensate
   *  for IMBE/AMBE output sitting quieter than analog speech. */
  private dsdGain = 1.8;
  /** Generic multimon-ng modes — single decoder instance, mode flag
   *  swapped when the operator picks a different protocol. */
  private multimonOn = false;
  private multimonMode: MultimonMode = 'flex';
  private multimonDecoder: MultimonDecoder | null = null;
  /** Vendored-binary decoders — one shared state slot since they all
   *  emit into the same text panel and only one runs at a time. */
  private vendoredOn = false;
  private vendoredKind: 'msk144'|'ais'|'acars'|'tetrapol'|'op25'|'lrpt'|null = null;
  private vendoredDecoder: VendoredDecoder | null = null;
  /** Most recent received SSTV image — kept around so the SAVE
   *  button can drop it to disk. */
  private sstvLastImage: SstvImage | null = null;
  private js8On = false;
  private js8Decoder: Js8Decoder | null = null;
  private fst4On = false;
  private fst4Decoder: Fst4Decoder | null = null;
  // Audio oscilloscope state — captured float samples and trigger config.
  private scopeOn = false;
  // High-resolution audio FFT panel — 16384-point single-sided FFT of
  // the demodulated audio, 0..6 kHz (Nyquist @ 12 kHz input). Same
  // Int16 feed as the SCOP panel via player.onThd. The ~1.4-s window
  // gives ~0.73 Hz bin resolution.
  private thdOn = false;
  private thdBuf = new Float32Array(16384);
  private thdBufWrite = 0;
  private thdRaf: number | null = null;
  /** Hover cursor X (CSS px from canvas left). Null when pointer is
   *  outside the canvas — no cursor drawn, status line shows defaults. */
  private thdCursorX: number | null = null;
  private thdCursorBound = false;
  /** Running-average ring for spectrum smoothing — last N magnitude
   *  arrays summed bin-wise. Mean = sum / actualFrames. */
  private static readonly THD_AVG_LEN = 80;
  private thdMagHist: Float32Array[] = [];
  private thdMagSum: Float32Array | null = null;
  private thdMagWrite = 0;
  private thdMagFilled = 0;
  private scopeBuf = new Float32Array(4096);   // ring of recent audio
  private scopeBufWrite = 0;
  private scopeRaf: number | null = null;
  private scopeTriggerLevel = 0;               // -1..1 (normalized)
  private scopeTriggerRising = true;           // true = rising edge, false = falling
  private scopeWindowSamples = 1024;           // ~85 ms @ 12 kHz
  // QRSS slow-CW grabber state. The buffer is a *fixed* power-of-two
  // window we FFT in one shot — sized for ~0.7 Hz/bin at 12 kHz, the
  // resolution QRP beacons need. drawTimer fires once per column.
  private qrssOn = false;
  private qrssBuffer = new Float32Array(16384);
  private qrssWriteIdx = 0;
  private qrssFilled = 0;
  private qrssWindow: Float32Array | null = null;
  private qrssMode: 'q3' | 'q10' | 'q30' | 'q60' | 'q120' = 'q10';
  private qrssTimer: number | null = null;
  /** Audio passband shown in the grabber (Hz). 400–1200 covers the
   *  standard QRSS sub-band as the operator hears it through a USB
   *  passband centred ~800 Hz above the carrier. */
  private qrssAudioLo = 400;
  private qrssAudioHi = 1200;
  /** DFCW (Dual-Frequency CW) overlay. When on, the canvas zooms to a
   *  ±50 Hz window centred on the strongest signal in the current band
   *  and overlays two reference lines `dfcwSpacingHz` apart — the dit
   *  and dah carriers. The center auto-tracks the running median peak
   *  bin so the markers stay aligned even as the operator's BFO drifts. */
  private qrssDfcw = false;
  private qrssDfcwCenterHz: number | null = null;
  private qrssDfcwSpacingHz = 5;
  private qrssDfcwHalfSpanHz = 50;
  // Gray-line / propagation map.
  private grayOn = false;
  private grayTimer: number | null = null;
  // Lissajous / vector audio scope.
  private vectOn = false;
  private vectBuf = new Float32Array(4096);
  private vectBufWrite = 0;
  private vectRaf: number | null = null;
  private vectDelay = 36;   // samples — ~3 ms at 12 kHz, ≈90° phase shift for 1 kHz tone
  // Eye-diagram state.
  private iqEyeOn = false;
  private iqEyeRaf: number | null = null;
  private iqEyeBaud = 31.25;
  private iqEyeSPS = 12000 / 31.25;
  private iqEyeRing = new Float32Array(8192);     // power-of-2 ring of recent I samples
  private iqEyeRingW = 0;
  private iqEyeRingFill = 0;
  // Phase counter — when it crosses sps, a new symbol decision occurred
  // and we want to draw a `-T..+T` window around that point.
  private iqEyePhase = 0;
  private iqEyePending: number[] = [];            // ring-buffer indices of recent decision points
  private iqEyeNextDrawIdx = 0;                   // next index in iqEyePending to render
  private sitorOn = false;
  private sitorDecoder: NAVTEXDecoder | null = null;
  private wwvOn = false;
  private wwvDecoder: WwvFldigiDecoder | null = null;
  private wwvHistory: Uint8Array[] = []; // ring of recent frames for waterfall
  private wwvZoomed = false;
  private navtexStation: NavtexStation = NAVTEX_STATIONS[0];
  private wefaxOn = false;
  private wefaxDecoder: WefaxDecoder | null = null;
  private wefaxImageMeta: WefaxImageMeta | null = null;
  private wefaxStation: WefaxStation = WEFAX_STATIONS[0];
  /** Click-to-align offset (in pixels) applied to every WEFAX row before
   *  painting. Used only as a one-shot manual override; in normal operation
   *  the server's phasing-tone lock + correlation tracker emit pre-aligned
   *  rows so this stays at zero. */
  private wefaxRowOffset = 0;
  /** When true, the FAX panel expands so the canvas height is
   *  2.083333 × its rendered width (a tall marine-chart aspect at
   *  IOC 576 / 120 LPM). Toggled by the panel's "ext" button. */
  private wefaxExt = false;
  private faxScanOn = false;
  private faxScanIdx = 0;
  /** Lags `faxScanIdx` by one frame so the on-screen station label only
   *  updates after the dial change has been pushed to the receiver. */
  private faxScanDisplayIdx = 0;
  /** One score per WEFAX_STATIONS entry, 0..1. NaN = not yet measured this pass. */
  private faxScanScores: Float32Array = new Float32Array(WEFAX_STATIONS.length).fill(NaN);
  /** Best score seen this pass, for normalising bar heights. */
  private faxScanMax = 1;
  private faxScanTimer: number | null = null;
  private faxScanRaf: number | null = null;
  private faxScanPaused = false;
  /** 1 s ring buffer of raw audio at 12 kHz, used for the 300 Hz phasing test.
   *  Filled while scan is on by tapping the existing onWefax sink. */
  private faxScanAudio = new Float32Array(12000);
  private faxScanAudioPos = 0;
  private faxScanAudioFilled = 0;
  /** Score above which the scanner stops on a station — interpreted as the
   *  combined SNR (in dB) of the 1500 Hz / 2300 Hz WEFAX subcarriers. */
  private readonly FAX_SCAN_HIT_DB = 8;
  /** Time held on each station before scoring (ms). Covers Kiwi tune latency
   *  + audio buffer drain + a few analyser frames. */
  private readonly FAX_SCAN_DWELL_MS = 4000;
  private autoHistory: ClassifierResult[] = [];
  private activeBwPreset: number | null = 2.7;
  private banner(text: string, ms = 3000) {
    const el = this.$('banner');
    el.textContent = text;
    el.classList.add('show');
    if (this.bannerTimer != null) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { el.classList.remove('show'); }, ms) as unknown as number;
  }

  private refreshLangButtons() {
    this.$('btnLangFrom').textContent = langLabel(LANGS_SRC, this.settings.whisperSourceLang);
    this.$('btnLangTo').textContent = langLabel(LANGS_DST, this.settings.whisperTargetLang);
  }

  private aiPanelOn = false;

  /** Last SID DSP measurement report (the raw text shown in the SID
   *  overlay). The AI panel's "sid" button feeds this string to OpenAI
   *  for explanation + candidate-mode estimation. */
  private lastSidReport: string | null = null;
  private lastSidFreqKHz = 0;
  private lastSidMode: Mode = 'iq';
  private lastSidAt = 0;

  /** Open / close the AI report panel. Mutually exclusive with the other
   *  spectrum-wrap panels — opening AI tears down whatever decoder /
   *  visualizer was showing. */
  private memPanelOn = false;

  /** Open / close the channel memory panel. Mutually exclusive with the
   *  other spectrum-wrap panels (same shutdown pattern as the AI panel). */
  private toggleMemPanel(): void {
    const willOpen = !this.memPanelOn;
    if (willOpen) this.shutdownAllPanels();
    this.memPanelOn = willOpen;
    (this.$('memPanel') as HTMLElement).style.display = willOpen ? '' : 'none';
    (this.$('btnMem') as HTMLElement).classList.toggle('active', willOpen);
    if (willOpen) this.renderMemoryList();
  }

  /** Capture the current dial as a new memory channel, then refresh the
   *  list. Used by both the panel's "+ add" button and the long-press
   *  shortcut on the MEM button itself. */
  private memorySaveCurrent(): void {
    const name = this.guessChannelName(this.freqKHz, this.mode);
    addChannel({
      freqKHz: this.freqKHz,
      mode: this.mode,
      lowCut: this.lowCut,
      highCut: this.highCut,
      name,
    });
    this.banner(`Logged ${this.freqKHz.toFixed(2)} kHz ${this.mode.toUpperCase()}`, 1500);
    if (this.memPanelOn) this.renderMemoryList();
  }

  /** Free-text filter applied to the log list. Cleared when the panel
   *  is closed; persists for the open session otherwise. */
  private memSearchQuery = '';

  /** Try to derive a sensible default channel name from the current
   *  cursor: nearest known station / preset name if any, else empty. */
  private guessChannelName(_freqKHz: number, _mode: Mode): string {
    // Stub for now — populated more aggressively once the channel-name
    // sources (EIBI, stations table, etc.) are unified. The user can
    // always rename inline from the panel.
    return '';
  }

  private renderMemoryList(): void {
    const listEl = this.$('memList') as HTMLElement;
    const statusEl = this.$('memStatus') as HTMLElement;
    // Sort: frequency ascending, then time descending (newest first
    // within the same frequency) — the standard logbook ordering.
    const all = loadMemory().slice().sort((a, b) => {
      if (a.freqKHz !== b.freqKHz) return a.freqKHz - b.freqKHz;
      return b.added - a.added;
    });
    const q = this.memSearchQuery.trim().toLowerCase();
    const matches = q
      ? all.filter(c => {
          if (c.freqKHz.toFixed(3).includes(q)) return true;
          if ((c.name || '').toLowerCase().includes(q)) return true;
          if ((c.notes || '').toLowerCase().includes(q)) return true;
          return false;
        })
      : all;
    const total = all.length;
    statusEl.textContent = q
      ? `${matches.length} of ${total} entr${total === 1 ? 'y' : 'ies'} match "${q}"`
      : `${total} entr${total === 1 ? 'y' : 'ies'}`;
    if (matches.length === 0) {
      listEl.innerHTML = q
        ? '<div class="mem-empty">No matches. Clear the search or try another term.</div>'
        : '<div class="mem-empty">Log is empty. Tap "+ add" or long-press MEM to log the current dial.</div>';
      return;
    }
    listEl.innerHTML = matches.map(c => {
      const f = c.freqKHz.toFixed(2);
      const m = c.mode.toUpperCase();
      const bw = `${c.lowCut}/${c.highCut} Hz`;
      const name = escapeAttr(c.name || '');
      const notes = escapeAttr(c.notes || '');
      const stamp = new Date(c.added).toISOString().replace('T', ' ').replace(/\..*$/, ' UTC');
      return `<div class="mem-row" data-id="${c.id}">
        <div class="mem-row-body">
          <div class="mem-row-title">${f} kHz <span class="mem-row-mode">${m}</span></div>
          <input class="mem-row-name"  type="text" placeholder="(name)"  value="${name}"  spellcheck="false" />
          <input class="mem-row-notes" type="text" placeholder="(notes)" value="${notes}" spellcheck="false" />
          <div class="mem-row-sub">${bw} · ${stamp}</div>
        </div>
        <div class="mem-row-actions">
          <button class="transcript-btn mem-row-tune" type="button" title="Tune to this entry">tune</button>
          <button class="transcript-btn mem-row-del"  type="button" title="Delete">del</button>
        </div>
      </div>`;
    }).join('');
    for (const row of Array.from(listEl.querySelectorAll('.mem-row')) as HTMLElement[]) {
      const id = row.dataset.id!;
      const nameEl  = row.querySelector('.mem-row-name')  as HTMLInputElement;
      const notesEl = row.querySelector('.mem-row-notes') as HTMLInputElement;
      nameEl.addEventListener('change',  () => updateChannel(id, { name: nameEl.value.trim() }));
      notesEl.addEventListener('change', () => updateChannel(id, { notes: notesEl.value.trim() || undefined }));
      (row.querySelector('.mem-row-tune') as HTMLElement).addEventListener('click', () => {
        const ch = loadMemory().find(c => c.id === id);
        if (!ch) return;
        this.applyPreset({ freqKHz: ch.freqKHz, mode: ch.mode, lowCut: ch.lowCut, highCut: ch.highCut, name: ch.name });
        this.banner(`Recalled ${ch.freqKHz.toFixed(2)} kHz ${ch.mode.toUpperCase()}${ch.name ? ' · ' + ch.name : ''}`, 1500);
      });
      (row.querySelector('.mem-row-del') as HTMLElement).addEventListener('click', () => {
        deleteChannel(id);
        this.renderMemoryList();
      });
    }
  }

  private async memoryExport(): Promise<void> {
    const text = exportMemoryJson();
    try {
      await this.copyText(text);
      this.banner(`Memory exported (${(text.length / 1024).toFixed(1)} kB) to clipboard`, 2000);
    } catch {
      this.banner('Copy failed', 1500);
    }
  }

  private memoryImport(): void {
    const text = prompt('Paste memory JSON (replaces all existing channels):');
    if (text == null) return;
    try {
      const n = importMemoryJson(text);
      this.banner(`Imported ${n} channels`, 1500);
      this.renderMemoryList();
    } catch (e) {
      this.banner(`Import failed: ${(e as Error).message}`, 2500);
    }
  }

  private toggleAiPanel(): void {
    const willOpen = !this.aiPanelOn;
    // Tear down other spectrum-wrap panels BEFORE flipping our own flag
    // so shutdownAllPanels (which now also closes the AI panel) doesn't
    // immediately undo this open.
    if (willOpen) this.shutdownAllPanels();
    this.aiPanelOn = willOpen;
    (this.$('aiPanel') as HTMLElement).style.display = willOpen ? '' : 'none';
    (this.$('btnScribeAi') as HTMLElement).classList.toggle('active', willOpen);
  }

  /** Feed the current SCRIBE transcript to OpenAI's flagship reasoning
   *  model and append an OSINT-style report to the AI panel. Opens the
   *  panel automatically if it isn't already visible. */
  private async runScribeAi(): Promise<void> {
    if (!this.settings.whisperApiKey) {
      this.banner('Set OpenAI API key in Settings first', 2500);
      return;
    }
    const linesEl = this.$('transcriptLines');
    const corpus = Array.from(linesEl.children)
      .map(c => (c.textContent ?? '').trim())
      .filter(s => s && !/^\(detected language:/.test(s) && !s.startsWith('['))
      .join('\n');
    if (!corpus) {
      this.banner('SCRIBE has no text yet', 2000);
      return;
    }
    if (!this.aiPanelOn) this.toggleAiPanel();
    const btn = this.$('btnScribeAi') as HTMLButtonElement;
    btn.classList.add('active');
    btn.disabled = true;
    const aiText = this.$('aiText');
    const aiStatus = this.$('aiStatus');
    const appendSeparator = (text: string) => {
      const div = document.createElement('div');
      div.className = 'ai-separator';
      div.textContent = text;
      aiText.appendChild(div);
      aiText.scrollTop = aiText.scrollHeight;
    };
    const appendMarkdown = (md: string) => {
      const div = document.createElement('div');
      div.className = 'ai-markdown';
      div.innerHTML = renderMarkdown(md);
      aiText.appendChild(div);
      aiText.scrollTop = aiText.scrollHeight;
    };
    const stamp = new Date().toLocaleTimeString();
    appendSeparator(`── AI analysis @ ${stamp} ──`);
    aiStatus.textContent = 'AI thinking…';
    try {
      const system = [
        'Reply in well-formatted GitHub-flavored Markdown: use `##` headings',
        'for each section, bullet / numbered lists for enumerations, pipe',
        'tables for any data with two or more columns, and `**bold**` for',
        'key terms. Do NOT wrap the whole answer in a code block.',
        '',
        'You are an OSINT analyst reading a noisy HF shortwave voice transcript.',
        'The user message starts with a RECEIVER CONTEXT block giving the tuned',
        'frequency, demod mode, and UTC at capture time — use this to ground',
        'inferences about likely services on this frequency, propagation conditions,',
        'and schedule references (EIBI / amateur band plans / aviation HF-GCS / etc.).',
        'The text was produced by OpenAI Whisper from a weak / noisy radio signal',
        'and may also be machine-translated. Treat it as evidence, not ground truth:',
        '',
        '• Whisper hallucinates filler phrases ("thank you", "subscribe to my channel",',
        '  silence-filler lyrics, dubbed-movie quotes) when fed silence or static —',
        '  silently ignore these.',
        '• Real content is fragmented, mis-spelled, phonetically warped (callsigns',
        '  garbled, place names contorted). Reconstruct conservatively.',
        '• If translated, original language may have leaked phonetic artefacts.',
        '',
        'Produce a short intelligence report with these sections, omitting any',
        'section that has no evidence:',
        '',
        '1. ASSESSMENT — one or two sentences on what the transmission appears to be',
        '   (e.g. amateur QSO, maritime weather, military net, broadcast, propaganda,',
        '   numbers station, aviation HF-GCS). Confidence level.',
        '2. LOCATIONS — places, regions, coordinates, transmitter sites mentioned.',
        '3. CALLSIGNS / IDENTIFIERS — amateur, aviation (ICAO), maritime (MMSI), military',
        '   tactical callsigns, ship names, aircraft tail numbers.',
        '4. PEOPLE — names, ranks, roles.',
        '5. EVENTS — actions, incidents, schedules, intentions.',
        '6. TIMES & FREQUENCIES — UTC times, dates, working frequencies, sked',
        '   references, net schedules.',
        '7. KEYWORDS — domain-specific jargon that survived transcription (Q-codes,',
        '   prosigns, mil acronyms, weather terms, NATO phonetics fragments).',
        '8. HALLUCINATION FLAGS — lines you discarded and why (one line each).',
        '9. RECOMMENDED FOLLOW-UP — what the listener should do next (re-tune,',
        '   cross-reference EIBI / shortwave schedule, look up the callsign on QRZ,',
        '   tune adjacent frequencies, etc.).',
        '',
        'Be terse. Mark all inferences with [low/med/high] confidence. If the',
        'transcript is too thin or pure hallucination, say so plainly.',
      ].join('\n');
      // Receiver context — pin the frequency / mode / UTC at the time of
      // capture so the model can ground its inferences (band, propagation,
      // likely services on this frequency, schedule lookups). The mode and
      // freq use the live Kiwi state; UTC is wall-clock at request time.
      const freqMHz = (this.freqKHz / 1000).toFixed(3);
      const utc = new Date().toISOString().replace('T', ' ').replace(/\..*$/, ' UTC');
      const rxContext = [
        'RECEIVER CONTEXT (at time of analysis):',
        `  Frequency : ${freqMHz} MHz  (${this.freqKHz.toFixed(3)} kHz)`,
        `  Mode      : ${this.mode.toUpperCase()}`,
        `  Time      : ${utc}`,
        '',
        'TRANSCRIPT:',
        corpus,
      ].join('\n');
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.whisperApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.settings.aiModel || 'gpt-5-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: rxContext },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`AI ${res.status}: ${body.slice(0, 300)}`);
      }
      const j = await res.json() as { choices: Array<{ message: { content: string } }> };
      const report = (j.choices?.[0]?.message?.content ?? '').trim();
      if (!report) {
        appendSeparator('(no report returned)');
      } else {
        appendMarkdown(report);
      }
      appendSeparator('── end AI analysis ──');
      aiStatus.textContent = 'AI report ready';
    } catch (e) {
      appendSeparator(`AI error: ${(e as Error).message}`);
      aiStatus.textContent = 'AI error';
    } finally {
      btn.classList.remove('active');
      btn.disabled = false;
    }
  }

  /** Submit the most recent SID DSP measurement report to OpenAI's
   *  flagship reasoning model. Asks for plain-language explanations of
   *  the measurements plus a ranked list of candidate HF digital modes
   *  (with the evidence each ranking is based on). */
  private async runSidAi(): Promise<void> {
    if (!this.settings.whisperApiKey) {
      this.banner('Set OpenAI API key in Settings first', 2500);
      return;
    }
    if (!this.lastSidReport) {
      this.banner('Run SID first to capture a measurement report', 2500);
      return;
    }
    if (!this.aiPanelOn) this.toggleAiPanel();
    const btn = this.$('aiSid') as HTMLButtonElement;
    btn.classList.add('active');
    btn.disabled = true;
    const aiText = this.$('aiText');
    const aiStatus = this.$('aiStatus');
    const appendSeparator = (text: string) => {
      const div = document.createElement('div');
      div.className = 'ai-separator';
      div.textContent = text;
      aiText.appendChild(div);
      aiText.scrollTop = aiText.scrollHeight;
    };
    const appendMarkdown = (md: string) => {
      const div = document.createElement('div');
      div.className = 'ai-markdown';
      div.innerHTML = renderMarkdown(md);
      aiText.appendChild(div);
      aiText.scrollTop = aiText.scrollHeight;
    };
    const stamp = new Date().toLocaleTimeString();
    appendSeparator(`── AI SID analysis @ ${stamp} ──`);
    aiStatus.textContent = 'AI thinking…';
    try {
      const system = [
        'Reply in well-formatted GitHub-flavored Markdown: use `##` headings',
        'for the two sections below, pipe tables for the candidate-mode list,',
        'bullet lists for supporting / counter-evidence, and `**bold**` for',
        'key terms. Do NOT wrap the whole answer in a code block.',
        '',
        'You are an HF signal-identification analyst. The user message',
        'contains a SID DSP measurement report — raw measurements only,',
        'produced by analyzeLocalIQ() over ~20 s of complex baseband IQ.',
        'Sections typically include: two-sided spectrum, envelope stats,',
        'AMC features (kurtosis, peak/RMS, M2, M4), higher-order cumulants',
        '(C20/C40/C41/C42), cepstrum, autocorrelation baud estimate, and',
        'a cyclic spectrum.',
        '',
        'Produce a short report with two sections, in this order:',
        '',
        '1. MEASUREMENTS — for each measurement family present, one or two',
        '   sentences in plain language: what the number means, and what',
        '   that value (high / low / typical) tells you about the signal',
        '   (modulation envelope, keying, FSK vs PSK vs noise, etc.).',
        '   Skip measurement families that are flat / noise-like.',
        '',
        '2. CANDIDATE MODES — a ranked list (top 5 max) of likely HF',
        '   digital modes consistent with the measurements. For each, give:',
        '     • [low/med/high] confidence',
        '     • the SPECIFIC features in the report that support it',
        '       (cite the numeric value when relevant)',
        '     • any features that argue *against* it',
        '   Cover the realistic HF candidate set: FT8, FT4, JT65, JT9,',
        '   FT4W/WSPR, PSK31/63/125, RTTY, OLIVIA, MFSK, MT63, THOR,',
        '   DOMINOEX, FSQ, ALE, HFDL, STANAG 4285/4538/4539, PACTOR,',
        '   SITOR-B/NAVTEX, JS8, FST4/FST4W, plain CW, plain AM, NBFM,',
        '   SSB voice, FAX, SSTV. Skip modes with no supporting evidence.',
        '',
        'Be terse and concrete. If the report is too thin to discriminate,',
        'say so plainly and list which extra measurements would help.',
      ].join('\n');
      const freqMHz = (this.lastSidFreqKHz / 1000).toFixed(3);
      const utc = new Date(this.lastSidAt).toISOString().replace('T', ' ').replace(/\..*$/, ' UTC');
      const rxContext = [
        'RECEIVER CONTEXT (at time of SID capture):',
        `  Frequency : ${freqMHz} MHz  (${this.lastSidFreqKHz.toFixed(3)} kHz)`,
        `  Mode      : ${this.lastSidMode.toUpperCase()}`,
        `  Captured  : ${utc}`,
        '',
        'SID MEASUREMENT REPORT:',
        this.lastSidReport,
      ].join('\n');
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.settings.whisperApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.settings.aiModel || 'gpt-5-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: rxContext },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`AI ${res.status}: ${body.slice(0, 300)}`);
      }
      const j = await res.json() as { choices: Array<{ message: { content: string } }> };
      const report = (j.choices?.[0]?.message?.content ?? '').trim();
      if (!report) {
        appendSeparator('(no report returned)');
      } else {
        appendMarkdown(report);
      }
      appendSeparator('── end AI SID analysis ──');
      aiStatus.textContent = 'AI SID report ready';
    } catch (e) {
      appendSeparator(`AI error: ${(e as Error).message}`);
      aiStatus.textContent = 'AI error';
    } finally {
      btn.classList.remove('active');
      btn.disabled = false;
    }
  }

  private toggleTranscribe() {
    if (!this.settings.whisperApiKey) {
      this.banner('Set OpenAI API key in Settings first', 2500);
      return;
    }
    this.settings = { ...this.settings, whisperEnabled: !this.settings.whisperEnabled };
    saveSettings(this.settings);
    this.applyWhisper();
    (this.$('btnTranscribe') as HTMLElement).classList.toggle('active', this.settings.whisperEnabled);
    if (this.transcribeTimer != null) { clearTimeout(this.transcribeTimer); this.transcribeTimer = null; }
    if (this.settings.whisperEnabled) {
      const ms = this.settings.whisperMaxMinutes * 60_000;
      this.transcribeTimer = setTimeout(() => {
        this.transcribeTimer = null;
        if (this.settings.whisperEnabled) {
          this.toggleTranscribe();
          this.banner(`Transcribe stopped (${this.settings.whisperMaxMinutes} min limit)`, 3000);
        }
      }, ms) as unknown as number;
      this.banner(`Transcribe on (auto-stop in ${this.settings.whisperMaxMinutes} min)`, 1500);
    } else {
      this.banner('Transcribe off', 1500);
    }
  }

  private toggleRecord() {
    const btn = this.$('btnRec');
    if (this.recorder.isActive()) {
      // STOP: pull blob, save, clean up.
      this.player.onRecord = null;
      this.player.onIqRecord = null;
      const blob = this.recorder.stop();
      if (this.recTickTimer != null) { clearInterval(this.recTickTimer); this.recTickTimer = null; }
      btn.classList.remove('active');
      btn.textContent = 'REC';
      if (!blob) { this.banner('Nothing recorded', 1500); return; }
      const dur = this.recorder.durationSec();
      const server = (this.$('server') as HTMLInputElement).value.trim();
      saveRecording(blob, { durationSec: dur, freqKHz: this.freqKHz, mode: this.mode, server }).then(() => {
        this.banner(`Saved (${formatDuration(dur)}, ${(blob.size / 1024 | 0)} KB)`, 1800);
      }).catch((e) => this.banner('Save failed: ' + (e as Error).message, 2500));
      return;
    }
    // START
    if (this.player.iqMode) {
      // IQ mode: capture the raw Kiwi stereo stream as a stereo WAV
      // (L = I, R = Q). Convert the big-endian int16 payload to native
      // int16 on the fly so encodeWav can write little-endian samples
      // directly.
      this.recorder.start(2);
      this.player.onIqRecord = (b) => {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const out = new Int16Array(b.byteLength >> 1);
        for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, false);
        this.recorder.feed(out);
      };
      this.banner('Recording IQ (stereo)…', 1200);
    } else {
      this.recorder.start(1);
      this.player.onRecord = (s) => this.recorder.feed(s);
      this.banner('Recording…', 1200);
    }
    btn.classList.add('active');
    btn.textContent = '● 0:00';
    this.recTickTimer = setInterval(() => {
      btn.textContent = `● ${formatDuration(this.recorder.durationSec())}`;
    }, 500) as unknown as number;
  }

  private toggleAudioFft() {
    this.audioFftOn = !this.audioFftOn;
    if (this.audioFftOn) this.exclusiveActivate('spec');
    this.updateWaterfallStream();
    const canvas = this.$('audioFft') as HTMLCanvasElement;
    const label = this.$('audioFftLabel');
    const btn = this.$('btnAudioFft');
    canvas.style.display = this.audioFftOn ? '' : 'none';
    label.style.display = this.audioFftOn && this.audioFftCursorHz != null ? '' : 'none';
    const showSide = this.audioFftOn && this.audioFftCursorHz != null;
    this.$('audioFftLabelLo').style.display = showSide ? '' : 'none';
    this.$('audioFftLabelHi').style.display = showSide ? '' : 'none';
    this.setSpectrumPanesHidden(this.audioFftOn);
    const controls = this.$('audioFftContrast');
    if (controls) controls.style.display = this.audioFftOn ? '' : 'none';
    const pitchBar = this.$('pitchBar');
    if (pitchBar) pitchBar.style.display = this.audioFftOn ? '' : 'none';
    const extBtn = this.$('audioFftExt');
    if (extBtn) extBtn.style.display = this.audioFftOn ? '' : 'none';
    if (!this.audioFftOn && this.audioFftExt) {
      this.audioFftExt = false;
      document.body.classList.remove('audio-fft-ext');
      extBtn?.classList.remove('active');
    }
    btn.classList.toggle('active', this.audioFftOn);
    if (this.audioFftOn) {
      // Default the cursor so the lo / hi / center labels are visible right
      // away, instead of waiting for the user to click the spectrogram.
      if (this.audioFftCursorHz == null) this.audioFftCursorHz = this.audio_freq_cursor;
      label.style.display = '';
      this.$('audioFftLabelLo').style.display = '';
      this.$('audioFftLabelHi').style.display = '';
      this.$('audioFftAuto').style.display = '';
      // Force buffer re-init on next draw so we always start black.
      this.audioFftBufW = 0; this.audioFftBufH = 0;
      this.audioFftBuf = null; this.audioFftImgData = null;
      // Reset histogram so the first AUTO tap samples fresh data.
      this.audioFftHist.fill(0);
      this.audioFftHistFrames = 0;
      this.audioFftBase = 0;
      this.audioFftTop = 255;
      this.audioFftRaf = requestAnimationFrame(() => this.drawAudioFft());
      // AUTO is on by default — start the continuous periodic stretch.
      if (this.audioFftAutoOn) this.startAudioFftAuto();
    } else {
      if (this.audioFftRaf != null) cancelAnimationFrame(this.audioFftRaf);
      this.audioFftRaf = null;
      this.$('audioFftAuto').style.display = 'none';
      // Pause the periodic timer without clearing the user's AUTO toggle
      // preference, so re-opening the spectrogram resumes the same state.
      if (this.audioFftAutoTimer != null) {
        clearInterval(this.audioFftAutoTimer);
        this.audioFftAutoTimer = null;
      }
    }
  }

  /** AUTO — toggle continuous periodic histogram-based stretch.
   *  When on, runs the same EMA-smoothed update (5th / 99th percentile,
   *  α = 0.3, histogram decay 0.7/s) at 1 Hz indefinitely. Enabled by
   *  default when the spectrogram opens. */
  private toggleAudioFftAuto() {
    if (!this.audioFftOn) return;
    this.audioFftAutoOn = !this.audioFftAutoOn;
    if (this.audioFftAutoOn) this.startAudioFftAuto();
    else this.stopAudioFftAuto();
  }

  private startAudioFftAuto() {
    if (!this.audioFftOn) return;
    this.audioFftAutoOn = true;
    const btn = this.$('audioFftAuto') as HTMLElement;
    btn.classList.add('active');
    if (this.audioFftAutoTimer != null) clearInterval(this.audioFftAutoTimer);
    this.audioFftAutoTimer = setInterval(() => this.tickAudioFftAuto(), 1000) as unknown as number;
  }

  /** One AUTO tick — same 5th/99th-percentile EMA stretch the waterfall
   *  uses. Runs indefinitely while audioFftAutoOn is true. */
  private tickAudioFftAuto() {
    if (!this.audioFftOn || !this.audioFftAutoOn) {
      this.stopAudioFftAuto();
      return;
    }
    const h = this.audioFftHist;
    let total = 0;
    for (let i = 0; i < 256; i++) total += h[i];
    if (total > 0 && this.audioFftHistFrames >= 4) {
      const loPct = 0.05, hiPct = 0.99;
      const loCut = total * loPct, hiCut = total * hiPct;
      let cum = 0, pLo = 0, pHi = 255;
      let foundLo = false, foundHi = false;
      for (let i = 0; i < 256; i++) {
        cum += h[i];
        if (!foundLo && cum >= loCut) { pLo = i; foundLo = true; }
        if (!foundHi && cum >= hiCut) { pHi = i; foundHi = true; break; }
      }
      const targetLo = pLo;
      const targetHi = Math.max(pHi, targetLo + 30);
      const alpha = 0.3;
      this.audioFftBase = Math.round(this.audioFftBase * (1 - alpha) + targetLo * alpha);
      this.audioFftTop  = Math.round(this.audioFftTop  * (1 - alpha) + targetHi * alpha);
      // Decay the histogram so old samples lose weight (≈ 3 s effective
      // window). Matches the waterfall's applyAutoStretch decay.
      for (let i = 0; i < 256; i++) h[i] = (h[i] * 0.7) | 0;
      this.audioFftHistFrames = (this.audioFftHistFrames * 0.7) | 0;
    }
  }

  private stopAudioFftAuto() {
    if (this.audioFftAutoTimer != null) {
      clearInterval(this.audioFftAutoTimer);
      this.audioFftAutoTimer = null;
    }
    this.audioFftAutoOn = false;
    const btn = this.$('audioFftAuto') as HTMLElement | null;
    btn?.classList.remove('active');
  }

  private tuneToCursorOffset(sign: -1 | 1) {
    if (this.audioFftCursorHz == null) return;
    const f = +(this.freqKHz + sign * this.audioFftCursorHz / 1000).toFixed(3);
    if (f <= 0) return;
    this.freqKHz = f;
    this.client?.setFreqKHz(f);
    this.recenter();
    this.refresh();
  }

  private toggleAudioFftExt() {
    this.audioFftExt = !this.audioFftExt;
    document.body.classList.toggle('audio-fft-ext', this.audioFftExt);
    this.$('audioFftExt').classList.toggle('active', this.audioFftExt);
    this.audioFftBufW = 0; this.audioFftBufH = 0;
    this.audioFftBuf = null; this.audioFftImgData = null;
  }

  private drawAudioFft() {
    if (!this.audioFftOn) return;
    try {
      const canvas = this.$('audioFft') as HTMLCanvasElement;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW < 2 || cssH < 2) {
        this.audioFftRaf = requestAnimationFrame(() => this.drawAudioFft());
        return;
      }
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const W = Math.max(2, Math.floor(cssW * dpr));
      const H = Math.max(2, Math.floor(cssH * dpr));
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const ctx = canvas.getContext('2d');
      if (!ctx) { this.audioFftRaf = requestAnimationFrame(() => this.drawAudioFft()); return; }

      // Filter changed → wipe the buffer so the y-axis labels stay coherent
      // with what's drawn (old columns belonged to a different mapping).
      const maxHz = this.spectrogramMaxHz();
      const filterChanged = maxHz !== this.audioFftLastMaxHz;
      this.audioFftLastMaxHz = maxHz;

      // (Re)allocate the backing buffer if size or filter changed. Buffer holds
      // packed RGBA pixels (Uint32 little-endian).
      if (this.audioFftBufW !== W || this.audioFftBufH !== H || filterChanged) {
        this.audioFftBufW = W; this.audioFftBufH = H;
        this.audioFftImgData = ctx.createImageData(W, H);
        this.audioFftBuf = new Uint32Array(this.audioFftImgData.data.buffer);
        // Initial fill: opaque black.
        const black = 0xff000000 >>> 0;
        const buf = this.audioFftBuf;
        for (let i = 0; i < buf.length; i++) buf[i] = black;
      }
      const buf = this.audioFftBuf!;
      const imgData = this.audioFftImgData!;

      // Shift every row left by 1 pixel.
      for (let y = 0; y < H; y++) {
        const off = y * W;
        for (let x = 0; x < W - 1; x++) buf[off + x] = buf[off + x + 1];
      }

      // Paint the newest column on the right.
      const bins = this.player.getAudioFftBins();
      const black = 0xff000000 >>> 0;
      if (bins && bins.length > 0) {
        const sr = this.player.getAudioRate();
        const nyquist = sr / 2;
        const showBins = Math.max(2, Math.min(bins.length, Math.floor(bins.length * maxHz / nyquist)));
        const gamma = this.audioFftGamma;
        // Accumulate the visible band into the rolling histogram (used
        // by the 1 Hz auto-stretch timer below).
        const hist = this.audioFftHist;
        for (let i = 0; i < showBins; i++) hist[bins[i]]++;
        this.audioFftHistFrames++;
        // Apply min/max stretch derived from the histogram percentiles.
        const lo = this.audioFftBase;
        const hi = this.audioFftTop;
        const span = Math.max(1, hi - lo);
        for (let y = 0; y < H; y++) {
          const f = 1 - y / (H - 1);
          const i = Math.min(showBins - 1, Math.max(0, Math.floor(f * showBins)));
          // Stretch [lo..hi] → [0..255]. Values below lo clamp to black,
          // above hi clamp to brightest.
          const raw = bins[i];
          let s = (raw - lo) * 255 / span;
          if (s < 0) s = 0; else if (s > 255) s = 255;
          const b = s / 255;
          const idx = gamma === 1 ? Math.round(s) : Math.min(255, Math.max(0, Math.round(Math.pow(b, gamma) * 255)));
          buf[y * W + (W - 1)] = this.audioFftLut[idx];
        }
      } else {
        for (let y = 0; y < H; y++) buf[y * W + (W - 1)] = black;
      }

      ctx.putImageData(imgData, 0, 0);

      // Overlay text + cursor (drawn each frame on top of the bitmap).
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const maxKHzTick = Math.floor(maxHz / 1000);
      for (let kHz = 1; kHz <= maxKHzTick; kHz++) {
        const y = (1 - kHz * 1000 / maxHz) * (H - 1);
        ctx.fillRect(0, y, 6 * dpr, 1);
        ctx.fillText(`${kHz}k`, 8 * dpr, y);
      }
      if (this.audioFftCursorHz != null) {
        const cy = (1 - this.audioFftCursorHz / maxHz) * (H - 1);
        ctx.strokeStyle = '#ffeb3b';
        ctx.lineWidth = Math.max(1, dpr);
        ctx.beginPath();
        ctx.moveTo(0, cy + 0.5); ctx.lineTo(W, cy + 0.5);
        ctx.stroke();
        const lbl = this.$('audioFftLabel');
        lbl.textContent = formatAudioHz(this.audioFftCursorHz);
        const topPct = (1 - this.audioFftCursorHz / maxHz) * 100;
        lbl.style.top = `${topPct}%`;
        lbl.style.display = '';
        const cursorKHz = this.audioFftCursorHz / 1000;
        const lblLo = this.$('audioFftLabelLo');
        const lblHi = this.$('audioFftLabelHi');
        lblLo.textContent = `lo=${(this.freqKHz - cursorKHz).toFixed(3)}`;
        lblHi.textContent = `hi=${(this.freqKHz + cursorKHz).toFixed(3)}`;
        lblLo.style.top = `${topPct}%`;
        lblHi.style.top = `${topPct}%`;
        lblLo.style.display = '';
        lblHi.style.display = '';
      } else {
        this.$('audioFftLabelLo').style.display = 'none';
        this.$('audioFftLabelHi').style.display = 'none';
      }
    } catch (e) {
      console.warn('[audio-fft] draw failed:', (e as Error).message);
    }
    this.audioFftRaf = requestAnimationFrame(() => this.drawAudioFft());
  }

  /** Single mutually-exclusive toggle for FT8 / FT4. Tapping the active
   *  mode's button turns decoding off; tapping the other mode switches. */
  private toggleFtx(mode: 'FT8' | 'FT4') {
    const sameModeOn = this.ft8On && this.ft8Mode === mode;
    // Always tear down first so a mode switch resets buffers cleanly.
    if (this.ft8On) {
      this.player.onFt8 = null;
      if (this.ft8Tick != null) { clearInterval(this.ft8Tick); this.ft8Tick = null; }
      this.ft8On = false;
      this.updateWaterfallStream();
    }
    if (!sameModeOn) {
      this.ft8Mode = mode;
      this.ft8On = true;
      this.updateWaterfallStream();
      this.ft8Idx = 0;
      this.ft8LastDecode = 0;
      this.ft8Buf = null;
      this.player.onFt8 = (s) => this.feedFt8(s);
      this.$('ft8Status').textContent = `${this.ft8Mode} listening…`;
      if (this.ft8Tick == null) {
        this.ft8Tick = setInterval(() => this.maybeDecodeFt8(), 1000) as unknown as number;
      }
    }
    this.$('ft8Panel').style.display = this.ft8On ? '' : 'none';
    this.refreshFtxButtons();
  }

  /** Swap the keypad between numeric (digits + SET/DEL/BW/SCAN) and
   *  decoder (CW/RTTY/NAVTEX/SFAX/FAX/PSK31/OLIVIA/FT4/FT8). The DEC
   *  button sits in both views (last column, third row of numeric;
   *  bottom-right of decoder) so it can switch back. */
  /** Cycle the keypad through num → dec → dec3 → num. Page 1 is the
   *  numeric keypad; pages 2 and 3 are decoder grids that share the same
   *  right-column nav (PAGE / BAND / BW / DEL). */
  private toggleKeypadDec(): void {
    // 8-page cycle: numeric → 4 decoder pages (alphabetical) →
    // visualizers → IQ visualizers → freq pickers → numeric.
    //
    // Internal IDs are non-sequential because the visualizer / picker
    // pages kept their original IDs (Dec4/5/6) while the decoder
    // pages reuse Dec / Dec3 / Dec7 / Dec8. User-visible order is
    // controlled here.
    const num  = this.$('keypadNum')  as HTMLElement;
    const dec  = this.$('keypadDec')  as HTMLElement;  // decoders A-F
    const dec3 = this.$('keypadDec3') as HTMLElement;  // decoders F-N
    const dec7 = this.$('keypadDec7') as HTMLElement;  // decoders O-S
    const dec8 = this.$('keypadDec8') as HTMLElement;  // decoders T-W
    const dec4 = this.$('keypadDec4') as HTMLElement;  // visualizers
    const dec5 = this.$('keypadDec5') as HTMLElement;  // IQ visualizers
    const dec6 = this.$('keypadDec6') as HTMLElement;  // freq pickers
    const dec9 = this.$('keypadDec9') as HTMLElement;  // freq pickers (overflow 1)
    const decA = this.$('keypadDec10') as HTMLElement; // freq pickers (overflow 2)
    const decB = this.$('keypadDec11') as HTMLElement; // freq pickers (overflow 3)
    type K = 'num' | 'dec' | 'dec3' | 'dec7' | 'dec8' | 'dec4' | 'dec5' | 'dec6' | 'dec9' | 'decA' | 'decB';
    const visible: K = num.style.display !== 'none'  ? 'num'
                     : dec.style.display !== 'none'  ? 'dec'
                     : dec3.style.display !== 'none' ? 'dec3'
                     : dec7.style.display !== 'none' ? 'dec7'
                     : dec8.style.display !== 'none' ? 'dec8'
                     : dec4.style.display !== 'none' ? 'dec4'
                     : dec5.style.display !== 'none' ? 'dec5'
                     : dec6.style.display !== 'none' ? 'dec6'
                     : dec9.style.display !== 'none' ? 'dec9'
                     : decA.style.display !== 'none' ? 'decA' : 'decB';
    // Skip the 4 decoder pages (dec / dec3 / dec7 / dec8) in the
    // cycle — they're now reachable only through the DECA / DECB
    // list picker. The buttons stay in the DOM so the picker can
    // .click() them; they're just no longer browsable from the
    // keypad PAGE cycle.
    const next: K =
      visible === 'num'  ? 'dec4' :
      visible === 'dec4' ? 'dec5' :
      visible === 'dec5' ? 'dec6' :
      visible === 'dec6' ? 'dec9' :
      visible === 'dec9' ? 'decA' :
      visible === 'decA' ? 'decB' :
                           'num';
    num.style.display  = next === 'num'  ? '' : 'none';
    dec4.style.display = next === 'dec4' ? '' : 'none';
    dec5.style.display = next === 'dec5' ? '' : 'none';
    dec6.style.display = next === 'dec6' ? '' : 'none';
    dec9.style.display = next === 'dec9' ? '' : 'none';
    decA.style.display = next === 'decA' ? '' : 'none';
    decB.style.display = next === 'decB' ? '' : 'none';
    // Decoder pages stay hidden — list picker is the only access path.
    dec.style.display  = 'none';
    dec3.style.display = 'none';
    dec7.style.display = 'none';
    dec8.style.display = 'none';
  }

  /** Open the decoder-reference modal. Introspects every keypad-pad
   *  button (`.kpbtn`) whose id starts with `btn` and that carries a
   *  `title` tooltip, then lists them as a single scrollable cheat
   *  sheet. Pulling content from the live DOM keeps the help text
   *  auto-synced with the tooltips — no separate data table to
   *  maintain.
   *
   *  Tooltips don't fire on Android tap, so this modal is the
   *  mobile-discoverable counterpart of the desktop hover-tooltip. */
  private openHelpModal(): void {
    type Entry = { label: string; title: string };
    const entries: Entry[] = [];
    const seen = new Set<string>();
    // Skip the help button itself — it shouldn't appear inside its
    // own list. Also skip any disabled keypad placeholders (label is
    // empty / no title anyway).
    const SKIP_LABEL = new Set(['?']);
    // Only the button's OWN visibility — most keypad pages are
    // display:none until cycled to, so checking computed style here
    // would drop all but the active page's controls from the list.
    const isHidden = (el: HTMLElement): boolean =>
      el.classList.contains('kpbtn-empty') ||
      el.style.display === 'none' ||
      el.style.visibility === 'hidden' ||
      el.dataset.helpHide === '1';
    const add = (rawLabel: string, title: string, el: HTMLElement) => {
      const label = rawLabel.trim();
      if (!label || !title || SKIP_LABEL.has(label)) return;
      if (isHidden(el)) return;
      const key = label.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ label, title });
    };
    // All titled controls: keypad pads (decoders + visualizers + mode
    // buttons + nav commands), function-row buttons (audio toggles +
    // tune controls), knob-mini WF chips, audio-FFT pitch buttons,
    // top-bar power.
    const buttonSelectors = [
      'button.kpbtn[title]',
      'button.fnbtn[title]',
      'button.knob-mini[title]',
      'button.pitch-btn[title]',
      'header.topbar button[title]',
    ];
    for (const sel of buttonSelectors) {
      this.root.querySelectorAll<HTMLButtonElement>(sel).forEach(el => {
        const title = el.getAttribute('title') || '';
        const label = el.dataset.helpLabel
          || (el.textContent || '').trim()
          || el.getAttribute('aria-label')
          || '';
        add(label, title, el);
      });
    }
    // Knobs — the visible label is the inner `.knob-label`, not the
    // outer .knob element's text content.
    this.root.querySelectorAll<HTMLElement>('.knob[title]').forEach(el => {
      const title = el.getAttribute('title') || '';
      const label = (el.querySelector('.knob-label')?.textContent || '').trim();
      add(label, title, el);
    });
    entries.sort((a, b) => a.label.localeCompare(b.label));

    const root = document.createElement('div');
    root.className = 'band-modal help-modal';
    root.innerHTML = `
      <div class="help-content">
        <div class="help-header">
          <span class="help-title">Help · ${entries.length} controls</span>
          <button class="help-close" type="button" aria-label="close">×</button>
        </div>
        <input class="help-search" type="text" placeholder="filter…" autofocus />
        <div class="help-list">
          ${entries.map(e => `
            <div class="help-row${e.label.length > 8 ? ' help-row-wide' : ''}" data-q="${escapeAttr((e.label + ' ' + e.title).toLowerCase())}">
              <span class="help-label">${escapeAttr(e.label)}</span>
              <span class="help-desc">${escapeAttr(e.title)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const list = root.querySelector('.help-list') as HTMLElement;
    const search = root.querySelector('.help-search') as HTMLInputElement;
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      list.querySelectorAll<HTMLElement>('.help-row').forEach(row => {
        const ok = !q || (row.dataset.q || '').includes(q);
        row.style.display = ok ? '' : 'none';
      });
    });
    const close = () => root.remove();
    root.querySelector('.help-close')!.addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    // Esc closes the modal.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); window.removeEventListener('keydown', onKey); }
    };
    window.addEventListener('keydown', onKey);
  }

  /** Open the DECOD picker — sorted alphabetical list of every decoder
   *  in the app. Each row is a live button that toggles the underlying
   *  decoder by simulating a click on its on-page button (so the full
   *  exclusiveActivate / auto-tune / panel-open sequence fires exactly
   *  like a normal tap). Active decoders are highlighted with a dot
   *  indicator. Closes itself after a tap. */
  private openFilterPicker() {
    const root = document.createElement('div');
    root.className = 'band-modal ftx-picker';
    root.dataset.pickerId = 'bw';
    root.innerHTML = `
      <div class="band-grid">
        ${FILTER_WIDTHS.map((w) => {
          const label = w < 1 ? `${Math.round(w * 1000)}` : `${w}k`;
          return `<button class="band-btn" data-bw="${w}">${label}</button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
      if (t) {
        this.applyBandwidth(+t.dataset.bw!);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** 5-band peaking EQ picker. Modal with five vertical sliders ±15 dB
   *  per band, plus a "Flat" reset. Gains persist in localStorage and
   *  are restored at startup. */
  /** Close every member of the bottom-fnrow info-tool group except
   *  `except`. Used so EIBI / PSKR / NETS / WNET / GRAY / ZOOM stay
   *  mutually exclusive: opening one auto-closes the others. */
  private closeAllInfoTools(except?: string): void {
    // EIBI / PSKR / NETS / WNET all share the sig-overlay slot. If the
    // incoming tool is *not* in that group, tear the overlay down; if it
    // is in the group, its caller will overwrite the overlay so we leave
    // clearSigOverlay to that path.
    const overlayGroup = new Set(['btnEibi','btnPskr','btnNets','btnWnet']);
    if (!except || !overlayGroup.has(except)) clearSigOverlay();
    for (const id of overlayGroup) {
      if (id !== except) {
        (this.root.querySelector('#' + id) as HTMLElement | null)?.classList.remove('active');
      }
    }
    if (except !== 'btnGray' && this.grayOn) this.toggleGray();
    if (except !== 'btnZoom' && this.iq5Active === 'zoom') this.toggleIq5('zoom');
  }

  private openEqPicker() {
    const freqs = [150, 400, 1000, 2500, 5000];
    const cur = this.player.getEqGains();
    while (cur.length < freqs.length) cur.push(0);
    const labelFor = (hz: number) => hz < 1000 ? `${hz}` : `${hz/1000}k`;
    const root = document.createElement('div');
    root.className = 'band-modal eq-picker';
    root.innerHTML = `
      <div class="eq-card">
        <div class="eq-title">Audio EQ</div>
        <div class="eq-grid">
          ${freqs.map((f, i) => `
            <div class="eq-col">
              <div class="eq-val" data-val="${i}">${cur[i].toFixed(1)} dB</div>
              <input type="range" class="eq-slider" data-band="${i}"
                     min="-15" max="15" step="0.5" value="${cur[i]}"
                     orient="vertical" />
              <div class="eq-freq">${labelFor(f)} Hz</div>
            </div>
          `).join('')}
        </div>
        <div class="eq-bar">
          <button class="eq-flat" type="button">Flat</button>
          <button class="eq-close" type="button">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    const updateVal = (band: number, db: number) => {
      const v = root.querySelector(`[data-val="${band}"]`) as HTMLElement | null;
      if (v) v.textContent = `${db.toFixed(1)} dB`;
    };
    const save = () => {
      const gains = this.player.getEqGains();
      localStorage.setItem('radiom.eqGains', JSON.stringify(gains));
    };
    root.querySelectorAll<HTMLInputElement>('.eq-slider').forEach(s => {
      s.addEventListener('input', () => {
        const b = +s.dataset.band!;
        const db = +s.value;
        this.player.setEqGain(b, db);
        updateVal(b, db);
        save();
      });
    });
    (root.querySelector('.eq-flat') as HTMLButtonElement).addEventListener('click', () => {
      for (let i = 0; i < freqs.length; i++) {
        this.player.setEqGain(i, 0);
        updateVal(i, 0);
        const s = root.querySelector(`[data-band="${i}"]`) as HTMLInputElement;
        if (s) s.value = '0';
      }
      save();
    });
    const close = () => root.remove();
    (root.querySelector('.eq-close') as HTMLButtonElement).addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
  }

  /** Restore persisted EQ gains. Called once at startup after the audio
   *  graph is constructed. */
  private restoreEqGains() {
    try {
      const raw = localStorage.getItem('radiom.eqGains');
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < Math.min(5, arr.length); i++) {
        const v = +arr[i];
        if (Number.isFinite(v)) this.player.setEqGain(i, v);
      }
    } catch { /* ignored */ }
  }

  private openRttyPresetPicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${RTTY_PRESETS.map((p, i) => {
          const shift = Math.abs(p.spaceHz - p.markHz);
          return `<button class="rtty-row ${p === this.rttyPreset ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${p.name}</div>
            <div class="rtty-row-meta">${p.markHz}/${p.spaceHz} Hz · ${shift} Hz shift · ${p.baud} baud</div>
          </button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const p = RTTY_PRESETS[+t.dataset.idx!];
        this.rttyPreset = p;
        // Tap on RTTY opens this picker; picking a preset both selects
        // it and ensures RTTY is running. If already on, just hot-swap.
        if (!this.rttyOn) {
          this.toggleRtty();
        } else if (this.rttyDecoder) {
          this.rttyDecoder.setPreset({
            carrierHz: (p.markHz + p.spaceHz) / 2,
            shift:     Math.abs(p.spaceHz - p.markHz),
            baud:      p.baud,
          });
        }
        this.banner(`RTTY ${p.name}`, 1500);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** Long-press RTTY → list of HF watering holes + utility broadcasts.
   *  Tapping a row tunes the receiver to the dial frequency in USB and
   *  hot-swaps the RTTY preset (shift / baud) to match the station. */
  private openRttyFreqPicker() {
    this.registerScanSet('RTTY', RTTY_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${RTTY_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.shift}/${f.baud} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = RTTY_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        // Hot-swap preset to match the station's shift / baud.
        const carrier = (f.markHz + f.spaceHz) / 2;
        const preset = RTTY_PRESETS.find(p =>
          Math.abs(p.spaceHz - p.markHz) === f.shift && p.baud === f.baud);
        if (preset) this.rttyPreset = preset;
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (this.rttyOn) {
          this.rttyDecoder?.setPreset({ carrierHz: carrier, shift: f.shift, baud: f.baud });
        }
        this.recenter();
        this.refresh();
        this.banner(`RTTY ${f.freqKHz.toFixed(3)} (${f.shift} Hz / ${f.baud} bd)`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleOlivia() {
    this.oliviaOn = !this.oliviaOn;
    this.updateWaterfallStream();
    const btn = this.$('btnOlivia');
    const panel = this.$('oliviaPanel');
    btn.classList.toggle('active', this.oliviaOn);
    panel.style.display = this.oliviaOn ? '' : 'none';
    btn.textContent = this.oliviaOn
      ? `OLIVIA ${(this.oliviaCarrierHz / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : 'OLIVIA';
    if (this.oliviaOn) {
      // Snap the SSB passband to the Olivia band: BW comes from the
      // preset, signal is centered on `oliviaCarrierHz`.
      const bwHz = this.oliviaPreset.bandwidth;
      const carrier = this.oliviaCarrierHz;
      this.lowCut  = Math.max(50,    Math.round(carrier - bwHz / 2));
      this.highCut = Math.min(5500, Math.round(carrier + bwHz / 2));
      this.applyPassband();
      this.refresh();
      const sr = this.player.getInputRate() || 12000;
      this.oliviaDecoder = new OliviaFldigiDecoder({
        sampleRate: sr,
        tones: this.oliviaPreset.tones,
        bandwidth: this.oliviaPreset.bandwidth,
        carrierHz: this.oliviaCarrierHz,
        smargin: this.settings.oliviaSmargin,
        sinteg:  this.settings.oliviaSinteg,
        onChar: (ch) => {
          const el = this.$('oliviaText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onOlivia = (s) => this.oliviaDecoder?.feed(s);
      this.$('oliviaStatus').textContent = `OLIVIA ${this.oliviaPreset.name} listening…`;
    } else {
      this.player.onOlivia = null;
      this.oliviaDecoder?.close();
      this.oliviaDecoder = null;
    }
  }

  private toggleMfsk(mode?: MfskMode) {
    const wantOn = mode != null ? !(this.mfskOn && this.mfskMode === mode) : !this.mfskOn;
    if (mode != null) {
      this.mfskMode = mode;
      this.settings.mfskMode = mode;
      saveSettings(this.settings);
    }
    if (this.mfskOn) {
      this.player.onMfsk = null;
      this.mfskDecoder?.close();
      this.mfskDecoder = null;
      this.mfskOn = false;
    }
    this.mfskOn = wantOn;
    this.updateWaterfallStream();
    const btn = this.$('btnMfsk');
    const panel = this.$('mfskPanel');
    btn.classList.toggle('active', this.mfskOn);
    panel.style.display = this.mfskOn ? '' : 'none';
    btn.textContent = this.mfskOn
      ? `MFSK ${(this.settings.mfskPitchHz / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : 'MFSK';
    if (!this.mfskOn) return;
    // Snap the SSB passband to the MFSK band: bandwidth derived from the
    // vendored fldigi formula (numtones+1) × samplerate / symlen, centred
    // on the configured pitch. User can still nudge lof/hif manually.
    const bwHz = mfskBandwidthFor(this.mfskMode);
    const carrier = this.settings.mfskPitchHz;
    if (bwHz > 0) {
      this.lowCut  = Math.max(50,    Math.round(carrier - bwHz / 2));
      this.highCut = Math.min(5500, Math.round(carrier + bwHz / 2));
      this.applyPassband();
      this.refresh();
    }
    const sr = this.player.getInputRate() || 12000;
    const label = this.mfskMode.toUpperCase();
    this.$('mfskStatus').textContent = `${label} listening…`;
    this.mfskDecoder = new MfskFldigiDecoder({
      sampleRate: sr,
      mode: this.mfskMode,
      pitchHz: this.settings.mfskPitchHz,
      onStatus: (s) => { this.$('mfskStatus').textContent = `${label} ${this.settings.mfskPitchHz}Hz ${s}`; },
      onChar: (ch) => {
        const el = this.$('mfskText');
        el.textContent = (el.textContent || '') + ch;
        const t = el.textContent;
        if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
        el.scrollTop = el.scrollHeight;
      },
    });
    this.player.onMfsk = (s) => this.mfskDecoder?.feed(s);
  }

  private toggleDominoex(mode?: DominoexMode) {
    const wantOn = mode != null ? !(this.dominoexOn && this.dominoexMode === mode) : !this.dominoexOn;
    if (mode != null) {
      this.dominoexMode = mode;
      this.settings.dominoexMode = mode;
      saveSettings(this.settings);
    }
    if (this.dominoexOn) {
      this.player.onDominoex = null;
      this.dominoexDecoder?.close();
      this.dominoexDecoder = null;
      this.dominoexOn = false;
    }
    this.dominoexOn = wantOn;
    this.updateWaterfallStream();
    const btn = this.$('btnDominoex');
    const panel = this.$('dominoexPanel');
    btn.classList.toggle('active', this.dominoexOn);
    panel.style.display = this.dominoexOn ? '' : 'none';
    if (!this.dominoexOn) return;
    const sr = this.player.getInputRate() || 12000;
    const label = this.dominoexMode.toUpperCase();
    this.$('dominoexStatus').textContent = `${label} listening…`;
    this.dominoexDecoder = new DominoexFldigiDecoder({
      sampleRate: sr,
      mode: this.dominoexMode,
      carrierHz: this.settings.dominoexCarrierHz,
      onStatus: (s) => { this.$('dominoexStatus').textContent = `${label} ${this.settings.dominoexCarrierHz}Hz ${s}`; },
      onChar: (ch) => {
        const el = this.$('dominoexText');
        el.textContent = (el.textContent || '') + ch;
        const t = el.textContent;
        if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
        el.scrollTop = el.scrollHeight;
      },
    });
    this.player.onDominoex = (s) => this.dominoexDecoder?.feed(s);
  }

  private openDominoexModePicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker psk-mode-picker';
    const modes: { mode: DominoexMode; label: string }[] = [
      { mode: 'dominoex4',  label: 'DEX4'  },
      { mode: 'dominoex5',  label: 'DEX5'  },
      { mode: 'dominoex8',  label: 'DEX8'  },
      { mode: 'dominoex11', label: 'DEX11' },
      { mode: 'dominoex16', label: 'DEX16' },
      { mode: 'dominoex22', label: 'DEX22' },
      { mode: 'dominoex44', label: 'DEX44' },
      { mode: 'dominoex88', label: 'DEX88' },
    ];
    root.innerHTML = `
      <div class="rtty-list">
        ${modes.map(m => `
          <button class="rtty-row ${this.dominoexOn && this.dominoexMode === m.mode ? 'active' : ''}" data-mode="${m.mode}">
            <div class="rtty-row-name">${m.label}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const m = t.dataset.mode as DominoexMode;
        if (this.dominoexOn && this.dominoexMode === m) { root.remove(); return; }
        this.exclusiveActivate('dominoex');
        this.toggleDominoex(m);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openDominoexFreqPicker() {
    this.registerScanSet('DominoEX', DOMINOEX_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${DOMINOEX_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = DOMINOEX_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.dominoexOn) {
          this.exclusiveActivate('dominoex');
          this.toggleDominoex();
        }
        this.recenter();
        this.refresh();
        this.banner(`DominoEX ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleContestia(preset?: { tones: number; bandwidth: number }) {
    const cur = { tones: this.settings.contestiaTones, bandwidth: this.settings.contestiaBandwidth };
    const wantOn = preset != null
      ? !(this.contestiaOn && cur.tones === preset.tones && cur.bandwidth === preset.bandwidth)
      : !this.contestiaOn;
    if (preset != null) {
      this.settings.contestiaTones    = preset.tones    as Settings['contestiaTones'];
      this.settings.contestiaBandwidth = preset.bandwidth as Settings['contestiaBandwidth'];
      saveSettings(this.settings);
    }
    if (this.contestiaOn) {
      this.player.onContestia = null;
      this.contestiaDecoder?.close();
      this.contestiaDecoder = null;
      this.contestiaOn = false;
    }
    this.contestiaOn = wantOn;
    this.updateWaterfallStream();
    const btn = this.$('btnContestia');
    const panel = this.$('contestiaPanel');
    btn.classList.toggle('active', this.contestiaOn);
    panel.style.display = this.contestiaOn ? '' : 'none';
    if (!this.contestiaOn) return;
    const sr = this.player.getInputRate() || 12000;
    const tones = this.settings.contestiaTones;
    const bandwidth = this.settings.contestiaBandwidth;
    const carrierHz = this.settings.contestiaCarrierHz;
    const label = `CON-${tones}-${bandwidth}`;
    this.$('contestiaStatus').textContent = `${label} listening…`;
    this.contestiaDecoder = new ContestiaFldigiDecoder({
      sampleRate: sr,
      tones, bandwidth, carrierHz,
      onStatus: (s) => { this.$('contestiaStatus').textContent = `${label} ${carrierHz}Hz ${s}`; },
      onChar: (ch) => {
        const el = this.$('contestiaText');
        el.textContent = (el.textContent || '') + ch;
        const t = el.textContent;
        if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
        el.scrollTop = el.scrollHeight;
      },
    });
    this.player.onContestia = (s) => this.contestiaDecoder?.feed(s);
  }

  private openContestiaModePicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker psk-mode-picker';
    // `popular: true` marks configurations that actually carry on-air HF
    // traffic (common: 8/250, 16/500; sometimes: 4/250, 32/1k; rare:
    // 8/500). The picker renders those buttons in yellow as a visual hint.
    const presets: { tones: number; bandwidth: number; label: string; popular?: boolean }[] = [
      { tones: 4,  bandwidth: 250,  label: 'CON-4-250',  popular: true  },
      { tones: 4,  bandwidth: 500,  label: 'CON-4-500'   },
      { tones: 8,  bandwidth: 125,  label: 'CON-8-125'   },
      { tones: 8,  bandwidth: 250,  label: 'CON-8-250',  popular: true  },
      { tones: 8,  bandwidth: 500,  label: 'CON-8-500',  popular: true  },
      { tones: 16, bandwidth: 250,  label: 'CON-16-250'  },
      { tones: 16, bandwidth: 500,  label: 'CON-16-500', popular: true  },
      { tones: 16, bandwidth: 1000, label: 'CON-16-1K'   },
      { tones: 32, bandwidth: 1000, label: 'CON-32-1K',  popular: true  },
      { tones: 32, bandwidth: 2000, label: 'CON-32-2K'   },
      { tones: 64, bandwidth: 500,  label: 'CON-64-500'  },
      { tones: 64, bandwidth: 1000, label: 'CON-64-1K'   },
    ];
    const cur = { t: this.settings.contestiaTones, b: this.settings.contestiaBandwidth };
    root.innerHTML = `
      <div class="rtty-list">
        ${presets.map(p => `
          <button class="rtty-row ${this.contestiaOn && cur.t === p.tones && cur.b === p.bandwidth ? 'active' : ''}" data-tones="${p.tones}" data-bw="${p.bandwidth}">
            <div class="rtty-row-name"${p.popular ? ' style="color:#ffeb3b"' : ''}>${p.label}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const tones = +t.dataset.tones!;
        const bandwidth = +t.dataset.bw!;
        if (this.contestiaOn && cur.t === tones && cur.b === bandwidth) { root.remove(); return; }
        this.exclusiveActivate('contestia');
        this.toggleContestia({ tones, bandwidth });
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openContestiaFreqPicker() {
    this.registerScanSet('Contestia', CONTESTIA_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${CONTESTIA_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = CONTESTIA_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.contestiaOn) {
          this.exclusiveActivate('contestia');
          this.toggleContestia();
        }
        this.recenter();
        this.refresh();
        this.banner(`Contestia ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleThor(mode?: ThorMode) {
    const wantOn = mode != null ? !(this.thorOn && this.thorMode === mode) : !this.thorOn;
    if (mode != null) {
      this.thorMode = mode;
      this.settings.thorMode = mode;
      saveSettings(this.settings);
    }
    if (this.thorOn) {
      this.player.onThor = null;
      this.thorDecoder?.close();
      this.thorDecoder = null;
      this.thorOn = false;
    }
    this.thorOn = wantOn;
    this.updateWaterfallStream();
    const btn = this.$('btnThor');
    const panel = this.$('thorPanel');
    btn.classList.toggle('active', this.thorOn);
    panel.style.display = this.thorOn ? '' : 'none';
    btn.textContent = this.thorOn
      ? `THOR b${(this.settings.thorCarrierHz / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : 'THOR';
    if (!this.thorOn) return;
    // THOR's "carrier" is the LOWER edge of the band (THORBASEFREQ
    // convention in fldigi); 18 tones extend upward from there.
    const bwHz = thorBandwidthFor(this.thorMode);
    const carrier = this.settings.thorCarrierHz;
    if (bwHz > 0) {
      this.lowCut  = Math.max(50,    Math.round(carrier));
      this.highCut = Math.min(5500, Math.round(carrier + bwHz));
      this.applyPassband();
      this.refresh();
    }
    const sr = this.player.getInputRate() || 12000;
    const label = this.thorMode.toUpperCase();
    this.$('thorStatus').textContent = `${label} listening…`;
    this.thorDecoder = new ThorFldigiDecoder({
      sampleRate: sr,
      mode: this.thorMode,
      carrierHz: this.settings.thorCarrierHz,
      onStatus: (s) => { this.$('thorStatus').textContent = `${label} ${this.settings.thorCarrierHz}Hz ${s}`; },
      onChar: (ch) => {
        const el = this.$('thorText');
        el.textContent = (el.textContent || '') + ch;
        const t = el.textContent;
        if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
        el.scrollTop = el.scrollHeight;
      },
    });
    this.player.onThor = (s) => this.thorDecoder?.feed(s);
  }

  private openThorModePicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker psk-mode-picker';
    const modes: { mode: ThorMode; label: string }[] = [
      { mode: 'thor4',    label: 'THOR4'    },
      { mode: 'thor5',    label: 'THOR5'    },
      { mode: 'thor8',    label: 'THOR8'    },
      { mode: 'thor11',   label: 'THOR11'   },
      { mode: 'thor16',   label: 'THOR16'   },
      { mode: 'thor22',   label: 'THOR22'   },
      { mode: 'thor25x4', label: 'THOR25x4' },
      { mode: 'thor50x1', label: 'THOR50x1' },
      { mode: 'thor50x2', label: 'THOR50x2' },
      { mode: 'thor100',  label: 'THOR100'  },
    ];
    root.innerHTML = `
      <div class="rtty-list">
        ${modes.map(m => `
          <button class="rtty-row ${this.thorOn && this.thorMode === m.mode ? 'active' : ''}" data-mode="${m.mode}">
            <div class="rtty-row-name">${m.label}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const m = t.dataset.mode as ThorMode;
        if (this.thorOn && this.thorMode === m) { root.remove(); return; }
        this.exclusiveActivate('thor');
        this.toggleThor(m);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openThorFreqPicker() {
    this.registerScanSet('THOR', THOR_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${THOR_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = THOR_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.thorOn) {
          this.exclusiveActivate('thor');
          this.toggleThor();
        }
        this.recenter();
        this.refresh();
        this.banner(`THOR ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleFsq(baud?: 1.5 | 2 | 3 | 4.5 | 6) {
    // If a baud is supplied, behave like the other vari-mode toggles:
    // when already-on with the same baud → toggle off; otherwise turn on
    // (or hot-swap baud) at the new value.
    const wantOn = baud != null ? !(this.fsqOn && this.settings.fsqBaud === baud) : !this.fsqOn;
    if (baud != null) this.settings.fsqBaud = baud;
    // Tear down any current decoder before flipping state, so we can
    // hot-swap baud without leaving a stale instance behind.
    if (this.fsqOn) {
      this.player.onFsq = null;
      this.fsqDecoder?.close();
      this.fsqDecoder = null;
      this.fsqOn = false;
    }
    this.fsqOn = wantOn;
    this.updateWaterfallStream();
    const btn = this.$('btnFsq');
    const panel = this.$('fsqPanel');
    btn.classList.toggle('active', this.fsqOn);
    panel.style.display = this.fsqOn ? '' : 'none';
    if (this.fsqOn) {
      const sr = this.player.getInputRate() || 12000;
      this.fsqDecoder = new FsqFldigiDecoder({
        sampleRate: sr,
        carrierHz:  this.settings.fsqCarrierHz,
        baud:       this.settings.fsqBaud,
        onStatus: (s) => { this.$('fsqStatus').textContent = `FSQ ${this.settings.fsqBaud}b ${this.settings.fsqCarrierHz}Hz ${s}`; },
        onChar: (ch) => {
          const el = this.$('fsqText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onFsq = (s) => this.fsqDecoder?.feed(s);
    }
    // Teardown for the off path already happened at the top of the
    // method (before flipping state), so no else branch needed.
  }

  private toggleMt63(mode?: Mt63Mode) {
    const wantOn = mode != null ? !(this.mt63On && this.mt63Mode === mode) : !this.mt63On;
    if (mode != null) {
      this.mt63Mode = mode;
      this.settings.mt63Mode = mode;
      // Mirror the s/l suffix into mt63Integration so downstream code
      // (decoder feed, native binary --integration arg) stays in sync.
      this.settings.mt63Integration = mode.endsWith('s') ? 'short' : 'long';
      saveSettings(this.settings);
    }
    if (this.mt63On) {
      this.player.onMt63 = null;
      this.mt63Decoder?.close();
      this.mt63Decoder = null;
      this.mt63On = false;
    }
    this.mt63On = wantOn;
    this.updateWaterfallStream();
    const btn = this.$('btnMt63');
    const panel = this.$('mt63Panel');
    btn.classList.toggle('active', this.mt63On);
    panel.style.display = this.mt63On ? '' : 'none';
    btn.textContent = this.mt63On
      ? `MT63 ${(this.settings.mt63CarrierHz / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : 'MT63';
    if (!this.mt63On) return;
    // Snap the receiver passband to the MT63 band: tones occupy
    // carrier ± bandwidth/2 (carrier is the center, per fldigi convention).
    const bwHz = parseInt(this.mt63Mode, 10);  // '500s' → 500, '1000l' → 1000, '2000s' → 2000
    const carrier = this.settings.mt63CarrierHz;
    if (Number.isFinite(bwHz) && bwHz > 0) {
      this.lowCut  = Math.max(50,    carrier - bwHz / 2);
      this.highCut = Math.min(5500, carrier + bwHz / 2);
      this.applyPassband();
      this.refresh();
    }
    const sr = this.player.getInputRate() || 12000;
    const label = this.mt63Mode.toUpperCase();
    this.$('mt63Status').textContent = `MT63-${label} listening…`;
    this.mt63Decoder = new Mt63FldigiDecoder({
      sampleRate: sr,
      mode: this.mt63Mode,
      carrierHz: this.settings.mt63CarrierHz,
      integration: this.settings.mt63Integration,
      eightBit:    this.settings.mt63EightBit,
      onStatus: (s) => { this.$('mt63Status').textContent = `MT63-${label} ${this.settings.mt63CarrierHz}Hz ${s}`; },
      onChar: (ch) => {
        const el = this.$('mt63Text');
        el.textContent = (el.textContent || '') + ch;
        const t = el.textContent;
        if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
        el.scrollTop = el.scrollHeight;
      },
    });
    this.player.onMt63 = (s) => this.mt63Decoder?.feed(s);
  }

  private openMt63ModePicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker psk-mode-picker';
    const modes: { mode: Mt63Mode; label: string }[] = [
      { mode: '500s',  label: '500 S'  },
      { mode: '500l',  label: '500 L'  },
      { mode: '1000s', label: '1000 S' },
      { mode: '1000l', label: '1000 L' },
      { mode: '2000s', label: '2000 S' },
      { mode: '2000l', label: '2000 L' },
    ];
    root.innerHTML = `
      <div class="rtty-list">
        ${modes.map(m => `
          <button class="rtty-row ${this.mt63On && this.mt63Mode === m.mode ? 'active' : ''}" data-mode="${m.mode}">
            <div class="rtty-row-name">${m.label}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const m = t.dataset.mode as Mt63Mode;
        if (this.mt63On && this.mt63Mode === m) { root.remove(); return; }
        this.exclusiveActivate('mt63');
        this.toggleMt63(m);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openMt63FreqPicker() {
    this.registerScanSet('MT63', MT63_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${MT63_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · MT63-${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = MT63_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (this.mt63On && this.mt63Mode !== f.mode) {
          this.exclusiveActivate('mt63');
          this.toggleMt63(f.mode);
        } else if (!this.mt63On) {
          this.exclusiveActivate('mt63');
          this.toggleMt63(f.mode);
        }
        this.recenter();
        this.refresh();
        this.banner(`MT63 ${f.freqKHz.toFixed(3)} (${f.note})`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openMfskModePicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker psk-mode-picker';
    const modes: { mode: MfskMode; label: string }[] = [
      { mode: 'mfsk4',   label: 'MFSK4'   },
      { mode: 'mfsk8',   label: 'MFSK8'   },
      { mode: 'mfsk11',  label: 'MFSK11'  },
      { mode: 'mfsk16',  label: 'MFSK16'  },
      { mode: 'mfsk22',  label: 'MFSK22'  },
      { mode: 'mfsk31',  label: 'MFSK31'  },
      { mode: 'mfsk32',  label: 'MFSK32'  },
      { mode: 'mfsk64',  label: 'MFSK64'  },
      { mode: 'mfsk128', label: 'MFSK128' },
    ];
    root.innerHTML = `
      <div class="rtty-list">
        ${modes.map(m => `
          <button class="rtty-row ${this.mfskOn && this.mfskMode === m.mode ? 'active' : ''}" data-mode="${m.mode}">
            <div class="rtty-row-name">${m.label}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const m = t.dataset.mode as MfskMode;
        if (this.mfskOn && this.mfskMode === m) { root.remove(); return; }
        this.exclusiveActivate('mfsk');
        this.toggleMfsk(m);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openFsqModePicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker';
    const modes: { baud: 1.5 | 2 | 3 | 4.5 | 6; label: string; note: string }[] = [
      { baud: 1.5, label: 'FSQ-1.5', note: 'marginal conditions' },
      { baud: 2,   label: 'FSQ-2',   note: 'poor conditions'     },
      { baud: 3,   label: 'FSQ-3',   note: 'standard'            },
      { baud: 4.5, label: 'FSQ-4.5', note: 'stronger signals'    },
      { baud: 6,   label: 'FSQ-6',   note: 'shortest messages'   },
    ];
    root.innerHTML = `
      <div class="rtty-list">
        ${modes.map(m => `
          <button class="rtty-row ${this.fsqOn && this.settings.fsqBaud === m.baud ? 'active' : ''}" data-baud="${m.baud}">
            <div class="rtty-row-name">${m.label}</div>
            <div class="rtty-row-meta">${m.baud} baud · ${m.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const baud = parseFloat(t.dataset.baud!) as 1.5 | 2 | 3 | 4.5 | 6;
        if (this.fsqOn && this.settings.fsqBaud === baud) { root.remove(); return; }
        this.exclusiveActivate('fsq');
        this.toggleFsq(baud);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openFsqFreqPicker() {
    this.registerScanSet('FSQ', FSQ_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${FSQ_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = FSQ_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.fsqOn) {
          this.exclusiveActivate('fsq');
          this.toggleFsq();
        }
        this.recenter();
        this.refresh();
        this.banner(`FSQ ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openMfskFreqPicker() {
    this.registerScanSet('MFSK', MFSK_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${MFSK_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = MFSK_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.mfskOn) {
          this.exclusiveActivate('mfsk');
          this.toggleMfsk();
        }
        this.recenter();
        this.refresh();
        this.banner(`MFSK ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openOliviaPresetPicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${OLIVIA_PRESETS.map((p, i) => `
          <button class="rtty-row ${p === this.oliviaPreset ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${p.name}</div>
            <div class="rtty-row-meta">${p.tones} tones · ${p.bandwidth} Hz BW</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const p = OLIVIA_PRESETS[+t.dataset.idx!];
        this.oliviaPreset = p;
        // Tap on OLIVIA opens this picker; picking a preset both selects
        // it and ensures Olivia is running. If already on, just hot-swap
        // the mode + passband.
        if (!this.oliviaOn) {
          this.toggleOlivia();  // turns Olivia on with the new preset
        } else {
          this.oliviaDecoder?.setMode(p.tones, p.bandwidth);
          this.lowCut  = Math.max(50,    Math.round(this.oliviaCarrierHz - p.bandwidth / 2));
          this.highCut = Math.min(5500, Math.round(this.oliviaCarrierHz + p.bandwidth / 2));
          this.applyPassband();
          this.refresh();
        }
        this.$('oliviaStatus').textContent = `OLIVIA ${p.name} listening…`;
        this.banner(`OLIVIA ${p.name}`, 1500);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** Long-press OLIVIA → list of HF watering holes. Tapping a row tunes
   *  the receiver to the dial frequency in USB so the audio carrier
   *  lands at ~1500 Hz, and (if Olivia is running) hot-swaps to the
   *  recommended mode preset for that band. */
  private openBeaconsFreqPicker() {
    this.registerScanSet('Beacons', BEACON_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${BEACON_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = BEACON_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        this.recenter();
        this.refresh();
        this.banner(`${f.label} ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openVlfbFreqPicker() {
    this.registerScanSet('VLF beacons', VLF_BEACONS.map(b => ({
      label: b.label, freqKHz: b.freqKHz, mode: 'cw' as Mode,
    })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${VLF_BEACONS.map((b, i) => `
          <button class="rtty-row ${b.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${b.label}</div>
            <div class="rtty-row-meta">${b.freqKHz.toFixed(3)} kHz · ${b.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const b = VLF_BEACONS[+t.dataset.idx!];
        this.freqKHz = b.freqKHz;
        this.setMode('cw');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        this.recenter();
        this.refresh();
        this.banner(`${b.label} ${b.freqKHz.toFixed(3)}`, 1800);
        // Keep the picker open after a selection.
        root.querySelectorAll('.rtty-row.active').forEach(el => el.classList.remove('active'));
        t.classList.add('active');
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openTimeStationsPicker() {
    this.registerScanSet('Time stations', TIME_STATIONS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${TIME_STATIONS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = TIME_STATIONS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter(); this.refresh();
        this.banner(`${f.label} ${f.freqKHz.toFixed(3)}`, 1800);
        // Keep the picker open after a selection — only the backdrop
        // tap or × closes it. Move the active highlight to the pick.
        root.querySelectorAll('.rtty-row.active').forEach(el => el.classList.remove('active'));
        t.classList.add('active');
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openVolmetPicker() {
    this.registerScanSet('VOLMET', VOLMET_STATIONS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${VOLMET_STATIONS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = VOLMET_STATIONS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter(); this.refresh();
        this.banner(`${f.label} ${f.freqKHz.toFixed(3)}`, 1800);
        // Keep the picker open after a selection — only the backdrop
        // tap or × closes it. Move the active highlight to the pick.
        root.querySelectorAll('.rtty-row.active').forEach(el => el.classList.remove('active'));
        t.classList.add('active');
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openScienPicker() {
    this.registerScanSet('Science', SCIEN_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${SCIEN_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz < 1 ? (f.freqKHz * 1000).toFixed(2) + ' Hz' : f.freqKHz.toFixed(3) + ' kHz'} · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = SCIEN_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter(); this.refresh();
        this.banner(`${f.label} ${f.freqKHz < 1 ? (f.freqKHz * 1000).toFixed(2) + ' Hz' : f.freqKHz.toFixed(3) + ' kHz'}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openMilvPicker() {
    this.registerScanSet('Mil voice', MILV_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${MILV_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = MILV_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter(); this.refresh();
        this.banner(`${f.label} ${f.freqKHz.toFixed(3)}`, 1800);
        // Keep the picker open after a selection — only the backdrop
        // tap or × closes it. Move the active highlight to the pick.
        root.querySelectorAll('.rtty-row.active').forEach(el => el.classList.remove('active'));
        t.classList.add('active');
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** Generic frequency-list picker. All 10 new pickers added in the
   *  0.3.66x series follow the same shape: an array of {label, freq,
   *  mode, note} entries, a scan-set registration, and a modal list
   *  that tunes on click. */
  /** @param afterPick — optional side-effect run after the dial settles
   *  on a chosen entry. Used by pickers that engage a paired decoder
   *  (AMTR → SITOR-B, NDB → CW). */
  private openGenericFreqPicker(scanLabel: string, list: FreqPickerEntry[], afterPick?: (f: FreqPickerEntry) => void): void {
    this.registerScanSet(scanLabel, list.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${list.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = list[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter(); this.refresh();
        this.banner(`${f.label} ${f.freqKHz.toFixed(3)}`, 1800);
        afterPick?.(f);
        // Keep the picker open so the user can audition adjacent
        // entries; just move the 'active' highlight to the new pick.
        // Close only via backdrop tap.
        root.querySelectorAll('.rtty-row.active').forEach(el => el.classList.remove('active'));
        t.classList.add('active');
        return;
      }
      if (e.target === root) root.remove();
    });
  }
  /** Flatten every frequency-picker data array into a single unified
   *  list. Used by LISTS to give the user a searchable cross-picker
   *  view. Sorted by frequency ascending. */
  private aggregateAllFreqs(): { picker: string; label: string; freqKHz: number; mode: Mode; note: string }[] {
    const out: { picker: string; label: string; freqKHz: number; mode: Mode; note: string }[] = [];
    const add = (
      picker: string,
      items: Array<{ label: string; freqKHz: number; mode?: Mode; note?: string }>,
      defaultMode: Mode,
    ) => {
      for (const f of items) out.push({
        picker,
        label: f.label,
        freqKHz: f.freqKHz,
        mode: (f.mode ?? defaultMode) as Mode,
        note: f.note ?? '',
      });
    };
    // Pickers whose entries already carry an explicit mode.
    add('BCON',   BEACON_FREQS,    'cw');
    add('MILV',   MILV_FREQS,      'usb');
    add('MARN',   MARITIME_FREQS,  'usb');
    add('SCI',    SCIEN_FREQS,     'cw');
    add('TIME',   TIME_STATIONS,   'am');
    add('VOLM',   VOLMET_STATIONS, 'usb');
    add('PKT',    PACKET_FREQS,    'lsb');
    // MT63 entries carry a sub-mode string (500s/1000/2000) rather than
    // a KiwiSDR Mode; the picker tunes USB regardless of sub-mode.
    for (const m of MT63_FREQS) out.push({
      picker: 'MT63', label: m.label, freqKHz: m.freqKHz, mode: 'usb',
      note: `${m.mode} · ${m.note}`,
    });
    // Pickers without an explicit mode in the entry — assume USB.
    add('THOR',   THOR_FREQS,      'usb');
    add('CTSA',   CONTESTIA_FREQS, 'usb');
    add('DOMI',   DOMINOEX_FREQS,  'usb');
    add('FSQ',    FSQ_FREQS,       'usb');
    add('MFSK',   MFSK_FREQS,      'usb');
    add('RTTY',   RTTY_FREQS,      'usb');
    add('WSPR',   WSPR_FREQS,      'usb');
    add('JS8',    JS8_FREQS,       'usb');
    add('FST4',   FST4_FREQS,      'usb');
    // IQ-mode pickers — these need the IQ pipeline at tune time.
    add('HFDL',   HFDL_FREQS,      'iq');
    add('OTHR',   OTHR_FREQS,      'iq');
    add('ALE',    ALE_FREQS,       'usb');
    // VLF beacons — defaulted to CW.
    for (const b of VLF_BEACONS) out.push({
      picker: 'VLFB', label: b.label, freqKHz: b.freqKHz, mode: 'cw', note: b.note,
    });
    // OLIVIA presets carry tones/bandwidth in their own shape.
    for (const o of OLIVIA_FREQS) out.push({
      picker: 'OLIV', label: `${o.band} ${o.preset}`, freqKHz: o.freqKHz, mode: 'usb',
      note: `${o.tones}-tone / ${o.bandwidth} Hz · ${o.note}`,
    });
    // CW segment table — pick the segment midpoint as the tuneable freq.
    for (const c of CW_FREQS) {
      const mid = (c.startKHz + c.endKHz) / 2;
      out.push({
        picker: 'CW', label: c.label, freqKHz: mid, mode: 'cw',
        note: `${c.startKHz.toFixed(0)}–${c.endKHz.toFixed(0)} kHz segment`,
      });
    }
    // FT4 / FT8 tuples — freq is in Hz, no note.
    for (const [label, hz] of FT4_FREQS) out.push({
      picker: 'FT4', label, freqKHz: hz / 1000, mode: 'usb', note: 'FT4 default',
    });
    for (const [label, hz] of FT8_FREQS) out.push({
      picker: 'FT8', label, freqKHz: hz / 1000, mode: 'usb', note: 'FT8 default',
    });
    // The new 0.3.66x picker tables already use the FreqPickerEntry shape.
    add('NDB',    NDB_FREQS,    'cw');
    add('NUM',    NUMBERS_FREQS,'usb');
    add('HFGC',   HFGCS_FREQS,  'usb');
    add('AERO',   AERO_FREQS,   'usb');
    add('GMDS',   GMDSS_FREQS,  'usb');
    add('PIRA',   PIRATE_FREQS, 'am');
    add('MARS',   MARS_FREQS,   'usb');
    add('WFAX',   WFAX_FREQS,   'usb');
    add('STAN',   STANAG_FREQS, 'usb');
    add('CB',     CB_FREQS,     'am');
    add('DRM',    DRM_FREQS,    'drm');
    add('MWDX',   MWDX_FREQS,   'am');
    add('LW',     LW_FREQS,     'am');
    add('DGPS',   DGPS_FREQS,   'cw');
    add('SWBC',   SWBROAD_FREQS, 'am');
    add('TNET',   TRAFNETS_FREQS,'usb');
    add('PACT',   PACTOR_FREQS,  'usb');
    add('3GAL',   STANAG3G_FREQS,'usb');
    add('CSTV',   COAST_FREQS,   'usb');
    add('ECOM',   EMCOMM_FREQS,  'usb');
    add('DIPL',   EMBASSY_FREQS, 'usb');
    add('CLND',   CLANDESTINE_FREQS, 'am');
    add('RUSM',   RUSMIL_FREQS,  'usb');
    add('CAP',    CAP_FREQS,     'usb');
    add('MEPT',   MEPT_FREQS,    'cw');
    add('CSCW',   COASTCW_FREQS, 'cw');
    add('SKYN',   SKYNET_FREQS,  'usb');
    add('DXCL',   DXCLUSTER_FREQS,'cw');
    add('AIDR',   AIRDRILL_FREQS,'usb');
    add('AFRC',   AFRICA_BC_FREQS,'am');
    add('ASIA',   ASIA_BC_FREQS, 'am');
    add('LATM',   LATAM_BC_FREQS,'am');
    add('MPAC',   MARPAC_FREQS,  'usb');
    add('MRSE',   MARS_EU_FREQS, 'usb');
    add('HFDM',   HFDM_FREQS,    'usb');
    add('SITA',   SITOR_A_FREQS, 'usb');
    add('AMTR',   AMTOR_FREQS,   'usb');
    out.sort((a, b) => a.freqKHz - b.freqKHz || a.picker.localeCompare(b.picker));
    return out;
  }

  /** Unified searchable view of every frequency-picker entry. Search
   *  matches against frequency (substring of `kHz` text), label, note,
   *  picker tag, and mode — OR semantics, case-insensitive. */
  private openListsPicker(): void {
    const all = this.aggregateAllFreqs();
    this.registerScanSet('All lists', all.map(r => ({ label: `${r.picker} · ${r.label}`, freqKHz: r.freqKHz, mode: r.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal lists-picker';
    root.innerHTML = `
      <div class="lists-card">
        <div class="lists-bar">
          <input class="lists-search" type="search" placeholder="search freq or text…" spellcheck="false" />
          <span class="lists-count"></span>
          <button class="lists-close" type="button" aria-label="close">×</button>
        </div>
        <div class="lists-result" id="listsResult"></div>
      </div>
    `;
    document.body.appendChild(root);
    const searchEl = root.querySelector('.lists-search') as HTMLInputElement;
    const countEl  = root.querySelector('.lists-count')  as HTMLElement;
    const resultEl = root.querySelector('.lists-result') as HTMLElement;
    const render = (scrollToClosest = false) => {
      const q = searchEl.value.trim().toLowerCase();
      const matches = q
        ? all.filter(r => {
            if (r.freqKHz.toFixed(3).includes(q)) return true;
            if (r.label.toLowerCase().includes(q)) return true;
            if (r.note.toLowerCase().includes(q)) return true;
            if (r.picker.toLowerCase().includes(q)) return true;
            if (r.mode.toLowerCase().includes(q)) return true;
            return false;
          })
        : all;
      countEl.textContent = q
        ? `${matches.length} of ${all.length}`
        : `${all.length}`;
      // Pick the row nearest the currently tuned freq so we can both
      // mark it `active` and scroll to it on initial open.
      let nearestIdx = -1;
      let nearestDelta = Infinity;
      for (let i = 0; i < matches.length; i++) {
        const d = Math.abs(matches[i].freqKHz - this.freqKHz);
        if (d < nearestDelta) { nearestDelta = d; nearestIdx = i; }
      }
      resultEl.innerHTML = matches.map((r, i) => `
        <button class="lists-row${i === nearestIdx ? ' active' : ''}" data-idx="${i}">
          <div class="lists-row-freq">${r.freqKHz.toFixed(3)}<span class="lists-row-unit"> kHz</span></div>
          <div class="lists-row-meta">
            <span class="lists-row-mode">${r.mode.toUpperCase()}</span>
            <span class="lists-row-picker">${r.picker}</span>
            <span class="lists-row-label">${escapeAttr(r.label)}</span>
            ${r.note ? `<span class="lists-row-note">${escapeAttr(r.note)}</span>` : ''}
          </div>
        </button>`).join('');
      if (scrollToClosest && nearestIdx >= 0) {
        const row = resultEl.children[nearestIdx] as HTMLElement | undefined;
        // 'center' positions the closest-freq row in the middle of the
        // visible pane so the surrounding context is visible too.
        row?.scrollIntoView({ block: 'center' });
      }
    };
    resultEl.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.lists-row') as HTMLElement | null;
      if (!t) return;
      const q = searchEl.value.trim().toLowerCase();
      const matches = q
        ? all.filter(r =>
            r.freqKHz.toFixed(3).includes(q) ||
            r.label.toLowerCase().includes(q) ||
            r.note.toLowerCase().includes(q) ||
            r.picker.toLowerCase().includes(q) ||
            r.mode.toLowerCase().includes(q))
        : all;
      const r = matches[+t.dataset.idx!];
      if (!r) return;
      this.freqKHz = r.freqKHz;
      this.setMode(r.mode);
      this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
      this.recenter(); this.refresh();
      this.banner(`${r.picker} · ${r.label} ${r.freqKHz.toFixed(3)}`, 1800);
      // Keep LIST open after a tune; just move the active highlight to
      // the picked row.
      resultEl.querySelectorAll('.lists-row.active').forEach(el => el.classList.remove('active'));
      t.classList.add('active');
    });
    (root.querySelector('.lists-close') as HTMLElement).addEventListener('click', () => root.remove());
    root.addEventListener('click', (e) => { if (e.target === root) root.remove(); });
    searchEl.addEventListener('input', () => render(false));
    render(true);
    setTimeout(() => searchEl.focus(), 50);
  }

  private openNdbPicker() {
    // NDB beacons send slow Morse 1–3-letter idents. Auto-engage the CW
    // decoder so the ident text appears in the CW panel once tuned.
    this.openGenericFreqPicker('NDB beacons', NDB_FREQS, () => {
      if (!this.cwOn) { this.exclusiveActivate('cw'); this.toggleCw(); }
    });
  }
  private openNumbersPicker() { this.openGenericFreqPicker('Numbers',      NUMBERS_FREQS); }
  private openHfgcsPicker()   { this.openGenericFreqPicker('HF-GCS',       HFGCS_FREQS); }
  private openAeroPicker()    { this.openGenericFreqPicker('Aero oceanic', AERO_FREQS); }
  private openGmdssPicker()   { this.openGenericFreqPicker('GMDSS',        GMDSS_FREQS); }
  private openPiratePicker()  { this.openGenericFreqPicker('Pirate',       PIRATE_FREQS); }
  private openMarsPicker()    { this.openGenericFreqPicker('MARS',         MARS_FREQS); }
  private openWfaxPicker()    { this.openGenericFreqPicker('Weather fax',  WFAX_FREQS); }
  private openStanagPicker()  { this.openGenericFreqPicker('STANAG',       STANAG_FREQS); }
  private openCbPicker()      { this.openGenericFreqPicker('CB band',      CB_FREQS); }
  private openDrmPicker()     { this.openGenericFreqPicker('DRM',          DRM_FREQS); }
  private openMwdxPicker()    { this.openGenericFreqPicker('MW DX',        MWDX_FREQS); }
  private openLwPicker()      { this.openGenericFreqPicker('Longwave',     LW_FREQS); }
  private openDgpsPicker()    { this.openGenericFreqPicker('DGPS',         DGPS_FREQS); }
  private openSwbroadPicker() { this.openGenericFreqPicker('SW broadcast', SWBROAD_FREQS); }
  private openTrafnetsPicker(){ this.openGenericFreqPicker('Traffic nets', TRAFNETS_FREQS); }
  private openPactorPicker()  { this.openGenericFreqPicker('Pactor',       PACTOR_FREQS); }
  private openStanag3gPicker(){ this.openGenericFreqPicker('STANAG 3G',    STANAG3G_FREQS); }
  private openCoastPicker()   { this.openGenericFreqPicker('Coast voice',  COAST_FREQS); }
  private openEmcommPicker()  { this.openGenericFreqPicker('Emcomm',       EMCOMM_FREQS); }
  private openEmbassyPicker() { this.openGenericFreqPicker('Embassy',      EMBASSY_FREQS); }
  private openClandestinePicker() { this.openGenericFreqPicker('Clandestine', CLANDESTINE_FREQS); }
  private openRusmilPicker()  { this.openGenericFreqPicker('RUSMIL',       RUSMIL_FREQS); }
  private openCapPicker()     { this.openGenericFreqPicker('CAP',          CAP_FREQS); }
  private openMeptPicker()    { this.openGenericFreqPicker('MEPT',         MEPT_FREQS); }
  private openCoastcwPicker() { this.openGenericFreqPicker('Coastal CW',   COASTCW_FREQS); }
  private openSkynetPicker()  { this.openGenericFreqPicker('Skynet',       SKYNET_FREQS); }
  private openDxclusterPicker(){this.openGenericFreqPicker('DX cluster',   DXCLUSTER_FREQS); }
  private openAirdrillPicker(){ this.openGenericFreqPicker('Air drill',    AIRDRILL_FREQS); }
  private openAfricaBcPicker(){ this.openGenericFreqPicker('Africa BC',    AFRICA_BC_FREQS); }
  private openAsiaBcPicker()  { this.openGenericFreqPicker('Asia BC',      ASIA_BC_FREQS); }
  private openLatamBcPicker() { this.openGenericFreqPicker('LatAm BC',     LATAM_BC_FREQS); }
  private openMarpacPicker()  { this.openGenericFreqPicker('Marine Pacific',MARPAC_FREQS); }
  private openMarsEuPicker()  { this.openGenericFreqPicker('MARS Europe',  MARS_EU_FREQS); }
  private openHfdmPicker()    { this.openGenericFreqPicker('HF data modem',HFDM_FREQS); }
  private openSitorAPicker()  { this.openGenericFreqPicker('SITOR-A',      SITOR_A_FREQS); }
  private openAmtorPicker() {
    // AMTOR FEC shares the SITOR-B waveform (100 baud / 170 Hz shift) —
    // engage the SITOR-B decoder so AMTOR FEC text appears in the SITOR
    // panel once tuned.
    this.openGenericFreqPicker('AMTOR', AMTOR_FREQS, () => {
      if (!this.sitorOn) { this.exclusiveActivate('sitor'); this.toggleSitor(); }
    });
  }

  private openMaritimePicker() {
    this.registerScanSet('Maritime', MARITIME_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${MARITIME_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = MARITIME_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter(); this.refresh();
        this.banner(`${f.label} ${f.freqKHz.toFixed(3)}`, 1800);
        // Keep the picker open after a selection — only the backdrop
        // tap or × closes it. Move the active highlight to the pick.
        root.querySelectorAll('.rtty-row.active').forEach(el => el.classList.remove('active'));
        t.classList.add('active');
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openCwFreqPicker() {
    this.registerScanSet('CW', CW_FREQS.map(f => ({ label: f.label, freqKHz: f.startKHz, mode: 'cw' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${CW_FREQS.map((f, i) => {
          const within = this.freqKHz >= f.startKHz && this.freqKHz <= f.endKHz;
          const range  = f.startKHz === f.endKHz
            ? `${f.startKHz.toFixed(3)} kHz`
            : `${f.startKHz.toFixed(0)}–${f.endKHz.toFixed(0)} kHz`;
          return `
            <button class="rtty-row ${within ? 'active' : ''}" data-idx="${i}">
              <div class="rtty-row-name">${f.label}</div>
              <div class="rtty-row-meta">${range} · ${f.note}</div>
            </button>`;
        }).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = CW_FREQS[+t.dataset.idx!];
        // Tune to the start of the segment (or the single freq for point
        // entries) in CW mode so the user lands ready-to-listen.
        this.freqKHz = f.startKHz;
        this.setMode('cw');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        this.recenter();
        this.refresh();
        this.banner(`CW ${f.label} ${f.startKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openOliviaFreqPicker() {
    this.registerScanSet('Olivia', OLIVIA_FREQS.map(f => ({ label: `${f.band} · ${f.preset}`, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${OLIVIA_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.band} · ${f.preset}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = OLIVIA_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        const preset = OLIVIA_PRESETS.find(p => p.tones === f.tones && p.bandwidth === f.bandwidth);
        if (preset) this.oliviaPreset = preset;
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (this.oliviaOn && preset) {
          this.oliviaDecoder?.setMode(preset.tones, preset.bandwidth);
          this.lowCut  = Math.max(50,    Math.round(this.oliviaCarrierHz - preset.bandwidth / 2));
          this.highCut = Math.min(5500, Math.round(this.oliviaCarrierHz + preset.bandwidth / 2));
          this.applyPassband();
        }
        this.recenter();
        this.refresh();
        this.banner(`Olivia ${f.band} ${f.freqKHz.toFixed(3)} (${f.preset})`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleRtty() {
    this.rttyOn = !this.rttyOn;
    this.updateWaterfallStream();
    const btn = this.$('btnRtty');
    const panel = this.$('rttyPanel');
    btn.classList.toggle('active', this.rttyOn);
    panel.style.display = this.rttyOn ? '' : 'none';
    if (this.rttyOn) {
      const sr = this.player.getInputRate() || 12000;
      const sset = this.settings;
      // Settings override the preset for fine-tuning. fldigi RTTY takes
      // carrier + shift; convert from mark/space.
      const mark = sset.rttyMarkHz, space = sset.rttySpaceHz;
      const carrierHz = (mark + space) / 2;
      const shift     = Math.abs(space - mark);
      this.rttyDecoder = new RTTYFldigiDecoder({
        sampleRate: sr,
        carrierHz,
        baud:  sset.rttyBaud,
        shift,
        bits:  5,
        stop:  1.5,
        onStatus: (s) => { this.$('rttyStatus').textContent = `${this.rttyPreset.name} ${s}`; },
        onChar: (ch) => {
          const el = this.$('rttyText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onRtty = (s) => this.rttyDecoder?.feed(s);
    } else {
      this.player.onRtty = null;
      this.rttyDecoder?.close();
      this.rttyDecoder = null;
    }
  }

  private toggleCw() {
    this.cwOn = !this.cwOn;
    this.updateWaterfallStream();
    const btn = this.$('btnCw');
    const panel = this.$('cwPanel');
    btn.classList.toggle('active', this.cwOn);
    panel.style.display = this.cwOn ? '' : 'none';
    if (this.cwOn) {
      const sr = this.player.getInputRate() || 12000;
      const s = this.settings;
      this.cwDecoder = new CWDecoder({
        sampleRate: sr,
        pitchHz:       s.cwPitch,
        wpm:           s.cwWpm,
        lowerLimit:    s.cwLowerLimit,
        upperLimit:    s.cwUpperLimit,
        range:         s.cwRange,
        bandwidth:     s.cwBandwidth,
        matchedFilter: s.cwMatchedFilter,
        attack:        s.cwAttack,
        decay:         s.cwDecay,
        lowercase:     s.cwLowercase,
        dashDot:       s.cwDashDot,
        useSOM:        s.cwUseSOM,
        onStatus: (st) => { this.$('cwStatus').textContent = `CW ${st}`; },
        onChar: (ch) => {
          const el = this.$('cwText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onCw = (s) => this.cwDecoder?.feed(s);
    } else {
      this.player.onCw = null;
      this.cwDecoder?.close();
      this.cwDecoder = null;
      // CW going off implicitly tears down MCW since MCW IS "AM + CW
      // decoder on." Clear the MCW indicator so the button matches
      // the underlying state.
      if (this.mcwOn) {
        this.mcwOn = false;
        const mcwBtn = this.root.querySelector('#btnMcw') as HTMLElement | null;
        if (mcwBtn) mcwBtn.classList.remove('active');
      }
    }
  }

  /** AUTO is a one-shot. First tap: open the panel, run heuristic + RSID
   *  classifiers for AUTO_WINDOW_MS, then freeze on the dominant heuristic
   *  vote (RSID detections during the window already auto-switched the
   *  decoder). Second tap (panel still visible): close the panel + tear
   *  the classifiers down. */
  private toggleAuto() {
    // btnAuto was removed from the waterfall; guard the lookup so
    // exclusiveActivate's auto-close branch can't crash on null.
    const btn = this.root.querySelector('#btnAuto') as HTMLElement | null;
    const panel = this.$('autoPanel');
    if (this.autoOn) {
      // Second tap → close.
      this.autoOn = false;
      this.player.onClassify = null;
      this.autoClassifier = null;
      this.rsidClassifier?.close();
      this.rsidClassifier = null;
      if (this.autoFinalizeTimer != null) {
        clearTimeout(this.autoFinalizeTimer);
        this.autoFinalizeTimer = null;
      }
      this.updateWaterfallStream();
      btn?.classList.remove('active');
      panel.style.display = 'none';
      return;
    }
    // First tap → open + start the one-shot run.
    this.autoOn = true;
    this.updateWaterfallStream();
    btn?.classList.add('active');
    panel.style.display = '';
    const sr = this.player.getInputRate() || 12000;
    this.autoHistory = [];
    this.$('autoText').textContent = '';
    this.$('autoStatus').textContent = 'AUTO listening… (10 s)';
    this.autoClassifier = new ModeClassifier({
      sampleRate: sr,
      onResult: (r) => {
        this.autoHistory.push(r);
        if (this.autoHistory.length > 40) this.autoHistory.shift();
        const ns = this.nonSilentCount();
        if (ns < 8) {
          this.$('autoStatus').textContent = `AUTO listening… (${ns}/8 non-silent frames)`;
        } else {
          const dom = this.dominantHeuristic(ns);
          this.$('autoStatus').textContent =
            `→ ${dom.mode}  (${Math.round(dom.confidence * 100)}%)  ${dom.details}`;
          // Minimum analysis met → finalize and freeze the panel.
          this.finalizeAuto();
        }
        const el = this.$('autoText');
        const ts = new Date().toLocaleTimeString();
        const conf = Math.round(r.confidence * 100);
        el.textContent = (el.textContent || '') + `${ts}  ${r.mode.padEnd(12)} ${conf}%  ${r.details}\n`;
        const t = el.textContent;
        if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
        el.scrollTop = el.scrollHeight;
      },
    });
    this.rsidClassifier = new RsidClassifier({
      sampleRate: sr,
      onDetect: (d) => this.handleRsidDetect(d),
      onStatus: (s) => {
        const el = this.$('autoText');
        el.textContent = (el.textContent || '') + `${new Date().toLocaleTimeString()}  RSID: ${s}\n`;
      },
    });
    this.player.onClassify = (s) => {
      this.autoClassifier?.feed(s);
      this.rsidClassifier?.feed(s);
    };
    // Safety net only — drives finalize on a fully-silent channel where
    // the per-frame trigger would otherwise never fire. Real signals
    // finalize as soon as 8 non-silent frames accumulate.
    this.autoFinalizeTimer = window.setTimeout(() => this.finalizeAuto(), 60_000);
  }

  /** Stop the classifiers and freeze the panel on the dominant vote. The
   *  panel stays visible until the user taps AUTO again to dismiss it. */
  private finalizeAuto() {
    if (this.autoFinalizeTimer != null) {
      clearTimeout(this.autoFinalizeTimer);
      this.autoFinalizeTimer = null;
    }
    if (this.autoClassifier == null && this.rsidClassifier == null) return;
    this.player.onClassify = null;
    this.autoClassifier = null;
    this.rsidClassifier?.close();
    this.rsidClassifier = null;
    const ns = this.nonSilentCount();
    if (ns < 8) {
      this.$('autoStatus').textContent =
        `FINAL → no signal (only ${ns} non-silent frames before timeout)`;
      return;
    }
    const dom = this.dominantHeuristic(ns);
    this.$('autoStatus').textContent =
      `FINAL → ${dom.mode}  (${Math.round(dom.confidence * 100)}%)  ${dom.details}`;
  }

  /** Voting filter for the heuristic classifier — picks the mode that
   *  appeared most often in the last `window` frames, then averages
   *  confidence across the matching frames so a single 80% spike in a sea
   *  of 20% noise doesn't dominate the displayed score. Falls back to the
   *  most recent result when history is shorter than the window. */
  private dominantHeuristic(window: number): ClassifierResult {
    // Silent frames are excluded — they're "no signal in the passband"
    // and would otherwise dominate any quiet stretch and drown out the
    // real mode estimate. Voting happens only across actual classified
    // frames within the trailing window.
    const slice = this.autoHistory
      .filter((r) => r.mode !== 'silent')
      .slice(-window);
    if (slice.length === 0) return { mode: 'silent', confidence: 0, details: 'no non-silent frames' };
    const counts: Record<string, number> = {};
    for (const r of slice) counts[r.mode] = (counts[r.mode] || 0) + 1;
    let bestMode = slice[slice.length - 1].mode;
    let bestCount = 0;
    for (const [m, c] of Object.entries(counts)) {
      if (c > bestCount) { bestMode = m; bestCount = c; }
    }
    const matching = slice.filter((r) => r.mode === bestMode);
    const avgConf = matching.reduce((s, r) => s + r.confidence, 0) / matching.length;
    const last = matching[matching.length - 1];
    return {
      mode: bestMode,
      confidence: avgConf,
      details: `${bestCount}/${slice.length} frames · ${last.details}`,
    };
  }

  /** Number of non-silent frames in autoHistory. */
  private nonSilentCount(): number {
    let n = 0;
    for (const r of this.autoHistory) if (r.mode !== 'silent') n++;
    return n;
  }

  /** Map an RSID detection to a decoder activation. RSID's `mode` field is
   *  the canonical fldigi sname (e.g. "OLIVIA-8/500", "MFSK-32", "BPSK-31").
   *  We only auto-switch into modes radiom has a server-side decoder for —
   *  every detection is logged regardless. */
  private handleRsidDetect(d: RsidDetection) {
    const ts = new Date().toLocaleTimeString();
    const el = this.$('autoText');
    el.textContent = (el.textContent || '') + `${ts}  RSID ${d.mode} @ ${d.freq.toFixed(0)} Hz\n`;
    const t = el.textContent;
    if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
    el.scrollTop = el.scrollHeight;
    this.$('autoStatus').textContent = `RSID → ${d.mode} @ ${d.freq.toFixed(0)} Hz`;

    const switched = this.applyRsidSwitch(d);
    if (switched) this.banner(`RSID: switched to ${d.mode}`, 1800);
  }

  /** Returns true if a decoder was activated. Conservative — only handles
   *  the RSID modes that map cleanly to radiom's existing fldigi-vendored
   *  decoders. Anything else falls through (logged but not switched). */
  private applyRsidSwitch(d: RsidDetection): boolean {
    const m = d.mode.toUpperCase();
    // PSK (BPSK / QPSK / 8PSK / PSK-R variants).
    const pskMap: Record<string, PSKFldigiMode> = {
      'BPSK31': 'bpsk31', 'BPSK63': 'bpsk63', 'BPSK63F': 'bpsk63f',
      'BPSK125': 'bpsk125', 'BPSK250': 'bpsk250', 'BPSK500': 'bpsk500', 'BPSK1000': 'bpsk1000',
      'QPSK31': 'qpsk31', 'QPSK63': 'qpsk63', 'QPSK125': 'qpsk125',
      'QPSK250': 'qpsk250', 'QPSK500': 'qpsk500',
      'PSK125R': 'psk125r', 'PSK250R': 'psk250r', 'PSK500R': 'psk500r', 'PSK1000R': 'psk1000r',
      '8PSK125': '8psk125', '8PSK125F': '8psk125f', '8PSK125FL': '8psk125fl',
      '8PSK250': '8psk250', '8PSK250F': '8psk250f', '8PSK250FL': '8psk250fl',
      '8PSK500': '8psk500', '8PSK500F': '8psk500f',
      '8PSK1000': '8psk1000', '8PSK1000F': '8psk1000f', '8PSK1200F': '8psk1200f',
    };
    if (pskMap[m]) { this.togglePsk31b(pskMap[m]); return true; }
    // MFSK.
    const mfskMap: Record<string, MfskMode> = {
      'MFSK4': 'mfsk4', 'MFSK8': 'mfsk8', 'MFSK11': 'mfsk11', 'MFSK16': 'mfsk16',
      'MFSK22': 'mfsk22', 'MFSK31': 'mfsk31', 'MFSK32': 'mfsk32',
      'MFSK64': 'mfsk64', 'MFSK128': 'mfsk128',
    };
    if (mfskMap[m]) { this.toggleMfsk(mfskMap[m]); return true; }
    // THOR.
    const thorMap: Record<string, ThorMode> = {
      'THOR4': 'thor4', 'THOR5': 'thor5', 'THOR8': 'thor8', 'THOR11': 'thor11',
      'THOR16': 'thor16', 'THOR22': 'thor22', 'THOR100': 'thor100',
    };
    if (thorMap[m]) { this.toggleThor(thorMap[m]); return true; }
    // DominoEX.
    const domMap: Record<string, DominoexMode> = {
      'DOMINOEX4': 'dominoex4', 'DOMINOEX5': 'dominoex5', 'DOMINOEX8': 'dominoex8',
      'DOMINOEX11': 'dominoex11', 'DOMINOEX16': 'dominoex16', 'DOMINOEX22': 'dominoex22',
      'DOMINOEX44': 'dominoex44', 'DOMINOEX88': 'dominoex88',
    };
    if (domMap[m]) { this.toggleDominoex(domMap[m]); return true; }
    // Olivia / Contestia presets — RSID encodes the (tones, BW) pair in the sname.
    // sname format examples: "OLIVIA-8/500", "OLIVIA-16/1000", "Cont-8/250".
    const olv = m.match(/^OLIVIA-?(\d+)\/(\d+)$/);
    if (olv) {
      this.toggleOliviaPreset(parseInt(olv[1], 10), parseInt(olv[2], 10));
      return true;
    }
    const ctt = m.match(/^CONT-?(\d+)\/(\d+)$/);
    if (ctt) {
      this.toggleContestia({ tones: parseInt(ctt[1], 10), bandwidth: parseInt(ctt[2], 10) });
      return true;
    }
    // RTTY (any 45/50/75 baud variant — let the user-selected RTTY shift stand).
    if (m.startsWith('RTTY')) { this.toggleRtty(); return true; }
    // MT63 — sname like "MT63-1000L".
    if (m.startsWith('MT63')) {
      const mt = m.match(/^MT63-?(\d+)([SL])?$/);
      if (mt) {
        const flav = `${mt[1]}${(mt[2] || 'S').toLowerCase()}` as Mt63Mode;
        this.toggleMt63(flav);
        return true;
      }
    }
    return false;
  }

  /** Helper: toggleOlivia takes saved settings; we want to switch to the
   *  exact (tones, BW) reported by RSID. */
  private toggleOliviaPreset(tones: number, bandwidth: number) {
    this.oliviaDecoder?.setMode(tones, bandwidth);
    if (!this.oliviaOn) this.toggleOlivia();
  }

  private togglePsk31b(mode?: PSKFldigiMode) {
    const wantOn = mode != null ? !(this.psk31bOn && this.psk31bMode === mode) : !this.psk31bOn;
    if (mode != null) {
      this.psk31bMode = mode;
      this.settings.psk31bMode = mode;
      saveSettings(this.settings);
    }
    if (this.psk31bOn) {
      this.player.onPsk = null;
      this.psk31bDecoder?.close();
      this.psk31bDecoder = null;
      this.psk31bOn = false;
    }
    this.psk31bOn = wantOn;
    this.updateWaterfallStream();
    const btn = this.$('btnPsk31b');
    const panel = this.$('psk31bPanel');
    btn.classList.toggle('active', this.psk31bOn);
    panel.style.display = this.psk31bOn ? '' : 'none';
    btn.textContent = this.psk31bOn
      ? `PSK ${(this.pskPitch / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : 'PSK';
    if (this.psk31bOn) {
      // Auto-set the SSB passband around the carrier (pskPitch) using
      // the mode's symbol rate × 1.2 — wide enough for sinc sidelobes,
      // narrow enough to reject adjacent QRM. User can still nudge
      // lof/hif manually after activation.
      const passbandHz = pskPassbandFor(this.psk31bMode);
      this.highCut = Math.min(5500, Math.round(this.pskPitch + passbandHz / 2));
      this.lowCut  = Math.max(50,    Math.round(this.pskPitch - passbandHz / 2));
      this.applyPassband();
      this.refresh();
      const sr = this.player.getInputRate() || 12000;
      const label = this.psk31bMode.toUpperCase();
      this.$('psk31bStatus').textContent = `${label} listening…`;
      this.psk31bDecoder = new PSKFldigiDecoder({
        sampleRate: sr,
        pitchHz: this.pskPitch,
        mode: this.psk31bMode,
        acqSn:       this.settings.pskAcqSn,
        searchRange: this.settings.pskSearchRange,
        onStatus: (s) => { this.$('psk31bStatus').textContent = `${label} ${this.pskPitch}Hz ${s}`; },
        onChar: (ch) => {
          const el = this.$('psk31bText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onPsk = (s) => this.psk31bDecoder?.feed(s);
    }
  }

  private openPskFldigiModePicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker psk-mode-picker';
    const modes: { mode: PSKFldigiMode; label: string }[] = [
      { mode: 'bpsk31',    label: 'PSK31'    },
      { mode: 'bpsk63',    label: 'PSK63'    },
      { mode: 'bpsk63f',   label: 'PSK63F'   },
      { mode: 'bpsk125',   label: 'PSK125'   },
      { mode: 'bpsk250',   label: 'PSK250'   },
      { mode: 'bpsk500',   label: 'PSK500'   },
      { mode: 'bpsk1000',  label: 'PSK1000'  },
      { mode: 'qpsk31',    label: 'QPSK31'   },
      { mode: 'qpsk63',    label: 'QPSK63'   },
      { mode: 'qpsk125',   label: 'QPSK125'  },
      { mode: 'qpsk250',   label: 'QPSK250'  },
      { mode: 'qpsk500',   label: 'QPSK500'  },
      { mode: '8psk125',   label: '8PSK125'  },
      { mode: '8psk125fl', label: '8PSK125FL'},
      { mode: '8psk125f',  label: '8PSK125F' },
      { mode: '8psk250',   label: '8PSK250'  },
      { mode: '8psk250fl', label: '8PSK250FL'},
      { mode: '8psk250f',  label: '8PSK250F' },
      { mode: '8psk500',   label: '8PSK500'  },
      { mode: '8psk500f',  label: '8PSK500F' },
      { mode: '8psk1000',  label: '8PSK1000' },
      { mode: '8psk1000f', label: '8PSK1000F'},
      { mode: '8psk1200f', label: '8PSK1200F'},
      { mode: 'psk125r',   label: 'PSK125R'  },
      { mode: 'psk250r',   label: 'PSK250R'  },
      { mode: 'psk500r',   label: 'PSK500R'  },
      { mode: 'psk1000r',  label: 'PSK1000R' },
    ];
    root.innerHTML = `
      <div class="rtty-list">
        ${modes.map(m => `
          <button class="rtty-row ${this.psk31bOn && this.psk31bMode === m.mode ? 'active' : ''}" data-mode="${m.mode}">
            <div class="rtty-row-name">${m.label}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const m = t.dataset.mode as PSKFldigiMode;
        this.exclusiveActivate('psk31b');
        this.togglePsk31b(m);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openModesPicker() {
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker modes-picker';
    const groups: { title: string; rows: { label: string; url: string; carrierHz?: number }[] }[] = [
      { title: 'CW', rows: [
        { label: 'Morse',     url: '/audio/cw/morse.mp3' },
      ]},
      { title: 'RTTY', rows: [
        { label: '170/45.45', url: '/audio/rtty/rtty_170_45p45.mp3' },
        { label: '170/50',    url: '/audio/rtty/rtty_170_50.mp3' },
        { label: '170/75',    url: '/audio/rtty/rtty_170_75.mp3' },
        { label: '170/100',   url: '/audio/rtty/rtty_170_100.mp3' },
        { label: '850/45.45', url: '/audio/rtty/rtty_850_45p45.mp3' },
      ]},
      { title: 'BPSK', rows: [
        { label: 'PSK31',    url: '/audio/psk/bpsk31_gen.mp3' },
        { label: 'PSK63',    url: '/audio/psk/bpsk63_gen.mp3' },
        { label: 'PSK63F',   url: '/audio/psk/bpsk63f_gen.mp3' },
        { label: 'PSK125',   url: '/audio/psk/bpsk125_gen.mp3' },
        { label: 'PSK250',   url: '/audio/psk/bpsk250_gen.mp3' },
        { label: 'PSK500',   url: '/audio/psk/bpsk500_gen.mp3' },
        { label: 'PSK1000',  url: '/audio/psk/bpsk1000_gen.mp3' },
        { label: 'PSK125R',  url: '/audio/psk/psk125r.mp3' },
        { label: 'PSK250R',  url: '/audio/psk/psk250r.mp3' },
        { label: 'PSK500R',  url: '/audio/psk/psk500r.mp3' },
        { label: 'PSK1000R', url: '/audio/psk/psk1000r.mp3' },
      ]},
      { title: 'QPSK', rows: [
        { label: 'QPSK31',  url: '/audio/qpsk/qpsk31_gen.mp3' },
        { label: 'QPSK63',  url: '/audio/qpsk/qpsk63_gen.mp3' },
        { label: 'QPSK125', url: '/audio/qpsk/qpsk125_gen.mp3' },
        { label: 'QPSK250', url: '/audio/qpsk/qpsk250_gen.mp3' },
        { label: 'QPSK500', url: '/audio/qpsk/qpsk500_gen.mp3' },
      ]},
      { title: '8PSK (unreliable)', rows: [
        { label: '125',       url: '/audio/psk8/8psk125.mp3'    },
        { label: '125FL',     url: '/audio/psk8/8psk125fl.mp3'  },
        { label: '125F',      url: '/audio/psk8/8psk125f.mp3'   },
        { label: '250',       url: '/audio/psk8/8psk250.mp3'    },
        { label: '250FL',     url: '/audio/psk8/8psk250fl.mp3'  },
        { label: '250F',      url: '/audio/psk8/8psk250f.mp3'   },
        { label: '500',       url: '/audio/psk8/8psk500.mp3'    },
        { label: '500F',      url: '/audio/psk8/8psk500f.mp3'   },
        { label: '1000',      url: '/audio/psk8/8psk1000.mp3'   },
        { label: '1000F',     url: '/audio/psk8/8psk1000f.mp3'  },
        { label: '1200F',     url: '/audio/psk8/8psk1200f.mp3'  },
      ]},
      { title: 'MT63', rows: [
        { label: '500S',  url: '/audio/mt63/mt63_500s_gen.mp3' },
        { label: '500L',  url: '/audio/mt63/mt63_500l_gen.mp3' },
        { label: '1000S', url: '/audio/mt63/mt63_1000s_gen.mp3' },
        { label: '1000L', url: '/audio/mt63/mt63_1000l_gen.mp3' },
        { label: '2000S', url: '/audio/mt63/mt63_2000s_gen.mp3' },
        { label: '2000L', url: '/audio/mt63/mt63_2000l_gen.mp3' },
      ]},
      { title: 'MFSK', rows: [
        { label: 'MFSK4',   url: '/audio/mfsk/mfsk4_gen.mp3' },
        { label: 'MFSK8',   url: '/audio/mfsk/mfsk8_gen.mp3' },
        { label: 'MFSK11',  url: '/audio/mfsk/mfsk11_gen.mp3' },
        { label: 'MFSK16',  url: '/audio/mfsk/mfsk16_gen.mp3' },
        { label: 'MFSK22',  url: '/audio/mfsk/mfsk22_gen.mp3' },
        { label: 'MFSK31',  url: '/audio/mfsk/mfsk31_gen.mp3' },
        { label: 'MFSK32',  url: '/audio/mfsk/mfsk32_gen.mp3' },
        { label: 'MFSK64',  url: '/audio/mfsk/mfsk64_gen.mp3' },
        { label: 'MFSK128', url: '/audio/mfsk/mfsk128_gen.mp3' },
      ]},
      { title: 'THOR', rows: [
        { label: 'THOR4',     url: '/audio/throb/thor4.mp3' },
        { label: 'THOR5',     url: '/audio/throb/thor5.mp3' },
        { label: 'THOR8',     url: '/audio/throb/thor8.mp3' },
        { label: 'THOR11',    url: '/audio/throb/thor11.mp3' },
        { label: 'THOR16',    url: '/audio/throb/thor16.mp3' },
        { label: 'THOR22',    url: '/audio/throb/thor22.mp3' },
        { label: 'THOR25x4',  url: '/audio/throb/thor25x4.mp3' },
        { label: 'THOR50x1',  url: '/audio/throb/thor50x1.mp3' },
        { label: 'THOR50x2',  url: '/audio/throb/thor50x2.mp3' },
        { label: 'THOR100',   url: '/audio/throb/thor100.mp3' },
      ]},
      { title: 'DominoEX', rows: [
        // carrierHz is the measured centre of each test file's tone
        // bank (averaged FFT across the whole file picks up all the
        // mode's MFSK tones, then take the midpoint of the span).
        // When INJECT plays a tagged sample the DOMEX decoder is
        // reconfigured to that carrier so its filters land on signal.
        { label: 'DEX 4',     url: '/audio/dominoex/dominoex4.mp3',      carrierHz: 1129 },
        { label: 'DEX 5',     url: '/audio/dominoex/dominoex5.mp3',      carrierHz: 1160 },
        { label: 'DEX 7-8',   url: '/audio/dominoex/dominoex7-8.mp3',    carrierHz: 1182 },
        { label: 'DEX 8',     url: '/audio/dominoex/dominoex8.wav',      carrierHz: 1002 },
        { label: 'DEX 11',    url: '/audio/dominoex/dominoex11.mp3',     carrierHz: 1162 },
        { label: 'DEX 11FEC', url: '/audio/dominoex/dominoex11_fec.mp3', carrierHz: 1214 },
        { label: 'DEX 16',    url: '/audio/dominoex/dominoex16.mp3',     carrierHz: 1176 },
        { label: 'DEX 22',    url: '/audio/dominoex/dominoex22.mp3',     carrierHz: 1263 },
      ]},
      { title: 'Olivia', rows: [
        { label: '4/125',      url: '/audio/olivia/olivia_4_125_gen.mp3' },
        { label: '4/250 *',    url: '/audio/olivia/olivia_4_250_gen.mp3' },
        { label: '4/500',      url: '/audio/olivia/olivia_4_500_gen.mp3' },
        { label: '4/1k',       url: '/audio/olivia/olivia_4_1000_gen.mp3' },
        { label: '4/2k',       url: '/audio/olivia/olivia_4_2000_gen.mp3' },
        { label: '8/125',      url: '/audio/olivia/olivia_8_125_gen.mp3' },
        { label: '8/250 *',    url: '/audio/olivia/olivia_8_250_gen.mp3' },
        { label: '8/500 *',    url: '/audio/olivia/olivia_8_500_gen.mp3' },
        { label: '8/1k',       url: '/audio/olivia/olivia_8_1000_gen.mp3' },
        { label: '8/2k',       url: '/audio/olivia/olivia_8_2000_gen.mp3' },
        { label: '16/500 *',   url: '/audio/olivia/olivia_16_500_gen.mp3' },
        { label: '16/1k *',    url: '/audio/olivia/olivia_16_1000_gen.mp3' },
        { label: '16/2k',      url: '/audio/olivia/olivia_16_2000_gen.mp3' },
        { label: '32/1k *',    url: '/audio/olivia/olivia_32_1000_gen.mp3' },
        { label: '32/2k',      url: '/audio/olivia/olivia_32_2000_gen.mp3' },
        { label: '64/500',     url: '/audio/olivia/olivia_64_500_gen.mp3' },
        { label: '64/1k',      url: '/audio/olivia/olivia_64_1000_gen.mp3' },
        { label: '64/2k',      url: '/audio/olivia/olivia_64_2000_gen.mp3' },
      ]},
      { title: 'Contestia', rows: [
        { label: '4/125',    url: '/audio/contestia/contestia_4_125_gen.mp3' },
        { label: '4/250 *',  url: '/audio/contestia/contestia_4_250_gen.mp3' },
        { label: '4/500',    url: '/audio/contestia/contestia_4_500_gen.mp3' },
        { label: '4/1k',     url: '/audio/contestia/contestia_4_1000_gen.mp3' },
        { label: '4/2k',     url: '/audio/contestia/contestia_4_2000_gen.mp3' },
        { label: '8/125',    url: '/audio/contestia/contestia_8_125_gen.mp3' },
        { label: '8/250 *',  url: '/audio/contestia/contestia_8_250_gen.mp3' },
        { label: '8/500 *',  url: '/audio/contestia/contestia_8_500_gen.mp3' },
        { label: '8/1k',     url: '/audio/contestia/contestia_8_1000_gen.mp3' },
        { label: '8/2k',     url: '/audio/contestia/contestia_8_2000_gen.mp3' },
        { label: '16/250',   url: '/audio/contestia/contestia_16_250_gen.mp3' },
        { label: '16/500 *', url: '/audio/contestia/contestia_16_500_gen.mp3' },
        { label: '16/1k',    url: '/audio/contestia/contestia_16_1000_gen.mp3' },
        { label: '16/2k',    url: '/audio/contestia/contestia_16_2000_gen.mp3' },
        { label: '32/1k *',  url: '/audio/contestia/contestia_32_1000_gen.mp3' },
        { label: '32/2k',    url: '/audio/contestia/contestia_32_2000_gen.mp3' },
        { label: '64/500',   url: '/audio/contestia/contestia_64_500_gen.mp3' },
        { label: '64/1k',    url: '/audio/contestia/contestia_64_1000_gen.mp3' },
        { label: '64/2k',    url: '/audio/contestia/contestia_64_2000_gen.mp3' },
      ]},
      { title: 'Hell', rows: [
        { label: 'Feld',      url: '/audio/hell/feld_hell.mp3' },
        { label: 'Feld×5',    url: '/audio/hell/feldhell_x5.mp3' },
        { label: 'Feld×9',    url: '/audio/hell/feldhell_x9.mp3' },
        { label: 'FSK',       url: '/audio/hell/fsk_hell.mp3' },
        { label: 'FSK 105',   url: '/audio/hell/fsk_hell_105.mp3' },
        { label: 'Slow',      url: '/audio/hell/slow_hell.mp3' },
        { label: 'FM',        url: '/audio/hell/fm_hell.mp3' },
        { label: 'Hell-80',   url: '/audio/hell/hell80.mp3' },
      ]},
      { title: 'Throb', rows: [
        { label: 'THROB1',    url: '/audio/throb/throb1.mp3' },
        { label: 'THROB2',    url: '/audio/throb/throb2.mp3' },
        { label: 'THROB4',    url: '/audio/throb/throb4.mp3' },
        { label: 'THROBX1',   url: '/audio/throb/throbx1.mp3' },
        { label: 'THROBX2',   url: '/audio/throb/throbx2.mp3' },
        { label: 'THROBX4',   url: '/audio/throb/throbx4.mp3' },
      ]},
      { title: 'FSQ', rows: [
        { label: 'FSQ',       url: '/audio/fsq/fsq.mp3' },
      ]},
      { title: 'FST4', rows: [
        { label: 'FST4W-60',     url: '/audio/fst4/210115_0058.wav' },
        { label: 'FST4W-1800 #1',url: '/audio/fst4/201230_0300.wav' },
        { label: 'FST4W-1800 #2',url: '/audio/fst4/210203_0600.wav' },
      ]},
      { title: 'JS8', rows: [
        { label: 'JS8 (SigID)',  url: '/audio/js8/js8_sigidwiki.mp3' },
      ]},
      { title: 'ALE 2G', rows: [
        { label: 'SigID',     url: '/audio/ale/ale2g_sigidwiki.mp3' },
        { label: 'Sounding',  url: '/audio/ale/MIL-STD-188-141A_SOUND.WAV' },
        { label: 'Standard',  url: '/audio/ale/MIL-STD-188-141A.WAV' },
        { label: 'AMD msg',   url: '/audio/ale/MIL-STD-188-141A_AMD.WAV' },
        { label: 'DBM',       url: '/audio/ale/MIL-STD-188-141A_DBM.WAV' },
        { label: 'DTM',       url: '/audio/ale/MIL-STD-188-141A_DTM.WAV' },
        { label: 'Link Prot', url: '/audio/ale/MIL-STD-188-141A_LinkProt.WAV' },
      ]},
      { title: 'FT4', rows: [
        { label: 'FT4 #1',  url: '/audio/ft4/000000_000002.wav' },
        { label: 'FT4 #2',  url: '/audio/ft4/190106_000112.wav' },
        { label: 'FT4 #3',  url: '/audio/ft4/190106_000115.wav' },
      ]},
      { title: 'FT8', rows: [
        { label: 'FT8 #1',  url: '/audio/ft8/170709_135615.wav' },
        { label: 'FT8 #2',  url: '/audio/ft8/181201_180245.wav' },
        { label: 'FT8 #3',  url: '/audio/ft8/210703_133430.wav' },
      ]},
      { title: 'WSPR', rows: [
        { label: 'WSPR-2',  url: '/audio/wspr/150426_0918.wav' },
      ]},
      { title: 'NAVTEX / SITOR-B', rows: [
        { label: 'NAVTEX (W)',url: '/audio/navtex/navtex_wiki.ogg' },
        { label: 'NAVTEX syn',url: '/audio/navtex/navtex_synthetic.mp3' },
        { label: 'NAVTEX ogg',url: '/audio/navtex/navtex_synthetic.ogg' },
        { label: 'NAVTEX off',url: '/audio/navtex/navtex_offair.wav' },
        { label: 'SITOR-B',   url: '/audio/navtex/sitorb.mp3' },
        { label: 'SITOR tfc', url: '/audio/navtex/sitorb_tfc.mp3' },
        { label: 'NAVTEX (gen)', url: '/audio/navtex/navtex_gen.mp3' },
        { label: 'SITOR-B (gen)',url: '/audio/navtex/sitorb_gen.mp3' },
      ]},
      { title: 'WEFAX', rows: [
        { label: 'HFFAX',     url: '/audio/wefax/hffax.wav' },
        { label: 'Fax 120',   url: '/audio/wefax/fax120.mp3' },
        { label: 'Fax 240',   url: '/audio/wefax/fax240.mp3' },
        { label: 'NW intro',  url: '/audio/wefax/northwood_intro.mp3' },
        { label: 'NW EoT',    url: '/audio/wefax/northwood_eot.mp3' },
      ]},
      { title: 'Packet', rows: [
        { label: 'HF APRS 300',    url: '/audio/packet/hf_aprs_300.wav' },
        { label: 'HF AX.25 300',   url: '/audio/packet/hf_packet_300.wav' },
        { label: 'HF AX.25 noisy', url: '/audio/packet/hf_aprs_300_noisy.wav' },
      ]},
      { title: 'Time', rows: [
        { label: 'WWV 10 MHz',     url: '/audio/wwv/wwv_10mhz.mp3' },
      ]},
    ];
    // Sort sections alphabetically (case-insensitive); within each
    // section the original row order is preserved.
    groups.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
    root.innerHTML = `
      <div class="rtty-list">
        ${groups.map(g => `
          <div class="modes-group-title">${g.title}</div>
          <div class="modes-grid">
            ${g.rows.map(r => `
              <button class="rtty-row" data-url="${r.url}"${r.carrierHz != null ? ` data-carrier="${r.carrierHz}"` : ''}>
                <div class="rtty-row-name">${r.label}</div>
              </button>`).join('')}
          </div>
        `).join('')}
      </div>
    `;
    document.body.appendChild(root);

    // Re-highlight the currently-active sample (if any).
    if (this.testActiveUrl) {
      const cur = root.querySelector(`button.rtty-row[data-url="${this.testActiveUrl}"]`);
      if (cur) cur.classList.add('active');
    }

    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const url = t.dataset.url!;
        const carrierHz = t.dataset.carrier ? +t.dataset.carrier : undefined;
        const wasActive = (this.testActiveUrl === url);
        // Stop whatever is running, then either bail (re-tap = stop) or
        // start the newly-tapped sample.
        this.stopTestSample();
        root.querySelectorAll('button.rtty-row.active').forEach(el => el.classList.remove('active'));
        if (wasActive) return;
        t.classList.add('active');
        // Per-test-file carrier metadata: when the row carries a
        // carrierHz, retune any running decoder that supports it so
        // the modem's filters land on the actual signal in the WAV.
        // (Live signals are normally tuned by the operator via the
        // dial; INJECT samples are fixed-carrier, so we override.)
        if (carrierHz != null && Number.isFinite(carrierHz)) {
          this.dominoexDecoder?.setCarrierHz(carrierHz);
          this.thorDecoder?.setCarrierHz(carrierHz);
          this.mt63Decoder?.setCarrierHz(carrierHz);
          this.mfskDecoder?.setPitch(carrierHz);
          this.oliviaDecoder?.setCarrierHz(carrierHz);
          this.contestiaDecoder?.setCarrierHz(carrierHz);
          this.fsqDecoder?.setCarrierHz(carrierHz);
        }
        this.startTestSample(url, true, true, () => {
          // Loop is always on now, so this only fires on hard error.
          if (this.testActiveUrl === url) {
            const tile = document.querySelector(`.modes-picker button.rtty-row[data-url="${url}"]`);
            tile?.classList.remove('active');
          }
        });
        return;
      }
      // Click outside any tile → close the modal but KEEP the sample
      // playing/feeding in the background.
      if (e.target === root) root.remove();
    });
  }

  private startTestSample(url: string, loop: boolean, feed: boolean, onEnd: () => void) {
    this.testActiveUrl = url;
    // Resync any UTC-aligned batch decoder so its capture window
    // starts at the playback start. Without this the WSPR/JS8/FST4
    // decoder would be mid-period and only catch part of the sample.
    if (url.includes('/audio/wspr/') && this.wsprOn) this.wsprDecoder?.triggerNow();
    if (url.includes('/audio/js8/')  && this.js8On)  this.js8Decoder?.triggerNow();
    if (url.includes('/audio/fst4/') && this.fst4On) this.fst4Decoder?.triggerNow();
    // When MUTE is on, route the sample through the player so SPEC,
    // speakers, recorder, FT8, classifier, and all decoders see it. Kiwi
    // is gated at pushAudio while muted, so the test sample is the sole
    // audio source app-wide. When MUTE is off, fall back to a plain
    // <audio> element + selective decoder fan-out (so live Kiwi audio
    // keeps playing through speakers/SPEC unchanged).
    if (this.aux) {
      this.testFeed = this.injectIntoPlayer(url, loop, () => {
        if (!loop) { this.stopTestSample(); onEnd(); }
      });
      return;
    }
    // Single decode shared between speaker (playTestBuffer → AudioContext →
    // destination + SPEC analyser) and decoder fan-out (setTimeout-paced
    // chunks of the same Int16 buffer). Doing it once eliminates both the
    // dual-decode race (late-resolving promises stomping current playback)
    // and any drift between what's heard and what's decoded.
    this.testFeed = this.startUnifiedTestPlayback(url, loop, feed, onEnd);
  }

  /** Decode `url` once, then play it through both the speaker (via
   *  `player.playTestBuffer`, which feeds the SPEC analyser) and the
   *  decoder hooks (via setTimeout fan-out). Returns a handle whose
   *  `stop()` cancels both. */
  private startUnifiedTestPlayback(
    url: string,
    loop: boolean,
    feed: boolean,
    onEnd: () => void,
  ): { stop: () => void } {
    let cancelled = false;
    let timer: number | null = null;
    let bufHandle: { stop: () => void } | null = null;
    const p = this.player;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (bufHandle) { try { bufHandle.stop(); } catch {} bufHandle = null; }
    };
    // Live read — call whichever decoder hooks are currently set on the
    // player. Reading at fanout time means the user can toggle a decoder
    // ON *after* selecting a TEST sample and it'll start receiving audio
    // immediately. Both Kiwi (via pushAudio) and TEST (via this fanout)
    // feed every active decoder concurrently — same model as the audio
    // mixer feeding the speaker.
    const fanout = (chunk: Int16Array) => {
      if (!feed) return;
      p.onCw?.(chunk);
      p.onRtty?.(chunk);
      p.onOlivia?.(chunk);
      p.onPsk?.(chunk);
      p.onWefax?.(chunk);
      p.onNavtex?.(chunk);
      p.onSitor?.(chunk);
      p.onMfsk?.(chunk);
      p.onMt63?.(chunk);
      p.onFsq?.(chunk);
      p.onThor?.(chunk);
      p.onDominoex?.(chunk);
      p.onContestia?.(chunk);
      p.onWwv?.(chunk);
      p.onAle?.(chunk);
      p.onPacket?.(chunk);
      p.onWspr?.(chunk);
      p.onJs8?.(chunk);
      p.onFst4?.(chunk);
      // Audio-side visualizers — fed the same int16 chunks as the decoders
      // above so SCOPE / VECT / ACON keep working when the input is a GEN
      // test sample rather than the live Kiwi stream.
      p.onScope?.(chunk);
      p.onVect?.(chunk);
      p.onIqAudio?.(chunk);
    };
    const CHUNK_MS = 100;
    const CHUNK_N  = (TEST_TARGET_SR * CHUNK_MS) / 1000;
    void (async () => {
      try {
        const out = await decodeAndResampleTo12k(url);
        if (cancelled) return;
        bufHandle = this.player.playTestBuffer(out, TEST_TARGET_SR, loop, () => {
          if (!loop && !cancelled) { this.stopTestSample(); onEnd(); }
        });
        if (!feed) return;
        let pos = 0;
        const tick = () => {
          if (cancelled) return;
          if (pos >= out.length) {
            if (loop) pos = 0;
            else { onEnd(); return; }
          }
          const end = Math.min(out.length, pos + CHUNK_N);
          fanout(out.subarray(pos, end));
          pos = end;
          timer = setTimeout(tick, CHUNK_MS) as unknown as number;
        };
        tick();
      } catch (err) {
        this.banner('Audio error: ' + (err as Error).message, 1800);
        if (!cancelled) { cancel(); onEnd(); }
      }
    })();
    // Fake-Audio shim so stopTestSample() can pause the speaker handle. The
    // real cancel happens via testFeed.stop() — which lives on the same
    // session, so we only need pause() not full HTMLAudioElement parity.
    this.testAudio = {
      pause: () => cancel(),
      currentTime: 0,
    } as unknown as HTMLAudioElement;
    return { stop: cancel };
  }

  /** Decode → resample → push through `player.injectTestSamples` so the
   *  whole app (SPEC, speakers, decoders, recorder, FT8, classifier) sees
   *  the test sample as its audio source. Used when MUTE is on. */
  private injectIntoPlayer(url: string, loop: boolean, onEnd: () => void): { stop: () => void } {
    let cancelled = false;
    let timer: number | null = null;
    let bufHandle: { stop: () => void } | null = null;
    const p = this.player;
    // Save + null all decoder hooks so Kiwi can't reach them while the
    // setTimeout fanout below is feeding test int16 chunks. (AUX gate
    // already drops Kiwi at pushAudio; this is belt-and-suspenders.)
    const saved = {
      onCw:        p.onCw,
      onRtty:      p.onRtty,
      onOlivia:    p.onOlivia,
      onPsk:       p.onPsk,
      onWefax:     p.onWefax,
      onNavtex:    p.onNavtex,
      onSitor:     p.onSitor,
      onMfsk:      p.onMfsk,
      onMt63:      p.onMt63,
      onFsq:       p.onFsq,
      onThor:      p.onThor,
      onDominoex:  p.onDominoex,
      onContestia: p.onContestia,
      onWwv:       p.onWwv,
      onAle:       p.onAle,
      onPacket:    p.onPacket,
      onWspr:      p.onWspr,
      onJs8:       p.onJs8,
      onFst4:      p.onFst4,
    };
    p.onCw = p.onRtty = p.onOlivia = p.onPsk = p.onWefax = p.onNavtex = null;
    p.onSitor = p.onMfsk = p.onMt63 = p.onFsq = p.onThor = null;
    p.onDominoex = p.onContestia = p.onWwv = p.onAle = null;
    p.onPacket = p.onWspr = p.onJs8 = p.onFst4 = null;

    const cancel = () => {
      cancelled = true;
      if (timer != null) { clearTimeout(timer); timer = null; }
      if (bufHandle) { bufHandle.stop(); bufHandle = null; }
      if (p.onCw        === null) p.onCw        = saved.onCw;
      if (p.onRtty      === null) p.onRtty      = saved.onRtty;
      if (p.onOlivia    === null) p.onOlivia    = saved.onOlivia;
      if (p.onPsk       === null) p.onPsk       = saved.onPsk;
      if (p.onWefax     === null) p.onWefax     = saved.onWefax;
      if (p.onNavtex    === null) p.onNavtex    = saved.onNavtex;
      if (p.onSitor     === null) p.onSitor     = saved.onSitor;
      if (p.onMfsk      === null) p.onMfsk      = saved.onMfsk;
      if (p.onMt63      === null) p.onMt63      = saved.onMt63;
      if (p.onFsq       === null) p.onFsq       = saved.onFsq;
      if (p.onThor      === null) p.onThor      = saved.onThor;
      if (p.onDominoex  === null) p.onDominoex  = saved.onDominoex;
      if (p.onContestia === null) p.onContestia = saved.onContestia;
      if (p.onWwv       === null) p.onWwv       = saved.onWwv;
      if (p.onAle       === null) p.onAle       = saved.onAle;
      if (p.onPacket    === null) p.onPacket    = saved.onPacket;
      if (p.onWspr      === null) p.onWspr      = saved.onWspr;
      if (p.onJs8       === null) p.onJs8       = saved.onJs8;
      if (p.onFst4      === null) p.onFst4      = saved.onFst4;
    };

    const fanout = (chunk: Int16Array) => {
      if (saved.onPsk)        saved.onPsk(chunk);
      if (saved.onCw)         saved.onCw(chunk);
      if (saved.onRtty)       saved.onRtty(chunk);
      if (saved.onOlivia)     saved.onOlivia(chunk);
      if (saved.onWefax)      saved.onWefax(chunk);
      if (saved.onNavtex)     saved.onNavtex(chunk);
      if (saved.onSitor)      saved.onSitor(chunk);
      if (saved.onMfsk)       saved.onMfsk(chunk);
      if (saved.onMt63)       saved.onMt63(chunk);
      if (saved.onFsq)        saved.onFsq(chunk);
      if (saved.onThor)       saved.onThor(chunk);
      if (saved.onDominoex)   saved.onDominoex(chunk);
      if (saved.onContestia)  saved.onContestia(chunk);
      if (saved.onWwv)        saved.onWwv(chunk);
      if (saved.onAle)        saved.onAle(chunk);
      if (saved.onPacket)     saved.onPacket(chunk);
      if (saved.onWspr)       saved.onWspr(chunk);
      if (saved.onJs8)        saved.onJs8(chunk);
      if (saved.onFst4)       saved.onFst4(chunk);
    };

    const CHUNK_MS = 100;
    const CHUNK_N  = (TEST_TARGET_SR * CHUNK_MS) / 1000;

    const run = async () => {
      try {
        const out = await decodeAndResampleTo12k(url);
        // Speaker + SPEC: AudioBufferSourceNode (sample-accurate, no JS
        // scheduling — eliminates the setTimeout-jitter glitches that
        // plagued the worklet-ring approach).
        bufHandle = this.player.playTestBuffer(out, TEST_TARGET_SR, loop);
        // Decoders: stream int16 chunks at real-time pacing. setTimeout
        // jitter here is harmless — the decoder process buffers stdin and
        // a few ms of timing skew don't affect demodulation.
        let pos = 0;
        const tick = () => {
          if (cancelled) return;
          if (pos >= out.length) {
            if (loop) { pos = 0; }
            else      { onEnd(); return; }
          }
          const end = Math.min(out.length, pos + CHUNK_N);
          fanout(out.subarray(pos, end));
          pos = end;
          timer = setTimeout(tick, CHUNK_MS) as unknown as number;
        };
        tick();
      } catch (err) {
        this.banner('Inject error: ' + (err as Error).message, 1800);
        if (!cancelled) onEnd();
      }
    };
    void run();
    return { stop: cancel };
  }

  private toggleAux() {
    this.aux = !this.aux;
    this.player.setBlockKiwi(this.aux);
    (this.$('btnMute') as HTMLElement).classList.toggle('active', this.aux);
    // If a TEST sample is currently active in the wrong mode (audio-element
    // vs player-injection), restart it under the new routing.
    if (this.testActiveUrl) {
      const url = this.testActiveUrl;
      const picker = document.querySelector('.modes-picker');
      this.stopTestSample();
      this.testActiveUrl = url;
      const tile = picker?.querySelector(`button.rtty-row[data-url="${url}"]`);
      tile?.classList.add('active');
      this.startTestSample(url, true, true, () => {
        tile?.classList.remove('active');
      });
    }
  }

  private stopTestSample() {
    if (this.testAudio) { try { this.testAudio.pause(); } catch {} this.testAudio = null; }
    if (this.testFeed)  { this.testFeed.stop(); this.testFeed = null; }
    this.testActiveUrl = null;
  }


  private togglePsk() {
    this.pskOn = !this.pskOn;
    this.updateWaterfallStream();
    const btn = this.$('btnPsk');
    const panel = this.$('pskPanel');
    btn.classList.toggle('active', this.pskOn);
    panel.style.display = this.pskOn ? '' : 'none';
    if (this.pskOn) {
      const sr = this.player.getInputRate() || 12000;
      this.pskDecoder = new PSKDecoder({
        sampleRate: sr,
        pitchHz: this.pskPitch,
        onStatus: (s) => { this.$('pskStatus').textContent = `PSK31 ${this.pskPitch}Hz ${s}`; },
        onChar: (ch) => {
          const el = this.$('pskText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onPsk = (s) => this.pskDecoder?.feed(s);
    } else {
      this.player.onPsk = null;
      this.pskDecoder?.close();
      this.pskDecoder = null;
    }
  }

  private openPskBandPicker() {
    this.registerScanSet('PSK31', PSK31_BANDS.map(b => ({ label: b.name, freqKHz: b.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${PSK31_BANDS.map((b) => `
          <button class="rtty-row ${b.freqKHz === this.freqKHz ? 'active' : ''}" data-freq="${b.freqKHz}">
            <div class="rtty-row-name">${b.name} — ${b.freqKHz.toFixed(3)} kHz</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = +t.dataset.freq!;
        this.freqKHz = f;
        this.client?.setFreqKHz(f);
        this.recenter();
        this.refresh();
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** Lissajous / vector audio scope. We have only one audio channel, so we
   *  fake the second axis by plotting (sample[n], sample[n+delay]). The
   *  delay is ~quarter period of typical audio frequencies (default 36
   *  samples ≈ 3 ms), giving roughly a 90° phase shift for 1 kHz tones —
   *  pure sinusoids draw circles, complex audio draws cloudy patterns. */
  /** IQ baseband waterfall — feeds on the raw Kiwi IQ payload, FFTs each
   *  256-sample window, scrolls the canvas down by one pixel per frame
   *  and draws the new magnitude row at the top. Frequency axis: −6 kHz
   *  (left) to +6 kHz (right) since complex sample rate is 12 kHz. */
  /** Eye diagram — overlay the I-baseband across a 2-symbol window for
   *  the most recent decisions. The "eye" opens when the chosen baud
   *  matches the signal's symbol rate; otherwise traces wash out into
   *  noise. Pure visual — no decoder is run; the user just sweeps the
   *  baud dropdown until a clear opening appears. */
  /** Page-5 dispatcher. Opens `name`'s panel and starts its dedicated
   *  feed + render loop; closes whichever was previously active.
   *  Re-tapping the same button closes it. */
  private toggleIq5(name: 'sfrc' | 'dopp' | 'zoom' | 'antc' | 'ppmc' | 'othr' | 'rfi' | 'wusb' | 'wlsb' | 'dlds' | 'kurt') {
    // Same-button tap → close.
    if (this.iq5Active === name) {
      this.closeIq5();
      return;
    }
    // ZOOM is part of the bottom-fnrow info-tool group, mutually exclusive
    // with EIBI / PSKR / NETS / WNET / GRAY. Activating it from anywhere
    // else must close those.
    if (name === 'zoom') this.closeAllInfoTools('btnZoom');
    // Different button → close current, then open new.
    if (this.iq5Active != null) this.closeIq5();
    this.iq5Active = name;
    if (this.mode !== 'iq') this.setMode('iq');
    this.exclusiveActivate('iqview');   // reuse 'iqview' slot — single IQ context
    const panel = this.$(name + 'Panel') as HTMLElement;
    const btn   = this.root.querySelector('#btn' + name.charAt(0).toUpperCase() + name.slice(1)) as HTMLElement | null;
    panel.style.display = '';
    btn?.classList.add('active');
    // Reset per-panel state.
    if (name === 'sfrc') {
      this.sfrcCounts = new Array(60).fill(0);
      this.sfrcLastImpulseTs = 0;
      this.sfrcRecentMag = 0;
    } else if (name === 'dopp') {
      this.doppPhase = 0;
      this.doppFreqHz = 0;
      this.doppHistory = [];
    } else if (name === 'zoom') {
      this.zoomRingI.fill(0);
      this.zoomRingQ.fill(0);
      this.zoomRingW = 0;
      this.zoomRingFill = 0;
    } else if (name === 'othr') {
      this.othrSpec.fill(-120);
      this.othrRidgeBin.fill(-1);
      this.othrRidgeSnr.fill(0);
      this.othrSpecW = 0;
      this.othrSpecFill = 0;
      this.othrInFill = 0;
    } else if (name === 'dlds') {
      this.dldsReset();
    } else if (name === 'kurt') {
      this.kurtReset();
    } else if (name === 'wusb' || name === 'wlsb') {
      this.weakInFill = 0;
      this.weakOverlap.fill(0);
      this.weakSpec.fill(0);
      // Seed P high so the gate doesn't slam shut on the first frame
      // before minimum-statistics has any data.
      this.weakP.fill(1);
      this.weakPMin.fill(1);
      this.weakAmpPrev.fill(0);
      this.weakXiSmooth.fill(1);
      this.weakResetCnt = 0;
      this.weakOutQueue = [];
      this.weakOutPos = 0;
      this.weakSide = name === 'wusb' ? 'usb' : 'lsb';
      this.openWeakAudio();
    }
    this.player.onIq5 = (iq) => this.feedIq5(iq);
    this.updateWaterfallStream();
    const tick = () => {
      if (!this.iq5Active) { this.iq5Raf = null; return; }
      this.renderIq5();
      this.iq5Raf = requestAnimationFrame(tick);
    };
    this.iq5Raf = requestAnimationFrame(tick);
  }

  private closeIq5() {
    if (this.iq5Active == null) return;
    const name = this.iq5Active;
    const panel = this.$(name + 'Panel') as HTMLElement;
    const btn   = this.root.querySelector('#btn' + name.charAt(0).toUpperCase() + name.slice(1)) as HTMLElement | null;
    panel.style.display = 'none';
    btn?.classList.remove('active');
    this.iq5Active = null;
    if (this.iq5Raf != null) { cancelAnimationFrame(this.iq5Raf); this.iq5Raf = null; }
    this.player.onIq5 = null;
    if (name === 'wusb' || name === 'wlsb') this.closeWeakAudio();
    this.updateWaterfallStream();
    if (this.mode === 'iq' && !this.hfdlOn && !this.isbOn && !this.ssbfOn && !this.iqViewOn && !this.iqEyeOn) {
      this.setMode(name === 'wlsb' ? 'lsb' : 'usb');
    }
  }

  /** Per-frame IQ feed dispatcher. */
  private feedIq5(iqBytes: Uint8Array) {
    switch (this.iq5Active) {
      case 'sfrc': this.feedSfrc(iqBytes); break;
      case 'dopp': this.feedDopp(iqBytes); break;
      case 'zoom': this.feedZoom(iqBytes); break;
      case 'antc': this.feedAntc(iqBytes); break;
      case 'ppmc': this.feedPpmc(iqBytes); break;
      case 'othr': this.feedOthr(iqBytes); break;
      case 'rfi':  this.feedRfi(iqBytes);  break;
      case 'wusb':
      case 'wlsb': this.feedWeak(iqBytes); break;
      case 'dlds': this.feedDlds(iqBytes); break;
      case 'kurt': this.feedKurt(iqBytes); break;
      default: break;
    }
  }

  /** Per-rAF render dispatcher. */
  private renderIq5() {
    switch (this.iq5Active) {
      case 'sfrc': this.renderSfrc(); break;
      case 'dopp': this.renderDopp(); break;
      case 'zoom': this.renderZoom(); break;
      case 'antc': this.renderAntc(); break;
      case 'ppmc': this.renderPpmc(); break;
      case 'othr': this.renderOthr(); break;
      case 'rfi':  this.renderRfi(); break;
      case 'wusb':
      case 'wlsb': this.renderWeak(); break;
      case 'dlds': this.renderDlds(); break;
      case 'kurt': this.renderKurt(); break;
    }
  }

  /** Sferic monitor — detect impulse-like phase / amplitude jumps in the
   *  IQ stream. Each frame, scan for samples whose magnitude is ≥ N×
   *  the slow-decay running average; count them as strikes/sec. */
  private feedSfrc(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    let mean = this.sfrcRecentMag;
    let strikesThisFrame = 0;
    const now = Date.now();
    for (let i = 0; i < nPairs; i++) {
      const I = dv.getInt16(i * 4, false);
      const Q = dv.getInt16(i * 4 + 2, false);
      const m = Math.sqrt(I * I + Q * Q);
      mean = mean * 0.998 + m * 0.002;
      // Impulse: ≥ 6× background AND at least 200 ms since last (debounce).
      if (mean > 1 && m > mean * 6 && now - this.sfrcLastImpulseTs > 200) {
        strikesThisFrame++;
        this.sfrcLastImpulseTs = now;
      }
    }
    this.sfrcRecentMag = mean;
    if (strikesThisFrame > 0) {
      // Slot into the current second of the rolling 60-bin counter.
      const sec = (Math.floor(now / 1000)) % 60;
      this.sfrcCounts[sec] = (this.sfrcCounts[sec] || 0) + strikesThisFrame;
    }
  }

  private renderSfrc() {
    const cv = this.$('sfrcCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // Bar chart: 60 seconds, scaled to max bin.
    const max = Math.max(1, ...this.sfrcCounts);
    const bw  = W / 60;
    for (let i = 0; i < 60; i++) {
      const c = this.sfrcCounts[i] || 0;
      const h = (c / max) * (H - 30 * dpr);
      const x = i * bw;
      ctx.fillStyle = c > max * 0.6 ? '#f04e3a' : c > 0 ? '#cfffa3' : '#222';
      ctx.fillRect(x, H - h - 14 * dpr, bw - 1, h);
    }
    // HUD line.
    const total = this.sfrcCounts.reduce((s, v) => s + v, 0);
    const txt = `${total} strikes / 60 s · peak ${max} / sec · noise floor ${this.sfrcRecentMag.toFixed(1)}`;
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.fillStyle = '#cfffa3';
    ctx.textBaseline = 'bottom';
    ctx.fillText(txt, 6 * dpr, H - 2 * dpr);
    this.$('sfrcStatus').textContent = `SFRC — ${total} strikes / 60 s (peak ${max}/s)`;
  }

  /** Doppler-vs-time PLL — track strongest narrow tone and plot its
   *  frequency offset on a 30-min rolling strip. Single-pole NCO + LMS-
   *  style frequency update. */
  private feedDopp(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    if (nPairs === 0) return;
    const fs = 12000;
    let phase = this.doppPhase;
    let f = this.doppFreqHz;
    const dt = 2 * Math.PI / fs;
    let sumI = 0, sumQ = 0;
    for (let i = 0; i < nPairs; i++) {
      const I = dv.getInt16(i * 4, false) / 32768;
      const Q = dv.getInt16(i * 4 + 2, false) / 32768;
      // Mix down by current freq estimate.
      phase += f * dt;
      if (phase > Math.PI)  phase -= 2 * Math.PI;
      if (phase < -Math.PI) phase += 2 * Math.PI;
      const c = Math.cos(-phase), s = Math.sin(-phase);
      const dI = I * c - Q * s;
      const dQ = I * s + Q * c;
      sumI += dI; sumQ += dQ;
    }
    // Phase of the integrated mixed-down vector → frequency error.
    const angle = Math.atan2(sumQ, sumI);
    const errHz = (angle / (2 * Math.PI)) * (fs / nPairs);
    f += errHz * this.doppAlpha;
    this.doppPhase = phase;
    this.doppFreqHz = f;
    this.doppHistory.push({ t: Date.now(), hz: f });
    // Keep last 30 min.
    const cutoff = Date.now() - 30 * 60_000;
    while (this.doppHistory.length && this.doppHistory[0].t < cutoff) this.doppHistory.shift();
  }

  private renderDopp() {
    const cv = this.$('doppCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const hist = this.doppHistory;
    if (hist.length < 2) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText('locking onto carrier…', 6 * dpr, 16 * dpr);
      return;
    }
    // Auto-scale Y to ±max(|hz|).
    const maxAbs = Math.max(1, ...hist.map(p => Math.abs(p.hz)));
    const t0 = hist[0].t, t1 = hist[hist.length - 1].t;
    const span = Math.max(1000, t1 - t0);
    // Centerline.
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();
    // Trace.
    ctx.strokeStyle = '#cfffa3';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const p = hist[i];
      const x = ((p.t - t0) / span) * W;
      const y = H / 2 - (p.hz / maxAbs) * (H / 2 - 20 * dpr);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();
    // HUD.
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.fillStyle = '#cfffa3';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `Δf ${this.doppFreqHz.toFixed(2)} Hz · scale ±${maxAbs.toFixed(1)} Hz · ${hist.length} samples`,
      6 * dpr, 4 * dpr,
    );
    this.$('doppStatus').textContent = `DOPP — Δf ${this.doppFreqHz.toFixed(2)} Hz`;
  }

  /** ZOOM — long-FFT (32k samples ≈ 2.7 s window) of the IQ stream gives
   *  ~0.4 Hz/bin around the dial. Renders a one-shot magnitude row each
   *  frame (no scrolling — refreshes every rAF tick to show drift). */
  private feedZoom(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    const I = this.zoomRingI, Q = this.zoomRingQ;
    const N = I.length;
    let w = this.zoomRingW;
    for (let i = 0; i < nPairs; i++) {
      I[w] = dv.getInt16(i * 4, false)     / 32768;
      Q[w] = dv.getInt16(i * 4 + 2, false) / 32768;
      w = (w + 1) & (N - 1);
    }
    this.zoomRingW = w;
    this.zoomRingFill = Math.min(N, this.zoomRingFill + nPairs);
  }

  private renderZoom() {
    const cv = this.$('zoomCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const F = this.zoomRingI.length;
    if (this.zoomRingFill < F) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText(`filling ring (${this.zoomRingFill}/${F})…`, 6 * dpr, 16 * dpr);
      return;
    }
    // Take most-recent F samples.
    const re = new Float32Array(F);
    const im = new Float32Array(F);
    const w = this.zoomRingW;
    for (let k = 0; k < F; k++) {
      const idx = (w + k) & (F - 1);
      // Hann-windowed.
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (F - 1)));
      re[k] = this.zoomRingI[idx] * h;
      im[k] = this.zoomRingQ[idx] * h;
    }
    fft32k(re, im);
    // Show only ±100 Hz around DC: 100 Hz / (12000/F) = 100*F/12000 bins each side.
    const halfWin = Math.min(F / 2 - 1, Math.round((100 * F) / 12000));
    const total = halfWin * 2 + 1;
    // Fixed dB scale — no autoscale. With a 64k-pt Hann-windowed FFT of
    // int16/32768 IQ samples, per-bin magnitudes typically run from
    // about -40 dB (Kiwi noise floor) up to +80 dB (strong carrier).
    // 90 dB top, -30 dB bottom keeps the noise floor near the bottom
    // edge and strong signals near the top in nearly every realistic
    // situation.
    const dbHi = 90;
    const dbLo = -30;
    const range = dbHi - dbLo;
    const mag = new Float32Array(total);
    let mx = -Infinity;
    for (let i = 0; i < total; i++) {
      const k = (i - halfWin + F) & (F - 1);
      const v = Math.sqrt(re[k] * re[k] + im[k] * im[k]) + 1e-9;
      const dB = 20 * Math.log10(v);
      mag[i] = dB;
      if (dB > mx) mx = dB;
    }
    // Carrier marker — in IQ mode the tuned frequency sits at DC (bin
    // halfWin in the centered window), i.e. exactly the middle of the
    // ±100 Hz strip we're plotting. Draw it first so the spectrum line
    // overlays it cleanly.
    const carrierX = (halfWin / (total - 1)) * W;
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.7)';
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(carrierX, 0);
    ctx.lineTo(carrierX, H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#cfffa3';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    for (let i = 0; i < total; i++) {
      const x = (i / (total - 1)) * W;
      const clamped = Math.min(dbHi, Math.max(dbLo, mag[i]));
      const y = H - ((clamped - dbLo) / range) * (H - 4 * dpr);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.fillStyle = '#cfffa3';
    ctx.fillText(`±100 Hz · ${(12000 / F).toFixed(2)} Hz/bin · scale ${dbHi}..${dbLo} dB · peak ${mx.toFixed(0)} dB`,
      6 * dpr, 12 * dpr);
    this.$('zoomStatus').textContent = `ZOOM — sub-Hz spectrogram (${(12000 / F).toFixed(2)} Hz/bin)`;
  }

  /** ANTC anti-carrier — locate strongest narrow tone in a 4k FFT
   *  window, plot magnitude before / after subtraction. The actual
   *  speaker-side null isn't injected through the audio graph here
   *  (would require a dedicated AudioBufferSource); the panel shows the
   *  *spectral* effect of the subtraction so the user can see the het
   *  collapse, even if their ears don't hear the change yet. */
  private feedAntc(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    const I = this.antcRingI, Q = this.antcRingQ;
    const N = I.length;
    let w = this.antcRingW;
    for (let i = 0; i < nPairs; i++) {
      I[w] = dv.getInt16(i * 4, false)     / 32768;
      Q[w] = dv.getInt16(i * 4 + 2, false) / 32768;
      w = (w + 1) & (N - 1);
    }
    this.antcRingW = w;
    this.antcRingFill = Math.min(N, this.antcRingFill + nPairs);
  }

  private renderAntc() {
    const cv = this.$('antcCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const F = this.antcRingI.length;
    if (this.antcRingFill < F) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText(`filling ring (${this.antcRingFill}/${F})…`, 6 * dpr, 16 * dpr);
      return;
    }
    // Snapshot the most-recent F samples (Hann-windowed).
    const re = new Float32Array(F);
    const im = new Float32Array(F);
    const w = this.antcRingW;
    for (let k = 0; k < F; k++) {
      const idx = (w + k) & (F - 1);
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (F - 1)));
      re[k] = this.antcRingI[idx] * h;
      im[k] = this.antcRingQ[idx] * h;
    }
    fft32k(re, im);
    // Find peak across the centred ±fs/2 window.
    const fs = 12000;
    let peakBin = 0, peakMag = 0;
    for (let k = 0; k < F; k++) {
      const m = re[k] * re[k] + im[k] * im[k];
      if (m > peakMag) { peakMag = m; peakBin = k; }
    }
    // Map FFT bin to signed Hz offset (DC at bin 0, +fs/2 at F/2, then negative).
    const hzPerBin = fs / F;
    const carrierHz = peakBin <= F / 2 ? peakBin * hzPerBin : (peakBin - F) * hzPerBin;
    this.antcCarrierHz = carrierHz;
    this.antcMagDb = 10 * Math.log10(peakMag + 1e-12);
    // Visual: spectrum BEFORE subtraction in dim, AFTER in bright.
    // "After" is computed by zeroing the peak bin (and ±1 neighbour).
    const reB = re.slice(), imB = im.slice();
    re[peakBin] = im[peakBin] = 0;
    if (peakBin > 0) { re[peakBin - 1] *= 0.1; im[peakBin - 1] *= 0.1; }
    if (peakBin < F - 1) { re[peakBin + 1] *= 0.1; im[peakBin + 1] *= 0.1; }
    // Plot magnitudes (centred FFT shift) for both, ±2 kHz around DC.
    const winHz = 2000;
    const halfBins = Math.round(winHz / hzPerBin);
    const total = halfBins * 2 + 1;
    const drawTrace = (rr: Float32Array, ii: Float32Array, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let mn = 0, mx = -200;
      const dB = new Float32Array(total);
      for (let i = 0; i < total; i++) {
        const k = (i - halfBins + F) & (F - 1);
        dB[i] = 10 * Math.log10((rr[k] * rr[k] + ii[k] * ii[k]) + 1e-12);
        if (dB[i] > mx) mx = dB[i];
        if (dB[i] < mn) mn = dB[i];
      }
      const range = Math.max(1, mx - mn);
      for (let i = 0; i < total; i++) {
        const x = (i / (total - 1)) * W;
        const y = H - ((dB[i] - mn) / range) * (H - 4 * dpr);
        if (i === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawTrace(reB, imB, 'rgba(240, 78, 58, 0.45)', 1 * dpr);   // before — red, dim
    drawTrace(re,  im,  '#cfffa3',                  1.2 * dpr); // after — green, bright
    // HUD.
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.fillStyle = '#cfffa3';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `Locked carrier ${carrierHz.toFixed(1)} Hz · peak ${this.antcMagDb.toFixed(1)} dB · ` +
      `red = before, green = after subtraction`,
      6 * dpr, 4 * dpr,
    );
    this.$('antcStatus').textContent =
      `ANTC — carrier ${carrierHz.toFixed(1)} Hz · ${this.antcMagDb.toFixed(0)} dB`;
  }

  /** PPMC — long-term carrier-as-clock self-calibration. Same Costas/
   *  averaging loop as DOPP but with a much smaller alpha so noise is
   *  averaged away and only the slow oscillator drift survives. The
   *  user is expected to tune to a known stable carrier (WWV 10 MHz,
   *  CHU 7850 kHz, BPM 5 MHz, etc.); the panel converts the locked
   *  Δf into ppm against `freqKHz` and plots the last 60 min. */
  private feedPpmc(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    if (nPairs === 0) return;
    const fs = 12000;
    let phase = this.ppmcPhase;
    let f = this.ppmcFreqHz;
    const dt = 2 * Math.PI / fs;
    let sumI = 0, sumQ = 0;
    for (let i = 0; i < nPairs; i++) {
      const I = dv.getInt16(i * 4, false) / 32768;
      const Q = dv.getInt16(i * 4 + 2, false) / 32768;
      phase += f * dt;
      if (phase > Math.PI)  phase -= 2 * Math.PI;
      if (phase < -Math.PI) phase += 2 * Math.PI;
      const c = Math.cos(-phase), s = Math.sin(-phase);
      sumI += I * c - Q * s;
      sumQ += I * s + Q * c;
    }
    const angle = Math.atan2(sumQ, sumI);
    const errHz = (angle / (2 * Math.PI)) * (fs / nPairs);
    f += errHz * this.ppmcAlpha;
    this.ppmcPhase = phase;
    this.ppmcFreqHz = f;
    const ppm = (this.freqKHz > 0) ? (f / (this.freqKHz * 1000)) * 1e6 : 0;
    this.ppmcHistory.push({ t: Date.now(), ppm });
    const cutoff = Date.now() - 60 * 60_000;
    while (this.ppmcHistory.length && this.ppmcHistory[0].t < cutoff) this.ppmcHistory.shift();
  }

  private renderPpmc() {
    const cv = this.$('ppmcCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const hist = this.ppmcHistory;
    if (hist.length < 2) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText('locking onto carrier (slow loop, allow ~30 s)…', 6 * dpr, 16 * dpr);
      return;
    }
    const maxAbs = Math.max(0.01, ...hist.map(p => Math.abs(p.ppm)));
    const t0 = hist[0].t, t1 = hist[hist.length - 1].t;
    const span = Math.max(1000, t1 - t0);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.strokeStyle = '#cfffa3';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const p = hist[i];
      const x = ((p.t - t0) / span) * W;
      const y = H / 2 - (p.ppm / maxAbs) * (H / 2 - 20 * dpr);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();
    const ppm = hist[hist.length - 1].ppm;
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.fillStyle = '#cfffa3';
    ctx.textBaseline = 'top';
    ctx.fillText(
      `PPM ${ppm.toFixed(3)} · scale ±${maxAbs.toFixed(3)} ppm · ` +
      `dial ${this.freqKHz.toFixed(3)} kHz · ${hist.length} samples`,
      6 * dpr, 4 * dpr,
    );
    this.$('ppmcStatus').textContent = `PPMC — ${ppm.toFixed(3)} ppm at ${this.freqKHz.toFixed(3)} kHz`;
  }

  /** OTHR — accumulate IQ into N=128-sample frames, FFT each frame
   *  (Hann-windowed), keep the magnitude spectrum and the brightest-bin
   *  ridge in rolling buffers for renderOthr to interpret. */
  private feedOthr(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    const N = this.othrFftN;
    const FRAMES = this.othrSpecFrames;
    const inI = this.othrInI, inQ = this.othrInQ;
    let f = this.othrInFill;
    for (let i = 0; i < nPairs; i++) {
      inI[f] = dv.getInt16(i * 4, false)     / 32768;
      inQ[f] = dv.getInt16(i * 4 + 2, false) / 32768;
      f++;
      if (f >= N) {
        // Hann-window into FFT scratch buffers.
        const re = new Float32Array(N), im = new Float32Array(N);
        for (let k = 0; k < N; k++) {
          const h = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (N - 1)));
          re[k] = inI[k] * h;
          im[k] = inQ[k] * h;
        }
        fft32k(re, im);
        // Store magnitudes (dB) in spec[w * N + bin]. Bin 0 = DC; bins 0..N/2-1
        // are positive freqs, N/2..N-1 are negative freqs (after fftshift).
        const w = this.othrSpecW;
        const off = w * N;
        for (let k = 0; k < N; k++) {
          // fftshift: map bin k → display bin (k + N/2) % N so DC sits centred.
          const sk = (k + N / 2) % N;
          const v = Math.sqrt(re[k] * re[k] + im[k] * im[k]) + 1e-9;
          this.othrSpec[off + sk] = 20 * Math.log10(v);
        }
        // Find ridge: brightest bin (excluding ±1 of DC to avoid LO leak).
        const dcBin = N / 2;
        let peakBin = -1, peakVal = -Infinity;
        for (let k = 0; k < N; k++) {
          if (Math.abs(k - dcBin) <= 1) continue;
          const v = this.othrSpec[off + k];
          if (v > peakVal) { peakVal = v; peakBin = k; }
        }
        // Median noise floor (rough): use the 50th-percentile of bins.
        // Cheap O(N) approximation: average of all bins minus 3 dB.
        let s = 0;
        for (let k = 0; k < N; k++) s += this.othrSpec[off + k];
        const noiseDb = (s / N);
        const snr = peakVal - noiseDb;
        this.othrRidgeBin[w] = snr >= 6 ? peakBin : -1;
        this.othrRidgeSnr[w] = snr;
        this.othrSpecW = (w + 1) % FRAMES;
        if (this.othrSpecFill < FRAMES) this.othrSpecFill++;
        f = 0;
      }
    }
    this.othrInFill = f;
  }

  private renderOthr() {
    const cv = this.$('othrCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const N = this.othrFftN;
    const FRAMES = this.othrSpecFrames;
    const fill = this.othrSpecFill;
    if (fill < 32) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText(`collecting spectrogram (${fill}/${FRAMES})…`, 6 * dpr, 16 * dpr);
      return;
    }
    // Linearize ring into time-ordered indices (oldest first).
    const w0 = (this.othrSpecW - fill + FRAMES) % FRAMES;
    const idx = new Int32Array(fill);
    for (let i = 0; i < fill; i++) idx[i] = (w0 + i) % FRAMES;
    // Auto-range: use 5th and 99th percentile of all magnitudes.
    const flat = new Float32Array(fill * N);
    for (let i = 0; i < fill; i++) {
      const off = idx[i] * N;
      for (let k = 0; k < N; k++) flat[i * N + k] = this.othrSpec[off + k];
    }
    const sorted = flat.slice().sort();
    const lo = sorted[Math.floor(sorted.length * 0.05)];
    const hi = sorted[Math.floor(sorted.length * 0.99)];
    const range = Math.max(1, hi - lo);
    // Render waterfall: x = time (left=oldest), y = frequency (top=high pos freq).
    const img = ctx.createImageData(W, H);
    for (let x = 0; x < W; x++) {
      const i = Math.min(fill - 1, Math.floor((x / W) * fill));
      const off = idx[i] * N;
      for (let y = 0; y < H; y++) {
        // y=0 → bin N-1 (highest), y=H → bin 0 (lowest)
        const k = N - 1 - Math.min(N - 1, Math.floor((y / H) * N));
        const v = (this.othrSpec[off + k] - lo) / range;
        const t = Math.max(0, Math.min(1, v));
        // Amber-on-black colormap.
        const r = Math.round(255 * t);
        const g = Math.round(180 * t * t);
        const b = Math.round(40 * t * t * t);
        const p = (y * W + x) * 4;
        img.data[p]     = r;
        img.data[p + 1] = g;
        img.data[p + 2] = b;
        img.data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // Overlay ridge points.
    ctx.fillStyle = '#22e0ff';
    let validRidge = 0;
    for (let i = 0; i < fill; i++) {
      const b = this.othrRidgeBin[idx[i]];
      if (b < 0) continue;
      validRidge++;
      const x = (i / fill) * W;
      const y = H - 1 - Math.floor((b / N) * H);
      ctx.fillRect(x, y, Math.max(1, dpr), Math.max(1, dpr));
    }
    const fillRatio = validRidge / fill;
    // Compute slope (Hz/s) by linear fit on the most recent contiguous
    // valid run (≥ 8 points). Bins → Hz: each bin = 12000/N Hz, with
    // bin N/2 = DC (after fftshift), so freqHz = (bin - N/2) * binHz.
    const binHz = 12000 / N;
    const ridgeHz = new Float32Array(fill);
    const ridgeT  = new Float32Array(fill); // seconds
    let runEnd = fill - 1;
    while (runEnd >= 0 && this.othrRidgeBin[idx[runEnd]] < 0) runEnd--;
    let runStart = runEnd;
    while (runStart > 0 && this.othrRidgeBin[idx[runStart - 1]] >= 0) runStart--;
    let slopeHzPerS = 0;
    if (runEnd - runStart >= 8) {
      const n = runEnd - runStart + 1;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) {
        const t = i / this.othrFrameRate;
        const hz = (this.othrRidgeBin[idx[runStart + i]] - N / 2) * binHz;
        ridgeT[i] = t; ridgeHz[i] = hz;
        sx += t; sy += hz; sxx += t * t; sxy += t * hz;
      }
      const denom = n * sxx - sx * sx;
      if (Math.abs(denom) > 1e-9) slopeHzPerS = (n * sxy - sx * sy) / denom;
    }
    // Estimate sweep-repetition frequency (SRF): count "wraps" (large
    // jumps in ridge bin) over the full window.
    let wraps = 0;
    let lastBin = -1;
    for (let i = 0; i < fill; i++) {
      const b = this.othrRidgeBin[idx[i]];
      if (b < 0) { lastBin = -1; continue; }
      if (lastBin >= 0 && Math.abs(b - lastBin) > N / 4) wraps++;
      lastBin = b;
    }
    const windowSec = fill / this.othrFrameRate;
    const srfHz = wraps / windowSec;
    // Classify.
    let klass = 'no signal';
    if (fillRatio >= 0.6) {
      // FMCW: continuous ridge most of the time.
      const slopeAbs = Math.abs(slopeHzPerS) / 1000;  // kHz/s
      if (slopeAbs > 50 && srfHz >= 30 && srfHz <= 80) {
        klass = 'FMCW · Container-class (~50 Hz SRF)';
      } else if (slopeAbs > 50 && srfHz >= 5 && srfHz < 30) {
        klass = 'FMCW · slow-sweep (JORN/Nostradamus-class)';
      } else if (slopeAbs > 200) {
        klass = `FMCW · unidentified sweep`;
      } else {
        klass = 'FMCW · slow / steady carrier';
      }
    } else if (fillRatio >= 0.1) {
      // Pulsed: intermittent ridge.
      if (srfHz >= 40 && srfHz <= 80) {
        klass = `pulsed · ROTHR-class (~${srfHz.toFixed(0)} pps)`;
      } else if (srfHz >= 10 && srfHz < 40) {
        klass = `pulsed · ${srfHz.toFixed(0)} pps`;
      } else {
        klass = `pulsed · sparse (${srfHz.toFixed(1)} pps)`;
      }
    }
    // Status line + on-canvas legend.
    const status = `${klass} · slope ${(slopeHzPerS/1000).toFixed(1)} kHz/s · SRF ${srfHz.toFixed(1)} Hz · ridge ${(fillRatio*100).toFixed(0)}%`;
    this.$('othrStatus').textContent = `OTHR — ${status}`;
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, 18 * dpr);
    ctx.fillStyle = '#cfffa3';
    ctx.textBaseline = 'top';
    ctx.fillText(status, 6 * dpr, 4 * dpr);
  }

  /** RFI sniffer — scan a 4k-sample IQ window every ~1 s, find narrow
   *  peaks (single-bin spikes ≥ 14 dB above neighbour median, like the
   *  auto-notch detector). Each detection is added/refreshed in the
   *  catalogue. Tap a row in the rendered list to label / delete it. */
  private feedRfi(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    const I = this.rfiRingI, Q = this.rfiRingQ;
    const N = I.length;
    let w = this.rfiRingW;
    for (let i = 0; i < nPairs; i++) {
      I[w] = dv.getInt16(i * 4, false)     / 32768;
      Q[w] = dv.getInt16(i * 4 + 2, false) / 32768;
      w = (w + 1) & (N - 1);
    }
    this.rfiRingW = w;
    this.rfiRingFill = Math.min(N, this.rfiRingFill + nPairs);
    // Throttle scans to once per second.
    const now = Date.now();
    if (now - this.rfiLastScan < 1000) return;
    if (this.rfiRingFill < N) return;
    this.rfiLastScan = now;
    this.rfiScan();
  }

  private rfiScan() {
    const F = this.rfiRingI.length;
    const re = new Float32Array(F);
    const im = new Float32Array(F);
    const w = this.rfiRingW;
    for (let k = 0; k < F; k++) {
      const idx = (w + k) & (F - 1);
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (F - 1)));
      re[k] = this.rfiRingI[idx] * h;
      im[k] = this.rfiRingQ[idx] * h;
    }
    fft32k(re, im);
    const fs = 12000;
    const hzPerBin = fs / F;
    // Magnitude in dB.
    const dB = new Float32Array(F);
    for (let i = 0; i < F; i++) dB[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-12);
    // Find narrow peaks in [3..F-3]; threshold = 14 dB above local
    // median over ±10-bin window.
    const R = 10;
    const tmp = new Float32Array(2 * R);
    const peaks: Array<{ hz: number; db: number }> = [];
    for (let i = R; i < F - R; i++) {
      const v = dB[i];
      if (v <= dB[i - 1] || v <= dB[i + 1]) continue;
      let n = 0;
      for (let j = i - R; j <= i + R; j++) {
        if (Math.abs(j - i) <= 1) continue;
        tmp[n++] = dB[j];
      }
      const sorted = tmp.subarray(0, n).slice().sort();
      const med = sorted[n >> 1];
      if (v - med < 14) continue;
      // Map FFT bin to signed Hz.
      const hz = i <= F / 2 ? i * hzPerBin : (i - F) * hzPerBin;
      peaks.push({ hz, db: v });
    }
    // Keep top 12 by magnitude.
    peaks.sort((a, b) => b.db - a.db);
    peaks.length = Math.min(12, peaks.length);
    // Update catalogue: match within ±5 Hz of an existing entry; else add.
    const now = Date.now();
    for (const p of peaks) {
      const existing = this.rfiCatalogue.find(c => Math.abs(c.hz - p.hz) < 5);
      if (existing) {
        existing.db = p.db;
        existing.seen = now;
      } else {
        this.rfiCatalogue.push({ hz: p.hz, db: p.db, seen: now });
      }
    }
    // Drop entries not seen in 60 s.
    this.rfiCatalogue = this.rfiCatalogue.filter(c => now - c.seen < 60_000);
    // Cap to 30 entries by age.
    this.rfiCatalogue.sort((a, b) => b.seen - a.seen);
    this.rfiCatalogue.length = Math.min(30, this.rfiCatalogue.length);
  }

  private renderRfi() {
    const cv = this.$('rfiCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (this.rfiCatalogue.length === 0) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText('scanning for narrow carriers (1 Hz scan / s)…', 6 * dpr, 16 * dpr);
      return;
    }
    // Sort by frequency offset for display.
    const sorted = this.rfiCatalogue.slice().sort((a, b) => a.hz - b.hz);
    const rowH = 14 * dpr;
    ctx.font = `${11 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    const now = Date.now();
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      const y = 4 * dpr + i * rowH;
      if (y > H - rowH) break;
      const ageSec = Math.round((now - c.seen) / 1000);
      const fade = Math.max(0.3, 1 - ageSec / 60);
      ctx.fillStyle = `rgba(207,255,163,${fade.toFixed(2)})`;
      const sign = c.hz >= 0 ? '+' : '';
      const absKHz = this.freqKHz + c.hz / 1000;
      const txt = `${sign}${c.hz.toFixed(0).padStart(5)} Hz · ${absKHz.toFixed(3)} kHz · ` +
                  `${c.db.toFixed(0).padStart(4)} dB · seen ${ageSec}s ago`;
      ctx.fillText(txt, 6 * dpr, y);
    }
    this.$('rfiStatus').textContent = `RFI — ${this.rfiCatalogue.length} narrow emitters tracked`;
  }

  private dldsReset() {
    this.dldsRingI.fill(0);
    this.dldsRingQ.fill(0);
    this.dldsRingW = 0;
    this.dldsRingFill = 0;
    this.dldsDecimPhase = 0;
    this.dldsDecimAccI = 0;
    this.dldsDecimAccQ = 0;
    this.dldsMap.fill(-120);
    this.dldsMaxDb = 0;
    this.dldsLastRender = 0;
  }

  /** Decimate 12 kHz IQ to 1 kHz with a simple 12-tap boxcar (cheap and
   *  good enough — the decimation filter only needs to suppress aliasing
   *  outside ±500 Hz, and we only display ±32 Hz of Doppler anyway). */
  private feedDlds(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    const D = this.dldsDecim;
    const W = this.dldsW;
    for (let i = 0; i < nPairs; i++) {
      this.dldsDecimAccI += dv.getInt16(i * 4,     false) / 32768;
      this.dldsDecimAccQ += dv.getInt16(i * 4 + 2, false) / 32768;
      this.dldsDecimPhase++;
      if (this.dldsDecimPhase >= D) {
        const I = this.dldsDecimAccI / D;
        const Q = this.dldsDecimAccQ / D;
        this.dldsDecimAccI = 0;
        this.dldsDecimAccQ = 0;
        this.dldsDecimPhase = 0;
        this.dldsRingI[this.dldsRingW] = I;
        this.dldsRingQ[this.dldsRingW] = Q;
        this.dldsRingW = (this.dldsRingW + 1) % W;
        if (this.dldsRingFill < W) this.dldsRingFill++;
      }
    }
  }

  private renderDlds() {
    const cv = this.$('dldsCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (this.dldsRingFill < this.dldsFftN + this.dldsLags + 8) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText(
        `DLDS — accumulating IQ (${this.dldsRingFill}/${this.dldsFftN + this.dldsLags})…`,
        6 * dpr, 16 * dpr);
      return;
    }

    // Recompute the scattering function ~3 fps (heavy work).
    const now = performance.now();
    if (now - this.dldsLastRender > 320) {
      this.dldsLastRender = now;
      this.computeDlds();
    }

    const lags = this.dldsLags;
    const dopBins = this.dldsDopHalf * 2 + 1;

    // Shared dB scale: floor at maxDb − 40, ceiling at maxDb.
    const maxDb = this.dldsMaxDb;
    const minDb = maxDb - 40;
    const range = Math.max(1, maxDb - minDb);

    // Render as W x H heatmap. X = doppler, Y = delay (top → 0 ms).
    const cellW = W / dopBins;
    const cellH = (H - 28 * dpr) / lags;
    for (let r = 0; r < lags; r++) {
      for (let c = 0; c < dopBins; c++) {
        const v = this.dldsMap[r * dopBins + c];
        let t = (v - minDb) / range;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        // Magma-ish: black → red → yellow → white.
        const R = Math.min(255, (t * 510) | 0);
        const G = Math.max(0, ((t - 0.4) * 425) | 0);
        const B = Math.max(0, ((t - 0.7) * 850) | 0);
        ctx.fillStyle = `rgb(${R},${G},${B})`;
        ctx.fillRect((c * cellW) | 0, (r * cellH) | 0,
                     Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
      }
    }

    // Axes.
    ctx.fillStyle = '#cfffa3';
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(`−${this.dldsDopHalf} Hz`, 4 * dpr, H - 4 * dpr);
    ctx.fillText(`+${this.dldsDopHalf} Hz`, W - 60 * dpr, H - 4 * dpr);
    ctx.textAlign = 'center';
    ctx.fillText('Doppler →', W / 2, H - 4 * dpr);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`0 ms`, 4 * dpr, 4 * dpr);
    ctx.fillText(`${lags} ms delay`, 4 * dpr, (lags - 1) * cellH);
    this.$('dldsStatus').textContent =
      `DLDS — ${lags} ms × ±${this.dldsDopHalf} Hz · max ${maxDb.toFixed(0)} dB · 1 kHz IQ`;
  }

  /** Compute |A(τ, ν)|² for τ = 0..lags and ν in the visible Doppler
   *  window. For each lag we form g[n] = s[n] · conj(s[n+τ]) over the
   *  most recent dldsFftN samples, FFT it, and copy the centred ±halfDop
   *  bins into the output map. */
  private computeDlds() {
    const N = this.dldsFftN;
    const lags = this.dldsLags;
    const halfDop = this.dldsDopHalf;
    const dopBins = halfDop * 2 + 1;
    const W = this.dldsW;
    const fill = this.dldsRingFill;
    if (fill < N + lags + 1) return;

    // Reverse-walk index helper: pull the most recent N+lags samples
    // ending at the current write pointer.
    const w = this.dldsRingW;
    const need = N + lags;
    const start = (w - need + W) % W;

    // Pre-compute the sample window once for fast access.
    const winI = new Float32Array(need);
    const winQ = new Float32Array(need);
    for (let i = 0; i < need; i++) {
      const idx = (start + i) % W;
      winI[i] = this.dldsRingI[idx];
      winQ[i] = this.dldsRingQ[idx];
    }

    // Hann window the lag-product before FFT to suppress sidelobes.
    const hann = new Float32Array(N);
    for (let n = 0; n < N; n++) hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));

    let runMax = -Infinity;

    for (let tau = 0; tau < lags; tau++) {
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      // g[n] = s[n] * conj(s[n+tau])
      for (let n = 0; n < N; n++) {
        const aR = winI[n];
        const aI = winQ[n];
        const bR = winI[n + tau];
        const bI = winQ[n + tau];
        // a * conj(b) = (aR*bR + aI*bI) + j(aI*bR − aR*bI)
        const gR = aR * bR + aI * bI;
        const gI = aI * bR - aR * bI;
        const w = hann[n];
        re[n] = gR * w;
        im[n] = gI * w;
      }
      // In-place radix-2 FFT (N is a power of two).
      this.fftInPlace(re, im);
      // Centre DC: bins 0..N-1 with FFT shift to put 0 Hz in middle.
      // dldsRate / N Hz per bin. We sample the central ±halfDop bins.
      const binsPerHz = N / this.dldsRate;
      for (let c = 0; c < dopBins; c++) {
        const v = c - halfDop;        // Doppler in Hz
        let k = Math.round(v * binsPerHz);
        if (k < 0) k += N;
        const re_ = re[k];
        const im_ = im[k];
        const p = re_ * re_ + im_ * im_;
        const dB = 10 * Math.log10(p + 1e-20);
        this.dldsMap[tau * dopBins + c] = dB;
        if (dB > runMax) runMax = dB;
      }
    }
    this.dldsMaxDb = runMax;
  }

  private kurtReset() {
    this.kurtAccN = 0;
    this.kurtAccM = 0;
    this.kurtAccM2 = 0;
    this.kurtAccM3 = 0;
    this.kurtAccM4 = 0;
    this.kurtHistory = [];
  }

  /** Stream-accumulate moments of |s|. Every kurtWinSamples samples, push
   *  a kurtosis sample to the history and reset the accumulators. */
  private feedKurt(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    for (let i = 0; i < nPairs; i++) {
      const I = dv.getInt16(i * 4,     false) / 32768;
      const Q = dv.getInt16(i * 4 + 2, false) / 32768;
      const m = Math.sqrt(I * I + Q * Q);
      const m2 = m * m;
      this.kurtAccN++;
      this.kurtAccM  += m;
      this.kurtAccM2 += m2;
      this.kurtAccM3 += m2 * m;
      this.kurtAccM4 += m2 * m2;
      if (this.kurtAccN >= this.kurtWinSamples) {
        const N = this.kurtAccN;
        const mean = this.kurtAccM / N;
        // E[(x − μ)²] = E[x²] − μ²
        const v = this.kurtAccM2 / N - mean * mean;
        if (v > 1e-12) {
          // E[(x − μ)⁴] = E[x⁴] − 4μE[x³] + 6μ²E[x²] − 3μ⁴
          const ex2 = this.kurtAccM2 / N;
          const ex3 = this.kurtAccM3 / N;
          const ex4 = this.kurtAccM4 / N;
          const m4c = ex4 - 4 * mean * ex3 + 6 * mean * mean * ex2 - 3 * mean * mean * mean * mean;
          const k = m4c / (v * v);
          this.kurtHistory.push({ t: performance.now(), k });
          if (this.kurtHistory.length > this.kurtHistMax) {
            this.kurtHistory.splice(0, this.kurtHistory.length - this.kurtHistMax);
          }
        }
        this.kurtAccN = 0;
        this.kurtAccM = this.kurtAccM2 = this.kurtAccM3 = this.kurtAccM4 = 0;
      }
    }
  }

  private renderKurt() {
    const cv = this.$('kurtCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const hist = this.kurtHistory;
    if (hist.length < 2) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText(`KURT — accumulating samples (${hist.length})…`, 6 * dpr, 16 * dpr);
      return;
    }

    // Y axis: kurtosis. Auto-scale, but always include the Gaussian-mag
    // reference value (3.245) so the user sees how far we are from "pure
    // noise". Clamp the visible window to [1.5, 25] for stability.
    let kMin = Infinity, kMax = -Infinity;
    for (const p of hist) { if (p.k < kMin) kMin = p.k; if (p.k > kMax) kMax = p.k; }
    kMin = Math.min(kMin, 2.5);
    kMax = Math.max(kMax, 4.5);
    if (kMax - kMin < 1.5) kMax = kMin + 1.5;
    if (kMax > 25) kMax = 25;

    const padL = 32 * dpr, padR = 8 * dpr, padT = 16 * dpr, padB = 16 * dpr;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const yOf = (k: number) => padT + (1 - (k - kMin) / (kMax - kMin)) * plotH;

    // Reference lines: Gaussian-magnitude (~3.245), and kurtosis = 3.
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    [3, 3.245, 6, 12].forEach(refK => {
      if (refK >= kMin && refK <= kMax) {
        const y = yOf(refK);
        ctx.beginPath();
        ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
        ctx.stroke();
      }
    });
    ctx.setLineDash([]);

    // Plot trace.
    const t0 = hist[0].t, tN = hist[hist.length - 1].t;
    const span = Math.max(1, tN - t0);
    ctx.strokeStyle = '#cfffa3';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    for (let i = 0; i < hist.length; i++) {
      const x = padL + ((hist[i].t - t0) / span) * plotW;
      const y = yOf(Math.min(kMax, Math.max(kMin, hist[i].k)));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Y axis labels.
    ctx.fillStyle = 'rgba(207,255,163,0.7)';
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [kMin, 3, 3.245, 6, 12, kMax].forEach(refK => {
      if (refK >= kMin && refK <= kMax) {
        const y = yOf(refK);
        ctx.fillText(refK.toFixed(refK === 3.245 ? 2 : 1), padL - 4 * dpr, y);
      }
    });

    // Status line.
    const last = hist[hist.length - 1].k;
    let label = 'Gaussian noise-like';
    if (last > 6)      label = 'impulsive (lightning / QRN)';
    else if (last > 4) label = 'mildly impulsive';
    else if (last < 2.5) label = 'tone-/carrier-dominated';
    this.$('kurtStatus').textContent =
      `KURT — current ${last.toFixed(2)} (excess ${(last - 3).toFixed(2)}) · ${label} · ref Gaussian-mag ≈ 3.25`;
  }

  /** Iterative radix-2 in-place FFT. Length must be a power of two.
   *  Used by DLDS — kept local to avoid pulling another FFT lib. */
  private fftInPlace(re: Float32Array, im: Float32Array) {
    const N = re.length;
    // Bit-reverse permutation.
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // Butterflies.
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1;
      const ang = -2 * Math.PI / size;
      const wpR = Math.cos(ang);
      const wpI = Math.sin(ang);
      for (let i = 0; i < N; i += size) {
        let wR = 1, wI = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const tR = re[b] * wR - im[b] * wI;
          const tI = re[b] * wI + im[b] * wR;
          re[b] = re[a] - tR;
          im[b] = im[a] - tI;
          re[a] += tR;
          im[a] += tI;
          const nR = wR * wpR - wI * wpI;
          wI = wR * wpI + wI * wpR;
          wR = nR;
        }
      }
    }
  }

  /** WEAK — buffer the IQ stream into N=1024 frames with 50% overlap,
   *  FFT, apply per-bin Wiener noise-reduction, drop the LSB half,
   *  iFFT, overlap-add into the audio output queue. */
  private feedWeak(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    const N = this.weakFftN;
    const HOP = this.weakHopN;
    let f = this.weakInFill;
    for (let i = 0; i < nPairs; i++) {
      // Slide the input ring by 1: shift left, append at the end.
      // We only do this when buffering into the FFT window — using a
      // straight-through buffer where the last HOP samples are the new
      // ones and the first HOP are carried over from the previous frame.
      this.weakInI[N - HOP + f] = dv.getInt16(i * 4, false)     / 32768;
      this.weakInQ[N - HOP + f] = dv.getInt16(i * 4 + 2, false) / 32768;
      f++;
      if (f >= HOP) {
        this.processWeakFrame();
        // Shift left by HOP so the most-recent HOP samples become the
        // first HOP of the next frame.
        this.weakInI.copyWithin(0, HOP, N);
        this.weakInQ.copyWithin(0, HOP, N);
        f = 0;
      }
    }
    this.weakInFill = f;
  }

  private processWeakFrame() {
    const N = this.weakFftN;
    const HOP = this.weakHopN;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    // Hann-window the input frame so the spectrum is clean and the
    // overlap-add reconstructs without seam buzz.
    for (let k = 0; k < N; k++) {
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * k) / (N - 1)));
      re[k] = this.weakInI[k] * h;
      im[k] = this.weakInQ[k] * h;
    }
    fft32k(re, im);
    // Ephraim-Malah MMSE-LSA per [Ephraim & Malah 1985].
    // -----------------------------------------------------------------
    // Noise-power tracking (Martin 2001 minimum-statistics, simplified):
    //   P_k(n)    = α_P · P_k(n-1) + (1-α_P) · |Y_k(n)|²    (smoothed power)
    //   P_min_k   = running minimum of P_k over a D-frame window
    //   λ_d_k    ≈ bias · P_min_k                            (noise variance)
    // The window-min is reset every D frames so it can track upward.
    //
    // Per-bin LSA gain:
    //   γ_k = |Y_k|² / λ_d_k                                  (a-posteriori SNR)
    //   ξ_k = α · |Â_k(n-1)|² / λ_d_k + (1-α) · max(γ_k-1, 0) (decision-directed)
    //   v_k = (ξ_k / (1+ξ_k)) · γ_k
    //   G_k = (ξ_k / (1+ξ_k)) · exp(½ · E₁(v_k))
    //   Â_k = G_k · |Y_k|        (fed back into next frame's ξ)
    const alphaP   = 0.7;              // periodogram smoothing
    const alphaDd  = 0.99;             // decision-directed smoothing (more = less flutter)
    const biasMs   = 1.5;              // min-statistics bias compensation
    const xiMin    = 10 ** (-1.0);     // -10 dB floor — max ~10 dB attenuation
    const resetD   = 100;              // window length (≈ 2 s at 47 fps)
    const P     = this.weakP;
    const PMin  = this.weakPMin;
    const ampPrev   = this.weakAmpPrev;
    const xiSmooth  = this.weakXiSmooth;
    // Pass 1: update noise estimates and compute raw ξ per bin.
    const xiRaw = new Float32Array(N);
    const gammaArr = new Float32Array(N);
    const Y2Arr = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const Y2 = re[k] * re[k] + im[k] * im[k];
      Y2Arr[k] = Y2;
      const p = alphaP * P[k] + (1 - alphaP) * Y2;
      P[k] = p;
      if (p < PMin[k]) PMin[k] = p;
      const lambda_d = Math.max(1e-18, biasMs * PMin[k]);
      const gamma = Y2 / lambda_d;
      gammaArr[k] = gamma;
      const Aprev2 = ampPrev[k] * ampPrev[k];
      let xi = alphaDd * (Aprev2 / lambda_d) + (1 - alphaDd) * Math.max(0, gamma - 1);
      if (xi < xiMin) xi = xiMin;
      xiRaw[k] = xi;
    }
    // Pass 2: cross-bin smoothing of ξ (3-tap moving average) — kills
    // the isolated-bin "ringing" that produces tonal/resonant artifacts.
    for (let k = 0; k < N; k++) {
      const km = k > 0 ? xiRaw[k - 1] : xiRaw[k];
      const kp = k < N - 1 ? xiRaw[k + 1] : xiRaw[k];
      const xi = (km + xiRaw[k] * 2 + kp) * 0.25;
      // Light EMA across frames too.
      xiSmooth[k] = 0.7 * xiSmooth[k] + 0.3 * xi;
    }
    // Pass 3: apply gain.
    for (let k = 0; k < N; k++) {
      const xi  = xiSmooth[k];
      const xiR = xi / (1 + xi);
      const v   = xiR * gammaArr[k];
      const gain = xiR * Math.exp(0.5 * expint1(v));
      re[k] *= gain;
      im[k] *= gain;
      const Yamp = Math.sqrt(Y2Arr[k]);
      const cleanAmp = Yamp * gain;
      ampPrev[k] = cleanAmp;
      this.weakSpec[k] = cleanAmp;
    }
    if (++this.weakResetCnt >= resetD) {
      this.weakResetCnt = 0;
      PMin.set(P);
    }
    // SSB demod: zero out one half of the spectrum. WUSB drops the
    // negative-freq bins (N/2..N-1) and keeps bin 0 (DC) + 1..N/2-1
    // (positive freqs); WLSB does the opposite.
    if (this.weakSide === 'usb') {
      for (let k = N / 2; k < N; k++) { re[k] = 0; im[k] = 0; }
    } else {
      for (let k = 1; k < N / 2; k++) { re[k] = 0; im[k] = 0; }
    }
    // Inverse FFT via the conjugate trick: ifft(X) = conj(fft(conj(X))) / N.
    for (let k = 0; k < N; k++) im[k] = -im[k];
    fft32k(re, im);
    const invN = 1 / N;
    // Output frame = real part / N. Because the input was Hann-windowed,
    // the output is also Hann-shaped; with 50% hop, two consecutive
    // frames sum to a constant envelope (Hann + Hann shifted N/2 = 1).
    const out = new Float32Array(HOP);
    // First HOP samples of this frame are summed with the second HOP
    // samples of the PREVIOUS frame, which we cached in weakOverlap.
    // Doubled because we discarded the LSB half-spectrum above.
    for (let k = 0; k < HOP; k++) {
      out[k] = (re[k] * invN * 2 + this.weakOverlap[k]) * 2;  // modest makeup
    }
    // Cache the second HOP for next frame's overlap-add (also x2).
    for (let k = 0; k < HOP; k++) this.weakOverlap[k] = re[HOP + k] * invN * 2;
    // Soft-saturate (tanh) rather than hard-clip — keeps overshoots
    // tame without the audible crunch a clipper produces.
    for (let k = 0; k < HOP; k++) out[k] = Math.tanh(out[k]);
    this.weakOutQueue.push(out);
    while (this.weakOutQueue.length > 32) this.weakOutQueue.shift();
  }

  private renderWeak() {
    const id = this.iq5Active;            // 'wusb' or 'wlsb' here
    if (id !== 'wusb' && id !== 'wlsb') return;
    const cv = this.$(id + 'Canvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = (cv.width = Math.round(cv.clientWidth * dpr));
    const H = (cv.height = Math.round(cv.clientHeight * dpr));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const N = this.weakFftN;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < N; k++) {
      const v = this.weakSpec[k];
      if (v > 0) {
        const dB = 20 * Math.log10(v);
        if (dB < lo) lo = dB;
        if (dB > hi) hi = dB;
      }
    }
    const tag = id === 'wusb' ? 'WUSB' : 'WLSB';
    if (!Number.isFinite(lo) || hi === lo) {
      ctx.fillStyle = '#cfffa3';
      ctx.font = `${11 * dpr}px ui-monospace, monospace`;
      ctx.fillText('warming up…', 6 * dpr, 16 * dpr);
      this.$(id + 'Status').textContent =
        `${tag} — MMSE-LSA · audio ${this.weakAudioCtx ? 'on' : 'off'} · queue ${this.weakOutQueue.length}`;
      return;
    }
    const range = Math.max(1, hi - lo);
    // Show only the kept sideband (the other half was zeroed in
    // processWeakFrame). For WUSB that's bins 0..N/2-1 (left-to-right
    // = audio 0..6 kHz); for WLSB it's the negative-freq bins
    // (rendered low-to-high freq with bin N-1 → x=0 and bin N/2 → x=W).
    const halfN = N / 2;
    ctx.strokeStyle = '#cfffa3';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    if (id === 'wusb') {
      for (let k = 0; k < halfN; k++) {
        const x = (k / (halfN - 1)) * W;
        const v = this.weakSpec[k];
        const dB = v > 0 ? 20 * Math.log10(v) : lo;
        const y = H - ((dB - lo) / range) * (H - 4 * dpr);
        if (k === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
      }
    } else {
      // LSB: bin N-1 = -6 kHz, bin N/2 = -≈0. Plot left→right as
      // most-negative→least-negative (which lines up with the dial).
      for (let i = 0; i < halfN; i++) {
        const k = N - 1 - i;
        const x = (i / (halfN - 1)) * W;
        const v = this.weakSpec[k];
        const dB = v > 0 ? 20 * Math.log10(v) : lo;
        const y = H - ((dB - lo) / range) * (H - 4 * dpr);
        if (i === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    this.$(id + 'Status').textContent =
      `${tag} — noise-reduction · ${this.weakAudioCtx ? `audio ${this.weakAudioCtx.sampleRate}Hz` : 'audio off'} · q ${this.weakOutQueue.length}`;
  }

  /** Open a fresh AudioContext at 12 kHz (the IQ rate) and pipe the
   *  WEAK output queue through a ScriptProcessor to the speakers. */
  private openWeakAudio() {
    this.closeWeakAudio();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 12000 });
    } catch {
      ctx = new AudioContext();   // fallback if 12 kHz isn't supported
    }
    this.weakAudioCtx = ctx;
    // ScriptProcessor is deprecated but works everywhere; the WEAK path
    // is small and an AudioWorklet adds enough boilerplate that it's
    // not worth it here. Buffer 2048 frames ≈ 170 ms at 12 kHz.
    const sp = ctx.createScriptProcessor(2048, 0, 1);
    sp.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      let written = 0;
      while (written < out.length && this.weakOutQueue.length > 0) {
        const head = this.weakOutQueue[0];
        const need = out.length - written;
        const have = head.length - this.weakOutPos;
        const take = Math.min(need, have);
        out.set(head.subarray(this.weakOutPos, this.weakOutPos + take), written);
        written  += take;
        this.weakOutPos += take;
        if (this.weakOutPos >= head.length) {
          this.weakOutQueue.shift();
          this.weakOutPos = 0;
        }
      }
      // Pad any remainder with silence rather than glitching.
      for (let i = written; i < out.length; i++) out[i] = 0;
    };
    sp.connect(ctx.destination);
    this.weakSp = sp;
    // Resume — most browsers require a user-gesture, which the toggle
    // tap supplies.
    ctx.resume().catch(() => { /* ignore */ });
  }

  private closeWeakAudio() {
    if (this.weakSp) { try { this.weakSp.disconnect(); } catch {} this.weakSp = null; }
    if (this.weakAudioCtx) { try { this.weakAudioCtx.close(); } catch {} this.weakAudioCtx = null; }
    this.weakOutQueue = [];
    this.weakOutPos = 0;
  }


  private toggleIqEye() {
    this.iqEyeOn = !this.iqEyeOn;
    this.updateWaterfallStream();
    const btn = this.$('btnEye');
    const panel = this.$('eyePanel');
    btn.classList.toggle('active', this.iqEyeOn);
    panel.style.display = this.iqEyeOn ? '' : 'none';
    if (this.iqEyeOn) {
      if (this.mode !== 'iq') this.setMode('iq');
      this.iqEyeRing.fill(0);
      this.iqEyeRingW = 0;
      this.iqEyeRingFill = 0;
      this.iqEyePhase = 0;
      this.iqEyePending = [];
      this.iqEyeNextDrawIdx = 0;
      const canvas = this.$('eyeCanvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = canvas.clientWidth  * dpr;
        canvas.height = canvas.clientHeight * dpr;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      this.player.onIqEye = (iq) => this.feedIqEye(iq);
      this.updateEyeStatus();
      const tick = () => {
        if (!this.iqEyeOn) { this.iqEyeRaf = null; return; }
        this.drawEyeFrame();
        this.iqEyeRaf = requestAnimationFrame(tick);
      };
      this.iqEyeRaf = requestAnimationFrame(tick);
    } else {
      this.player.onIqEye = null;
      if (this.iqEyeRaf != null) { cancelAnimationFrame(this.iqEyeRaf); this.iqEyeRaf = null; }
      if (this.mode === 'iq' && !this.hfdlOn && !this.isbOn && !this.ssbfOn && !this.iqViewOn) this.setMode('usb');
    }
  }

  private feedIqEye(iqBytes: Uint8Array) {
    const dv = new DataView(iqBytes.buffer, iqBytes.byteOffset, iqBytes.byteLength);
    const nPairs = (iqBytes.length / 4) | 0;
    if (nPairs === 0) return;
    const ring = this.iqEyeRing;
    const N = ring.length;
    const sps = this.iqEyeSPS;
    let w = this.iqEyeRingW;
    let phase = this.iqEyePhase;
    for (let i = 0; i < nPairs; i++) {
      const I = dv.getInt16(i * 4, false) / 32768;
      ring[w] = I;
      w = (w + 1) & (N - 1);
      phase += 1;
      if (phase >= sps) {
        phase -= sps;
        // Symbol-decision time = the sample we just wrote. Queue its
        // ring index for rendering once we have +T more samples beyond
        // it (handled in drawEyeFrame).
        this.iqEyePending.push(w);
        // Cap pending queue so a long pause in rAF doesn't grow it
        // unbounded.
        if (this.iqEyePending.length > 256) {
          this.iqEyePending.splice(0, this.iqEyePending.length - 256);
          this.iqEyeNextDrawIdx = 0;
        }
      }
    }
    this.iqEyeRingW = w;
    this.iqEyePhase = phase;
    this.iqEyeRingFill = Math.min(N, this.iqEyeRingFill + nPairs);
  }

  private drawEyeFrame() {
    const canvas = this.$('eyeCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const W = canvas.width, H = canvas.height;
    // Phosphor fade — slow so the persistence builds an "eye" mask.
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(0, 0, W, H);

    // Subtle grid — centerline, ±0.5T verticals, decision threshold at 0.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.moveTo(W * 0.5, 0); ctx.lineTo(W * 0.5, H);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(W * 0.25, 0); ctx.lineTo(W * 0.25, H);
    ctx.moveTo(W * 0.75, 0); ctx.lineTo(W * 0.75, H);
    ctx.stroke();

    const sps = this.iqEyeSPS;
    const win = Math.round(2 * sps);              // 2-symbol horizontal span
    const ring = this.iqEyeRing;
    const N = ring.length;
    const wNow = this.iqEyeRingW;

    // For each pending decision, check if the ring now holds at least
    // sps samples after that index. If so, draw and pop it.
    while (this.iqEyeNextDrawIdx < this.iqEyePending.length) {
      const decIdx = this.iqEyePending[this.iqEyeNextDrawIdx];
      // Distance from decIdx to wNow (samples written since the decision,
      // mod ring size).
      const since = (wNow - decIdx + N) & (N - 1);
      if (since < Math.ceil(sps)) break;          // need +T more samples
      // Trace runs from `decIdx - sps` to `decIdx + sps` — inclusive.
      const startIdx = (decIdx - Math.ceil(sps) + N) & (N - 1);
      ctx.strokeStyle = 'rgba(160,255,140,0.55)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      for (let k = 0; k <= win; k++) {
        const idx = (startIdx + k) & (N - 1);
        const v = ring[idx];
        const x = (k / win) * W;
        const y = H / 2 - v * (H / 2 - 4 * dpr);
        if (k === 0) ctx.moveTo(x, y);
        else         ctx.lineTo(x, y);
      }
      ctx.stroke();
      this.iqEyeNextDrawIdx++;
    }
    // Compact the pending queue once we've drawn the front items so it
    // doesn't grow indefinitely while indices stay valid against `ring`.
    if (this.iqEyeNextDrawIdx > 64) {
      this.iqEyePending = this.iqEyePending.slice(this.iqEyeNextDrawIdx);
      this.iqEyeNextDrawIdx = 0;
    }
  }

  private updateEyeStatus() {
    this.$('eyeStatus').textContent =
      `EYE — ${this.iqEyeBaud} bd · ${this.iqEyeSPS.toFixed(1)} sps`;
  }

  private toggleAcon() {
    this.aconOn = !this.aconOn;
    if (this.aconOn) this.exclusiveActivate('acon');
    const btn = this.$('btnAcon');
    const panel = this.$('aconPanel');
    btn.classList.toggle('active', this.aconOn);
    panel.style.display = this.aconOn ? '' : 'none';
    this.setSpectrumPanesHidden(this.aconOn);
    if (this.aconOn) {
      this.aconMaxAbs = 1;
      const canvas = this.$('aconCanvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      if (!this.aconBridge) {
        this.aconBridge = new AudioConstellation({
          sampleRate: 12000,
          centerHz: this.aconCenterHz,
          bandwidthHz: this.aconBwHz,
          costas: this.aconLockOn,
          costasMode: this.aconLockMode,
          onIq: (bytes) => this.renderAcon(bytes),
        });
      } else {
        this.aconBridge.setCenter(this.aconCenterHz);
        this.aconBridge.setBandwidth(this.aconBwHz);
        this.aconBridge.setCostasMode(this.aconLockMode);
        this.aconBridge.setCostas(this.aconLockOn);
        this.aconBridge.reset();
      }
      this.player.onIqAudio = (s) => this.aconBridge?.feed(s);
      this.updateAconStatus();
    } else {
      this.player.onIqAudio = null;
      // Clear ext-fullscreen state so reopening doesn't surprise the user.
      if (this.aconExtOn) {
        this.aconExtOn = false;
        document.body.classList.remove('acon-ext');
        this.$('aconExt').classList.remove('active');
      }
    }
  }

  private aconExtOn = false;
  private toggleAconExt() {
    this.aconExtOn = !this.aconExtOn;
    document.body.classList.toggle('acon-ext', this.aconExtOn);
    this.$('aconExt').classList.toggle('active', this.aconExtOn);
  }

  /** Preset table: maps a dropdown value to the BW (post-mix LPF, Hz) and
   *  whether the BPSK Costas LOCK should be auto-engaged. f₀ is *not*
   *  touched — the user keeps full control of which audio tone they're
   *  centering on, since GEN files and live signals land at different
   *  spots. LOCK is set true only for genuine BPSK / single-tone cases. */
  private static readonly ACON_PRESETS: Record<string, { bw: number; lock: boolean; mode: CostasMode; f0?: number }> = {
    psk31:        { bw: 100,  lock: true,  mode: 'bpsk' },
    psk63:        { bw: 200,  lock: true,  mode: 'bpsk' },
    psk125:       { bw: 400,  lock: true,  mode: 'bpsk' },
    psk250:       { bw: 800,  lock: true,  mode: 'bpsk' },
    psk500:       { bw: 1500, lock: true,  mode: 'bpsk' },
    psk1000:      { bw: 2500, lock: true,  mode: 'bpsk' },
    hfdl:         { bw: 2500, lock: true,  mode: 'bpsk' },
    qpsk31:       { bw: 100,  lock: true,  mode: 'qpsk' },
    qpsk63:       { bw: 200,  lock: true,  mode: 'qpsk' },
    qpsk125:      { bw: 400,  lock: true,  mode: 'qpsk' },
    qpsk250:      { bw: 800,  lock: true,  mode: 'qpsk' },
    qpsk500:      { bw: 1500, lock: true,  mode: 'qpsk' },
    '8psk125':    { bw: 400,  lock: true,  mode: '8psk' },
    '8psk250':    { bw: 800,  lock: true,  mode: '8psk' },
    '8psk500':    { bw: 1500, lock: true,  mode: '8psk' },
    '8psk1000':   { bw: 2500, lock: true,  mode: '8psk' },
    'rtty45-170':  { bw: 300,  lock: true,  mode: 'fsk', f0: 1000 },
    'rtty75-170':  { bw: 400,  lock: true,  mode: 'fsk', f0: 1000 },
    'rtty100-170': { bw: 400,  lock: true,  mode: 'fsk', f0: 1000 },
    'rtty45-850':  { bw: 1200, lock: true,  mode: 'fsk', f0: 1000 },
    navtex:       { bw: 400,  lock: true,  mode: 'fsk', f0: 1000 },
    pocsag1200:   { bw: 3500, lock: true,  mode: 'fsk' },
    mfsk16:       { bw: 400,  lock: true,  mode: 'fsk', f0: 1400 },
    mfsk32:       { bw: 600,  lock: true,  mode: 'fsk', f0: 1400 },
    mfsk64:       { bw: 1100, lock: true,  mode: 'fsk', f0: 1400 },
    'olivia8-500':     { bw: 600,  lock: true,  mode: 'fsk', f0: 1400 },
    'olivia16-1000':   { bw: 1100, lock: true,  mode: 'fsk', f0: 1400 },
    'olivia32-1000':   { bw: 1100, lock: true,  mode: 'fsk', f0: 1400 },
    'mt63-500':   { bw: 600,  lock: false, mode: 'bpsk' },
    'mt63-1000':  { bw: 1100, lock: false, mode: 'bpsk' },
    'mt63-2000':  { bw: 2100, lock: false, mode: 'bpsk' },
    'am-tone':    { bw: 100,  lock: true,  mode: 'bpsk' },
  };

  private applyAconPreset(key: string) {
    if (key === 'custom') return;
    const p = Shell.ACON_PRESETS[key];
    if (!p) return;
    this.aconBwHz = p.bw;
    (this.$('aconBw') as HTMLInputElement).value = String(p.bw);
    this.aconBridge?.setBandwidth(p.bw);
    if (p.f0 != null) {
      this.aconCenterHz = p.f0;
      (this.$('aconCenter') as HTMLInputElement).value = String(p.f0);
      this.aconBridge?.setCenter(p.f0);
    }
    if (this.aconLockMode !== p.mode) {
      this.aconLockMode = p.mode;
      this.aconBridge?.setCostasMode(p.mode);
    }
    if (this.aconLockOn !== p.lock) {
      this.aconLockOn = p.lock;
      (this.$('aconLockBtn') as HTMLElement).classList.toggle('active', p.lock);
      this.aconBridge?.setCostas(p.lock);
    }
    this.updateAconStatus();
  }

  private updateAconStatus() {
    const lockLabel = {
      bpsk: 'BPSK Costas',
      qpsk: 'QPSK Costas (4th-power)',
      '8psk': '8-PSK Costas (8th-power)',
      fsk: 'FSK spectral-peak snap',
    }[this.aconLockMode];
    const lock = this.aconLockOn ? ` · LOCK (${lockLabel})` : '';
    this.$('aconStatus').textContent =
      `Audio constellation — f₀=${this.aconCenterHz} Hz, BW=${this.aconBwHz} Hz${lock}`;
  }

  private renderAcon(bytes: Uint8Array) {
    const canvas = this.$('aconCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    const MARGIN = 8;
    const R = Math.min(W, H) / 2 - MARGIN;
    const cx = W / 2, cy = H / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.stroke();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.length >> 2;
    if (n === 0) return;
    let frameMax = 0;
    for (let i = 0; i < n; i++) {
      const I = dv.getInt16(i * 4, false);
      const Q = dv.getInt16(i * 4 + 2, false);
      const m = Math.max(Math.abs(I), Math.abs(Q));
      if (m > frameMax) frameMax = m;
    }
    if (frameMax > this.aconMaxAbs) this.aconMaxAbs = frameMax;
    else this.aconMaxAbs = Math.max(1, this.aconMaxAbs * 0.99 + frameMax * 0.01);
    const scale = R / this.aconMaxAbs;
    ctx.fillStyle = 'rgba(255,207,106,0.85)';
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - R, cy - R, R * 2, R * 2);
    ctx.clip();
    for (let i = 0; i < n; i++) {
      const I = dv.getInt16(i * 4, false);
      const Q = dv.getInt16(i * 4 + 2, false);
      const x = (cx + I * scale) | 0;
      const y = (cy - Q * scale) | 0;
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
  }

  private toggleVect() {
    this.vectOn = !this.vectOn;
    this.updateWaterfallStream();
    const btn = this.$('btnVect');
    const panel = this.$('vectPanel');
    btn.classList.toggle('active', this.vectOn);
    panel.style.display = this.vectOn ? '' : 'none';
    if (this.vectOn) {
      this.vectBuf.fill(0);
      this.vectBufWrite = 0;
      this.player.onVect = (s) => this.feedVect(s);
      const tick = () => {
        if (!this.vectOn) { this.vectRaf = null; return; }
        this.drawVect();
        this.vectRaf = requestAnimationFrame(tick);
      };
      this.vectRaf = requestAnimationFrame(tick);
      this.updateVectStatus();
    } else {
      this.player.onVect = null;
      if (this.vectRaf != null) { cancelAnimationFrame(this.vectRaf); this.vectRaf = null; }
    }
  }

  private feedVect(samples: Int16Array) {
    const buf = this.vectBuf;
    const N = buf.length;
    let w = this.vectBufWrite;
    for (let i = 0; i < samples.length; i++) {
      buf[w] = samples[i] / 32768;
      w = (w + 1) % N;
    }
    this.vectBufWrite = w;
  }

  private drawVect() {
    const canvas = this.$('vectCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const W = canvas.width, H = canvas.height;
    // Phosphor-style fade rather than a hard clear, so the trace leaves
    // a brief ghost as the pattern moves — much more readable than a
    // single-frame snapshot.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);

    // Linearize the ring buffer.
    const buf = this.vectBuf;
    const N = buf.length;
    const flat = new Float32Array(N);
    const w = this.vectBufWrite;
    for (let i = 0; i < N; i++) flat[i] = buf[(w + i) % N];

    const cx = W / 2, cy = H / 2;
    const r  = Math.min(W, H) / 2 - 4 * dpr;

    // Crosshair guides.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
    ctx.moveTo(0, cy); ctx.lineTo(W, cy);
    ctx.stroke();
    // Outer unit circle.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Trace.
    const d = Math.max(1, Math.min(N - 1, this.vectDelay));
    const M = N - d;
    ctx.strokeStyle = '#cfffa3';
    ctx.lineWidth = 1.0 * dpr;
    ctx.beginPath();
    for (let i = 0; i < M; i++) {
      const x = flat[i];
      const y = flat[i + d];
      const px = cx + x * r;
      const py = cy - y * r;        // canvas Y grows downward; invert
      if (i === 0) ctx.moveTo(px, py);
      else         ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  private updateVectStatus() {
    const ms = (this.vectDelay / 12).toFixed(1);     // 12 kHz audio
    this.$('vectStatus').textContent = `VECTOR — delay ${this.vectDelay} samp · ${ms} ms`;
    this.$('vectDelayVal').textContent = String(this.vectDelay);
  }

  private toggleGray() {
    this.grayOn = !this.grayOn;
    this.updateWaterfallStream();
    const btn = this.$('btnGray');
    const panel = this.$('grayPanel');
    btn.classList.toggle('active', this.grayOn);
    panel.style.display = this.grayOn ? '' : 'none';
    if (this.grayOn) {
      this.drawGray();
      // Refresh once a minute — terminator drift is ~0.25° per minute, no
      // point burning rAF cycles for a slow-moving line.
      this.grayTimer = window.setInterval(() => this.drawGray(), 60_000);
    } else if (this.grayTimer != null) {
      clearInterval(this.grayTimer);
      this.grayTimer = null;
    }
  }

  /** Render a gray-line propagation chart: equirectangular world, dim
   *  earth, day/night terminator + civil/nautical/astronomical twilight
   *  bands, sub-solar point dot, and a coarse MUF/LUF readout. */
  private drawGray() {
    const canvas = this.$('grayCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const W = canvas.width, H = canvas.height;

    // Sun position now (UTC).
    const now = new Date();
    const dayOfYear = Math.floor((+now - +new Date(Date.UTC(now.getUTCFullYear(), 0, 0))) / 86_400_000);
    // Solar declination (degrees) — Cooper's approximation.
    const declDeg = 23.45 * Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);
    const declRad = declDeg * Math.PI / 180;
    // Sub-solar longitude: 15° per UTC hour, sign so noon UTC → 0°, 12 UTC → 0°.
    const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600;
    const subSolarLon = -((utcHours - 12) * 15);

    // Per-pixel sun-altitude shading (low-res offscreen, scaled up).
    const lowW = 360, lowH = 180;
    const off = ctx.createImageData(lowW, lowH);
    for (let y = 0; y < lowH; y++) {
      const lat = 90 - y * (180 / lowH);
      const latR = lat * Math.PI / 180;
      const sLat = Math.sin(latR), cLat = Math.cos(latR);
      const sDec = Math.sin(declRad), cDec = Math.cos(declRad);
      for (let x = 0; x < lowW; x++) {
        const lon = -180 + x * (360 / lowW);
        const haDeg = lon - subSolarLon;
        const haR = haDeg * Math.PI / 180;
        const altRad = Math.asin(sLat * sDec + cLat * cDec * Math.cos(haR));
        const altDeg = altRad * 180 / Math.PI;
        // Day → bright olive, terminator → green tint, twilight → gradient,
        // night → very dim. Match the existing UI palette.
        let r: number, g: number, b: number;
        if (altDeg > 6) { r = 80; g = 95; b = 50; }              // day
        else if (altDeg > 0)   { r = 140; g = 200; b = 90; }     // gray-line band (best DX)
        else if (altDeg > -6)  { r = 60; g = 90; b = 50; }       // civil twilight
        else if (altDeg > -12) { r = 40; g = 60; b = 35; }       // nautical
        else if (altDeg > -18) { r = 25; g = 40; b = 25; }       // astronomical
        else                   { r = 12; g = 18; b = 14; }       // night
        const i = (y * lowW + x) * 4;
        off.data[i] = r; off.data[i + 1] = g; off.data[i + 2] = b; off.data[i + 3] = 255;
      }
    }
    // Stretch the low-res shaded image to fill the canvas.
    const tmp = document.createElement('canvas');
    tmp.width = lowW; tmp.height = lowH;
    tmp.getContext('2d')!.putImageData(off, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, W, H);

    // Lat/long grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    for (let lonGrid = -180; lonGrid <= 180; lonGrid += 30) {
      const x = ((lonGrid + 180) / 360) * W;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let latGrid = -60; latGrid <= 60; latGrid += 30) {
      const y = ((90 - latGrid) / 180) * H;
      ctx.moveTo(0, y); ctx.lineTo(W, y);
    }
    ctx.stroke();
    // Equator emphasised.
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Sub-solar point.
    const ssx = ((subSolarLon + 180) / 360) * W;
    const ssy = ((90 - declDeg) / 180) * H;
    ctx.fillStyle = '#ffd54f';
    ctx.beginPath();
    ctx.arc(ssx, ssy, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();

    // Coarse MUF/LUF + sub-solar info — overlay text top-left.
    // MUF/LUF here are rough order-of-magnitude (no VOACAP solver in browser):
    // day-side ~25/5 MHz, night-side ~10/3 MHz, gray-line peaks for low-band DX.
    const utcStr = now.toISOString().slice(11, 19) + 'Z';
    const lines = [
      `UTC ${utcStr}`,
      `sub-sol  ${declDeg.toFixed(1)}°N · ${subSolarLon.toFixed(1)}°E`,
      `MUF day  ~25 MHz · night ~10 MHz`,
      `LUF day  ~5 MHz  · night ~3 MHz`,
    ];
    ctx.font = `${11 * dpr}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = 'top';
    const padX = 6 * dpr, padY = 4 * dpr, lh = 14 * dpr;
    let maxW = 0;
    for (const l of lines) maxW = Math.max(maxW, ctx.measureText(l).width);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, maxW + padX * 2, lh * lines.length + padY * 2);
    ctx.fillStyle = '#cfffa3';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], padX, padY + i * lh);
    }
  }

  private toggleScope() {
    this.scopeOn = !this.scopeOn;
    this.updateWaterfallStream();
    const btn = this.$('btnScope');
    const panel = this.$('scopePanel');
    btn.classList.toggle('active', this.scopeOn);
    panel.style.display = this.scopeOn ? '' : 'none';
    if (this.scopeOn) {
      this.scopeBuf.fill(0);
      this.scopeBufWrite = 0;
      this.player.onScope = (s) => this.feedScope(s);
      const tick = () => {
        if (!this.scopeOn) { this.scopeRaf = null; return; }
        this.drawScope();
        this.scopeRaf = requestAnimationFrame(tick);
      };
      this.scopeRaf = requestAnimationFrame(tick);
    } else {
      this.player.onScope = null;
      if (this.scopeRaf != null) { cancelAnimationFrame(this.scopeRaf); this.scopeRaf = null; }
    }
  }

  private feedScope(samples: Int16Array) {
    // Append into the ring buffer normalized to ±1.
    const buf = this.scopeBuf;
    const N = buf.length;
    let w = this.scopeBufWrite;
    for (let i = 0; i < samples.length; i++) {
      buf[w] = samples[i] / 32768;
      w = (w + 1) % N;
    }
    this.scopeBufWrite = w;
  }

  private drawScope() {
    const canvas = this.$('scopeCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // Linearize the ring buffer into a flat Float32Array we can scan.
    const buf = this.scopeBuf;
    const N = buf.length;
    const flat = new Float32Array(N);
    const w = this.scopeBufWrite;
    for (let i = 0; i < N; i++) flat[i] = buf[(w + i) % N];

    // Find a trigger crossing inside the older half so we have at least
    // `scopeWindowSamples` after it. If no crossing is found, free-run
    // from the start of the buffer (still draws, just unsynced).
    const win = Math.min(this.scopeWindowSamples, N - 1);
    const level = this.scopeTriggerLevel;
    const rising = this.scopeTriggerRising;
    let trig = -1;
    for (let i = 1; i < N - win; i++) {
      const prev = flat[i - 1], cur = flat[i];
      if (rising  && prev <  level && cur >= level) { trig = i; break; }
      if (!rising && prev >  level && cur <= level) { trig = i; break; }
    }
    const start = trig >= 0 ? trig : 0;
    const triggered = trig >= 0;

    // Centerline + level guide.
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.strokeStyle = '#3a5';
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    const levelY = H / 2 - level * (H / 2 - 4 * dpr);
    ctx.beginPath();
    ctx.moveTo(0, levelY); ctx.lineTo(W, levelY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform.
    ctx.strokeStyle = triggered ? '#cfffa3' : '#7a8a4a';
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    for (let i = 0; i < win; i++) {
      const x = (i / (win - 1)) * W;
      const v = flat[start + i];
      const y = H / 2 - v * (H / 2 - 4 * dpr);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** High-resolution audio FFT panel — 16384-pt single-sided
   *  log-magnitude spectrum of the demodulated audio, 0..6 kHz. */
  private toggleThd() {
    this.thdOn = !this.thdOn;
    this.updateWaterfallStream();
    const btn = this.$('btnThd');
    const panel = this.$('thdPanel');
    btn.classList.toggle('active', this.thdOn);
    panel.style.display = this.thdOn ? '' : 'none';
    if (this.thdOn) {
      this.thdBuf.fill(0);
      this.thdBufWrite = 0;
      // Wipe the running-average ring so reopening always starts
      // fresh — otherwise we'd briefly show the stale average from
      // the previous session.
      this.thdMagHist = [];
      this.thdMagSum = null;
      this.thdMagWrite = 0;
      this.thdMagFilled = 0;
      this.player.onThd = (s) => this.feedThd(s);
      // Hover cursor: track pointer X relative to the canvas so the
      // draw routine can overlay a vertical line + freq/amplitude
      // readout. Bind once (canvas element is permanent in the DOM).
      if (!this.thdCursorBound) {
        const canvas = this.$('thdCanvas') as HTMLCanvasElement;
        canvas.addEventListener('pointermove', (e) => {
          const r = canvas.getBoundingClientRect();
          this.thdCursorX = e.clientX - r.left;
        });
        canvas.addEventListener('pointerleave', () => { this.thdCursorX = null; });
        this.thdCursorBound = true;
      }
      const tick = () => {
        if (!this.thdOn) { this.thdRaf = null; return; }
        this.drawThd();
        this.thdRaf = requestAnimationFrame(tick);
      };
      this.thdRaf = requestAnimationFrame(tick);
    } else {
      this.player.onThd = null;
      if (this.thdRaf != null) { cancelAnimationFrame(this.thdRaf); this.thdRaf = null; }
    }
  }

  private feedThd(samples: Int16Array) {
    const buf = this.thdBuf;
    const N = buf.length;
    let w = this.thdBufWrite;
    for (let i = 0; i < samples.length; i++) {
      buf[w] = samples[i] / 32768;
      w = (w + 1) % N;
    }
    this.thdBufWrite = w;
  }

  private drawThd() {
    const canvas = this.$('thdCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const N = this.thdBuf.length;          // 16384 (power of 2)
    const sr = this.player.getInputRate() || 12000;
    // Linearise + Hann window in one pass.
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const buf = this.thdBuf;
    const wIdx = this.thdBufWrite;
    const twoPiOverN = 2 * Math.PI / (N - 1);
    for (let i = 0; i < N; i++) {
      const v = buf[(wIdx + i) % N];
      const w = 0.5 * (1 - Math.cos(twoPiOverN * i));   // Hann
      re[i] = v * w;
    }
    this.fftInPlace(re, im);

    // Single-sided magnitude (DC ignored).
    const half = N >> 1;
    const instMag = new Float32Array(half);
    for (let k = 1; k < half; k++) {
      instMag[k] = Math.hypot(re[k], im[k]);
    }

    // ── Running average over the last N FFTs ──
    // Keep a ring buffer of frame magnitudes plus a running sum so the
    // per-frame cost stays O(half), independent of ring length.
    if (this.thdMagSum == null || this.thdMagSum.length !== half) {
      this.thdMagSum = new Float32Array(half);
      this.thdMagHist = [];
      this.thdMagWrite = 0;
      this.thdMagFilled = 0;
    }
    const sum = this.thdMagSum;
    const hist = this.thdMagHist;
    const RING = Shell.THD_AVG_LEN;
    if (hist.length < RING) {
      // Filling the ring: just push and add into the sum.
      hist.push(instMag);
      for (let k = 1; k < half; k++) sum[k] += instMag[k];
      this.thdMagFilled = hist.length;
    } else {
      // Steady state: replace the oldest slot, updating the sum in-place.
      const idx = this.thdMagWrite;
      const old = hist[idx];
      for (let k = 1; k < half; k++) sum[k] += instMag[k] - old[k];
      hist[idx] = instMag;
      this.thdMagWrite = (idx + 1) % RING;
    }
    const denom = this.thdMagFilled || 1;
    const mag = new Float32Array(half);
    let maxMag = 1e-12;
    for (let k = 1; k < half; k++) {
      const m = sum[k] / denom;
      mag[k] = m;
      if (m > maxMag) maxMag = m;
    }

    // Display range: clamp to 0..6 kHz. At sr=12 kHz this is the full
    // single-sided spectrum; at lower sr (some OWRX profiles request
    // 8 kHz) we just show what's actually present.
    const binHz  = sr / N;
    const drawHi = Math.min(half, Math.floor(6000 / binHz));
    const span = drawHi;                   // drawLo = 0
    const dbFloor = -100, dbRange = 100;

    ctx.strokeStyle = '#0c4';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    for (let k = 1; k < span; k++) {
      const m = mag[k];
      const db = m > 0 ? 20 * Math.log10(m / maxMag) : dbFloor;
      const y = H - ((Math.max(dbFloor, db) - dbFloor) / dbRange) * H;
      const x = (k / span) * W;
      if (k === 1) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Frequency-axis tick labels (every 1 kHz).
    ctx.fillStyle = '#888';
    ctx.font = `${10 * dpr}px monospace`;
    for (let f = 1000; f < drawHi * binHz; f += 1000) {
      const x = ((f / binHz) / span) * W;
      ctx.fillRect(x, H - 4 * dpr, 1 * dpr, 4 * dpr);
      ctx.fillText(`${f / 1000}k`, x + 2 * dpr, H - 5 * dpr);
    }

    // ── Hover cursor: vertical yellow line at the pointer X with a
    //    bin-snapped freq + amplitude readout (dBFS relative to the
    //    frame's peak). ──
    let cursorTxt: string | null = null;
    if (this.thdCursorX != null) {
      const cssW = canvas.clientWidth;
      const xCss = Math.max(0, Math.min(cssW - 1, this.thdCursorX));
      const xPx = xCss * dpr;
      // Map back to bin (uses same span/drawHi as the spectrum draw).
      const frac = xPx / W;
      const k = Math.max(1, Math.min(span - 1, Math.round(frac * span)));
      const freqHz = k * binHz;
      const m = mag[k];
      const db = m > 0 ? 20 * Math.log10(m / maxMag) : -dbRange;
      ctx.strokeStyle = '#fd5';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(xPx, 0); ctx.lineTo(xPx, H);
      ctx.stroke();
      cursorTxt = ` · cursor ${freqHz.toFixed(1)} Hz @ ${db.toFixed(1)} dB`;
    }

    // Status — FFT geometry + cursor readout when hovering.
    const status = this.$('thdStatus');
    if (status) {
      status.textContent =
        `Audio FFT — ${N} pt · ${binHz.toFixed(2)} Hz/bin · 0–${(drawHi * binHz / 1000).toFixed(2)} kHz · avg ${this.thdMagFilled}/${Shell.THD_AVG_LEN}`
        + (cursorTxt ?? '');
    }
  }

  /** Toggle the WSPR-15 batch decoder. UTC-aligned on 15-minute
   *  boundaries (:00/:15/:30/:45). Defaults the dial to 137.500 kHz
   *  USB (the 2200 m WSPR-15 sub-band) if the receiver isn't already
   *  on an LF/MF frequency, since WSPR-15 traffic is concentrated
   *  there. The server-side decoder buffers ~14 minutes of audio per
   *  period and then spawns `wsprd -m`. */
  private toggleWspr15() {
    this.wspr15On = !this.wspr15On;
    this.updateWaterfallStream();
    const btn = this.$('btnWspr15');
    const panel = this.$('wspr15Panel');
    btn.classList.toggle('active', this.wspr15On);
    panel.style.display = this.wspr15On ? '' : 'none';
    if (this.wspr15On) {
      // If we're not already on an LF/MF freq, jump to 2200 m WSPR-15.
      if (this.freqKHz > 600) {
        this.freqKHz = 137.5;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 1400;
        this.highCut = 1600;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const sr = this.player.getInputRate() || 12000;
      this.wspr15Decoder = new Wspr15Decoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('wspr15Status').textContent = `WSPR-15 ${s}`; },
        onSpot: (spot) => this.appendWspr15Spot(spot),
      });
      this.player.onWspr15 = (s) => this.wspr15Decoder?.feed(s);
    } else {
      this.player.onWspr15 = null;
      this.wspr15Decoder?.close();
      this.wspr15Decoder = null;
    }
  }

  private appendWspr15Spot(s: WsprSpot) {
    const el = this.$('wspr15Text');
    const line =
      `${s.time}  ${s.snrDb >= 0 ? '+' : ''}${s.snrDb.toString().padStart(3)} dB  ` +
      `${s.dtSec.toFixed(1).padStart(5)} s  ${s.freqMHz.toFixed(6)} MHz  ` +
      `${s.driftHz >= 0 ? '+' : ''}${s.driftHz} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle the JT9 batch decoder. UTC-aligned on 1-minute boundaries.
   *  Auto-tunes to 14.078 MHz USB if the receiver isn't already in a
   *  conventional JT9 sub-band (within 100 kHz of any of the canonical
   *  JT9 dial frequencies). */
  private toggleJt9() {
    this.jt9On = !this.jt9On;
    this.updateWaterfallStream();
    const btn = this.$('btnJt9');
    const panel = this.$('jt9Panel');
    btn.classList.toggle('active', this.jt9On);
    panel.style.display = this.jt9On ? '' : 'none';
    if (this.jt9On) {
      // Canonical JT9 dial spots; if we're far from all of them, jump
      // to 20 m which is the most active band.
      const JT9_DIALS = [1.838, 3.578, 7.078, 10.138, 14.078, 18.104, 21.078, 24.919, 28.078];
      const onBand = JT9_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 100);
      if (!onBand) {
        this.freqKHz = 14078.0;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 0;
        this.highCut = 3000;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const sr = this.player.getInputRate() || 12000;
      this.jt9Decoder = new Jt9Decoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('jt9Status').textContent = `JT9 ${s}`; },
        onSpot: (spot) => this.appendJt9Spot(spot),
      });
      this.player.onJt9 = (s) => this.jt9Decoder?.feed(s);
    } else {
      this.player.onJt9 = null;
      this.jt9Decoder?.close();
      this.jt9Decoder = null;
    }
  }

  private appendJt9Spot(s: Jt9Spot) {
    const el = this.$('jt9Text');
    const snr = (s.snrDb >= 0 ? '+' : '') + s.snrDb.toString().padStart(3);
    const dt  = s.dtSec.toFixed(1).padStart(5);
    const off = (s.freqHz >= 0 ? '+' : '') + s.freqHz.toString().padStart(5);
    const line = `${s.time}  ${snr} dB  ${dt} s  ${off} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle the JT65 batch decoder. Same 1-min UTC alignment as JT9.
   *  Auto-tunes to 14.076 MHz USB (20 m JT65 watering hole) if the
   *  receiver isn't already within 100 kHz of a canonical JT65 dial. */
  private toggleJt65() {
    this.jt65On = !this.jt65On;
    this.updateWaterfallStream();
    const btn = this.$('btnJt65');
    const panel = this.$('jt65Panel');
    btn.classList.toggle('active', this.jt65On);
    panel.style.display = this.jt65On ? '' : 'none';
    if (this.jt65On) {
      // Canonical JT65 dial spots — offset 2 kHz higher than JT9 on
      // most bands so the two modes can share the same 2 kHz window
      // without colliding.
      const JT65_DIALS = [1.838, 3.576, 7.076, 10.138, 14.076, 18.102, 21.076, 24.917, 28.076, 50.276];
      const onBand = JT65_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 100);
      if (!onBand) {
        this.freqKHz = 14076.0;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 0;
        this.highCut = 3000;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const sr = this.player.getInputRate() || 12000;
      this.jt65Decoder = new Jt65Decoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('jt65Status').textContent = `JT65 ${s}`; },
        onSpot: (spot) => this.appendJt65Spot(spot),
      });
      this.player.onJt65 = (s) => this.jt65Decoder?.feed(s);
    } else {
      this.player.onJt65 = null;
      this.jt65Decoder?.close();
      this.jt65Decoder = null;
    }
  }

  private appendJt65Spot(s: Jt65Spot) {
    const el = this.$('jt65Text');
    const snr = (s.snrDb >= 0 ? '+' : '') + s.snrDb.toString().padStart(3);
    const dt  = s.dtSec.toFixed(1).padStart(5);
    const off = (s.freqHz >= 0 ? '+' : '') + s.freqHz.toString().padStart(5);
    const line = `${s.time}  ${snr} dB  ${dt} s  ${off} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle the Q65 batch decoder. Defaults to Q65-60 (1-minute UTC
   *  slots), the most common HF submode. Auto-tunes to 14.080 MHz USB
   *  if the receiver isn't already within 100 kHz of a canonical Q65
   *  dial. (Q65 isn't as universally aligned as JT9 / JT65, but these
   *  spots come from WSJT-X's default frequency list.) */
  private toggleQ65() {
    this.q65On = !this.q65On;
    this.updateWaterfallStream();
    const btn = this.$('btnQ65');
    const panel = this.$('q65Panel');
    btn.classList.toggle('active', this.q65On);
    panel.style.display = this.q65On ? '' : 'none';
    if (this.q65On) {
      const Q65_DIALS = [1.836, 3.582, 5.357, 7.056, 10.130, 14.080, 18.107, 21.080, 24.922, 28.080, 50.275];
      const onBand = Q65_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 100);
      if (!onBand) {
        this.freqKHz = 14080.0;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 0;
        this.highCut = 3000;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const sr = this.player.getInputRate() || 12000;
      this.q65Decoder = new Q65Decoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        periodSec: 60,
        onStatus: (s) => { this.$('q65Status').textContent = `Q65 ${s}`; },
        onSpot: (spot) => this.appendQ65Spot(spot),
      });
      this.player.onQ65 = (s) => this.q65Decoder?.feed(s);
    } else {
      this.player.onQ65 = null;
      this.q65Decoder?.close();
      this.q65Decoder = null;
    }
  }

  private appendQ65Spot(s: Q65Spot) {
    const el = this.$('q65Text');
    const snr = (s.snrDb >= 0 ? '+' : '') + s.snrDb.toString().padStart(3);
    const dt  = s.dtSec.toFixed(1).padStart(5);
    const off = (s.freqHz >= 0 ? '+' : '') + s.freqHz.toString().padStart(5);
    const line = `${s.time}  ${snr} dB  ${dt} s  ${off} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle the FST4W beacon decoder. Defaults to FST4W-120 (2-min
   *  slots, same boundaries as WSPR for direct comparison). Auto-tunes
   *  to 14.0956 MHz USB (the busiest FST4W watering hole on 20 m) if
   *  the receiver isn't already within 200 Hz of a canonical FST4W
   *  dial — note the sub-band overlaps the WSPR sub-band by design, so
   *  the same `wsprFreqList` entries work as reference. */
  private toggleFst4w() {
    this.fst4wOn = !this.fst4wOn;
    this.updateWaterfallStream();
    const btn = this.$('btnFst4w');
    const panel = this.$('fst4wPanel');
    btn.classList.toggle('active', this.fst4wOn);
    panel.style.display = this.fst4wOn ? '' : 'none';
    if (this.fst4wOn) {
      // FST4W reuses the WSPR sub-bands; these are the active FST4W
      // dials per WSJT-X 2.4+ defaults.
      const FST4W_DIALS = [0.136, 0.4742, 1.8366, 3.5686, 5.2872, 7.0386, 10.1387, 14.0956, 18.1046, 21.0946, 24.9246, 28.1246, 50.293];
      const onBand = FST4W_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 0.2);
      if (!onBand) {
        this.freqKHz = 14095.6;
        if (this.mode !== 'usb') this.setMode('usb');
        // 200 Hz sub-band, audio centred around 1500 Hz like WSPR.
        this.lowCut = 1400;
        this.highCut = 1600;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const sr = this.player.getInputRate() || 12000;
      this.fst4wDecoder = new Fst4wDecoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        periodSec: 120,
        onStatus: (s) => { this.$('fst4wStatus').textContent = `FST4W ${s}`; },
        onSpot: (spot) => this.appendFst4wSpot(spot),
      });
      this.player.onFst4w = (s) => this.fst4wDecoder?.feed(s);
    } else {
      this.player.onFst4w = null;
      this.fst4wDecoder?.close();
      this.fst4wDecoder = null;
    }
  }

  private appendFst4wSpot(s: Fst4wSpot) {
    const el = this.$('fst4wText');
    const snr = (s.snrDb >= 0 ? '+' : '') + s.snrDb.toString().padStart(3);
    const dt  = s.dtSec.toFixed(1).padStart(5);
    const off = (s.freqHz >= 0 ? '+' : '') + s.freqHz.toString().padStart(5);
    const line = `${s.time}  ${snr} dB  ${dt} s  ${off} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle the STANAG 4285 signal detector. Pure client-side DSP —
   *  no server bridge needed. Runs on whatever the receiver is
   *  currently demodulating (USB / LSB / etc.); the operator is
   *  expected to tune to the candidate signal first. */
  private toggleStanag() {
    this.stanagOn = !this.stanagOn;
    const btn = this.$('btnStanag');
    const panel = this.$('stanagPanel');
    btn.classList.toggle('active', this.stanagOn);
    panel.style.display = this.stanagOn ? '' : 'none';
    if (this.stanagOn) {
      let lastVerdict = '';
      this.stanagDetector = new Stanag4285Detector({
        onStatus: (s) => this.renderStanagStatus(s, () => lastVerdict, (v) => { lastVerdict = v; }),
      });
      this.player.onStanag = (samples) => this.stanagDetector?.feed(samples);
    } else {
      this.player.onStanag = null;
      this.stanagDetector?.close();
      this.stanagDetector = null;
    }
  }

  /** Toggle the STANAG 4539 detector. Independent of the 4285 detector
   *  — the two can't run simultaneously today because of
   *  exclusiveActivate, but their DSP is non-overlapping and could be
   *  fused later. */
  private toggleStanag4539() {
    this.stanag4539On = !this.stanag4539On;
    const btn = this.$('btnStanag4539');
    const panel = this.$('stanag4539Panel');
    btn.classList.toggle('active', this.stanag4539On);
    panel.style.display = this.stanag4539On ? '' : 'none';
    if (this.stanag4539On) {
      let lastVerdict = '';
      this.stanag4539Detector = new Stanag4539Detector({
        onStatus: (s) => this.renderStanag4539Status(
          s,
          () => lastVerdict,
          (v) => { lastVerdict = v; },
        ),
      });
      this.player.onStanag4539 = (samples) => this.stanag4539Detector?.feed(samples);
    } else {
      this.player.onStanag4539 = null;
      this.stanag4539Detector?.close();
      this.stanag4539Detector = null;
    }
  }

  private renderStanag4539Status(
    s: Stanag4539Status,
    getLast: () => string,
    setLast: (v: string) => void,
  ) {
    const cBar = s.carrierLock ? '●' : '○';
    const sBar = s.symbolLock ? '●' : '○';
    const pBar = s.preambleLock ? '●' : '○';
    const verdictLabel = {
      present: 'STANAG 4539 PRESENT',
      maybe: 'maybe …',
      absent: 'no signal',
    }[s.verdict];
    this.$('stanag4539Status').textContent =
      `${verdictLabel} · ${cBar} carrier ${s.carrierDbBump.toFixed(1)} dB · ` +
      `${sBar} symbol ${s.symbolPower.toFixed(2)} · ` +
      `${pBar} preamble ${s.preambleCorr.toFixed(2)}`;
    if (s.verdict !== getLast()) {
      setLast(s.verdict);
      const ts = new Date().toISOString().slice(11, 19);
      const el = this.$('stanag4539Text');
      el.textContent = (el.textContent || '') + `${ts}  → ${verdictLabel}\n`;
      const t = el.textContent;
      if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Toggle the SELCAL decoder. Auto-tunes to 8.891 MHz USB (the
   *  busiest North-Atlantic aero HF family) if not already on a
   *  major aero band. SELCAL traffic appears as short tone bursts;
   *  decoded events show the 4-letter aircraft code with a timestamp. */
  private toggleSelcal(): void {
    this.selcalOn = !this.selcalOn;
    this.updateWaterfallStream();
    const btn = this.$('btnSelcal');
    const panel = this.$('selcalPanel');
    btn.classList.toggle('active', this.selcalOn);
    panel.style.display = this.selcalOn ? '' : 'none';
    if (this.selcalOn) {
      // Common ICAO aeronautical HF families (all USB). Coverage
      // varies by region — these are the calling channels with the
      // most traffic on most days.
      const AERO_DIALS = [
        2.872, 2.899, 3.016, 4.675, 5.598, 5.616, 5.649,
        6.580, 6.586, 8.825, 8.864, 8.879, 8.891, 8.918,
        10.018, 11.279, 11.336, 13.291, 13.306, 17.946,
      ];
      const onBand = AERO_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 20);
      if (!onBand) {
        this.freqKHz = 8891.0;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 100;
        this.highCut = 2900;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      this.selcalDecoder = new SelcalDecoder({
        sampleRate: this.player.getInputRate() || 12000,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('selcalStatus').textContent = `SELCAL ${s}`; },
        onCall: (call) => this.appendSelcalCall(call),
      });
      this.player.onSelcal = (samples) => this.selcalDecoder?.feed(samples);
    } else {
      this.player.onSelcal = null;
      this.selcalDecoder?.close();
      this.selcalDecoder = null;
    }
  }

  /** POCSAG pager decoder. Server-side multimon-ng (-a POCSAG512/1200/2400)
   *  consumes a 22.05 kHz stream and emits decoded {address, fn, kind,
   *  payload} pages. Same shape as toggleSelcal but with the POCSAG
   *  bridge. Operates in NBFM mode (pager activity is on the dedicated
   *  band but Kiwi tunes USB/NBFM equivalently); the user picks a
   *  pager-band frequency separately. */
  private togglePocs(): void {
    this.pocsOn = !this.pocsOn;
    this.updateWaterfallStream();
    const btn = this.$('btnPocs');
    const panel = this.$('pocsPanel');
    btn.classList.toggle('active', this.pocsOn);
    panel.style.display = this.pocsOn ? '' : 'none';
    if (this.pocsOn) {
      this.pocsDecoder = new PocsagDecoder({
        sampleRate: this.player.getInputRate() || 12000,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('pocsStatus').textContent = `POCSAG ${s}`; },
        onPage: (p) => this.appendPocsPage(p),
      });
      this.player.onPocsag = (samples) => this.pocsDecoder?.feed(samples);
    } else {
      this.player.onPocsag = null;
      this.pocsDecoder?.close();
      this.pocsDecoder = null;
    }
  }

  /** DSD (D-STAR / DMR / NXDN / YSF / dPMR / M17 / P25) toggle.
   *  Switching modes while on tears down the active DsdDecoder and
   *  spawns a fresh one with the new mode flag. */
  private toggleDsd(mode: DsdMode): void {
    const wasOn = this.dsdOn;
    this.dsdOn = !wasOn;
    this.dsdMode = mode;
    this.updateWaterfallStream();
    const panel = this.$('dsdPanel');
    panel.style.display = this.dsdOn ? '' : 'none';
    // Highlight whichever of the 10 mode buttons matches the live state.
    const modeBtnIds: Record<DsdMode, string> = {
      dstar: 'btnDstar',  dmr: 'btnDmr',  dmrs: 'btnDmrs',
      nxdn48: 'btnNxdn48', nxdn96: 'btnNxdn96',
      ysf: 'btnYsf',      dpmr: 'btnDpmr',
      m17: 'btnM17',
      p25p1: 'btnP25p1',  p25p2: 'btnP25p2',
    };
    for (const id of Object.values(modeBtnIds)) {
      this.$(id).classList.toggle('active', false);
    }
    if (this.dsdOn) {
      this.$(modeBtnIds[mode]).classList.add('active');
      this.$('dsdStatus').textContent = `DSD ${mode.toUpperCase()} starting…`;
      const ctx = this.player.getOrCreateCtx();
      if (!ctx) {
        this.$('dsdStatus').textContent = 'DSD — audio context unavailable; click PWR to resume audio';
        this.dsdOn = false;
        panel.style.display = 'none';
        return;
      }
      // DSD modes live in VHF/UHF land — Kiwi caps at 30 MHz so the
      // dial can never reach a DMR/D-STAR/etc. channel from a Kiwi
      // connection. Banner to avoid silent confusion; the decoder
      // still spawns (the operator may already be on an OWRX server).
      if (!this.isOwrxSource() && this.freqKHz < 30_000) {
        this.banner(`${mode.toUpperCase()} is VHF/UHF — switch to an OpenWebRX server`, 3000);
      }
      this.dsdDecoder = new DsdDecoder(mode, {
        ctx,
        destination: this.player.getMixer() ?? undefined,
        onStatus: (s) => { this.$('dsdStatus').textContent = `DSD ${mode.toUpperCase()} — ${s}`; },
        onEvent:  (ev) => this.appendDsdEvent(ev),
        onText:   (line) => this.appendDsdText(line),
      });
      // Apply the operator's persisted gain to the fresh decoder.
      this.dsdDecoder.setGain(this.dsdGain);
      this.player.onDsd = (samples) => this.dsdDecoder?.feed(samples);
    } else {
      this.player.onDsd = null;
      this.dsdDecoder?.close();
      this.dsdDecoder = null;
    }
  }

  private appendDsdEvent(ev: DsdEvent): void {
    const ts = new Date(ev.tsMs).toISOString().slice(11, 19);
    const parts = [
      `${ts}  ${ev.mode.toUpperCase()}`,
      ev.src  ? `SRC=${ev.src}`  : '',
      ev.dst  ? `DST=${ev.dst}`  : '',
      ev.nac  ? `NAC=${ev.nac}`  : '',
      ev.cc   ? `CC=${ev.cc}`    : '',
      ev.ran  ? `RAN=${ev.ran}`  : '',
      ev.slot ? `SLOT=${ev.slot}` : '',
      ev.sync ? `SYNC=${ev.sync}` : '',
    ].filter(Boolean);
    const el = this.$('dsdText');
    el.textContent = (el.textContent || '') + parts.join('  ') + '\n';
    const t = el.textContent;
    if (t.length > 16000) el.textContent = t.slice(t.length - 16000);
    el.scrollTop = el.scrollHeight;
    if (ev.src) this.banner(`${ev.mode.toUpperCase()} ${ev.src}${ev.dst ? '→'+ev.dst : ''}`, 1500);
  }

  private appendDsdText(line: string): void {
    const el = this.$('dsdText');
    el.textContent = (el.textContent || '') + line + '\n';
    const t = el.textContent;
    if (t.length > 16000) el.textContent = t.slice(t.length - 16000);
    el.scrollTop = el.scrollHeight;
  }

  /** Generic multimon-ng modes (FLEX / ERMES / DTMF / ZVEI / AFSK1200 /
   *  X10 / EAS). Same toggle shape as DSD: one decoder instance, mode
   *  swapped on activation. Tearing down the existing decoder when the
   *  operator picks a different mode is handled in the click wiring. */
  private toggleMultimon(mode: MultimonMode): void {
    const wasOn = this.multimonOn;
    this.multimonOn = !wasOn;
    this.multimonMode = mode;
    this.updateWaterfallStream();
    const panel = this.$('multimonPanel');
    panel.style.display = this.multimonOn ? '' : 'none';
    const modeBtnIds: Record<MultimonMode, string> = {
      flex: 'btnFlex',     flex_next: 'btnFlexNext',
      ufsk1200: 'btnUfsk1200', afsk2400: 'btnAfsk2400',
      hapn4800: 'btnHapn4800', fsk9600: 'btnFsk9600',
      dpzvei: 'btnDpzvei', morse: 'btnCwm',
      clipfsk: 'btnClipFsk', fmsfsk: 'btnFmsFsk',
      dtmf: 'btnDtmf',     zvei:  'btnZvei',
      afsk1200: 'btnAfsk1200', x10: 'btnX10',
      eas:  'btnEas',      dsc:  'btnDsc',
      ccir: 'btnCcir',     ccitt: 'btnCcitt',
      eea:  'btnEea',      eia:   'btnEia',
      euro: 'btnEuro',
    };
    for (const id of Object.values(modeBtnIds)) {
      this.$(id).classList.toggle('active', false);
    }
    if (this.multimonOn) {
      this.$(modeBtnIds[mode]).classList.add('active');
      this.$('multimonStatus').textContent = `${mode.toUpperCase()} starting…`;
      this.multimonDecoder = new MultimonDecoder(mode, {
        onStatus: (s) => { this.$('multimonStatus').textContent = `${mode.toUpperCase()} — ${s}`; },
        onEvent:  (ev) => this.appendMultimonEvent(ev),
        onText:   (line) => this.appendMultimonText(line),
      });
      this.player.onMultimon = (samples) => this.multimonDecoder?.feed(samples);
    } else {
      this.player.onMultimon = null;
      this.multimonDecoder?.close();
      this.multimonDecoder = null;
    }
  }

  private appendMultimonEvent(ev: MultimonEvent): void {
    const ts = new Date(ev.tsMs).toISOString().slice(11, 19);
    const parts = [
      `${ts}  ${ev.mode.toUpperCase()}`,
      ev.ric     ? `RIC=${ev.ric}`       : '',
      ev.fmt     ? `fmt=${ev.fmt}`       : '',
      ev.kind    ? `kind=${ev.kind}`     : '',
      ev.digits  ? `digits=${ev.digits}` : '',
      ev.code    ? `code=${ev.code}`     : '',
      ev.payload ? `${ev.payload}`       : '',
    ].filter(Boolean);
    const el = this.$('multimonText');
    el.textContent = (el.textContent || '') + parts.join('  ') + '\n';
    const t = el.textContent;
    if (t.length > 16000) el.textContent = t.slice(t.length - 16000);
    el.scrollTop = el.scrollHeight;
    const tag = ev.ric ?? ev.digits ?? ev.code ?? '';
    if (tag) this.banner(`${ev.mode.toUpperCase()} ${tag}`, 1500);
  }

  /** Vendored-binary decoder dispatch — MSK144 / AIS / ACARS /
   *  TETRAPOL / OP25 / LRPT all share one panel and one decoder
   *  instance. Switching to a new kind tears down the current
   *  decoder and spawns a fresh WebSocket to the new endpoint. */
  private toggleVendored(
    kind: 'msk144'|'ais'|'acars'|'tetrapol'|'op25'|'lrpt',
    endpoint: string,
    sink: 'onMsk144'|'onAis'|'onAcars'|'onTetrapol'|'onOp25'|'onLrpt',
  ): void {
    const wasOn = this.vendoredOn;
    this.vendoredOn = !wasOn;
    this.vendoredKind = this.vendoredOn ? kind : null;
    this.updateWaterfallStream();
    const panel = this.$('vendoredPanel');
    panel.style.display = this.vendoredOn ? '' : 'none';
    const allBtnIds = ['btnMsk144','btnAis','btnAcars','btnOp25','btnLrpt'];
    for (const id of allBtnIds) this.$(id).classList.toggle('active', false);
    // Derive the display label from the WS endpoint path rather than
    // the routing `kind` — every IQ-in decoder shares kind='lrpt' but
    // the operator should see "ADS-B" / "VDL-2" / etc.
    const epName = (endpoint.match(/\/ws\/decode\/([^/?]+)/)?.[1] ?? kind).toUpperCase();
    if (this.vendoredOn) {
      this.$(`btn${kind.charAt(0).toUpperCase()}${kind.slice(1)}`).classList.add('active');
      this.$('vendoredStatus').textContent = `${epName} starting…`;
      this.vendoredDecoder = new VendoredDecoder({
        endpoint,
        onStatus: (s) => { this.$('vendoredStatus').textContent = `${epName} — ${s}`; },
        onText:   (line) => this.appendVendoredLine(`${epName}: ${line}`),
        onEvent:  (ev) => this.appendVendoredLine(`${epName}: ${JSON.stringify(ev)}`),
        onSpot:   (sp) => this.appendVendoredLine(`${epName} spot: ${JSON.stringify(sp)}`),
        onImage:  (img) => {
          this.appendVendoredLine(`${epName} image: ${img.name}`);
          const el = this.$('vendoredImg') as HTMLImageElement;
          // Revoke the previous URL so we don't leak.
          const prev = el.dataset.blobUrl;
          if (prev) { try { URL.revokeObjectURL(prev); } catch {} }
          el.src = img.url;
          el.dataset.blobUrl = img.url;
          el.dataset.fileName = img.name;
          el.style.display = '';
          (this.$('vendoredImgSave') as HTMLElement).style.display = '';
        },
      });
      // MSK144 wants dial freq so spots come back annotated.
      if (kind === 'msk144') this.vendoredDecoder.sendDial(this.freqKHz);
      // LRPT runs on raw IQ baseband (satdump expects this); every
      // other vendored binary takes int16 audio. The RTL-SDR backend
      // (when added) will also surface its samples through `onIq`, so
      // LRPT works there too without per-source branching.
      if (kind === 'lrpt') {
        const dec = this.vendoredDecoder;
        this.player.onIq = (iqBytes: Uint8Array) => dec?.feedIq(iqBytes);
        // Warn if we're on a Kiwi connection in a non-IQ mode — LRPT
        // needs the IQ pipeline running upstream.
        if (this.mode !== 'iq' && !this.isOwrxSource()) {
          this.banner('LRPT needs IQ mode — switch to MODE → IQ', 3000);
        }
      } else {
        this.player[sink] = (samples: Int16Array) => this.vendoredDecoder?.feed(samples);
      }
    } else {
      // Detach whichever sink was wired. exclusiveActivate already
      // tore down any other IQ consumer, so clearing onIq here is
      // safe — the only way it could still be set is if the kind we
      // just stopped was lrpt.
      const sinks: Array<'onMsk144'|'onAis'|'onAcars'|'onTetrapol'|'onOp25'|'onLrpt'> =
        ['onMsk144','onAis','onAcars','onTetrapol','onOp25','onLrpt'];
      for (const s of sinks) this.player[s] = null;
      if (kind === 'lrpt') this.player.onIq = null;
      // Tear down the image — the decoder.close() above also revokes
      // the blob URL it minted, but we still need to clear the <img>
      // src so the broken-image icon doesn't flash.
      const img = this.$('vendoredImg') as HTMLImageElement;
      const prev = img.dataset.blobUrl;
      if (prev) { try { URL.revokeObjectURL(prev); } catch {} }
      img.src = '';
      img.style.display = 'none';
      delete img.dataset.blobUrl;
      delete img.dataset.fileName;
      (this.$('vendoredImgSave') as HTMLElement).style.display = 'none';
      this.vendoredDecoder?.close();
      this.vendoredDecoder = null;
    }
  }

  private vendoredEndpointFor(kind: 'msk144'|'ais'|'acars'|'tetrapol'|'op25'|'lrpt'): string {
    return `/ws/decode/${kind}`;
  }

  /** satdump pipeline selector — reuses the LRPT WS endpoint with a
   *  `?pipeline=` query param so a single server-side bridge handles
   *  Meteor M2 LRPT / NOAA HRPT / NOAA APT. */
  private toggleSatdump(pipeline: 'hrpt' | 'apt'): void {
    if (this.vendoredOn && this.vendoredKind === 'lrpt') {
      // Tear down whatever pipeline is running, then start the new one.
      this.toggleVendored('lrpt', `/ws/decode/lrpt?pipeline=${pipeline}`, 'onLrpt');
      return;
    }
    this.exclusiveActivate('vendored');
    this.toggleVendored('lrpt', `/ws/decode/lrpt?pipeline=${pipeline}`, 'onLrpt');
  }

  private vendoredSinkFor(kind: 'msk144'|'ais'|'acars'|'tetrapol'|'op25'|'lrpt'):
    'onMsk144'|'onAis'|'onAcars'|'onTetrapol'|'onOp25'|'onLrpt' {
    switch (kind) {
      case 'msk144':   return 'onMsk144';
      case 'ais':      return 'onAis';
      case 'acars':    return 'onAcars';
      case 'tetrapol': return 'onTetrapol';
      case 'op25':     return 'onOp25';
      case 'lrpt':     return 'onLrpt';
    }
  }

  private appendVendoredLine(line: string): void {
    const el = this.$('vendoredText');
    const ts = new Date().toISOString().slice(11, 19);
    el.textContent = (el.textContent || '') + `${ts}  ${line}\n`;
    const t = el.textContent;
    if (t.length > 16000) el.textContent = t.slice(t.length - 16000);
    el.scrollTop = el.scrollHeight;
  }

  private appendMultimonText(line: string): void {
    const el = this.$('multimonText');
    el.textContent = (el.textContent || '') + line + '\n';
    const t = el.textContent;
    if (t.length > 16000) el.textContent = t.slice(t.length - 16000);
    el.scrollTop = el.scrollHeight;
  }

  private appendPocsPage(p: PocsagPage): void {
    const el = this.$('pocsText');
    const ts = new Date(p.tsMs).toISOString().slice(11, 19);
    const head = `${ts}  POCSAG${p.baud}  RIC ${p.address}  fn=${p.fn}`;
    const body = p.kind === 'tone' ? '(tone only)' : `${p.kind.toUpperCase()}: ${p.payload}`;
    const line = `${head}  ${body}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 16000) el.textContent = t.slice(t.length - 16000);
    el.scrollTop = el.scrollHeight;
    this.banner(`POCSAG ${p.address}`, 1500);
  }

  private appendSelcalCall(c: SelcalCall): void {
    const el = this.$('selcalText');
    const ts = new Date(c.tsMs).toISOString().slice(11, 19);
    // Standard SELCAL display format is the 4-letter code split by a
    // dash between the two tone pairs: "ABCD" → "AB-CD".
    const pretty = c.code.length === 4 ? `${c.code.slice(0, 2)}-${c.code.slice(2)}` : c.code;
    const line = `${ts}  ${pretty}  · ${this.freqKHz.toFixed(1)} kHz\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
    this.banner(`SELCAL: ${pretty}`, 1500);
  }

  /** Toggle the JT4 batch decoder. UTC-aligned on 1-minute slots,
   *  same as JT9/JT65. Auto-tunes to 14.078 MHz USB (the WSJT-X
   *  default 20 m calling) if not already within 100 kHz of a JT4
   *  dial. JT4 traffic is sparse on HF — most use is on VHF for EME
   *  / weak tropo — so don't expect frequent decodes. */
  private toggleJt4() {
    this.jt4On = !this.jt4On;
    this.updateWaterfallStream();
    const btn = this.$('btnJt4');
    const panel = this.$('jt4Panel');
    btn.classList.toggle('active', this.jt4On);
    panel.style.display = this.jt4On ? '' : 'none';
    if (this.jt4On) {
      const JT4_DIALS = [1.838, 3.578, 7.078, 10.138, 14.078, 18.104, 21.078, 24.919, 28.078];
      const onBand = JT4_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 100);
      if (!onBand) {
        this.freqKHz = 14078.0;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 0;
        this.highCut = 3000;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const sr = this.player.getInputRate() || 12000;
      this.jt4Decoder = new Jt4Decoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('jt4Status').textContent = `JT4 ${s}`; },
        onSpot: (spot) => this.appendJt4Spot(spot),
      });
      this.player.onJt4 = (s) => this.jt4Decoder?.feed(s);
    } else {
      this.player.onJt4 = null;
      this.jt4Decoder?.close();
      this.jt4Decoder = null;
    }
  }

  private appendJt4Spot(s: Jt4Spot) {
    const el = this.$('jt4Text');
    const snr = (s.snrDb >= 0 ? '+' : '') + s.snrDb.toString().padStart(3);
    const dt  = s.dtSec.toFixed(1).padStart(5);
    const off = (s.freqHz >= 0 ? '+' : '') + s.freqHz.toString().padStart(5);
    const line = `${s.time}  ${snr} dB  ${dt} s  ${off} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle the Throb (fldigi-vendored) chat decoder. Default submode
   *  is Throb-1 (the narrowest / most robust variant). The operator
   *  picks a different submode from the panel's action row. */
  private toggleThrob(): void {
    this.throbOn = !this.throbOn;
    this.updateWaterfallStream();
    const btn = this.$('btnThrob');
    const panel = this.$('throbPanel');
    btn.classList.toggle('active', this.throbOn);
    panel.style.display = this.throbOn ? '' : 'none';
    if (this.throbOn) {
      if (this.mode !== 'usb' && this.mode !== 'lsb') this.setMode('usb');
      this.throbDecoder = new ThrobFldigiDecoder({
        sampleRate: this.player.getInputRate() || 12000,
        mode: this.throbMode,
        pitchHz: 1000,
        onStatus: (s) => { this.$('throbStatus').textContent = `Throb ${s}`; },
        onChar: (ch) => this.appendThrobChar(ch),
      });
      this.player.onThrob = (samples) => this.throbDecoder?.feed(samples);
      this.refreshThrobModeButtons();
    } else {
      this.player.onThrob = null;
      this.throbDecoder?.close();
      this.throbDecoder = null;
    }
  }

  private setThrobMode(mode: ThrobMode): void {
    this.throbMode = mode;
    if (this.throbDecoder) this.throbDecoder.setMode(mode);
    this.refreshThrobModeButtons();
  }

  private refreshThrobModeButtons(): void {
    for (const [id, mode] of [
      ['throbMode1',  'throb1'],
      ['throbMode2',  'throb2'],
      ['throbMode4',  'throb4'],
      ['throbModeX1', 'throbx1'],
      ['throbModeX2', 'throbx2'],
      ['throbModeX4', 'throbx4'],
    ] as const) {
      const el = this.root.querySelector('#' + id) as HTMLElement | null;
      if (el) el.classList.toggle('active', mode === this.throbMode);
    }
  }

  private appendThrobChar(ch: string): void {
    const el = this.$('throbText');
    el.textContent = (el.textContent || '') + ch;
    const t = el.textContent;
    if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle FreeDV (open-source HF digital voice). Auto-tunes to
   *  14.236 MHz USB (20 m FreeDV calling channel) if the receiver
   *  isn't already on a known FreeDV spot. Decoded speech plays
   *  through its own GainNode mounted on the player's AudioContext,
   *  separate from the main Kiwi audio path (which carries the raw
   *  modem signal — usually muted by the operator via VOL). */
  private toggleFreedv(): void {
    this.freedvOn = !this.freedvOn;
    this.updateWaterfallStream();
    const btn = this.$('btnFreedv');
    const panel = this.$('freedvPanel');
    btn.classList.toggle('active', this.freedvOn);
    panel.style.display = this.freedvOn ? '' : 'none';
    if (this.freedvOn) {
      // Common FreeDV gathering spots (USB). 14.236 is the universal
      // 20 m calling frequency.
      const FREEDV_DIALS = [3.625, 3.643, 7.197, 14.236, 21.313, 28.330];
      const onBand = FREEDV_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 5);
      if (!onBand) {
        this.freqKHz = 14236.0;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 100;
        this.highCut = 2900;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const ctx = this.player.getOrCreateCtx();
      if (!ctx) {
        this.appendFreedvStatus('audio context unavailable — tap the FDV button directly (Safari needs a user gesture)');
        this.freedvOn = false;
        btn.classList.remove('active');
        panel.style.display = 'none';
        return;
      }
      // Safari starts AudioContexts in 'suspended' state; resume on the
      // user gesture so AudioBufferSourceNode playback actually fires.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      this.freedvDecoder = new FreedvDecoder({
        ctx,
        outputRate: 8000,
        mode: this.freedvMode,
        dialKHz: this.freqKHz,
        onStatus: (s) => this.appendFreedvStatus(s),
      });
      this.player.onFreedv = (samples) => this.freedvDecoder?.feed(samples);
      this.refreshFreedvModeButtons();
    } else {
      this.player.onFreedv = null;
      this.freedvDecoder?.close();
      this.freedvDecoder = null;
    }
  }

  /** Switch FreeDV submode. The server-side bridge will restart
   *  `freedv_rx` with the new flag (the modem is mode-pinned at
   *  startup; live-reconfiguration isn't supported in the codec2
   *  CLI). Re-sync takes 1-3 seconds typically. */
  private setFreedvMode(mode: FreedvMode): void {
    this.freedvMode = mode;
    if (this.freedvDecoder) this.freedvDecoder.setMode(mode);
    this.refreshFreedvModeButtons();
  }

  private refreshFreedvModeButtons(): void {
    for (const [id, mode] of [
      ['freedvMode1600', '1600'],
      ['freedvMode700C', '700C'],
      ['freedvMode700D', '700D'],
      ['freedvMode700E', '700E'],
      ['freedvMode2020', '2020'],
    ] as const) {
      const el = this.root.querySelector('#' + id) as HTMLElement | null;
      if (el) el.classList.toggle('active', mode === this.freedvMode);
    }
  }

  private appendFreedvStatus(s: string): void {
    this.$('freedvStatus').textContent = `FreeDV ${s}`;
    const el = this.$('freedvLog');
    const ts = new Date().toISOString().slice(11, 19);
    el.textContent = (el.textContent || '') + `${ts}  ${s}\n`;
    const t = el.textContent;
    if (t.length > 4000) el.textContent = t.slice(t.length - 4000);
    el.scrollTop = el.scrollHeight;
  }

  /** Toggle MCW (Modulated CW). MCW is plain Morse keyed on an audio
   *  tone, broadcast via an AM (sometimes FM) carrier — so unlike
   *  regular CW it's read with the receiver in AM mode, then the
   *  audio tone goes through the same dit/dah detector as ordinary
   *  CW. We just orchestrate the mode flip + CW-decoder activation.
   *
   *  The MCW indicator stays lit as long as both halves of the
   *  shortcut are still in place (AM-family mode + CW decoder on);
   *  if the operator changes mode manually, we surrender the badge
   *  but leave the CW decoder running — same behaviour as turning
   *  off any other panel mid-session. */
  private toggleMcw(): void {
    this.mcwOn = !this.mcwOn;
    const btn = this.$('btnMcw');
    btn.classList.toggle('active', this.mcwOn);
    if (this.mcwOn) {
      // Switch to AM with a wide-ish audio passband — MCW transmitters
      // pick tones anywhere from 400 Hz to 1500 Hz, so 200..3000 Hz
      // captures all of them without resampling.
      if (this.mode !== 'am' && this.mode !== 'amn') this.setMode('am');
      this.lowCut = -3000;
      this.highCut = 3000;
      this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
      this.refresh();
      // Activate the existing CW decoder if it isn't already on.
      if (!this.cwOn) this.toggleCw();
      this.banner('MCW · AM + CW decoder', 1500);
    } else {
      // Turn off the CW decoder side of the shortcut. Leave AM mode
      // in place so the operator can keep listening if they want.
      if (this.cwOn) this.toggleCw();
    }
  }

  /** Toggle the analog SSTV decoder. Auto-tunes to 14.230 MHz USB
   *  (20 m SSTV calling channel) on first activation; the operator
   *  can also bring up the panel and tune to 7.171 / 21.340 / 28.680
   *  manually for the other common SSTV nets. */
  private toggleSstv() {
    this.sstvOn = !this.sstvOn;
    this.updateWaterfallStream();
    const btn = this.$('btnSstv');
    const panel = this.$('sstvPanel');
    btn.classList.toggle('active', this.sstvOn);
    panel.style.display = this.sstvOn ? '' : 'none';
    if (this.sstvOn) {
      // Common SSTV calling spots (USB). 14.230 is the universal
      // calling frequency; the others see steady traffic on weekends.
      const SSTV_DIALS = [3.730, 3.845, 7.171, 14.230, 14.233, 21.340, 28.680];
      const onBand = SSTV_DIALS.some(mhz => Math.abs(this.freqKHz - mhz * 1000) < 5);
      if (!onBand) {
        this.freqKHz = 14230.0;
        if (this.mode !== 'usb') this.setMode('usb');
        this.lowCut = 100;
        this.highCut = 2900;
        this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
        this.recenter();
        this.refresh();
      }
      const sr = this.player.getInputRate() || 12000;
      this.sstvDecoder = new SstvDecoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('sstvStatus').textContent = `SSTV ${s}`; },
        onImage: (img) => this.onSstvImage(img),
      });
      this.player.onSstv = (s) => this.sstvDecoder?.feed(s);
    } else {
      this.player.onSstv = null;
      this.sstvDecoder?.close();
      this.sstvDecoder = null;
    }
  }

  private onSstvImage(img: SstvImage) {
    this.sstvLastImage = img;
    (this.$('sstvImage') as HTMLImageElement).src = img.dataUrl;
    const ts = new Date(img.tsMs).toISOString().slice(11, 19);
    this.$('sstvStatus').textContent = `SSTV ${ts}  ${img.mode}  ✓`;
    this.banner(`SSTV image: ${img.mode}`, 1800);
  }

  /** Stream the last received PNG to disk via an anchor download. */
  private saveSstvImage() {
    const img = this.sstvLastImage;
    if (!img) { this.banner('No SSTV image yet', 1200); return; }
    const a = document.createElement('a');
    const stamp = new Date(img.tsMs).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = img.dataUrl;
    a.download = `sstv_${stamp}_${img.mode}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Toggle the Feld-Hellschreiber renderer. Pure client-side DSP —
   *  the operator tunes USB / LSB so the keyed carrier falls at
   *  ~1000 Hz audio offset and reads the resulting image strip by
   *  eye. There is no decoded-text output; Hell is fundamentally a
   *  visual mode. */
  private toggleHell() {
    this.hellOn = !this.hellOn;
    const btn = this.$('btnHell');
    const panel = this.$('hellPanel');
    btn.classList.toggle('active', this.hellOn);
    panel.style.display = this.hellOn ? '' : 'none';
    if (this.hellOn) {
      this.clearHellCanvas();
      this.hellDecoder = new HellDecoder({
        audioCenterHz: 1000,
        onColumn: (col) => this.paintHellColumn(col),
      });
      this.player.onHell = (s) => this.hellDecoder?.feed(s);
    } else {
      this.player.onHell = null;
      this.hellDecoder?.close();
      this.hellDecoder = null;
    }
  }

  private clearHellCanvas(): void {
    const c = this.$('hellCanvas') as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    if (c.width !== Math.floor(cssW * dpr) || c.height !== Math.floor(cssH * dpr)) {
      c.width = Math.floor(cssW * dpr);
      c.height = Math.floor(cssH * dpr);
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
  }

  /** Paint one Hellschreiber column at the right edge of the canvas
   *  and scroll the rest left by one pixel. The 14-row intensity
   *  vector from the decoder is identical top-to-bottom (Hell is a
   *  per-column mode); we still paint each row independently so the
   *  canvas height shapes the character glyph naturally. */
  private paintHellColumn(col: Float32Array): void {
    const canvas = this.$('hellCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const W = canvas.width, H = canvas.height;
    if (W < 2 || H < 2) return;
    // Scroll left by 1 pixel.
    ctx.drawImage(canvas, 1, 0, W - 1, H, 0, 0, W - 1, H);
    // Paint the new column on the right. The 14-row vector maps
    // linearly onto the canvas height — taller canvases just stretch
    // the strip, since each column is intentionally a single intensity.
    const strip = ctx.createImageData(1, H);
    const buf32 = new Uint32Array(strip.data.buffer);
    for (let y = 0; y < H; y++) {
      const k = Math.floor((y / H) * col.length);
      const t = col[k];
      // Phosphor-amber on black so the panel reads like a vintage
      // teleprinter — high-intensity pixels glow green-yellow, low
      // ones fade to black through orange/red. Same palette as the
      // QRSS grabber so the two visual modes feel related.
      const v = (t * 255) | 0;
      const r = v;
      const g = t < 0.5 ? (t * 2 * 255) | 0 : 255;
      const b = t > 0.8 ? (((t - 0.8) / 0.2) * 255) | 0 : 0;
      buf32[y] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
    ctx.putImageData(strip, W - 1, 0);
  }

  /** Render a STANAG status frame to the panel. The compact status
   *  line updates every second; verdict transitions are also appended
   *  to a scrolling log so the operator can see when a signal popped
   *  in or out during a tuning sweep. */
  private renderStanagStatus(s: StanagStatus, getLast: () => string, setLast: (v: string) => void) {
    const cBar = s.carrierLock ? '●' : '○';
    const sBar = s.symbolLock ? '●' : '○';
    const yBar = s.syncLock ? '●' : '○';
    const verdictLabel = { present: 'STANAG 4285 PRESENT', maybe: 'maybe …', absent: 'no signal' }[s.verdict];
    this.$('stanagStatus').textContent =
      `${verdictLabel} · ${cBar} carrier ${s.carrierDbBump.toFixed(1)} dB · ` +
      `${sBar} symbol ${s.symbolPower.toFixed(2)} · ` +
      `${yBar} sync ${s.syncCorr.toFixed(2)}`;
    if (s.verdict !== getLast()) {
      setLast(s.verdict);
      const ts = new Date().toISOString().slice(11, 19);
      const el = this.$('stanagText');
      el.textContent = (el.textContent || '') + `${ts}  → ${verdictLabel}\n`;
      const t = el.textContent;
      if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
      el.scrollTop = el.scrollHeight;
    }
  }

  private toggleWspr() {
    this.wsprOn = !this.wsprOn;
    this.updateWaterfallStream();
    const btn = this.$('btnWspr');
    const panel = this.$('wsprPanel');
    btn.classList.toggle('active', this.wsprOn);
    panel.style.display = this.wsprOn ? '' : 'none';
    if (this.wsprOn) {
      // WSPR is a UTC-aligned batch decoder; it can stand by waiting
      // for audio. Don't require a live source — the user often wants
      // to enable WSPR first, then INJECT a sample so triggerNow()
      // resyncs the capture window to the playback start.
      const sr = this.player.getInputRate() || 12000;
      this.wsprDecoder = new WsprDecoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('wsprStatus').textContent = `WSPR ${s}`; },
        onSpot: (spot) => this.appendWsprSpot(spot),
      });
      this.player.onWspr = (s) => this.wsprDecoder?.feed(s);
    } else {
      this.player.onWspr = null;
      this.wsprDecoder?.close();
      this.wsprDecoder = null;
    }
  }

  private updateScopeStatus() {
    const arrow = this.scopeTriggerRising ? '↑' : '↓';
    this.$('scopeStatus').textContent = `SCOPE — trigger ${arrow} @ ${this.scopeTriggerLevel.toFixed(2)}`;
    this.$('scopeLevelVal').textContent = this.scopeTriggerLevel.toFixed(2);
  }

  private toggleJs8() {
    this.js8On = !this.js8On;
    this.updateWaterfallStream();
    const btn = this.$('btnJs8');
    const panel = this.$('js8Panel');
    btn.classList.toggle('active', this.js8On);
    panel.style.display = this.js8On ? '' : 'none';
    if (this.js8On) {
      // UTC-aligned batch decoder — can stand by waiting for audio,
      // so the user can enable JS8 first, then INJECT a sample.
      const sr = this.player.getInputRate() || 12000;
      this.js8Decoder = new Js8Decoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        onStatus: (s) => { this.$('js8Status').textContent = `JS8 ${s}`; },
        onSpot: (spot) => this.appendJs8Spot(spot),
      });
      this.player.onJs8 = (s) => this.js8Decoder?.feed(s);
    } else {
      this.player.onJs8 = null;
      this.js8Decoder?.close();
      this.js8Decoder = null;
    }
  }

  private appendJs8Spot(s: Js8Spot) {
    const el = this.$('js8Text');
    const snr = (s.snrDb >= 0 ? '+' : '') + s.snrDb.toString().padStart(3);
    const dt  = s.dtSec.toFixed(1).padStart(5);
    const off = (s.freqHz >= 0 ? '+' : '') + s.freqHz.toString().padStart(5);
    const line = `${s.time}  ${snr} dB  ${dt} s  ${off} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  private openJs8FreqPicker() {
    this.registerScanSet('JS8', JS8_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${JS8_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · USB · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = JS8_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.js8On) {
          this.exclusiveActivate('js8');
          this.toggleJs8();
        } else {
          this.js8Decoder?.setDial(f.freqKHz);
        }
        this.recenter();
        this.refresh();
        this.banner(`JS8 ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleFst4() {
    this.fst4On = !this.fst4On;
    this.updateWaterfallStream();
    const btn = this.$('btnFst4');
    const panel = this.$('fst4Panel');
    btn.classList.toggle('active', this.fst4On);
    panel.style.display = this.fst4On ? '' : 'none';
    if (this.fst4On) {
      // UTC-aligned batch decoder — can stand by waiting for audio,
      // so the user can enable FST4 first, then INJECT a sample.
      const sr = this.player.getInputRate() || 12000;
      this.fst4Decoder = new Fst4Decoder({
        sampleRate: sr,
        dialKHz: this.freqKHz,
        periodSec: 120,
        onStatus: (s) => { this.$('fst4Status').textContent = `FST4 ${s}`; },
        onSpot: (spot) => this.appendFst4Spot(spot),
      });
      this.player.onFst4 = (s) => this.fst4Decoder?.feed(s);
    } else {
      this.player.onFst4 = null;
      this.fst4Decoder?.close();
      this.fst4Decoder = null;
    }
  }

  private appendFst4Spot(s: Fst4Spot) {
    const el = this.$('fst4Text');
    const snr = (s.snrDb >= 0 ? '+' : '') + s.snrDb.toString().padStart(3);
    const dt  = s.dtSec.toFixed(1).padStart(5);
    const off = (s.freqHz >= 0 ? '+' : '') + s.freqHz.toString().padStart(5);
    const line = `${s.time}  ${snr} dB  ${dt} s  ${off} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  private openFst4FreqPicker() {
    this.registerScanSet('FST4W', FST4_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${FST4_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · USB · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = FST4_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        // setMode resets the passband to USB defaults — narrow it to
        // the WSJT-X-convention 1400-1600 Hz (200 Hz centred on the
        // 1500 Hz FSK keying centre) AFTER the mode switch.
        this.setMode('usb');
        this.lowCut  = 1400;
        this.highCut = 1600;
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.fst4On) {
          this.exclusiveActivate('fst4');
          this.toggleFst4();
        } else {
          this.fst4Decoder?.setDial(f.freqKHz);
        }
        this.recenter();
        this.refresh();
        this.banner(`FST4W ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** Robust copy-to-clipboard with three escalating fallbacks:
   *    1. navigator.clipboard.writeText — works on https / localhost.
   *    2. document.execCommand('copy')  — works in older browsers and
   *       most plain-http contexts where the user has just clicked a
   *       button (the click counts as a user gesture).
   *    3. Visible overlay with the text in a pre-selected textarea
   *       and a close button. Works in every environment, including
   *       headless previews where (1) and (2) both refuse. */
  private copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text).catch(() => this.copyViaExec(text));
    }
    return this.copyViaExec(text);
  }

  private copyViaExec(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      try {
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve();
        else { this.showCopyOverlay(text); resolve(); }
      } catch {
        document.body.removeChild(ta);
        this.showCopyOverlay(text);
        resolve();
      }
    });
  }

  /** Last-ditch copy: present the text in a visible textarea overlay
   *  so the user can manually select-all-copy. Closes on outside-tap
   *  or the close button. */
  private showCopyOverlay(text: string) {
    const root = document.createElement('div');
    root.className = 'copy-overlay';
    root.innerHTML = `
      <div class="copy-overlay-card">
        <div class="copy-overlay-hint">Tap-and-hold the text below to copy.</div>
        <textarea class="copy-overlay-text" readonly></textarea>
        <button class="copy-overlay-close" type="button">close</button>
      </div>
    `;
    document.body.appendChild(root);
    const ta = root.querySelector('textarea')!;
    ta.value = text;
    ta.focus();
    ta.select();
    const dismiss = () => root.remove();
    root.addEventListener('click', (e) => { if (e.target === root) dismiss(); });
    (root.querySelector('.copy-overlay-close') as HTMLElement).addEventListener('click', dismiss);
  }

  private appendWsprSpot(s: WsprSpot) {
    const el = this.$('wsprText');
    const line =
      `${s.time}  ${s.snrDb >= 0 ? '+' : ''}${s.snrDb.toString().padStart(3)} dB  ` +
      `${s.dtSec.toFixed(1).padStart(5)} s  ${s.freqMHz.toFixed(6)} MHz  ` +
      `${s.driftHz >= 0 ? '+' : ''}${s.driftHz} Hz  ${s.message}\n`;
    el.textContent = (el.textContent || '') + line;
    const t = el.textContent;
    if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
    el.scrollTop = el.scrollHeight;
  }

  private togglePacket() {
    // Tear down any sibling packet mode first — all four share the
    // same panel + `player.onPacket` sink.
    if (!this.packetOn) {
      if (this.packetVhfOn)  this.togglePacketVhf();
      if (this.packet9600On) this.togglePacket9600();
      if (this.packetIl2pOn) this.togglePacketIl2p();
    }
    this.packetOn = !this.packetOn;
    this.updateWaterfallStream();
    const btn = this.$('btnPacket');
    const panel = this.$('packetPanel');
    btn.classList.toggle('active', this.packetOn);
    panel.style.display = this.packetOn ? '' : 'none';
    if (this.packetOn) {
      const sr = this.player.getInputRate() || 12000;
      this.packetDecoder = new PacketDecoder({
        sampleRate: sr,
        onStatus: (s) => { this.$('packetStatus').textContent = `PACKET ${s}`; },
        onLine: (line) => {
          const el = this.$('packetText');
          el.textContent = (el.textContent || '') + line + '\n';
          const t = el.textContent;
          if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onPacket = (s) => this.packetDecoder?.feed(s);
    } else {
      this.player.onPacket = null;
      this.packetDecoder?.close();
      this.packetDecoder = null;
    }
  }

  /** VHF Bell-202 packet — same direwolf binary as the HF bridge but
   *  spawned with the 1200-baud config (?baud=1200 on the WS URL).
   *  Re-uses the same panel; only one of the two packet modes can be
   *  active at a time. */
  private togglePacketVhf() {
    // If any sibling packet mode is already running, tear it down
    // first — the panel is shared and they'd clobber each other.
    if (this.packetOn) this.togglePacket();
    if (this.packet9600On) this.togglePacket9600();
    if (this.packetIl2pOn) this.togglePacketIl2p();
    this.packetVhfOn = !this.packetVhfOn;
    this.updateWaterfallStream();
    const btn = this.$('btnPacketVhf');
    const panel = this.$('packetPanel');
    btn.classList.toggle('active', this.packetVhfOn);
    panel.style.display = this.packetVhfOn ? '' : 'none';
    if (this.packetVhfOn) {
      const sr = this.player.getInputRate() || 12000;
      this.packetVhfDecoder = new PacketDecoder({
        sampleRate: sr,
        baud: 1200,
        onStatus: (s) => { this.$('packetStatus').textContent = `PACKET-VHF ${s}`; },
        onLine: (line) => {
          const el = this.$('packetText');
          el.textContent = (el.textContent || '') + line + '\n';
          const t = el.textContent;
          if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onPacket = (s) => this.packetVhfDecoder?.feed(s);
    } else {
      this.player.onPacket = null;
      this.packetVhfDecoder?.close();
      this.packetVhfDecoder = null;
    }
  }

  /** 9600 G3RUH packet — wider audio chain than HF/VHF: the bridge
   *  upsamples 12k → 48k internally because direwolf needs ≥24 kHz
   *  Nyquist for the ~9.6 kHz G3RUH baseband. Source must actually
   *  carry that bandwidth (rtl_tcp/OWRX NBFM) — Kiwi audio (≤6 kHz)
   *  won't decode. Re-uses the same panel as HF/VHF; the three are
   *  mutually exclusive. */
  private togglePacket9600() {
    if (this.packetOn) this.togglePacket();
    if (this.packetVhfOn) this.togglePacketVhf();
    if (this.packetIl2pOn) this.togglePacketIl2p();
    this.packet9600On = !this.packet9600On;
    this.updateWaterfallStream();
    const btn = this.$('btnPacket9600');
    const panel = this.$('packetPanel');
    btn.classList.toggle('active', this.packet9600On);
    panel.style.display = this.packet9600On ? '' : 'none';
    if (this.packet9600On) {
      const sr = this.player.getInputRate() || 12000;
      this.packet9600Decoder = new PacketDecoder({
        sampleRate: sr,
        baud: 9600,
        onStatus: (s) => { this.$('packetStatus').textContent = `PACKET-9600 ${s}`; },
        onLine: (line) => {
          const el = this.$('packetText');
          el.textContent = (el.textContent || '') + line + '\n';
          const t = el.textContent;
          if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onPacket = (s) => this.packet9600Decoder?.feed(s);
    } else {
      this.player.onPacket = null;
      this.packet9600Decoder?.close();
      this.packet9600Decoder = null;
    }
  }

  /** IL2P framing on the same VHF 1200 Bell-202 carrier as VPKT.
   *  Direwolf decodes Reed-Solomon-protected frames that vanilla AX.25
   *  would miss in marginal conditions. Re-uses the same panel as the
   *  other packet modes; mutually exclusive with HF/VHF/9600. */
  private togglePacketIl2p() {
    if (this.packetOn) this.togglePacket();
    if (this.packetVhfOn) this.togglePacketVhf();
    if (this.packet9600On) this.togglePacket9600();
    this.packetIl2pOn = !this.packetIl2pOn;
    this.updateWaterfallStream();
    const btn = this.$('btnPacketIl2p');
    const panel = this.$('packetPanel');
    btn.classList.toggle('active', this.packetIl2pOn);
    panel.style.display = this.packetIl2pOn ? '' : 'none';
    if (this.packetIl2pOn) {
      const sr = this.player.getInputRate() || 12000;
      this.packetIl2pDecoder = new PacketDecoder({
        sampleRate: sr,
        baud: 1200,
        framing: 'il2p',
        onStatus: (s) => { this.$('packetStatus').textContent = `PACKET-IL2P ${s}`; },
        onLine: (line) => {
          const el = this.$('packetText');
          el.textContent = (el.textContent || '') + line + '\n';
          const t = el.textContent;
          if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onPacket = (s) => this.packetIl2pDecoder?.feed(s);
    } else {
      this.player.onPacket = null;
      this.packetIl2pDecoder?.close();
      this.packetIl2pDecoder = null;
    }
  }

  private toggleNavtex() {
    this.navtexOn = !this.navtexOn;
    this.updateWaterfallStream();
    const btn = this.$('btnNavtex');
    const panel = this.$('navtexPanel');
    btn.classList.toggle('active', this.navtexOn);
    panel.style.display = this.navtexOn ? '' : 'none';
    if (this.navtexOn) {
      const sr = this.player.getInputRate() || 12000;
      this.navtexDecoder = new NAVTEXDecoder({
        sampleRate: sr,
        mode: this.settings.navtexMode,
        carrierHz: this.settings.navtexCarrierHz,
        onStatus: (s) => { this.$('navtexStatus').textContent = `NAVTEX ${s}`; },
        onChar: (ch) => {
          const el = this.$('navtexText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onNavtex = (s) => this.navtexDecoder?.feed(s);
    } else {
      this.player.onNavtex = null;
      this.navtexDecoder?.close();
      this.navtexDecoder = null;
    }
  }

  private toggleAle() {
    this.aleOn = !this.aleOn;
    this.updateWaterfallStream();
    const btn = this.$('btnAle');
    const panel = this.$('alePanel');
    btn.classList.toggle('active', this.aleOn);
    panel.style.display = this.aleOn ? '' : 'none';
    if (this.aleOn) {
      const sr = this.player.getInputRate() || 12000;
      this.aleDecoder = new ALE2GDecoder({
        sampleRate: sr,
        onStatus: (s) => { this.$('aleStatus').textContent = `ALE ${s}`; },
        onLine: (line) => {
          const el = this.$('aleText');
          el.textContent = (el.textContent || '') + line + '\n';
          const t = el.textContent;
          if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onAle = (s) => this.aleDecoder?.feed(s);
    } else {
      this.player.onAle = null;
      this.aleDecoder?.close();
      this.aleDecoder = null;
    }
  }

  /** Set the receiver to IQ mode at `freqKHz` for HFDL reception. Used
   *  both by toggleHfdl (defaulting to GS-1 SF when nothing was tuned)
   *  and by the freq picker. Caller decides whether to also flip the
   *  decoder on/off. */
  private tuneHfdlChannel(freqKHz: number) {
    this.freqKHz = freqKHz;
    this.setMode('iq');
    this.client?.setTune({
      mode: this.mode, freqKHz: this.freqKHz,
      lowCutHz: this.lowCut, highCutHz: this.highCut,
    });
    this.recenter();
    this.refresh();
  }

  private toggleHfdl() {
    this.hfdlOn = !this.hfdlOn;
    this.updateWaterfallStream();
    const btn = this.$('btnHfdl');
    const panel = this.$('hfdlPanel');
    btn.classList.toggle('active', this.hfdlOn);
    panel.style.display = this.hfdlOn ? '' : 'none';
    if (this.hfdlOn) {
      // Default to GS-1 San Francisco 11.184 MHz unless we're already
      // sitting on an HFDL channel — preserves picker selection.
      const onChannel = HFDL_FREQS.some(f => f.freqKHz === this.freqKHz);
      const target = onChannel ? this.freqKHz : 11184.0;
      this.tuneHfdlChannel(target);
      const sr = this.player.getInputRate() || 12000;
      this.hfdlDecoder = new HFDLDecoder({
        freqKHz: target,
        centerKHz: target,
        onStatus: (s) => { this.$('hfdlStatus').textContent = `HFDL ${s} · ${target.toFixed(3)} kHz · ${sr} Hz IQ`; },
        onMessage: (msg: unknown) => {
          const el = this.$('hfdlText');
          let block = '';
          // Try to surface a one-line position / aircraft summary if the
          // PDU carries lat/lon. Most HFDL frames don't (squitters, freq
          // data, sounds), so the summary is best-effort and falls back
          // to the raw JSON dump for anything we can't parse.
          const summary = summarizeHfdl(msg);
          if (summary) block += summary + '\n';
          let line: string;
          try {
            line = JSON.stringify(msg, null, 0);
            if (line.length > 800) line = line.slice(0, 800) + '…';
          } catch { line = String(msg); }
          block += line + '\n';
          el.textContent = (el.textContent || '') + block;
          const t = el.textContent;
          if (t.length > 16000) el.textContent = t.slice(t.length - 16000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onIq = (b) => this.hfdlDecoder?.feed(b);
    } else {
      this.player.onIq = null;
      this.hfdlDecoder?.close();
      this.hfdlDecoder = null;
      // Drop back to USB so the speaker has a usable demodulation when
      // the user turns HFDL off (otherwise the player stays in IQ-mode
      // short-circuit and audio is silent).
      if (this.mode === 'iq') this.setMode('usb');
    }
  }

  /** Exalted-Carrier Selective-Sideband: a one-shot alignment helper.
   *  Reads the latest 1024-bin waterfall slice, finds the strongest
   *  peak within ±300 Hz of the cursor (i.e. the AM carrier the user
   *  is roughly tuned to), refines it with parabolic interpolation,
   *  retunes Kiwi so that carrier sits ~30 Hz inside the SSB passband
   *  edge, and picks USB or LSB based on which side has more audio-
   *  band energy. ECSS uses the receiver's stable LO as the BFO — no
   *  PLL, no lock-loss — so a single tap usually nets the cleanest
   *  AM-broadcast demod the band offers, free of the synchronous
   *  detector's selective-fade artefacts. */
  private doEcssAlign(): void {
    const bins = this.lastWfBins;
    if (!bins || bins.length === 0) { this.banner('No spectrum yet', 1500); return; }
    const totalBins = 1024 * (1 << this.zoom);
    const hzPerBin = this.bandwidthHz / totalBins;
    // ECSS demands sub-30 Hz alignment; coarser zoom levels can't get
    // there. Tell the user to zoom in rather than mis-tune them.
    if (hzPerBin > 30) {
      this.banner(`Zoom in for ECSS (${hzPerBin.toFixed(0)} Hz/bin, need ≤30)`, 2400);
      return;
    }
    // Convert current tune freq into an absolute server-bin index.
    const tuneServerBin = (this.freqKHz * 1000) / hzPerBin;
    // Search window: ±300 Hz around the cursor, clamped to the visible
    // 1024-bin slice (xBinServer .. xBinServer+1024).
    const win = Math.ceil(300 / hzPerBin);
    const centreIdx = Math.round(tuneServerBin - this.lastWfXBinServer);
    const lo = Math.max(2, centreIdx - win);
    const hi = Math.min(bins.length - 3, centreIdx + win);
    if (hi <= lo + 2) {
      this.banner('Carrier out of WF view — recenter first', 2000);
      return;
    }
    // Peak pick. Bins are bytes mapped from minDb..maxDb; we treat them
    // as already-log-scale and just pick the max in the window.
    let bestIdx = lo, bestVal = -1;
    for (let i = lo; i <= hi; i++) {
      if (bins[i] > bestVal) { bestVal = bins[i]; bestIdx = i; }
    }
    // Reject if the peak isn't meaningfully above the local floor — no
    // carrier here, just noise.
    let floorSum = 0, floorN = 0;
    for (let i = Math.max(0, bestIdx - 100); i < Math.min(bins.length, bestIdx + 100); i++) {
      if (Math.abs(i - bestIdx) > 5) { floorSum += bins[i]; floorN++; }
    }
    const floor = floorN ? floorSum / floorN : 0;
    if (bestVal - floor < 18) {
      this.banner('No clear carrier near cursor', 1800);
      return;
    }
    // Parabolic interpolation for sub-bin precision (dB log-magnitude
    // peak is locally quadratic; vertex offset = ½·(yL−yR)/(yL−2y0+yR)).
    let frac = 0;
    const yL = bins[bestIdx - 1], y0 = bestVal, yR = bins[bestIdx + 1];
    const denom = yL - 2 * y0 + yR;
    if (denom !== 0) frac = 0.5 * (yL - yR) / denom;
    if (frac < -1 || frac > 1) frac = 0;
    const serverBin = this.lastWfXBinServer + bestIdx + frac;
    const carrierHz = serverBin * hzPerBin;

    // Sideband choice: sum energy 200..2500 Hz above vs below the
    // carrier (audio-band reach of an AM transmitter). The side with
    // more energy carries the modulation we want.
    const a0 = Math.ceil(200 / hzPerBin);
    const a1 = Math.ceil(2500 / hzPerBin);
    let upSum = 0, dnSum = 0, n = 0;
    for (let k = a0; k <= a1; k++) {
      const ui = bestIdx + k, di = bestIdx - k;
      if (ui < bins.length) { upSum += bins[ui]; n++; }
      if (di >= 0)           { dnSum += bins[di]; }
    }
    const useUsb = upSum >= dnSum;

    // Offset the tune so the carrier sits ~30 Hz inside the passband
    // edge — close enough to null with the 1-Hz tune buttons, far
    // enough that the carrier itself doesn't whistle.
    const offsetHz = useUsb ? -30 : 30;
    const newFreqKHz = (carrierHz + offsetHz) / 1000;
    this.freqKHz = newFreqKHz;
    // ECSS passband: open just past 0 Hz on the carrier side to let a
    // tiny bit of carrier in (helps the ear lock the beat), 3500 Hz on
    // the audio side for natural-sounding AM.
    this.lowCut  = useUsb ? -100  : -3500;
    this.highCut = useUsb ? 3500  : 100;
    if (this.mode !== (useUsb ? 'usb' : 'lsb')) this.setMode(useUsb ? 'usb' : 'lsb');
    this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
    this.recenter();
    this.refresh();
    this.banner(`ECSS ${useUsb ? 'USB' : 'LSB'} · ${(carrierHz / 1000).toFixed(3)} kHz`, 2200);
  }

  /** Quick-tune the receiver to the 30 m QRSS sub-band (10.140 MHz
   *  USB). Long-pressing the QRSS button calls this without toggling
   *  the panel — useful for repositioning while the grabber is open. */
  private tuneQrssBand(): void {
    this.freqKHz = 10140.0;
    this.lowCut = 200;
    this.highCut = 1500;
    if (this.mode !== 'usb') this.setMode('usb');
    this.client?.setTune({ mode: this.mode, freqKHz: this.freqKHz, lowCutHz: this.lowCut, highCutHz: this.highCut });
    this.recenter();
    this.refresh();
    this.banner('QRSS · 10.140 MHz USB', 1500);
  }

  /** Switch the column-emit period. Q3 ≈ 0.25 s/col, Q60 ≈ 6 s/col —
   *  matching the standard QRSS3/QRSS10/QRSS30/QRSS60 dot lengths so a
   *  single dot is at minimum 4 columns wide on the canvas. */
  private setQrssMode(m: 'q3' | 'q10' | 'q30' | 'q60' | 'q120'): void {
    this.qrssMode = m;
    this.updateQrssStatus();
    if (this.qrssOn) this.restartQrssTimer();
    for (const id of ['qrssMode3','qrssMode10','qrssMode30','qrssMode60','qrssMode120']) {
      const el = this.root.querySelector('#' + id) as HTMLElement | null;
      if (el) el.classList.toggle('active', id === 'qrssMode' + m.slice(1));
    }
  }

  private clearQrssCanvas(): void {
    const c = this.$('qrssCanvas') as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height); }
  }

  private updateQrssStatus(): void {
    const inputRate = this.player.getInputRate() || 12000;
    const hzPerBin = inputRate / this.qrssBuffer.length;
    const periodSec = ({ q3: 0.25, q10: 1.0, q30: 3.0, q60: 6.0, q120: 12.0 }[this.qrssMode]);
    const el = this.$('qrssStatus');
    if (this.qrssDfcw) {
      const c = this.qrssDfcwCenterHz;
      const span = this.qrssDfcwHalfSpanHz * 2;
      const ctxt = c == null ? 'locking…' : `${c.toFixed(1)} Hz ±${this.qrssDfcwHalfSpanHz}`;
      el.textContent = `DFCW · ${this.qrssMode.toUpperCase()} — ${hzPerBin.toFixed(2)} Hz/bin · ${ctxt} · Δ${this.qrssDfcwSpacingHz} Hz · ${periodSec}s/col · span ${span} Hz`;
    } else {
      el.textContent = `${this.qrssMode.toUpperCase()} — ${hzPerBin.toFixed(2)} Hz/bin · ${this.qrssAudioLo}–${this.qrssAudioHi} Hz · ${periodSec}s/col`;
    }
  }

  /** Toggle the DFCW overlay. Picks up the strongest in-band peak as
   *  the centre, then auto-tracks it on every subsequent column so the
   *  dit / dah reference lines stay locked to the transmitter. */
  private toggleQrssDfcw(): void {
    this.qrssDfcw = !this.qrssDfcw;
    this.qrssDfcwCenterHz = null;  // re-acquire on next column
    const btn = this.root.querySelector('#qrssDfcw') as HTMLElement | null;
    if (btn) btn.classList.toggle('active', this.qrssDfcw);
    this.clearQrssCanvas();
    this.updateQrssStatus();
  }

  private restartQrssTimer(): void {
    if (this.qrssTimer != null) { clearInterval(this.qrssTimer); this.qrssTimer = null; }
    const periodMs = { q3: 250, q10: 1000, q30: 3000, q60: 6000, q120: 12000 }[this.qrssMode];
    this.qrssTimer = window.setInterval(() => this.drawQrssColumn(), periodMs);
  }

  /** Toggle the QRSS grabber. When on, attaches to the player's audio
   *  fan-out and runs a periodic 16384-pt FFT (~0.73 Hz/bin at 12 kHz)
   *  with a Hann window, mapping the 400–1200 Hz audio passband to a
   *  vertical strip and scrolling left one pixel per emit period. The
   *  receiver should be in USB at 10.140 MHz for 30 m QRSS — the
   *  long-press shortcut sets that up. */
  private toggleQrss(): void {
    this.qrssOn = !this.qrssOn;
    const btn = this.$('btnQrss');
    const panel = this.$('qrssPanel');
    btn.classList.toggle('active', this.qrssOn);
    panel.style.display = this.qrssOn ? '' : 'none';
    if (this.qrssOn) {
      // Build the Hann window once at the size of the analysis buffer.
      if (!this.qrssWindow || this.qrssWindow.length !== this.qrssBuffer.length) {
        const N = this.qrssBuffer.length;
        this.qrssWindow = new Float32Array(N);
        for (let i = 0; i < N; i++) this.qrssWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      }
      this.qrssBuffer.fill(0);
      this.qrssWriteIdx = 0;
      this.qrssFilled = 0;
      this.clearQrssCanvas();
      this.updateQrssStatus();
      this.setQrssMode(this.qrssMode);  // syncs the active-button highlight
      this.player.onQrss = (s) => this.feedQrss(s);
      this.restartQrssTimer();
    } else {
      this.player.onQrss = null;
      if (this.qrssTimer != null) { clearInterval(this.qrssTimer); this.qrssTimer = null; }
    }
  }

  private feedQrss(samples: Int16Array): void {
    const buf = this.qrssBuffer;
    const N = buf.length;
    let w = this.qrssWriteIdx;
    for (let i = 0; i < samples.length; i++) {
      buf[w] = samples[i] / 32768;
      w = (w + 1) % N;
    }
    this.qrssWriteIdx = w;
    this.qrssFilled = Math.min(N, this.qrssFilled + samples.length);
  }

  private drawQrssColumn(): void {
    if (!this.qrssOn) return;
    const N = this.qrssBuffer.length;
    if (this.qrssFilled < N) return;     // wait for first full buffer
    const win = this.qrssWindow!;
    // Linearise the ring buffer into a contiguous windowed real input,
    // and supply a zero imag for the complex FFT.
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const w0 = this.qrssWriteIdx;
    for (let i = 0; i < N; i++) {
      const s = this.qrssBuffer[(w0 + i) % N];
      re[i] = s * win[i];
    }
    fft32k(re, im);
    const inputRate = this.player.getInputRate() || 12000;
    const hzPerBin = inputRate / N;

    // Pick the display band. DFCW: re-locate the center to the loudest
    // peak in the QRSS band on every column, low-pass smoothed so it
    // doesn't twitch between dit and dah.
    let displayLoHz: number, displayHiHz: number;
    if (this.qrssDfcw) {
      // Find loudest bin across the full QRSS band first.
      const wideLo = Math.max(1, Math.floor(this.qrssAudioLo / hzPerBin));
      const wideHi = Math.min(N >> 1, Math.ceil(this.qrssAudioHi / hzPerBin));
      let bestBin = wideLo, bestMag = 0;
      for (let b = wideLo; b <= wideHi; b++) {
        const m = re[b] * re[b] + im[b] * im[b];
        if (m > bestMag) { bestMag = m; bestBin = b; }
      }
      const peakHz = bestBin * hzPerBin;
      this.qrssDfcwCenterHz = this.qrssDfcwCenterHz == null
        ? peakHz
        : this.qrssDfcwCenterHz * 0.9 + peakHz * 0.1;
      displayLoHz = this.qrssDfcwCenterHz - this.qrssDfcwHalfSpanHz;
      displayHiHz = this.qrssDfcwCenterHz + this.qrssDfcwHalfSpanHz;
      this.updateQrssStatus();
    } else {
      displayLoHz = this.qrssAudioLo;
      displayHiHz = this.qrssAudioHi;
    }
    const loBin = Math.max(1, Math.floor(displayLoHz / hzPerBin));
    const hiBin = Math.min(N >> 1, Math.ceil(displayHiHz / hzPerBin));
    if (hiBin <= loBin + 2) return;

    const canvas = this.$('qrssCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const W = canvas.width, H = canvas.height;
    if (W < 2 || H < 2) return;

    // Scroll the entire canvas one pixel left, then paint the new
    // column at x = W - 1. drawImage onto self is well-defined.
    ctx.drawImage(canvas, 1, 0, W - 1, H, 0, 0, W - 1, H);

    // Build a 1×H ImageData strip. y=0 is top = highest freq.
    const strip = ctx.createImageData(1, H);
    const buf32 = new Uint32Array(strip.data.buffer);

    // Pre-compute magnitudes for the displayed band so we can normalise
    // against the in-band median (gives a clean floor regardless of AGC).
    const span = hiBin - loBin;
    const mags = new Float32Array(span);
    for (let k = 0; k < span; k++) {
      const b = loBin + k;
      mags[k] = Math.hypot(re[b], im[b]);
    }
    const sorted = mags.slice().sort();
    const median = sorted[sorted.length >> 1] || 1e-12;
    const floorDb = 20 * Math.log10(Math.max(median, 1e-12));
    const ceilDb  = floorDb + 36;  // 36 dB display range

    for (let y = 0; y < H; y++) {
      // top of canvas = highest frequency.
      const t = 1 - y / (H - 1);
      const binF = loBin + t * span;
      const k = Math.max(0, Math.min(span - 1, Math.round(binF - loBin)));
      const mag = mags[k];
      const db = 20 * Math.log10(Math.max(mag, 1e-12));
      const u = Math.max(0, Math.min(1, (db - floorDb) / (ceilDb - floorDb)));
      // Heat-ish palette: black → green → yellow → white.
      const v = (u * 255) | 0;
      const r = v;
      const g = u < 0.5 ? (u * 2 * 255) | 0 : 255;
      const bcol = u > 0.8 ? (((u - 0.8) / 0.2) * 255) | 0 : 0;
      buf32[y] = (255 << 24) | (bcol << 16) | (g << 8) | r;
    }
    ctx.putImageData(strip, W - 1, 0);

    // DFCW reference markers — two faint horizontal lines at the dit
    // (lower) and dah (higher) carrier frequencies. They're redrawn on
    // every column rather than once at toggle time because the centre
    // tracks the signal and the canvas scrolls underneath.
    if (this.qrssDfcw && this.qrssDfcwCenterHz != null) {
      const c = this.qrssDfcwCenterHz;
      const ditHz = c - this.qrssDfcwSpacingHz / 2;
      const dahHz = c + this.qrssDfcwSpacingHz / 2;
      const yOf = (hz: number) => {
        const t = (hz - displayLoHz) / (displayHiHz - displayLoHz);
        return Math.round((1 - t) * (H - 1));
      };
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#5cc8ff';
      ctx.fillRect(0, yOf(ditHz), W, 1);
      ctx.fillStyle = '#ff9a3c';
      ctx.fillRect(0, yOf(dahHz), W, 1);
      ctx.restore();
    }
  }

  /** Toggle the Independent-Sideband demodulator. Flips the receiver to
   *  IQ mode and runs a client-side overlap-add FFT to split LSB and
   *  USB into stereo (LSB → left, USB → right). Tapping again restores
   *  the previous USB demod path. */
  private toggleIsb() {
    this.isbOn = !this.isbOn;
    const btn = this.$('btnIsb');
    btn.classList.toggle('active', this.isbOn);
    if (this.isbOn) {
      if (this.mode !== 'iq') this.setMode('iq');
      const ctx = this.player.getOrCreateCtx();
      if (!ctx) { this.isbOn = false; btn.classList.remove('active'); return; }
      const inputRate = this.player.getInputRate() || 12000;
      this.isbDemod = new IsbDemod({ ctx, inputRate });
      this.player.onIq = (b) => this.isbDemod?.feed(b);
    } else {
      this.player.onIq = null;
      this.isbDemod?.close();
      this.isbDemod = null;
      if (this.mode === 'iq' && !this.hfdlOn && !this.iqViewOn && !this.iqEyeOn) {
        this.setMode('usb');
      }
    }
  }

  /** Toggle the filtered-IQ SSB demod for side L (LSB2) or U (USB2).
   *  Re-tapping the same side turns it off; tapping the other side
   *  hot-swaps without restarting the chain. */
  private toggleSsbFiltered(side: SsbSide): void {
    const sameSideOff = this.ssbfOn && this.ssbfSide === side;
    if (this.ssbfOn && !sameSideOff) {
      // Hot-swap sides — keep the decoder alive.
      this.ssbfSide = side;
      this.ssbfDemod?.setSide(side);
      this.refreshSsbfButtons();
      return;
    }
    this.ssbfOn = !sameSideOff;
    this.ssbfSide = side;
    this.refreshSsbfButtons();
    if (this.ssbfOn) {
      if (this.mode !== 'iq') this.setMode('iq');
      const ctx = this.player.getOrCreateCtx();
      if (!ctx) { this.ssbfOn = false; this.refreshSsbfButtons(); return; }
      const inputRate = this.player.getInputRate() || 12000;
      const bw = Math.max(50, this.highCut - this.lowCut);
      const notchHzList: number[] = [];
      if (this.antchOn && this.antchLastHz > 0) {
        const audioCentre = (this.lowCut + this.highCut) / 2;
        notchHzList.push(audioCentre + this.antchLastHz);
      }
      this.ssbfDemod = new SsbFilteredDemod({
        ctx, inputRate, side,
        bandwidthHz: bw,
        notchHzList,
      });
      this.player.onIq = (b) => this.ssbfDemod?.feed(b);
    } else {
      this.player.onIq = null;
      this.ssbfDemod?.close();
      this.ssbfDemod = null;
      if (this.mode === 'iq' && !this.hfdlOn && !this.isbOn && !this.ssbfOn && !this.iqViewOn && !this.iqEyeOn) {
        this.setMode('usb');
      }
    }
  }

  private refreshSsbfButtons(): void {
    this.$('btnLsb2').classList.toggle('active', this.ssbfOn && this.ssbfSide === 'L');
    this.$('btnUsb2').classList.toggle('active', this.ssbfOn && this.ssbfSide === 'U');
  }

/** Hide / show the three kiwi-side spectrum panes (live FFT, averaged
   *  heatmap, waterfall) so a full-canvas visualizer (SPEC, IQ VIEW,
   *  S PLOT, DRIFT) owns the spectrum-wrap area. S DIAL deliberately
   *  doesn't call this — its small dial is fine alongside the spectrum. */
  private setSpectrumPanesHidden(hidden: boolean): void {
    // The live FFT pane and the averaged-FFT strip are permanently
    // hidden via inline / CSS rules now (the user removed them); only
    // the waterfall needs to be toggled by full-area visualizers like
    // SPEC, IQ VIEW, SPLOT, DRIFT. Touching .fft-wrap here would clear
    // its inline `display:none` and bring the FFT canvas back after
    // any panel closes.
    const wfWrap = this.root.querySelector('.wf-wrap') as HTMLElement | null;
    if (wfWrap) wfWrap.style.display = hidden ? 'none' : '';
  }

  private toggleSPlot() {
    this.sPlotOn = !this.sPlotOn;
    if (this.sPlotOn) this.exclusiveActivate('splot');
    const btn = this.$('btnSPlot');
    const panel = this.$('sPlotPanel');
    btn.classList.toggle('active', this.sPlotOn);
    panel.style.display = this.sPlotOn ? '' : 'none';
    this.setSpectrumPanesHidden(this.sPlotOn);
    if (this.sPlotOn) {
      this.sPlotHistory = [];
      this.sPlotAllSamples = [];
      const tick = () => {
        if (!this.sPlotOn) return;
        this.sPlotRender();
        this.sPlotRaf = requestAnimationFrame(tick);
      };
      this.sPlotRaf = requestAnimationFrame(tick);
    } else if (this.sPlotRaf != null) {
      cancelAnimationFrame(this.sPlotRaf);
      this.sPlotRaf = null;
    }
  }

  private toggleFmnt() {
    this.fmntOn = !this.fmntOn;
    if (this.fmntOn) this.exclusiveActivate('fmnt');
    const btn = this.$('btnFmnt');
    const panel = this.$('fmntPanel');
    btn.classList.toggle('active', this.fmntOn);
    panel.style.display = this.fmntOn ? '' : 'none';
    this.setSpectrumPanesHidden(this.fmntOn);
    if (this.fmntOn) {
      this.fmntHistory = [];
      const tick = () => {
        if (!this.fmntOn) return;
        this.fmntStep();
        this.fmntRender();
        this.fmntRaf = requestAnimationFrame(tick);
      };
      this.fmntRaf = requestAnimationFrame(tick);
    } else if (this.fmntRaf != null) {
      cancelAnimationFrame(this.fmntRaf);
      this.fmntRaf = null;
    }
  }

  /** Read one audio-FFT snapshot, smooth it (cepstral-style box average
   *  to flatten harmonics so peaks are formant envelopes, not pitch
   *  harmonics), and pick the strongest peak in each formant search
   *  band: F1 250–1000, F2 800–2500, F3 2000–3500. Voicing gate: only
   *  push a sample if total band energy is well above the running
   *  noise floor — otherwise the trace freezes. */
  private fmntStep() {
    const bins = this.player.getAudioFftBins();
    if (!bins) return;
    const sr = this.player.getAudioRate();
    const N = bins.length;
    const binHz = sr / 2 / N;        // analyser frequencyBinCount → fftSize/2

    // Convert to a smoothed envelope (box-filter window scaled to ~120 Hz
    // so individual harmonics blur into formant lobes).
    const winBins = Math.max(3, Math.round(120 / binHz) | 1);
    const half = winBins >> 1;
    const env = new Float32Array(N);
    let sum = 0;
    for (let i = 0; i < winBins && i < N; i++) sum += bins[i];
    for (let i = 0; i < N; i++) {
      const lo = i - half, hi = i + half + 1;
      // Sliding window — adjust sum incrementally.
      if (i > 0) {
        const add = hi <= N ? bins[hi - 1] : 0;
        const drop = lo - 1 >= 0 ? bins[lo - 1] : 0;
        sum += add - drop;
      }
      const cnt = Math.min(hi, N) - Math.max(lo, 0);
      env[i] = cnt > 0 ? sum / cnt : 0;
    }

    // Voicing gate from the speech band only (200..3500 Hz). Compare to
    // a slow-decay reference held in fmntNoiseRef.
    const lo200 = Math.max(1, Math.floor(200 / binHz));
    const hi3500 = Math.min(N - 1, Math.ceil(3500 / binHz));
    let speechEnergy = 0, peak = 0;
    for (let i = lo200; i <= hi3500; i++) {
      speechEnergy += env[i];
      if (env[i] > peak) peak = env[i];
    }
    speechEnergy /= Math.max(1, hi3500 - lo200 + 1);
    const voiced = speechEnergy > 100 && peak > 130;

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
      // Quadratic-interpolated bin centre for sub-bin resolution.
      const yL = env[Math.max(0, bestI - 1)];
      const yC = env[bestI];
      const yR = env[Math.min(N - 1, bestI + 1)];
      const denom = (yL - 2 * yC + yR);
      const delta = denom !== 0 ? 0.5 * (yL - yR) / denom : 0;
      return (bestI + delta) * binHz;
    };

    let f1 = 0, f2 = 0, f3 = 0;
    if (voiced) {
      f1 = pickPeak(250, 1000);
      f2 = pickPeak(Math.max(900, f1 + 200), 2500);
      f3 = pickPeak(Math.max(2000, f2 + 300), 3500);
    }
    const t = performance.now();
    this.fmntHistory.push({ t, f1, f2, f3, voiced });
    const cutoff = t - this.fmntHistMs;
    let drop = 0;
    while (drop < this.fmntHistory.length && this.fmntHistory[drop].t < cutoff) drop++;
    if (drop > 0) this.fmntHistory.splice(0, drop);
  }

  private fmntRender() {
    const cv = this.$('fmntCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    const W = (cv.width  = Math.max(120, Math.round(r.width  * dpr)));
    const H = (cv.height = Math.max(80,  Math.round(r.height * dpr)));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const padL = 36 * dpr, padR = 8 * dpr, padT = 6 * dpr, padB = 16 * dpr;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const fMin = 0, fMax = 3600;        // Hz
    const yOf = (f: number) => padT + (1 - (f - fMin) / (fMax - fMin)) * plotH;

    // Y-axis grid lines + labels every 500 Hz.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(207,255,163,0.6)';
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let f = 500; f <= fMax; f += 500) {
      const y = yOf(f);
      ctx.beginPath();
      ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${f}`, padL - 4 * dpr, y);
    }

    const hist = this.fmntHistory;
    if (hist.length < 2) {
      ctx.fillStyle = '#cfffa3';
      ctx.fillText('FMNT — waiting for voice…', padL, padT + 12 * dpr);
      this.$('fmntStatus').textContent = 'FMNT — voice formant tracker (F1/F2/F3 vs time)';
      return;
    }
    const tNow = performance.now();
    const t0 = tNow - this.fmntHistMs;
    const span = this.fmntHistMs;
    const xOf = (t: number) => padL + ((t - t0) / span) * plotW;

    // Draw three trajectories — break the path on un-voiced gaps so the
    // line doesn't leap across silences.
    const drawTrack = (key: 'f1' | 'f2' | 'f3', colour: string) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < hist.length; i++) {
        const p = hist[i];
        const v = p[key];
        if (!p.voiced || v <= 0) { started = false; continue; }
        const x = xOf(p.t), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else          ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    drawTrack('f1', '#ff6961');   // F1 — red
    drawTrack('f2', '#ffd166');   // F2 — amber
    drawTrack('f3', '#7ee787');   // F3 — green

    // Legend.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ff6961'; ctx.fillText('F1', padL, padT);
    ctx.fillStyle = '#ffd166'; ctx.fillText('F2', padL + 24 * dpr, padT);
    ctx.fillStyle = '#7ee787'; ctx.fillText('F3', padL + 48 * dpr, padT);

    // Last-value readout.
    const last = hist[hist.length - 1];
    const fmt = (f: number) => f > 0 ? `${f.toFixed(0)} Hz` : '—';
    this.$('fmntStatus').textContent =
      `FMNT — ${last.voiced ? 'voiced' : 'silent'} · F1 ${fmt(last.f1)} · F2 ${fmt(last.f2)} · F3 ${fmt(last.f3)}`;
  }

  private sPlotPushSample(dbm: number) {
    const now = performance.now();
    this.sPlotHistory.push({ t: now, dbm });
    // Keep the last SPLOT_WINDOW_MS worth — anything older drops off.
    const cutoff = now - SPLOT_WINDOW_MS;
    let i = 0;
    while (i < this.sPlotHistory.length && this.sPlotHistory[i].t < cutoff) i++;
    if (i > 0) this.sPlotHistory.splice(0, i);
    // Also append to the full-session capture (wall-clock timestamp so the
    // CSV export has usable absolute times, not session-relative).
    this.sPlotAllSamples.push({ t: Date.now(), dbm });
  }

  private sPlotRender() {
    const canvas = this.$('sPlotCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Match the canvas pixel buffer to its displayed size so the plot
    // fills the panel cleanly instead of stretching its intrinsic
    // 640×180 aspect.
    const r = canvas.getBoundingClientRect();
    const targetW = Math.max(120, Math.round(r.width)  || 640);
    const targetH = Math.max(60,  Math.round(r.height) || 180);
    if (canvas.width  !== targetW) canvas.width  = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    // Grid: vertical = 10 s, horizontal = 20 dBm. Frame the plot area
    // with a 32 px left gutter for dBm labels and a 16 px bottom for
    // seconds-ago labels.
    const padL = 32, padR = 6, padT = 6, padB = 16;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const plotW = x1 - x0, plotH = y1 - y0;
    const Y_TOP = -20, Y_BOT = -130;
    const xFor = (t: number, now: number) => x1 - (plotW * (now - t)) / SPLOT_WINDOW_MS;
    const yFor = (dbm: number) => {
      const v = Math.min(Math.max(dbm, Y_BOT), Y_TOP);
      return y0 + (plotH * (Y_TOP - v)) / (Y_TOP - Y_BOT);
    };
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.fillStyle   = '#888';
    ctx.font        = '10px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth    = 1;
    // Horizontal gridlines + dBm labels.
    for (let v = -30; v >= -130; v -= 20) {
      const y = yFor(v);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(`${v}`, 4, y);
    }
    // Vertical gridlines every 10 s.
    ctx.textBaseline = 'top';
    for (let s = 0; s <= SPLOT_WINDOW_MS / 1000; s += 10) {
      const x = x1 - (plotW * s * 1000) / SPLOT_WINDOW_MS;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      if (s > 0 && s < SPLOT_WINDOW_MS / 1000) ctx.fillText(`-${s}s`, x - 12, y1 + 2);
    }
    // Plot the line.
    if (this.sPlotHistory.length > 1) {
      const now = performance.now();
      ctx.strokeStyle = '#7ee787';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (const p of this.sPlotHistory) {
        const x = xFor(p.t, now);
        if (x < x0 - 1) continue;
        const y = yFor(p.dbm);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else            ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Header with current / min / max / avg over the visible window.
      const dbms = this.sPlotHistory.map(p => p.dbm);
      const cur  = dbms[dbms.length - 1];
      const min  = Math.min(...dbms);
      const max  = Math.max(...dbms);
      const avg  = dbms.reduce((s, v) => s + v, 0) / dbms.length;
      const fmt  = (v: number) => `${v.toFixed(1)}`;
      this.$('sPlotStatus').textContent =
        `S-meter — cur ${fmt(cur)} dBm · min ${fmt(min)} · max ${fmt(max)} · avg ${fmt(avg)} · ${dbms.length} samples`;
    }
  }


  private toggleDrift() {
    this.driftOn = !this.driftOn;
    if (this.driftOn) this.exclusiveActivate('drift');
    const btn = this.$('btnDrift');
    const panel = this.$('driftPanel');
    btn.classList.toggle('active', this.driftOn);
    panel.style.display = this.driftOn ? '' : 'none';
    this.setSpectrumPanesHidden(this.driftOn);
    if (this.driftOn) {
      this.driftHistory = [];
      this.driftAllSamples = [];
      this.driftLastSampleAt = 0;
      const tick = () => {
        if (!this.driftOn) return;
        const now = performance.now();
        // Sample the analyser at ~5 Hz — finer than that just adds noise
        // and a 16k FFT at 48 kHz already takes ~340 ms to settle anyway.
        if (now - this.driftLastSampleAt > 200) {
          this.driftLastSampleAt = now;
          const hz = this.measureCarrierPeakHz();
          if (hz != null) {
            this.driftHistory.push({ t: now, hz });
            // Wall-clock timestamp + dial freq + mode so the CSV export
            // is self-describing (audio Hz alone is meaningless without
            // knowing what the receiver was tuned to at sample time).
            this.driftAllSamples.push({ t: Date.now(), hz, freqKHz: this.freqKHz, mode: this.mode });
            const cutoff = now - DRIFT_WINDOW_MS;
            let i = 0;
            while (i < this.driftHistory.length && this.driftHistory[i].t < cutoff) i++;
            if (i > 0) this.driftHistory.splice(0, i);
          }
        }
        this.driftRender();
        this.driftRaf = requestAnimationFrame(tick);
      };
      this.driftRaf = requestAnimationFrame(tick);
    } else if (this.driftRaf != null) {
      cancelAnimationFrame(this.driftRaf);
      this.driftRaf = null;
    }
  }

  /** Run the existing audio analyser, find the strongest bin in the
   *  passband, and refine its centre with parabolic interpolation for
   *  sub-bin accuracy. Returns null when the analyser hasn't been
   *  built yet (no audio source running) or the passband is empty.
   *  Searches only the audio range [80, 4500] Hz so DC, hum, and
   *  out-of-passband artifacts don't dominate. */
  private measureCarrierPeakHz(): number | null {
    const bins = this.player.getAudioFftBins();
    if (!bins || bins.length === 0) return null;
    const sr = this.player.getAudioRate();
    const fftSize = bins.length * 2;
    const binHz = sr / fftSize;
    const lo = Math.max(1, Math.floor(80   / binHz));
    const hi = Math.min(bins.length - 2, Math.floor(4500 / binHz));
    if (hi <= lo) return null;
    let kPeak = lo, vPeak = bins[lo];
    for (let k = lo + 1; k <= hi; k++) {
      if (bins[k] > vPeak) { vPeak = bins[k]; kPeak = k; }
    }
    // Reject if the peak is barely above the mean — no real carrier
    // present (would just be tracking noise).
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += bins[k];
    const mean = sum / (hi - lo + 1);
    if (vPeak - mean < 12) return null;
    // Parabolic interpolation on the dB-scaled bytes — close enough to
    // log-magnitude that the result is sub-bin-accurate. Returns
    // fractional bin offset in [-0.5, 0.5].
    const a = bins[kPeak - 1], b = vPeak, c = bins[kPeak + 1];
    const denom = 2 * (a - 2 * b + c);
    const frac  = denom !== 0 ? (a - c) / denom : 0;
    return (kPeak + frac) * binHz;
  }

  private driftRender() {
    const canvas = this.$('driftCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Match buffer to displayed size so the plot fills the panel.
    const r = canvas.getBoundingClientRect();
    const targetW = Math.max(120, Math.round(r.width)  || 640);
    const targetH = Math.max(60,  Math.round(r.height) || 200);
    if (canvas.width  !== targetW) canvas.width  = targetW;
    if (canvas.height !== targetH) canvas.height = targetH;
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const padL = 50, padR = 6, padT = 6, padB = 16;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const plotW = x1 - x0, plotH = y1 - y0;
    // Y-axis: absolute audio peak Hz. The KiwiSDR demodulator anchors
    // the audio passband to the LCD frequency, so audio peak Hz IS the
    // signal's offset from the LCD freq — no auto-discovered reference
    // needed. Auto-scale to fit the visible samples with a 4 Hz floor
    // (so a stable carrier doesn't look like it's flailing).
    if (this.driftHistory.length === 0) {
      this.$('driftStatus').textContent = 'Carrier drift — listening…';
      return;
    }
    const peaks = this.driftHistory.map(p => p.hz);
    let yMin = Infinity, yMax = -Infinity;
    for (const v of peaks) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
    if (!Number.isFinite(yMin)) { yMin = 0; yMax = 4; }
    const center = (yMin + yMax) / 2;
    const span = Math.max(4, yMax - yMin);
    yMin = center - span / 2;
    yMax = center + span / 2;
    yMin -= span * 0.1;
    yMax += span * 0.1;
    const yFor = (v: number) => y0 + plotH * (yMax - v) / (yMax - yMin);
    const xFor = (t: number, now: number) => x1 - plotW * (now - t) / DRIFT_WINDOW_MS;
    // Grid + axis labels.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.fillStyle   = '#888';
    ctx.font        = '10px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth    = 1;
    // Pick a sensible step for the y-axis based on span. Targets ~5–7
    // gridlines, snapped to a 1 / 2 / 5 × 10^N "nice" multiple so labels
    // are evenly spaced and readable. (Old formula returned values too
    // small — 36 labels stacked illegibly across ~250 px.)
    const niceStep = (target: number) => {
      if (target <= 0) return 1;
      const pow = Math.pow(10, Math.floor(Math.log10(target)));
      const r   = target / pow;
      const m   = r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10;
      return m * pow;
    };
    const target = (yMax - yMin) / 5;
    const step = niceStep(target);
    // Decide label decimals from step so we don't print "0.00" for big
    // steps or "100.00" for fractional steps.
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    const yStart = Math.ceil(yMin / step) * step;
    for (let v = yStart; v <= yMax; v += step) {
      const y = yFor(v);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.fillText(`${v.toFixed(decimals)} Hz`, 4, y);
    }
    // Time grid.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle   = '#888';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= DRIFT_WINDOW_MS / 1000; s += 30) {
      const x = x1 - plotW * s * 1000 / DRIFT_WINDOW_MS;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
      if (s > 0 && s < DRIFT_WINDOW_MS / 1000) ctx.fillText(`-${s}s`, x - 12, y1 + 2);
    }
    // Plot the line.
    if (this.driftHistory.length > 1) {
      const now = performance.now();
      ctx.strokeStyle = '#ffaa3c';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      let started = false;
      for (const p of this.driftHistory) {
        const x = xFor(p.t, now);
        if (x < x0 - 1) continue;
        const y = yFor(p.hz);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else            ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // Header — peak audio Hz (= signal offset from LCD), absolute
    // received frequency (LCD ± offset depending on demod side), drift
    // rate over last 30 s, ppm of LCD frequency.
    const last = this.driftHistory[this.driftHistory.length - 1];
    if (last) {
      const win = 30_000;
      const cutoff = last.t - win;
      const tail = this.driftHistory.filter(p => p.t >= cutoff);
      let rateHzPerMin: number | null = null;
      let driftHz = 0;
      if (tail.length > 4 && tail[tail.length - 1].t > tail[0].t) {
        const dt = (tail[tail.length - 1].t - tail[0].t) / 1000;
        const dhz = (tail[tail.length - 1].hz - tail[0].hz);
        rateHzPerMin = dhz / dt * 60;
        driftHz = dhz;
      }
      const dialHz = this.freqKHz * 1000;
      // USB: signal = dial + audio offset. LSB: signal = dial − audio offset.
      // Other modes treat audio peak as offset from dial.
      const sign = this.mode === 'lsb' ? -1 : 1;
      const sigKHz = this.freqKHz + sign * last.hz / 1000;
      const ppm = dialHz > 0 ? driftHz / dialHz * 1e6 : 0;
      this.$('driftStatus').textContent =
        `peak ${last.hz.toFixed(2)} Hz · signal ${sigKHz.toFixed(6)} kHz` +
        (rateHzPerMin != null ? ` · ${rateHzPerMin >= 0 ? '+' : ''}${rateHzPerMin.toFixed(2)} Hz/min` : '') +
        (rateHzPerMin != null ? ` · ${ppm >= 0 ? '+' : ''}${ppm.toFixed(3)} ppm/30s` : '');
    }
  }

  private toggleSDial() {
    this.sDialOn = !this.sDialOn;
    if (this.sDialOn) this.exclusiveActivate('sdial');
    const btn = this.$('btnSDial');
    const panel = this.$('sDialPanel');
    btn.classList.toggle('active', this.sDialOn);
    panel.style.display = this.sDialOn ? '' : 'none';
    if (this.sDialOn) {
      // Seed the needle from the current smoothed reading so it doesn't
      // jump from -120 dBm on every open.
      this.sDialDbm = this.smeterDbm;
      const tick = () => {
        if (!this.sDialOn) return;
        // Asymmetric damping: chase the smoothed RSSI fast on rising
        // signal (fast attack), slow on falling (slow decay) — matches
        // the visual feel of real analog meter ballistics.
        const target = this.smeterDbm;
        const a = target > this.sDialDbm ? 0.30 : 0.05;
        this.sDialDbm = this.sDialDbm * (1 - a) + target * a;
        this.sDialRender();
        this.sDialRaf = requestAnimationFrame(tick);
      };
      this.sDialRaf = requestAnimationFrame(tick);
    } else if (this.sDialRaf != null) {
      cancelAnimationFrame(this.sDialRaf);
      this.sDialRaf = null;
    }
  }

  /** Map dBm → angle in radians for the analog meter arc. The scale is
   *  piecewise-linear: 80° span across S0 → S9 (6 dB per S-unit) and a
   *  compressed 40° span across S9 → S9+60. Matches the look of typical
   *  amateur transceiver meters that compress the over-S9 region. */
  private sDialAngleFor(dbm: number): number {
    const S0 = -127, S9 = -73, MAX = -13;        // dBm bounds
    const A_LEFT  = -Math.PI * 75 / 180;          // -75°
    const A_S9    = +Math.PI * 15 / 180;          // +15° at S9
    const A_RIGHT = +Math.PI * 75 / 180;          // +75°
    if (dbm <= S0) return A_LEFT;
    if (dbm >= MAX) return A_RIGHT;
    if (dbm <= S9) {
      const t = (dbm - S0) / (S9 - S0);
      return A_LEFT + t * (A_S9 - A_LEFT);
    }
    const t = (dbm - S9) / (MAX - S9);
    return A_S9 + t * (A_RIGHT - A_S9);
  }

  private sDialRender() {
    const canvas = this.$('sDialCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    // Background bezel.
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, W, H);
    const cx = W / 2, cy = H * 1.15, R = H * 1.05;
    // Arc bounds in canvas-radians. Pivot is below the canvas; the
    // visible arc is centered on -π/2 (straight up). ±75° span.
    const A_START = -Math.PI / 2 - Math.PI * 75 / 180;   // top-left
    const A_END   = -Math.PI / 2 + Math.PI * 75 / 180;   // top-right
    // Cream meter face — wedge from pivot, swept across the visible arc.
    const grad = ctx.createRadialGradient(cx, cy - R * 0.6, R * 0.2, cx, cy - R * 0.6, R * 1.0);
    grad.addColorStop(0,   '#fbe9b0');
    grad.addColorStop(0.7, '#e8c87a');
    grad.addColorStop(1,   '#a88a3f');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, A_START, A_END, false);
    ctx.closePath();
    ctx.fill();
    // Outer rim arc.
    ctx.strokeStyle = '#3a2c10';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, A_START, A_END, false);
    ctx.stroke();
    // Inner tick arc radius.
    const RT = R * 0.92;
    // Red zone for >S9.
    ctx.strokeStyle = '#c1372d';
    ctx.lineWidth = 4;
    ctx.beginPath();
    const aS9 = -Math.PI / 2 + this.sDialAngleFor(-73);
    const aMx = -Math.PI / 2 + this.sDialAngleFor(-13);
    ctx.arc(cx, cy, RT, aS9, aMx, false);
    ctx.stroke();
    // Black zone for S0..S9.
    ctx.strokeStyle = '#1a1a1a';
    ctx.beginPath();
    const aS0 = -Math.PI / 2 + this.sDialAngleFor(-127);
    ctx.arc(cx, cy, RT, aS0, aS9, false);
    ctx.stroke();
    // Tick marks + S-unit labels.
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 14px ui-sans-serif,system-ui,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const drawTick = (dbm: number, big: boolean, label: string | null) => {
      const ang = -Math.PI / 2 + this.sDialAngleFor(dbm);
      const r1 = RT - (big ? 14 : 8);
      const r2 = RT;
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = big ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
      ctx.stroke();
      if (label != null) {
        const r3 = RT - 30;
        ctx.fillStyle = dbm > -73 ? '#7e1f17' : '#1a1a1a';
        ctx.fillText(label, cx + Math.cos(ang) * r3, cy + Math.sin(ang) * r3);
      }
    };
    // S0..S9 every S-unit, labels at odd values.
    for (let s = 0; s <= 9; s++) {
      const dbm = -127 + s * 6;
      drawTick(dbm, s % 2 === 1 || s === 0 || s === 9, (s % 2 === 1 || s === 9) ? String(s) : null);
    }
    // +20, +40, +60 dB over S9.
    drawTick(-53, true, '+20');
    drawTick(-33, true, '+40');
    drawTick(-13, true, '+60');
    // Face label.
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 18px ui-serif,Georgia,serif';
    ctx.fillText('S', cx, cy - R * 0.55);
    ctx.font = '11px ui-sans-serif,system-ui,sans-serif';
    ctx.fillText('SIGNAL  STRENGTH', cx, cy - R * 0.40);
    // Current dBm read-out below the pivot.
    ctx.fillStyle = '#cf8a2c';
    ctx.font = '12px ui-monospace,SFMono-Regular,Menlo,monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${this.smeterDbm.toFixed(1)} dBm`, 12, H - 14);
    ctx.textAlign = 'right';
    ctx.fillText(sUnit(this.smeterDbm), W - 12, H - 14);
    // Needle.
    const angN = -Math.PI / 2 + this.sDialAngleFor(this.sDialDbm);
    const tipR = RT;
    const tailR = R * 0.18;
    ctx.strokeStyle = '#7c0d05';
    ctx.lineWidth = 3;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.moveTo(cx - Math.cos(angN) * tailR, cy - Math.sin(angN) * tailR);
    ctx.lineTo(cx + Math.cos(angN) * tipR,  cy + Math.sin(angN) * tipR);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    // Pivot screw / hub.
    ctx.fillStyle = '#3a3a3a';
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Enforce mutual exclusion across the three voice trackers. Pass 0 to
   *  turn them all off, 1/2/3 to leave only the matching tracker on. */
  private setVtrkExclusive(which: 0 | 1 | 2 | 3) {
    const want1 = which === 1, want2 = which === 2, want3 = which === 3;
    if (this.player.isVoiceTrackEnabled()  !== want1) this.player.setVoiceTrackEnabled(want1);
    if (this.player.isVoiceTrack2Enabled() !== want2) this.player.setVoiceTrack2Enabled(want2);
    if (this.player.isVoiceTrack3Enabled() !== want3) this.player.setVoiceTrack3Enabled(want3);
    (this.$('btnVtrk')  as HTMLElement).classList.toggle('active', want1);
    (this.$('btnVtrk2') as HTMLElement).classList.toggle('active', want2);
    (this.$('btnVtrk3') as HTMLElement).classList.toggle('active', want3);
    if (want2) this.player.setVoiceTrack2Gain(this.vTrackGain);
    if (want3) this.player.setVoiceTrack3Gain(this.vTrackGain);
  }

  private updateIqClockStatus() {
    if (!this.iqClockOn) {
      this.$('iqViewStatus').textContent = 'IQ constellation';
      return;
    }
    const sps = this.iqClockMM ? this.iqClockMM.currentOmega : this.iqClockSPS;
    if (this.iqAutoOn) {
      if (this.iqAutoLastRs > 0) {
        this.$('iqViewStatus').textContent =
          `IQ constellation — AUTO ${this.iqAutoLastRs.toFixed(2)} bd ` +
          `(${sps.toFixed(3)} sps, conf ${this.iqAutoLastConf.toFixed(1)}× [${this.iqAutoLastKind}] — Oerder-Meyr → MM)`;
      } else if (this.iqAutoLastCandRs > 0) {
        this.$('iqViewStatus').textContent =
          `IQ constellation — AUTO: best ${this.iqAutoLastCandRs.toFixed(2)} bd ` +
          `(conf ${this.iqAutoLastCandConf.toFixed(1)}× [${this.iqAutoLastKind}] — below lock, holding)`;
      } else {
        this.$('iqViewStatus').textContent =
          'IQ constellation — AUTO baud — filling ring…';
      }
    } else {
      this.$('iqViewStatus').textContent =
        `IQ constellation — clock ${this.iqClockBaud} bd (${sps.toFixed(3)} sps, GR clock_recovery_mm_cc)`;
    }
  }

  /** Push an IQ batch into the AUTO ring and, when it's full, re-run the
   *  Oerder-Meyr non-data-aided estimator. The recovered symbol rate is
   *  pushed into the MM block via setOmega(); the MM loop then handles
   *  fine-grain tracking and the per-sample timing decisions. */
  private iqAutoEstimate(inBuf: Float32Array, nPairs: number) {
    const ring = this.iqAutoRing;
    const cap = ring.length >> 1;
    // Append (overwriting oldest) into the circular ring.
    for (let i = 0; i < nPairs; i++) {
      ring[this.iqAutoRingW * 2]     = inBuf[i * 2];
      ring[this.iqAutoRingW * 2 + 1] = inBuf[i * 2 + 1];
      this.iqAutoRingW = (this.iqAutoRingW + 1) % cap;
    }
    this.iqAutoRingFill = Math.min(cap, this.iqAutoRingFill + nPairs);
    if (this.iqAutoRingFill < cap) return;
    // Throttle re-estimates: at most every 500 ms (cheap on N=8192).
    const now = performance.now();
    if (now - this.iqAutoLastEstAt < 500) return;
    this.iqAutoLastEstAt = now;
    // Unroll the ring into a contiguous snapshot (oldest first).
    const snap = new Float32Array(cap * 2);
    const head = this.iqAutoRingW;
    snap.set(ring.subarray(head * 2), 0);
    snap.set(ring.subarray(0, head * 2), (cap - head) * 2);
    let r;
    try {
      r = estimateSymbolTimingBoth(snap, { fs: 12000, minRs: 25, maxRs: 4000 });
    } catch { return; }
    this.iqAutoLastKind = r.kind ?? 'sq';
    // NaN-safe gate. `NaN < 6` and `NaN <= 0` both evaluate to false, which
    // would let a NaN estimate through and poison every downstream `> 0`
    // check. Inverting via Number.isFinite + explicit-true comparisons keeps
    // NaN out of iqAutoLast{Rs,CandRs,etc}.
    if (!Number.isFinite(r.conf) || !Number.isFinite(r.rs)) return;
    this.iqAutoLastConf = r.conf;
    this.iqAutoLastCandRs = r.rs;
    this.iqAutoLastCandConf = r.conf;
    // Only commit when the spectral line is unambiguously above the noise
    // floor — otherwise we'd keep snapping to the loudest het in the band.
    if (!(r.conf >= 6) || !(r.rs > 0)) return;
    this.iqAutoLastRs = r.rs;
    this.iqClockBaud = r.rs;
    this.iqClockSPS = 12000 / r.rs;
    if (this.iqClockMM) this.iqClockMM.setOmega(this.iqClockSPS);
  }

  private rebuildIqClockMM() {
    // Mirror gr-digital defaults: gain_mu = 0.03, gain_omega = mu^2/4,
    // omega_relative_limit = 0.005. mu starts at 0.5 (eye centre).
    this.iqClockMM = new ClockRecoveryMM({
      omega: this.iqClockSPS,
      gainMu: 0.03,
      omegaRelativeLimit: 0.005,
      mu: 0.5,
    });
  }

  private toggleIqView() {
    this.iqViewOn = !this.iqViewOn;
    if (this.iqViewOn) this.exclusiveActivate('iqview');
    const btn = this.$('btnIqView');
    const panel = this.$('iqViewPanel');
    btn.classList.toggle('active', this.iqViewOn);
    panel.style.display = this.iqViewOn ? '' : 'none';
    this.setSpectrumPanesHidden(this.iqViewOn);
    if (this.iqViewOn) {
      // Need IQ samples to plot — flip the receiver into IQ mode if it
      // isn't already (e.g. user hasn't toggled HFDL or hit the IQ
      // demod button). Auto-scale starts fresh each session.
      if (this.mode !== 'iq') this.setMode('iq');
      this.iqViewMaxAbs = 1;
      const canvas = this.$('iqViewCanvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // Fresh background + axes.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.player.onIqView = (iq) => this.renderIqConstellation(iq);
    } else {
      this.player.onIqView = null;
      // If IQ mode was only kept around for the constellation, drop
      // back to USB so the speaker comes alive again. Don't disturb
      // anything if HFDL is also running — it owns the IQ stream too.
      if (this.mode === 'iq' && !this.hfdlOn && !this.isbOn && !this.ssbfOn) this.setMode('usb');
      // Clear the ext-fullscreen state so the next open isn't surprising.
      if (this.iqViewExt) {
        this.iqViewExt = false;
        document.body.classList.remove('iq-view-ext');
        this.$('iqViewExt').classList.remove('active');
      }
    }
  }

  private toggleIqViewExt() {
    this.iqViewExt = !this.iqViewExt;
    document.body.classList.toggle('iq-view-ext', this.iqViewExt);
    this.$('iqViewExt').classList.toggle('active', this.iqViewExt);
  }


  private renderIqConstellation(iq: Uint8Array) {
    const canvas = this.$('iqViewCanvas') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    // Plot region: a centred square inset from the edges so the dots
    // never touch the canvas border. Using a square (not the full
    // rectangle) keeps the I/Q axes equally scaled — a circle / square
    // constellation looks like a circle / square, not an ellipse.
    const MARGIN = 8;
    const R = Math.min(W, H) / 2 - MARGIN;
    const cx = W / 2, cy = H / 2;
    // Trail / persistence: slight fade each frame so old points decay.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(0, 0, W, H);
    // Cross-hair axes (low contrast so they don't dominate the view).
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.stroke();
    // Decode interleaved BE int16 I/Q.
    const dv = new DataView(iq.buffer, iq.byteOffset, iq.byteLength);
    const nPairs = (iq.length / 4) | 0;
    if (nPairs === 0) return;
    // Track running peak across this batch for adaptive normalisation.
    const strideMax = Math.max(1, Math.floor(nPairs / 256));
    let frameMax = 0;
    for (let i = 0; i < nPairs; i += strideMax) {
      const I = dv.getInt16(i * 4, false);
      const Q = dv.getInt16(i * 4 + 2, false);
      const m = Math.max(Math.abs(I), Math.abs(Q));
      if (m > frameMax) frameMax = m;
    }
    // Slow-decay peak hold: chase up fast, release slow.
    if (frameMax > this.iqViewMaxAbs) this.iqViewMaxAbs = frameMax;
    else this.iqViewMaxAbs = Math.max(1, this.iqViewMaxAbs * 0.99 + frameMax * 0.01);
    const scale = R / this.iqViewMaxAbs;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - R, cy - R, R * 2, R * 2);
    ctx.clip();

    if (!this.iqClockOn) {
      // Free-run mode: plot every (decimated) sample directly.
      ctx.fillStyle = 'rgba(120,255,120,0.85)';
      const stride = strideMax;
      for (let i = 0; i < nPairs; i += stride) {
        const I = dv.getInt16(i * 4, false);
        const Q = dv.getInt16(i * 4 + 2, false);
        const x = Math.max(cx - R, Math.min(cx + R - 2, (cx + I * scale) | 0));
        const y = Math.max(cy - R, Math.min(cy + R - 2, (cy - Q * scale) | 0));
        ctx.fillRect(x, y, 2, 2);
      }
    } else {
      // GNU Radio clock_recovery_mm_cc as the front stage: convert the BE
      // int16 IQ batch into a normalised Float32 complex stream, run it
      // through the MM block, and plot only the recovered symbol decisions.
      if (!this.iqClockMM) this.rebuildIqClockMM();
      const mm = this.iqClockMM!;
      // Resize scratch buffers if needed. Output upper bound = nPairs / sps + 4.
      if (!this.iqClockInBuf || this.iqClockInBuf.length < nPairs * 2) {
        this.iqClockInBuf = new Float32Array(nPairs * 2);
      }
      const maxOut = Math.max(8, Math.ceil(nPairs / Math.max(1, this.iqClockSPS)) + 8);
      if (!this.iqClockOutBuf || this.iqClockOutBuf.length < maxOut * 2) {
        this.iqClockOutBuf = new Float32Array(maxOut * 2);
      }
      const inBuf = this.iqClockInBuf;
      const outBuf = this.iqClockOutBuf;
      // Normalise to roughly unit amplitude using the running peak hold so
      // the slicer's ±1 reference stays meaningful (GR upstream usually
      // hands the block AGC'd samples).
      const norm = 1 / this.iqViewMaxAbs;
      for (let i = 0; i < nPairs; i++) {
        inBuf[i * 2]     = dv.getInt16(i * 4,     false) * norm;
        inBuf[i * 2 + 1] = dv.getInt16(i * 4 + 2, false) * norm;
      }
      if (this.iqAutoOn) this.iqAutoEstimate(inBuf, nPairs);
      const nSym = mm.process(inBuf.subarray(0, nPairs * 2), outBuf);
      ctx.fillStyle = '#cfffa3';
      const symScale = R; // symbols are unit-normalised
      for (let s = 0; s < nSym; s++) {
        const sI = outBuf[s * 2];
        const sQ = outBuf[s * 2 + 1];
        const x = Math.max(cx - R, Math.min(cx + R - 2, (cx + sI * symScale) | 0));
        const y = Math.max(cy - R, Math.min(cy + R - 2, (cy - sQ * symScale) | 0));
        ctx.fillRect(x - 1, y - 1, 4, 4);
      }
      // Refresh the status line periodically with the tracked omega so
      // operators can see the loop converging.
      if (((performance.now() / 250) | 0) !== this.iqClockStatusTick) {
        this.iqClockStatusTick = (performance.now() / 250) | 0;
        this.updateIqClockStatus();
      }
    }
    ctx.restore();
  }

  private openHfdlFreqPicker() {
    this.registerScanSet('HFDL', HFDL_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'iq' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${HFDL_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = HFDL_FREQS[+t.dataset.idx!];
        this.tuneHfdlChannel(f.freqKHz);
        // If the decoder is already running, re-spawn against the new
        // channel — dumphfdl is configured per-frequency at startup, so
        // the cleanest hot-swap is teardown + restart.
        if (this.hfdlOn) {
          this.toggleHfdl();   // off
          this.toggleHfdl();   // back on with new freqKHz
        }
        this.banner(`HFDL ${f.freqKHz.toFixed(3)} (${f.note})`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** FreeDV freq picker. Hardcoded list of the gathering channels
   *  where FreeDV nets / individual operators are typically heard.
   *  All USB, with the OFDM modem occupying the audio passband. */
  private openFreedvFreqPicker() {
    const FDV: { freqKHz: number; label: string; note: string }[] = [
      { freqKHz:  3625.0, label: 'FreeDV 80 m', note: '3.625 MHz USB · regional / overnight' },
      { freqKHz:  3643.0, label: 'FreeDV 80 m', note: '3.643 MHz USB · alternate' },
      { freqKHz:  7197.0, label: 'FreeDV 40 m', note: '7.197 MHz USB · NA evening net' },
      { freqKHz: 14236.0, label: 'FreeDV 20 m', note: '14.236 MHz USB · universal calling channel' },
      { freqKHz: 21313.0, label: 'FreeDV 15 m', note: '21.313 MHz USB · daytime DX' },
      { freqKHz: 28330.0, label: 'FreeDV 10 m', note: '28.330 MHz USB · solar-high daytime' },
    ];
    this.registerScanSet('FreeDV', FDV.map(s => ({ label: s.label, freqKHz: s.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${FDV.map((s, i) => `
          <button class="rtty-row ${s.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${s.label}</div>
            <div class="rtty-row-meta">${s.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const s = FDV[+t.dataset.idx!];
        this.setMode('usb');
        this.freqKHz = s.freqKHz;
        this.lowCut = 100;
        this.highCut = 2900;
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.freedvOn) {
          this.exclusiveActivate('freedv');
          this.toggleFreedv();
        } else {
          // Already running — restart so freedv_rx re-syncs.
          this.toggleFreedv();
          this.toggleFreedv();
        }
        this.recenter();
        this.refresh();
        this.banner(`${s.label} · ${s.freqKHz.toFixed(1)} kHz`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** WWV-only freq picker. Hardcoded to the 5 NIST WWV (Fort Collins,
   *  Colorado) broadcast frequencies the operator actually wants when
   *  they tap WWV: 2.5 / 5 / 10 / 15 / 20 MHz. No WWVH, no BPM, no
   *  CHU — those live on the broader page-8 TIME button. */
  private openWwvFreqPicker() {
    const WWV: { freqKHz: number; label: string; note: string }[] = [
      { freqKHz:  2500, label: 'WWV  2500 kHz', note: 'night only (low power)' },
      { freqKHz:  5000, label: 'WWV  5000 kHz', note: '24 h' },
      { freqKHz: 10000, label: 'WWV 10000 kHz', note: '24 h · most reliable' },
      { freqKHz: 15000, label: 'WWV 15000 kHz', note: 'daytime' },
      { freqKHz: 20000, label: 'WWV 20000 kHz', note: 'daytime · solar high' },
    ];
    this.registerScanSet('WWV', WWV.map(s => ({ label: s.label, freqKHz: s.freqKHz, mode: 'am' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${WWV.map((s, i) => `
          <button class="rtty-row ${s.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${s.label}</div>
            <div class="rtty-row-meta">${s.freqKHz.toFixed(3)} kHz · AM · ${s.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const s = WWV[+t.dataset.idx!];
        this.setMode('am');
        this.freqKHz = s.freqKHz;
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.wwvOn) {
          this.exclusiveActivate('wwv');
          this.toggleWwv();
        } else {
          // Already running — restart so the WWV scope reseeds against
          // the new audio path.
          this.toggleWwv();
          this.toggleWwv();
        }
        this.recenter();
        this.refresh();
        this.banner(`${s.label}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openWsprFreqPicker() {
    this.registerScanSet('WSPR', WSPR_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${WSPR_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · USB · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = WSPR_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.wsprOn) {
          this.exclusiveActivate('wspr');
          this.toggleWspr();
        } else {
          this.wsprDecoder?.setDial(f.freqKHz);
        }
        this.recenter();
        this.refresh();
        this.banner(`WSPR ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openPacketFreqPicker() {
    this.registerScanSet('Packet', PACKET_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${PACKET_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = PACKET_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.packetOn) {
          this.exclusiveActivate('packet');
          this.togglePacket();
        }
        this.recenter();
        this.refresh();
        this.banner(`PACKET ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** VHF Bell-202 packet picker. NBFM mode; selecting a row turns the
   *  decoder on automatically (the HF picker does the same). */
  private openPacketVhfFreqPicker() {
    this.registerScanSet('Packet-VHF', PACKET_VHF_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${PACKET_VHF_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = PACKET_VHF_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.packetVhfOn) {
          this.exclusiveActivate('packet-vhf');
          this.togglePacketVhf();
        }
        this.recenter();
        this.refresh();
        this.banner(`PACKET-VHF ${(f.freqKHz / 1000).toFixed(3)} MHz`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** 9600 G3RUH packet picker — mostly satellite downlinks. NBFM mode.
   *  Selecting a row turns the decoder on automatically (same as
   *  the HF/VHF pickers). */
  private openPacket9600FreqPicker() {
    this.registerScanSet('Packet-9600', PACKET_9600_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: f.mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${PACKET_9600_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.mode.toUpperCase()} · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = PACKET_9600_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode(f.mode);
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.packet9600On) {
          this.exclusiveActivate('packet-9600');
          this.togglePacket9600();
        }
        this.recenter();
        this.refresh();
        this.banner(`PACKET-9600 ${(f.freqKHz / 1000).toFixed(3)} MHz`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openOthrFreqPicker() {
    this.registerScanSet('OTHR', OTHR_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'iq' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${OTHR_FREQS.map((f, i) => `
          <button class="rtty-row" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = OTHR_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('iq');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (this.iq5Active !== 'othr') {
          this.toggleIq5('othr');
        }
        this.recenter();
        this.refresh();
        this.banner(`OTHR ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openAleFreqPicker() {
    this.registerScanSet('ALE', ALE_FREQS.map(f => ({ label: f.label, freqKHz: f.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker freq-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${ALE_FREQS.map((f, i) => `
          <button class="rtty-row ${f.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${f.label}</div>
            <div class="rtty-row-meta">${f.freqKHz.toFixed(3)} kHz · ${f.note}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = ALE_FREQS[+t.dataset.idx!];
        this.freqKHz = f.freqKHz;
        this.setMode('usb');
        this.client?.setTune({
          mode: this.mode, freqKHz: this.freqKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.aleOn) {
          this.exclusiveActivate('ale');
          this.toggleAle();
        }
        this.recenter();
        this.refresh();
        this.banner(`ALE ${f.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleWwv() {
    this.wwvOn = !this.wwvOn;
    this.updateWaterfallStream();
    const btn = this.$('btnWwv');
    const panel = this.$('wwvPanel');
    btn.classList.toggle('active', this.wwvOn);
    panel.style.display = this.wwvOn ? '' : 'none';
    if (this.wwvOn) {
      const sr = this.player.getInputRate() || 12000;
      this.wwvHistory.length = 0;
      this.wwvDecoder = new WwvFldigiDecoder({
        sampleRate: sr,
        onStatus: (s) => { this.$('wwvStatus').textContent = `WWV ${s}`; },
        onFrame: (frame) => {
          this.wwvHistory.push(frame);
          if (this.wwvHistory.length > 240) this.wwvHistory.shift();
          this.drawWwv();
        },
      });
      this.player.onWwv = (s) => this.wwvDecoder?.feed(s);
    } else {
      this.player.onWwv = null;
      this.wwvDecoder?.close();
      this.wwvDecoder = null;
      this.wwvHistory.length = 0;
    }
  }

  /** Render the WWV scope: most recent frame as a top trace, plus a stack of
   *  earlier frames as a greyscale waterfall below — one pixel-row per frame
   *  (one frame ≈ 1 sec). The carrier-tick column should hold steady at the
   *  same x-coordinate when the receive clock is locked to WWV. */
  private drawWwv() {
    const cv = this.$('wwvCanvas') as HTMLCanvasElement;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const hist = this.wwvHistory;
    if (hist.length === 0) return;

    const traceH = Math.min(60 * dpr, H * 0.3);
    const wfTop  = traceH;
    const wfH    = H - traceH;
    const last   = hist[hist.length - 1];
    const N      = last.length;

    // Top: line trace of the most recent frame (tick waveform).
    ctx.strokeStyle = '#7cf';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = i * W / N;
      const y = traceH - (last[i] / 255) * traceH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Waterfall: paint older frames at top, newest at bottom.
    const rows = Math.min(hist.length, Math.floor(wfH / Math.max(1, dpr)));
    if (rows <= 0) return;
    const img = ctx.createImageData(N, rows);
    for (let r = 0; r < rows; r++) {
      const f = hist[hist.length - rows + r];
      for (let i = 0; i < N; i++) {
        const v = f[i];
        const off = (r * N + i) * 4;
        // Cool palette: black → blue → cyan → white.
        const t = v / 255;
        const rr = t < 0.5 ? 0 : Math.round((t - 0.5) * 510);
        const gg = t < 0.25 ? 0 : Math.round((t - 0.25) * 340);
        const bb = Math.round(Math.min(1, t * 2) * 255);
        img.data[off]   = rr;
        img.data[off+1] = gg;
        img.data[off+2] = bb;
        img.data[off+3] = 255;
      }
    }
    // Stretch source img to canvas via temporary canvas.
    const tmp = document.createElement('canvas');
    tmp.width = N; tmp.height = rows;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, wfTop, W, wfH);

    // Center marker line — where the 1 PPS tick should land.
    ctx.strokeStyle = 'rgba(255,235,59,0.6)';
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.lineWidth = 1 * dpr;
    const cx = W / 2;
    ctx.beginPath();
    ctx.moveTo(cx, 0); ctx.lineTo(cx, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private toggleSitor() {
    this.sitorOn = !this.sitorOn;
    this.updateWaterfallStream();
    const btn = this.$('btnSitor');
    const panel = this.$('sitorPanel');
    btn.classList.toggle('active', this.sitorOn);
    panel.style.display = this.sitorOn ? '' : 'none';
    if (this.sitorOn) {
      const sr = this.player.getInputRate() || 12000;
      this.sitorDecoder = new NAVTEXDecoder({
        sampleRate: sr,
        mode: 'sitorb',
        carrierHz: this.settings.navtexCarrierHz,
        onStatus: (s) => { this.$('sitorStatus').textContent = `SITOR-B ${s}`; },
        onChar: (ch) => {
          const el = this.$('sitorText');
          el.textContent = (el.textContent || '') + ch;
          const t = el.textContent;
          if (t.length > 8000) el.textContent = t.slice(t.length - 8000);
          el.scrollTop = el.scrollHeight;
        },
      });
      this.player.onSitor = (s) => this.sitorDecoder?.feed(s);
    } else {
      this.player.onSitor = null;
      this.sitorDecoder?.close();
      this.sitorDecoder = null;
    }
  }

  private openSitorStationPicker() {
    this.registerScanSet('SITOR', SITOR_STATIONS.map(s => ({
      label: s.label, freqKHz: +(s.freqKHz - 1.9).toFixed(3),
      mode: 'usb' as Mode, lowCutHz: 1750, highCutHz: 2050,
    })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${SITOR_STATIONS.map((s, i) => `
          <button class="rtty-row ${s.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${s.label}</div>
            <div class="rtty-row-meta">${s.freqKHz.toFixed(3)} kHz</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const station = SITOR_STATIONS[+t.dataset.idx!];
        // Same offset/passband as NAVTEX — same modulation. Dial sits
        // 1.9 kHz below the station carrier so mark (1985 Hz) and space
        // (1815 Hz) sub-tones land in a tight 1750..2050 Hz filter.
        this.setMode('usb');
        const dialKHz = +(station.freqKHz - 1.9).toFixed(3);
        this.freqKHz = dialKHz;
        this.lowCut  = 1750;
        this.highCut = 2050;
        this.client?.setTune({
          mode: this.mode, freqKHz: dialKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        if (!this.sitorOn) {
          this.exclusiveActivate('sitor');
          this.toggleSitor();
        } else {
          // Already running — restart so the modem reseeds against the
          // new dial / passband instead of holding stale lock state.
          this.toggleSitor();
          this.toggleSitor();
        }
        this.recenter();
        this.refresh();
        this.banner(`SITOR-B ${station.freqKHz.toFixed(3)}`, 1800);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private openNavtexStationPicker() {
    this.registerScanSet('NAVTEX', NAVTEX_STATIONS.map(s => ({
      label: s.label, freqKHz: +(s.freqKHz - 1.9).toFixed(3),
      mode: 'usb' as Mode, lowCutHz: 1750, highCutHz: 2050,
    })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker';
    root.innerHTML = `
      <div class="rtty-list">
        ${NAVTEX_STATIONS.map((s, i) => `
          <button class="rtty-row ${s.freqKHz === this.freqKHz ? 'active' : ''}" data-idx="${i}">
            <div class="rtty-row-name">${s.label}</div>
            <div class="rtty-row-meta">${s.freqKHz.toFixed(3)} kHz</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const idx = +t.dataset.idx!;
        const station = NAVTEX_STATIONS[idx] ?? this.navtexStation;
        this.navtexStation = station;
        // Tune USB at carrier − 1.9 kHz so the mark (1985 Hz) and space
        // (1815 Hz) sub-tones land in the audio passband. Set a tight
        // 300 Hz filter (lof 1750 / hif 2050) covering both tones with
        // ~65 Hz margin on each side — matches fldigi's expectation.
        this.setMode('usb');
        const dialKHz = +(station.freqKHz - 1.9).toFixed(3);
        this.freqKHz = dialKHz;
        this.lowCut  = 1750;
        this.highCut = 2050;
        this.client?.setTune({
          mode: this.mode, freqKHz: dialKHz,
          lowCutHz: this.lowCut, highCutHz: this.highCut,
        });
        this.recenter();
        this.refresh();
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private toggleWefax() {
    this.wefaxOn = !this.wefaxOn;
    this.updateWaterfallStream();
    const btn = this.$('btnWefax');
    const panel = this.$('wefaxPanel');
    btn.classList.toggle('active', this.wefaxOn);
    panel.style.display = this.wefaxOn ? '' : 'none';
    if (this.wefaxOn) {
      this.setMode('usb');
      // AGC's variable gain breaks fldigi's APT/phasing detectors which
      // rely on absolute white/black amplitudes. Save the user's choice
      // and force OFF for the duration of the fax session.
      if (this.agcSavedForWefax == null) {
        this.agcSavedForWefax = this.agcMode;
        if (this.agcMode !== 'off') {
          this.agcMode = 'off';
          this.client?.setAgcMode('off', this.rfGain);
          this.refreshAgcButton();
        }
      }
      this.clearWefaxCanvas();
      this.wefaxRowOffset = 0;
      this.wefaxDecoder = new WefaxDecoder({
        onStatus: (s) => { this.$('wefaxStatus').textContent = `WEFAX ${s}`; },
        onImageStart: (meta) => {
          this.wefaxImageMeta = meta;
          const cv = this.$('wefaxCanvas') as HTMLCanvasElement;
          cv.width = meta.width;
          cv.height = 800;
          this.clearWefaxCanvas();
          this.wefaxRowOffset = 0;
          this.$('wefaxStatus').textContent =
            `WEFAX receiving (${meta.width}px / ${meta.lpm ?? '?'} LPM / IOC ${meta.ioc ?? '?'})`;
        },
        onRow: (row) => this.paintWefaxRow(row),
        onImageEnd: ({ height }) => {
          this.$('wefaxStatus').textContent = `WEFAX image complete (${height} rows)`;
        },
        onAlign: ({ originPx, driftPxPerRow, oldSpp, newSpp }) => {
          // Server-side phasing-tone lock acquired — origin + rate are now
          // both pinned to the TX. Clear any manual click offset since the
          // decoder will emit pre-aligned rows from this point on.
          this.wefaxRowOffset = 0;
          this.$('wefaxStatus').textContent =
            `WEFAX phase locked (origin ${originPx} px, drift ${driftPxPerRow.toFixed(2)} px/row, SPP ${oldSpp.toFixed(3)} → ${newSpp.toFixed(3)})`;
        },
      });
      this.player.onWefax = (s) => {
        this.wefaxDecoder?.feed(s);
        if (this.faxScanOn) this.feedFaxScanAudio(s);
      };
    } else {
      this.stopFaxScan();
      this.player.onWefax = null;
      this.wefaxDecoder?.close();
      this.wefaxDecoder = null;
      // Restore the AGC mode we displaced when fax started (skipped if
      // the user toggled the AGC button manually mid-session, since the
      // saved value is already what they want back).
      if (this.agcSavedForWefax != null) {
        const restored = this.agcSavedForWefax;
        this.agcSavedForWefax = null;
        if (this.agcMode !== restored) {
          this.agcMode = restored;
          this.client?.setAgcMode(restored, this.rfGain);
          this.refreshAgcButton();
        }
      }
      // Drop ext mode when the FAX panel closes so it doesn't leak.
      if (this.wefaxExt) {
        this.wefaxExt = false;
        document.body.classList.remove('wefax-ext');
        this.$('wefaxExt').classList.remove('active');
      }
    }
  }

  private toggleWefaxExt() {
    this.wefaxExt = !this.wefaxExt;
    document.body.classList.toggle('wefax-ext', this.wefaxExt);
    this.$('wefaxExt').classList.toggle('active', this.wefaxExt);
  }

  private paintWefaxRow(row: WefaxRow) {
    const cv = this.$('wefaxCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx || !this.wefaxImageMeta) return;
    const w = this.wefaxImageMeta.width;
    if (cv.width !== w) cv.width = w;
    // Grow canvas as more rows arrive.
    if (row.seq >= cv.height) {
      const newH = Math.max(cv.height * 2, row.seq + 100);
      const old = ctx.getImageData(0, 0, cv.width, cv.height);
      cv.height = newH;
      ctx.putImageData(old, 0, 0);
    }
    const img = ctx.createImageData(w, 1);
    const off = ((this.wefaxRowOffset % w) + w) % w;  // normalize negative offsets
    for (let x = 0; x < w; x++) {
      const v = row.data[(x + off) % w] ?? 0;
      img.data[x * 4 + 0] = v;
      img.data[x * 4 + 1] = v;
      img.data[x * 4 + 2] = v;
      img.data[x * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, row.seq);
  }

  /** Click on the WEFAX canvas → set that column as the new left edge.
   *  Every subsequent row paints rotated by the offset; previously-painted
   *  rows stay as they were (a fresh `image-start` clears the canvas). */
  private onWefaxCanvasClick(e: MouseEvent) {
    const cv = this.$('wefaxCanvas') as HTMLCanvasElement;
    const r = cv.getBoundingClientRect();
    if (r.width <= 0 || cv.width <= 0) return;
    const xCss = e.clientX - r.left;
    const col  = Math.max(0, Math.min(cv.width - 1, Math.floor(xCss * cv.width / r.width)));
    this.wefaxRowOffset = (this.wefaxRowOffset + col) % cv.width;
    this.$('wefaxStatus').textContent = `WEFAX aligned (offset ${this.wefaxRowOffset} px)`;
  }

  private clearWefaxCanvas() {
    const cv = this.$('wefaxCanvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
  }


  private saveWefaxCanvas() {
    const cv = this.$('wefaxCanvas') as HTMLCanvasElement;
    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = this.wefaxStation.location.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    a.download = `wefax-${slug}-${ts}.png`;
    a.click();
  }

  /** Toggle the FAX-frequency scanner. Cycles through every WEFAX_STATIONS
   *  entry, dwells on each, scores it for the presence of the 1500 Hz (white)
   *  and 2300 Hz (black) WEFAX subcarriers, and stops on the first station
   *  scoring above FAX_SCAN_HIT_DB. The bar graph shows one bar per station;
   *  the bar fills as the score is measured. */
  // @ts-expect-error unused — FAXS button is currently a placeholder.
  private toggleFaxScan() {
    if (this.faxScanOn) { this.stopFaxScan(); return; }
    this.faxScanOn = true;
    this.updateWaterfallStream();
    // Resume from wherever the scanner was last stopped. Scores and the
    // running max are preserved across stop/start so the bar graph keeps
    // its history.
    this.faxScanAudioFilled = 0;
    this.faxScanAudioPos = 0;
    this.setMode('usb');
    // Tap raw audio for the 300 Hz phasing test. Safe to commandeer
    // player.onWefax here — exclusiveActivate('sfax') has already turned
    // the WEFAX decoder off if it was running.
    this.player.onWefax = (s) => this.feedFaxScanAudio(s);
    this.$('btnFaxScan').classList.add('active');
    this.$('faxScanBars').style.display = '';
    this.faxScanRaf = requestAnimationFrame(() => this.drawFaxScanBars());
    this.faxScanStep();
  }

  /** Tap on the bar overlay → pause; tap again → resume on the current station. */
  private toggleFaxScanPause() {
    if (!this.faxScanOn) return;
    if (this.faxScanPaused) {
      this.faxScanPaused = false;
      this.faxScanStep();
    } else {
      this.faxScanPaused = true;
      if (this.faxScanTimer != null) { clearTimeout(this.faxScanTimer); this.faxScanTimer = null; }
    }
  }

  private stopFaxScan() {
    this.faxScanOn = false;
    this.updateWaterfallStream();
    this.faxScanPaused = false;
    if (this.faxScanTimer != null) { clearTimeout(this.faxScanTimer); this.faxScanTimer = null; }
    if (this.faxScanRaf != null) { cancelAnimationFrame(this.faxScanRaf); this.faxScanRaf = null; }
    if (this.player.onWefax && !this.wefaxOn) this.player.onWefax = null;
    this.$('btnFaxScan').classList.remove('active');
    this.$('faxScanBars').style.display = 'none';
  }

  private faxScanStep() {
    if (!this.faxScanOn) return;
    const station = WEFAX_STATIONS[this.faxScanIdx];
    // 1. Tune first — push the dial change to the receiver before showing
    //    anything to the user, so the displayed station only appears once
    //    the radio is actually on the new frequency. station.freqKHz is
    //    already the carrier / USB-dial value; no further offset applies.
    const dialKHz = station.freqKHz;
    this.freqKHz = dialKHz;
    this.client?.setFreqKHz(dialKHz);
    this.recenter();
    this.refresh();
    // Discard any audio from the previous station so the 300 Hz phasing test
    // sees only this dwell's samples.
    this.faxScanAudioFilled = 0;
    this.faxScanAudioPos = 0;
    // 2. Reveal the station label on the next frame so the dial change
    //    visibly precedes the displayed station.
    requestAnimationFrame(() => {
      if (!this.faxScanOn) return;
      this.wefaxStation = station;
      this.faxScanDisplayIdx = this.faxScanIdx;
      this.$('wefaxStatus').textContent =
        `WEFAX scanning ${this.faxScanIdx + 1}/${WEFAX_STATIONS.length} — ${station.location} ${station.freqKHz.toFixed(3)} kHz`;
    });
    this.faxScanTimer = setTimeout(() => {
      if (!this.faxScanOn) return;
      const score = this.measureFaxScore();
      this.faxScanScores[this.faxScanIdx] = score;
      if (score > this.faxScanMax) this.faxScanMax = score;
      if (score >= this.FAX_SCAN_HIT_DB) {
        this.$('wefaxStatus').textContent =
          `WEFAX detected on ${station.location} ${station.freqKHz.toFixed(3)} kHz (score ${score.toFixed(1)} dB)`;
        this.banner(`FAX: ${station.location}`, 4000);
        this.stopFaxScan();
        return;
      }
      this.faxScanIdx = (this.faxScanIdx + 1) % WEFAX_STATIONS.length;
      if (this.faxScanIdx === 0) {
        // Pass complete with no hit; reset scores for the next pass so old
        // bars don't linger forever, but keep the max for normalisation.
        this.faxScanScores.fill(NaN);
      }
      this.faxScanStep();
    }, this.FAX_SCAN_DWELL_MS) as unknown as number;
  }

  private feedFaxScanAudio(int16: Int16Array) {
    const buf = this.faxScanAudio;
    const N = buf.length;
    let pos = this.faxScanAudioPos;
    for (let i = 0; i < int16.length; i++) {
      buf[pos] = int16[i] / 32768;
      pos = (pos + 1) % N;
    }
    this.faxScanAudioPos = pos;
    if (this.faxScanAudioFilled < N) {
      this.faxScanAudioFilled = Math.min(N, this.faxScanAudioFilled + int16.length);
    }
  }

  /** Combined WEFAX-presence score in dB. Combines:
   *    (a) min(SNR_1500, SNR_2300)         — both subcarriers must be present
   *    (b) narrowband occupancy hard gate  — kills SSB voice / wideband noise
   *    (c) 300 Hz phasing-tone bonus       — high-specificity confirmation
   *  Returns 0 if the occupancy gate fails. */
  private measureFaxScore(): number {
    const bins = this.player.getAudioFftBins();
    if (!bins) return 0;
    const sr = this.player.getAudioRate();
    const fftSize = bins.length * 2;
    const binHz = sr / fftSize;
    const dBPerUnit = 80 / 255;
    const peakIn = (loHz: number, hiHz: number) => {
      const lo = Math.max(0, Math.floor(loHz / binHz));
      const hi = Math.min(bins.length - 1, Math.ceil(hiHz / binHz));
      let mx = 0;
      for (let i = lo; i <= hi; i++) if (bins[i] > mx) mx = bins[i];
      return mx;
    };
    const medianIn = (loHz: number, hiHz: number) => {
      const lo = Math.max(0, Math.floor(loHz / binHz));
      const hi = Math.min(bins.length - 1, Math.ceil(hiHz / binHz));
      const arr: number[] = [];
      for (let i = lo; i <= hi; i++) arr.push(bins[i]);
      arr.sort((a, b) => a - b);
      return arr[arr.length >> 1] || 0;
    };
    const peak1500 = peakIn(1450, 1550);
    const peak2300 = peakIn(2250, 2350);
    const ref = Math.max(1, (medianIn(500, 1000) + medianIn(3000, 4000)) / 2);
    const snr1500 = (peak1500 - ref) * dBPerUnit;
    const snr2300 = (peak2300 - ref) * dBPerUnit;
    const twoToneSnr = Math.min(snr1500, snr2300);

    // (b) Hard gate: most of the in-band power must lie inside 1400–2400 Hz,
    // otherwise this is voice/noise/CW and we don't bother with the rest.
    const occ = this.faxBandOccupancy(bins, binHz);
    if (occ < 0.45) return 0;

    // (c) 300 Hz phasing-tone bonus from raw-sample analysis. Returns dB
    // gain (typically 0–10 dB); 0 means no phasing tone seen, which is
    // expected during the active image portion.
    const phasingGain = this.faxPhasingScore();

    return Math.max(0, twoToneSnr + phasingGain);
  }

  /** (1) Narrowband occupancy ratio: in-band power (1400–2400 Hz) divided
   *  by total power across the SSB passband (200–3500 Hz). True WEFAX is
   *  > 0.7; voice runs ~0.3; CW runs near 0 because most energy sits at
   *  the CW pitch outside the fax window. */
  private faxBandOccupancy(bins: Uint8Array, binHz: number): number {
    const sumPower = (loHz: number, hiHz: number) => {
      const lo = Math.max(0, Math.floor(loHz / binHz));
      const hi = Math.min(bins.length - 1, Math.ceil(hiHz / binHz));
      let s = 0;
      for (let i = lo; i <= hi; i++) {
        const dbfs = -100 + (bins[i] / 255) * 80;
        s += Math.pow(10, dbfs / 10);
      }
      return s;
    };
    const inBand = sumPower(1400, 2400);
    const total  = sumPower(200, 3500);
    return total > 0 ? inBand / total : 0;
  }

  /** (2) 300 Hz phasing-tone detector. Computes |X(1500)| and |X(2300)|
   *  in 12-sample windows of the 12 kHz audio (so the envelope sample rate
   *  is 1 kHz, comfortably above 600 Hz Nyquist for the 300 Hz target),
   *  takes their difference, and runs a Goertzel at 300 Hz on it. The
   *  ratio of the 300 Hz component to total envelope power, in dB, is
   *  added to the two-tone SNR.
   *
   *  During the phasing prelude the diff signal is essentially a 300 Hz
   *  square wave → ratio approaches 1 (≈0 dB).  During image transmission
   *  the diff is more random → ratio is small (≈ −10 dB or worse), which
   *  is why we return Math.max(0, …). */
  private faxPhasingScore(): number {
    const N = this.faxScanAudio.length;
    if (this.faxScanAudioFilled < N) return 0;

    // Snapshot the ring buffer in chronological order.
    const snap = new Float32Array(N);
    const start = this.faxScanAudioPos;
    for (let i = 0; i < N; i++) snap[i] = this.faxScanAudio[(start + i) % N];

    // Block-Goertzel envelopes for 1500 Hz and 2300 Hz.
    const audioSr = 12000;
    const block   = 12;                      // 1 ms blocks → 1 kHz envelope rate
    const blocks  = Math.floor(N / block);
    const w1 = 2 * Math.PI * 1500 / audioSr;
    const w2 = 2 * Math.PI * 2300 / audioSr;
    const c1 = 2 * Math.cos(w1);
    const c2 = 2 * Math.cos(w2);
    const diff = new Float32Array(blocks);
    for (let b = 0; b < blocks; b++) {
      let s11 = 0, s12 = 0, s21 = 0, s22 = 0;
      const base = b * block;
      for (let k = 0; k < block; k++) {
        const x = snap[base + k];
        let y = x + c1 * s11 - s21; s21 = s11; s11 = y;
        y     = x + c2 * s12 - s22; s22 = s12; s12 = y;
      }
      const m1 = Math.sqrt(Math.max(0, s11*s11 + s21*s21 - c1*s11*s21));
      const m2 = Math.sqrt(Math.max(0, s12*s12 + s22*s22 - c2*s12*s22));
      diff[b] = m1 - m2;
    }

    // Remove DC, accumulate total AC power.
    let mean = 0;
    for (let i = 0; i < blocks; i++) mean += diff[i];
    mean /= blocks;
    let totalPower = 0;
    for (let i = 0; i < blocks; i++) {
      const v = diff[i] - mean;
      diff[i] = v;
      totalPower += v * v;
    }
    if (totalPower < 1e-9) return 0;

    // Goertzel at 300 Hz on `diff` (sample rate 1 kHz).
    const envSr = 1000;
    const w300 = 2 * Math.PI * 300 / envSr;
    const c300 = 2 * Math.cos(w300);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < blocks; i++) {
      const y = diff[i] + c300 * s1 - s2;
      s2 = s1; s1 = y;
    }
    const goertzelMagSq = s1*s1 + s2*s2 - c300*s1*s2;
    // Power at 300 Hz vs total AC power.
    const ratio = goertzelMagSq / totalPower / blocks;
    return 10 * Math.log10(Math.max(1e-9, ratio));
  }

  private drawFaxScanBars() {
    if (!this.faxScanOn) { this.faxScanRaf = null; return; }
    const cv = this.$('faxScanBars') as HTMLCanvasElement;
    const cssW = cv.clientWidth, cssH = cv.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== cssW * dpr || cv.height !== cssH * dpr) {
      cv.width = cssW * dpr; cv.height = cssH * dpr;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) { this.faxScanRaf = requestAnimationFrame(() => this.drawFaxScanBars()); return; }
    const W = cv.width, H = cv.height;
    // Transparent background — let the FFT and frequency cursor remain
    // visible underneath. Only the bars + footer text + threshold line are
    // drawn opaquely.
    ctx.clearRect(0, 0, W, H);
    const N = WEFAX_STATIONS.length;
    const barW = W / N;
    const norm = Math.max(this.FAX_SCAN_HIT_DB, this.faxScanMax);
    for (let i = 0; i < N; i++) {
      const score = this.faxScanScores[i];
      const x = i * barW;
      const drawn = Number.isFinite(score) ? score : 0;
      const t = Math.max(0, Math.min(1, drawn / norm));
      const h = t * (H - 24 * dpr);
      ctx.fillStyle = i === this.faxScanDisplayIdx ? '#ffeb3b'
                    : score >= this.FAX_SCAN_HIT_DB ? '#7bd16a'
                    : '#3a8ad9';
      ctx.fillRect(x + 1, H - h - 4 * dpr, Math.max(1, barW - 2), h);
    }
    // Threshold line.
    const thr = this.FAX_SCAN_HIT_DB / norm;
    const ty = H - thr * (H - 24 * dpr) - 4 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(W, ty); ctx.stroke();
    ctx.setLineDash([]);
    // Center label — station name on top line, frequency + index below.
    const cur = WEFAX_STATIONS[this.faxScanDisplayIdx];
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffeb3b';
    ctx.font = `bold ${16 * dpr}px ui-monospace, monospace`;
    ctx.fillText(cur.location, W / 2, H / 2 - 12 * dpr);
    ctx.fillStyle = '#cfffa3';
    ctx.font = `${13 * dpr}px ui-monospace, monospace`;
    ctx.fillText(`${cur.freqKHz.toFixed(3)} kHz   (${this.faxScanDisplayIdx + 1}/${N})`,
                 W / 2, H / 2 + 12 * dpr);
    this.faxScanRaf = requestAnimationFrame(() => this.drawFaxScanBars());
  }

  private openWefaxStationPicker() {
    this.registerScanSet('WEFAX', WEFAX_STATIONS.map(s => ({ label: s.location, freqKHz: s.freqKHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal rtty-picker';
    const escape = (s: string) => s.replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
    root.innerHTML = `
      <div class="rtty-list">
        ${WEFAX_STATIONS.map((s, i) => `
          <button class="rtty-row ${s.freqKHz === this.freqKHz ? 'active' : ''}" data-freq="${s.freqKHz}" data-idx="${i}">
            <div class="rtty-row-name">${escape(s.location)}</div>
            <div class="rtty-row-meta">${s.freqKHz.toFixed(3)} kHz</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.rtty-row') as HTMLElement | null;
      if (t) {
        const f = +t.dataset.freq!;
        const idx = +t.dataset.idx!;
        const station = WEFAX_STATIONS[idx] ?? this.wefaxStation;
        this.wefaxStation = station;
        this.freqKHz = f;
        this.client?.setFreqKHz(f);
        this.recenter();
        this.refresh();
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  /** Mutual exclusivity for the digital-mode row (CW / RTTY / PSK31 / OLIVIA /
   *  FT4 / FT8 / FAX / AUTO). Before activating one, turn off any other that
   *  is currently on. Tapping the already-active button still toggles it off
   *  via the caller's own toggle, since the same name is skipped here. */
  /** Returns true when at least one server-side decoder or the audio
   *  spectrogram is currently open — i.e. when the waterfall stream is
   *  redundant and should be paused. */
  private wfShouldPause(): boolean {
    return this.cwOn || this.rttyOn || this.pskOn || this.psk31bOn || this.oliviaOn ||
           this.mfskOn || this.mt63On || this.fsqOn || this.thorOn || this.dominoexOn ||
           this.wefaxOn || this.navtexOn || this.aleOn || this.hfdlOn || this.autoOn ||
           this.packetOn || this.wsprOn || this.js8On || this.fst4On || this.scopeOn || this.thdOn || this.dsdOn || this.multimonOn || this.vendoredOn || this.grayOn || this.vectOn || this.iqEyeOn ||
           this.ft8On || this.faxScanOn || this.audioFftOn;
  }
  /** Sync the waterfall stream's paused-state to whether any decoder /
   *  audio spectrogram is open. Called from each toggle method. */
  private updateWaterfallStream(): void {
    if (!this.client) return;
    if (this.wfShouldPause()) this.client.pauseWaterfall();
    else                      this.client.resumeWaterfall();
  }

  private exclusiveActivate(name: 'cw' | 'rtty' | 'psk' | 'psk31b' | 'olivia' | 'mfsk' | 'mt63' | 'fsq' | 'thor' | 'dominoex' | 'contestia' | 'ftx' | 'wefax' | 'auto' | 'sfax' | 'navtex' | 'sitor' | 'wwv' | 'ale' | 'hfdl' | 'isb' | 'ssbf' | 'qrss' | 'packet' | 'packet-vhf' | 'packet-9600' | 'packet-il2p' | 'wspr' | 'wspr15' | 'jt9' | 'jt65' | 'q65' | 'jt4' | 'js8' | 'fst4' | 'fst4w' | 'stanag' | 'stanag4539' | 'hell' | 'sstv' | 'freedv' | 'throb' | 'selcal' | 'pocs' | 'dsd' | 'multimon' | 'vendored' | 'scope' | 'thd' | 'gray' | 'vect' | 'eye' | 'spec' | 'iqview' | 'splot' | 'sdial' | 'drift' | 'fmnt' | 'acon') {
    // ── Decoder panels ──
    if (this.cwOn     && name !== 'cw')     this.toggleCw();
    if (this.rttyOn   && name !== 'rtty')   this.toggleRtty();
    if (this.pskOn    && name !== 'psk')    this.togglePsk();
    if (this.psk31bOn && name !== 'psk31b') this.togglePsk31b();
    if (this.oliviaOn && name !== 'olivia') this.toggleOlivia();
    if (this.mfskOn   && name !== 'mfsk')   this.toggleMfsk();
    if (this.mt63On   && name !== 'mt63')   this.toggleMt63();
    if (this.fsqOn    && name !== 'fsq')    this.toggleFsq();
    if (this.thorOn   && name !== 'thor')   this.toggleThor();
    if (this.dominoexOn && name !== 'dominoex') this.toggleDominoex();
    if (this.contestiaOn && name !== 'contestia') this.toggleContestia();
    if (this.wefaxOn  && name !== 'wefax')  this.toggleWefax();
    if (this.navtexOn && name !== 'navtex') this.toggleNavtex();
    if (this.packetOn && name !== 'packet') this.togglePacket();
    if (this.wsprOn   && name !== 'wspr')   this.toggleWspr();
    if (this.wspr15On && name !== 'wspr15') this.toggleWspr15();
    if (this.jt9On    && name !== 'jt9')    this.toggleJt9();
    if (this.jt65On   && name !== 'jt65')   this.toggleJt65();
    if (this.q65On    && name !== 'q65')    this.toggleQ65();
    if (this.fst4wOn  && name !== 'fst4w')  this.toggleFst4w();
    if (this.stanagOn && name !== 'stanag') this.toggleStanag();
    if (this.stanag4539On && name !== 'stanag4539') this.toggleStanag4539();
    if (this.hellOn   && name !== 'hell')   this.toggleHell();
    if (this.sstvOn   && name !== 'sstv')   this.toggleSstv();
    if (this.freedvOn && name !== 'freedv') this.toggleFreedv();
    if (this.throbOn  && name !== 'throb')  this.toggleThrob();
    if (this.jt4On    && name !== 'jt4')    this.toggleJt4();
    if (this.selcalOn && name !== 'selcal') this.toggleSelcal();
    if (this.pocsOn   && name !== 'pocs')   this.togglePocs();
    if (this.dsdOn    && name !== 'dsd')    this.toggleDsd(this.dsdMode);
    if (this.multimonOn && name !== 'multimon') this.toggleMultimon(this.multimonMode);
    if (this.vendoredOn && name !== 'vendored' && this.vendoredKind)
      this.toggleVendored(this.vendoredKind,
        this.vendoredEndpointFor(this.vendoredKind),
        this.vendoredSinkFor(this.vendoredKind));
    if (this.js8On    && name !== 'js8')    this.toggleJs8();
    if (this.fst4On   && name !== 'fst4')   this.toggleFst4();
    if (this.scopeOn  && name !== 'scope')  this.toggleScope();
    if (this.thdOn    && name !== 'thd')    this.toggleThd();
    if (this.grayOn   && name !== 'gray')   this.toggleGray();
    if (this.vectOn   && name !== 'vect')   this.toggleVect();
    if (this.iqEyeOn  && name !== 'eye')    this.toggleIqEye();
    if (this.aleOn    && name !== 'ale')    this.toggleAle();
    if (this.hfdlOn   && name !== 'hfdl')   this.toggleHfdl();
    if (this.isbOn    && name !== 'isb')    this.toggleIsb();
    if (this.ssbfOn   && name !== 'ssbf')   this.toggleSsbFiltered(this.ssbfSide);
    if (this.qrssOn   && name !== 'qrss')   this.toggleQrss();
    if (this.sitorOn  && name !== 'sitor')  this.toggleSitor();
    if (this.wwvOn    && name !== 'wwv')    this.toggleWwv();
    if (this.autoOn   && name !== 'auto')   this.toggleAuto();
    if (this.ft8On    && name !== 'ftx')    this.toggleFtx(this.ft8Mode);
    if (this.faxScanOn && name !== 'sfax')  this.stopFaxScan();
    // ── Visualizer / utility panels (all share the spectrum-wrap area
    // so they're mutually exclusive both with each other and with any
    // active decoder panel). ──
    if (this.audioFftOn && name !== 'spec')   this.toggleAudioFft();
    if (this.iqViewOn   && name !== 'iqview') this.toggleIqView();
    if (this.aconOn     && name !== 'acon')   this.toggleAcon();
    if (this.sPlotOn    && name !== 'splot')  this.toggleSPlot();
    if (this.fmntOn     && name !== 'fmnt')   this.toggleFmnt();
    if (this.sDialOn    && name !== 'sdial')  this.toggleSDial();
    if (this.driftOn    && name !== 'drift')  this.toggleDrift();
  }

  private bindFtxLongPress(el: HTMLElement, onTap: () => void, onLong: () => void) {
    let timer: number | null = null;
    let longFired = false;
    const cancel = () => { if (timer != null) { clearTimeout(timer); timer = null; } };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      longFired = false;
      timer = setTimeout(() => { timer = null; longFired = true; onLong(); }, 500) as unknown as number;
    });
    el.addEventListener('pointerup',     cancel);
    el.addEventListener('pointerleave',  cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('click', (e) => {
      if (longFired) { e.stopImmediatePropagation(); longFired = false; return; }
      onTap();
    });
    // Expose the long-press callback so external surfaces (like the
    // DECOD picker) can fire it even when the underlying on-page
    // button isn't reachable for a real long-press gesture.
    (el as HTMLElement & { __longPress?: () => void }).__longPress = onLong;
  }

  /** Fire `step` once on press, then repeat every 1 s while the button is held. */
  private bindRepeatPress(el: HTMLElement, step: () => void) {
    let timer: number | null = null;
    const stop = () => { if (timer != null) { clearInterval(timer); timer = null; } };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      step();
      stop();
      timer = setInterval(step, 1000) as unknown as number;
    });
    el.addEventListener('pointerup',     stop);
    el.addEventListener('pointerleave',  stop);
    el.addEventListener('pointercancel', stop);
  }

  private openFtxFreqPicker(mode: 'FT8' | 'FT4') {
    const list = mode === 'FT4' ? FT4_FREQS : FT8_FREQS;
    this.registerScanSet(mode, list.map(([band, kHz]) => ({ label: `${band} ${mode}`, freqKHz: kHz, mode: 'usb' as Mode })));
    const root = document.createElement('div');
    root.className = 'band-modal ftx-picker';
    root.innerHTML = `
      <div class="band-grid">
        ${list.map(([band, kHz]) => `
          <button class="band-btn" data-khz="${kHz}">
            <div style="font-size:12px;opacity:0.7">${band}</div>
            <div>${(kHz / 1000).toFixed(3)}</div>
          </button>`).join('')}
      </div>
    `;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
      if (t) {
        const kHz = +t.dataset.khz!;
        const pb = defaultPassbandFor('usb');
        this.applyPreset({ freqKHz: kHz, mode: 'usb', lowCut: pb.lowCut, highCut: pb.highCut, name: `${mode} ${kHz / 1000} MHz` });
        if (!this.ft8On || this.ft8Mode !== mode) this.toggleFtx(mode);
        root.remove();
        return;
      }
      if (e.target === root) root.remove();
    });
  }

  private refreshFtxButtons() {
    this.$('btnFt8').classList.toggle('active', this.ft8On && this.ft8Mode === 'FT8');
    this.$('btnFt4').classList.toggle('active', this.ft8On && this.ft8Mode === 'FT4');
  }

  private feedFt8(samples: Int16Array) {
    if (!this.ft8On) return;
    // Lazy alloc the rolling buffer at the actual audio rate. Re-allocate if
    // either the rate is unknown or the buffer was wiped (e.g. mode switch).
    if (this.ft8Rate === 0 || !this.ft8Buf) {
      this.ft8Rate = this.player.getInputRate() || 12000;
      // ~16 s buffer to give us overlap room past a 15 s window.
      this.ft8Buf = new Float32Array(Math.ceil(this.ft8Rate * 16));
      this.ft8Idx = 0;
    }
    const buf = this.ft8Buf;
    for (let i = 0; i < samples.length; i++) {
      buf[this.ft8Idx] = samples[i] / 32768;
      this.ft8Idx = (this.ft8Idx + 1) % buf.length;
    }
    this.maybeDecodeFt8();
  }

  /** Fire a decode each time UTC seconds cross a 15 s (FT8) or 7.5 s (FT4) boundary. */
  private maybeDecodeFt8() {
    if (!this.ft8On || this.ft8Decoding || !this.ft8Buf || this.ft8Rate === 0) return;
    const periodMs = this.ft8Mode === 'FT4' ? 7500 : 15000;
    const nowMs = Date.now();
    const slot = Math.floor(nowMs / periodMs) * periodMs;
    if (slot === this.ft8LastDecode) return;
    // Wait until ~1 s past the boundary so the window is genuinely complete.
    if (nowMs - slot < 1000) return;
    this.ft8LastDecode = slot;

    const winSec = this.ft8Mode === 'FT4' ? 7.5 : 15;
    const winSamples = Math.floor(this.ft8Rate * winSec);
    const buf = this.ft8Buf;
    // Read the most recent winSamples, ending ~1 s ago (skip the boundary tail).
    const endIdx = (this.ft8Idx - Math.floor(this.ft8Rate * 1) + buf.length) % buf.length;
    const startIdx = (endIdx - winSamples + buf.length) % buf.length;
    const window = new Float32Array(winSamples);
    if (startIdx + winSamples <= buf.length) {
      window.set(buf.subarray(startIdx, startIdx + winSamples));
    } else {
      const part1 = buf.length - startIdx;
      window.set(buf.subarray(startIdx), 0);
      window.set(buf.subarray(0, winSamples - part1), part1);
    }

    this.ft8Decoding = true;
    this.$('ft8Status').textContent = `${this.ft8Mode} decoding…`;
    decodeFt8Window(window, this.ft8Rate, this.ft8Mode)
      .then((msgs) => this.renderFt8(msgs))
      .catch((e) => {
        this.$('ft8Status').textContent = 'FT8 error: ' + (e as Error).message;
        console.warn('[ft8]', e);
      })
      .finally(() => {
        this.ft8Decoding = false;
        if (this.ft8On) this.$('ft8Status').textContent = `${this.ft8Mode} listening…`;
      });
  }

  private renderFt8(msgs: Ft8Message[]) {
    const lines = this.$('ft8Lines');
    const stamp = new Date().toLocaleTimeString();
    const header = document.createElement('div');
    header.className = 'ft8-header';
    header.textContent = `── ${stamp} · ${msgs.length} msg ──`;
    lines.appendChild(header);
    for (const m of msgs) {
      const div = document.createElement('div');
      div.className = 'ft8-line';
      div.textContent = `${(+m.snrDb).toFixed(0).padStart(3)} dB · ${m.freqHz.toFixed(0).padStart(4)} Hz · ${m.dtSec.toFixed(1)}s · ${m.text}`;
      lines.appendChild(div);
    }
    while (lines.children.length > 200) lines.removeChild(lines.firstChild!);
    lines.scrollTop = lines.scrollHeight;
  }

  /** Top of the spectrogram's frequency axis: |lof| + |hif|. */
  private spectrogramMaxHz(): number {
    return Math.max(100, Math.abs(this.lowCut) + Math.abs(this.highCut));
  }

  private adjustAudioFftContrast(delta: number) {
    this.audioFftGamma = Math.max(0.2, Math.min(9.9, +(this.audioFftGamma + delta).toFixed(1)));
    const v = this.$('audioFftContrastVal');
    if (v) v.textContent = `C ${this.audioFftGamma.toFixed(1)}`;
  }

  private onAudioFftClick(e: PointerEvent) {
    e.preventDefault();
    const canvas = this.$('audioFft') as HTMLCanvasElement;
    const lbl = this.$('audioFftLabel');
    const setFromY = (clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const t = 1 - (clientY - rect.top) / rect.height;
      const maxHz = this.spectrogramMaxHz();
      this.audioFftCursorHz = Math.max(0, Math.min(maxHz, t * maxHz));
      lbl.style.display = '';
    };
    setFromY(e.clientY);
    canvas.setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => setFromY(ev.clientY);
    const onUp = () => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  private async openRecordings() {
    try {
      const list = await listRecordings();
      openRecordingsModal(list, async (action, id) => {
        if (action === 'play') {
          const b = await getRecordingBlob(id);
          return b;
        }
        if (action === 'delete') {
          await deleteRecording(id);
        }
        return null;
      });
    } catch (e) {
      this.banner('Recordings error: ' + (e as Error).message, 2500);
    }
  }

  private toggle(name: keyof Toggles) {
    this.toggles[name] = !this.toggles[name];
    if (name === 'fft') (this.$('fft') as HTMLElement).style.display = this.toggles.fft ? '' : 'none';
    if (name === 'wf')  (this.$('wf')  as HTMLElement).style.display = this.toggles.wf  ? '' : 'none';
    if (name === 'comp') {
      this.player.setCompressor(this.toggles.comp);
      this.banner(`COMP ${this.toggles.comp ? 'on (+8 dB makeup)' : 'off'}`, 1500);
    }
    if (name === 'adpcm') {
      this.player.resetAdpcm();
      this.client?.setAdpcm(this.toggles.adpcm);
      this.banner(`ADPCM ${this.toggles.adpcm ? 'on (4-bit, ½ bandwidth)' : 'off (raw PCM)'}`, 1500);
    }
    this.refresh();
  }

  /* ───────────── refresh display ───────────── */

  private refresh() {
    // Re-evaluate the waterfall pause state on every refresh — cheap
    // (just one boolean compare + at most one WS message when state
    // changes) and guarantees the WF stream stays paused whenever any
    // decoder or the audio spectrogram is open.
    this.updateWaterfallStream();
    // LED freq: pending digits in entry mode (no leading-zero padding —
    // just whatever the user has typed so far + cursor), else current tune.
    const display = this.pending != null ? this.pending + ' kHz_' : formatFreqKHz(this.freqKHz);
    this.$('ledFreq').innerHTML = this.pending != null
      ? `<span style="opacity:.6">${display}</span>`
      : display;

    this.$('lblMode').textContent = this.mode.toUpperCase();
    this.$('lblBand').textContent = bandLabel(this.freqKHz);

    this.$('lblVol').textContent = `Vol ${this.vol|0}%`;
    this.$('lblSql').textContent = `SQL ${this.sql|0} dB`;
    this.$('lblLo').textContent = `Lo ${this.lowCut} Hz`;
    this.$('lblHi').textContent = `Hi ${this.highCut} Hz`;
    const usersEl = this.$('lblUsers');
    if (this.rxChans != null) {
      const u = this.usersOnline != null ? this.usersOnline : '?';
      usersEl.textContent = `U ${u}/${this.rxChans}`;
    } else {
      usersEl.textContent = '';
    }

    const stats: string[] = [];
    if (this.cpuPct != null) stats.push(`CPU ${this.cpuPct.toFixed(0)}%`);
    if (this.tempC != null) stats.push(`${this.tempC.toFixed(0)}°C`);
    if (this.memAvailKB != null) {
      const mb = this.memAvailKB / 1024;
      stats.push(`MEM ${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)}MB`);
    }
    if (this.gpsLocked != null) stats.push(this.gpsLocked ? 'GPS✓' : 'GPS×');
    if (this.adcOv != null && this.adcOv > 0) stats.push(`OV ${this.adcOv}`);
    if (this.droppedAudio != null && this.droppedAudio > 0) stats.push(`drop ${this.droppedAudio}`);
    if (this.droppedWf != null && this.droppedWf > 0) stats.push(`wf-drop ${this.droppedWf}`);
    // FPS moved to the top led-status row (#lblFps) — no longer in the
    // bottom stats line.
    // OpenWebRX doesn't expose zoom in the Kiwi sense — label the
    // visible bandwidth slot "BW <kHz>" instead, no separator dot.
    const v = this.spectrumSpanKHz;
    const bwStr = v != null ? `${v < 100 ? v.toFixed(1) : Math.round(v)} kHz` : '';
    if (this.isOwrxSource()) {
      if (bwStr) stats.push(`BW ${bwStr}`);
    } else {
      stats.push(this.zoomMax != null ? `Z${this.zoom}/${this.zoomMax}` : `Z${this.zoom}`);
      if (bwStr) stats.push(bwStr);
    }
    if (this.fwVersion) stats.push(this.fwVersion);
    this.$('ledStats').textContent = stats.join(' · ');

    // Knob dials (vol 0..100 → 0..270deg, sql -120..0 → 0..270, lof/hif map -8000..8000)
    this.setDial('vol', this.vol, 0, 100);
    this.setDial('sql', this.sql, 0, 40);
    this.setDial('gate', this.gate, 0, 100);
    this.setDial('rf',  this.rfGain, 0, 120);
    this.setDial('lof', this.lowCut, -8000, 8000);
    this.setDial('hif', this.highCut, -8000, 8000);
    this.setDial('wlo', this.wfBase, 0, 255);
    this.setDial('whi', this.wfTop, 0, 255);
    this.setDial('vtg', this.vTrackGain, 0, 18);

    // FPS button label is fixed at "FPS"; the current speed is shown
    // on the LED row in #lblFps as "current/max" (actual frames-per-
    // second the kiwi delivers at each wfSpeed code, against the max
    // the receiver can deliver — typically 23 fps).
    const speedBtn = this.root.querySelector('#btnSpeed') as HTMLElement | null;
    if (speedBtn) speedBtn.textContent = 'FPS';
    const lblFps = this.root.querySelector('#lblFps') as HTMLElement | null;
    if (lblFps) {
      // Kiwi wfSpeed → actual fps mapping (per official firmware).
      const fpsTable = [0, 1, 5, 13, 23];
      const cur = fpsTable[this.wfSpeed] ?? 0;
      const max = this.wfFpsMax ?? 23;
      lblFps.textContent = `FPS ${cur}/${max}`;
    }

    // Active states
    this.$$('button[data-mode]').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === this.mode);
    });
    this.$$('button[data-toggle]').forEach(b => {
      const k = b.dataset.toggle as keyof Toggles;
      b.classList.toggle('active', !!this.toggles[k]);
    });
    this.refreshScanButtons();
    this.$$('button[data-cmd="nb"]').forEach(b => b.classList.toggle('active', this.nbMode > 0));
    this.$$('button[data-cmd="nr"]').forEach(b => b.classList.toggle('active', this.nrMode > 0));
    this.$$('button[data-bw]').forEach(b => {
      const presetKHz = +b.dataset.bw!;
      b.classList.toggle('active', this.activeBwPreset === presetKHz);
    });
    const nbNames = ['', 'NB-STD', 'NB-AUTO', 'NB-WILD'];
    this.$('lblNb').textContent = nbNames[this.nbMode] || '';
    // NR badge — index 0 hidden (no badge when off), 1..3 = HI/MED/LO
    // (threshold decreases → more aggressive filtering).
    const nrNames = ['', 'NR-HI', 'NR-MED', 'NR-LO'];
    this.$('lblNr').textContent = nrNames[this.nrMode] || '';

    this.saveRadioState();
  }

  private setDial(id: string, v: number, min: number, max: number) {
    const el = this.root.querySelector(`.knob[data-knob="${id}"] .knob-line`) as HTMLElement | null;
    if (!el) return;
    const t = (v - min) / (max - min);
    const deg = -135 + t * 270;
    el.style.transform = `rotate(${deg.toFixed(1)}deg)`;
  }

  private log(line: string) {
    console.log('[radiom]', line);
    const el = this.root.querySelector('#log') as HTMLElement | null;
    if (el) el.textContent = (line + '\n' + el.textContent).slice(0, 16000);
  }

  /* ─────────────── persistent radio state ─────────────── */

  private loadRadioState() {
    try {
      const raw = localStorage.getItem(RADIO_STATE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<RadioState>;
      if (typeof s.mode === 'string') {
        // 'iq' is a transient mode used by HFDL / IQ-VIEW / IQ constellation.
        // Persisting it leaves the receiver dropping all real-audio frames
        // through pushAudio after a reload — the kiwi sends stereo frames
        // but the player's iqMode flag init's to false, so audio is silent
        // / garbled. Discard a saved 'iq' and fall back to USB.
        this.mode = (s.mode === 'iq' ? 'usb' : s.mode) as Mode;
      }
      if (Number.isFinite(s.freqKHz)) this.freqKHz = s.freqKHz!;
      if (Number.isFinite(s.lowCut)) this.lowCut = s.lowCut!;
      if (Number.isFinite(s.highCut)) this.highCut = s.highCut!;
      if (Number.isFinite(s.vol)) this.vol = clamp(s.vol!, 0, 100);
      if (Number.isFinite(s.sql)) this.sql = clamp(s.sql!, 0, 40);
      if (Number.isFinite(s.wfSpeed)) this.wfSpeed = clamp(s.wfSpeed! | 0, 0, 4);
      if (Number.isFinite(s.zoom)) this.zoom = clamp(s.zoom! | 0, 0, 14);
      if (Number.isFinite(s.wfBase)) this.wfBase = clamp(s.wfBase! | 0, 0, 255);
      if (Number.isFinite(s.wfTop)) this.wfTop = clamp(s.wfTop! | 0, 0, 255);
      if (Number.isFinite(s.nbMode)) this.nbMode = clamp(s.nbMode! | 0, 0, 3);
      if (s.toggles) this.toggles = { ...this.toggles, ...s.toggles };
      this.activeBwPreset = s.activeBwPreset == null ? null : +s.activeBwPreset;
    } catch { /* corrupt JSON — fall back to defaults */ }
  }

  private saveRadioState() {
    const s: RadioState = {
      // Don't persist transient 'iq' — restore it as 'usb' next session
      // so the receiver doesn't come up silent. See loadRadioState().
      mode: this.mode === 'iq' ? 'usb' : this.mode,
      freqKHz: this.freqKHz,
      lowCut: this.lowCut,
      highCut: this.highCut,
      vol: this.vol,
      sql: this.sql,
      wfSpeed: this.wfSpeed,
      zoom: this.zoom,
      wfBase: this.wfBase,
      wfTop: this.wfTop,
      nbMode: this.nbMode,
      toggles: this.toggles,
      activeBwPreset: this.activeBwPreset,
    };
    try { localStorage.setItem(RADIO_STATE_KEY, JSON.stringify(s)); } catch { /* quota */ }
  }
}

const RADIO_STATE_KEY = 'radiom.radio.v1';
interface RadioState {
  mode: Mode;
  freqKHz: number;
  lowCut: number;
  highCut: number;
  vol: number;
  sql: number;
  wfSpeed: number;
  zoom: number;
  wfBase: number;
  wfTop: number;
  nbMode: number;
  toggles: Toggles;
  activeBwPreset: number | null;
}

/* ───────────── helpers ───────────── */

function formatAudioHz(hz: number): string {
  if (hz >= 1000) return (hz / 1000).toFixed(3) + ' kHz';
  return hz.toFixed(3) + ' Hz';
}

function formatLabelKHz(kHz: number): string {
  // Always in kHz — the waterfall edge labels share a header where
  // the unit is implied by context (the bw readout uses the same unit).
  return kHz.toFixed(1);
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function openRecordingsModal(
  list: RecordingMeta[],
  action: (kind: 'play' | 'delete', id: number) => Promise<Blob | null>,
): void {
  const root = document.createElement('div');
  root.className = 'band-modal recordings-modal';
  const renderRow = (r: RecordingMeta) => {
    const date = new Date(r.ts).toLocaleString();
    const sizeKB = Math.round(r.bytes / 1024);
    return `
      <div class="rec-row" data-id="${r.id}">
        <div class="rec-meta">
          <div class="rec-title">${date}</div>
          <div class="rec-sub">${formatDuration(r.durationSec)} · ${sizeKB} KB · ${escapeAttr(r.mode.toUpperCase())} ${r.freqKHz} kHz</div>
          <div class="rec-sub">${escapeAttr(r.server)}</div>
        </div>
        <audio class="rec-audio" controls preload="none"></audio>
        <button class="rec-del" data-del="${r.id}">Delete</button>
      </div>`;
  };
  root.innerHTML = `
    <div class="stats-card">
      <div class="stats-bar">
        <h3>Recordings (${list.length})</h3>
        <button class="stats-close" aria-label="close">✕</button>
      </div>
      <div class="rec-list">
        ${list.length === 0 ? '<div class="stats-empty">No recordings yet.</div>' : list.map(renderRow).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const close = () => root.remove();
  (root.querySelector('.stats-close') as HTMLButtonElement).addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });

  // Lazy-load each row's audio src on first interaction.
  root.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const delId = t.getAttribute('data-del');
    if (delId) {
      e.stopPropagation();
      const row = t.closest('.rec-row') as HTMLElement | null;
      await action('delete', +delId);
      row?.remove();
      return;
    }
  });
  // Preload each row's blob into its <audio> element. The play button is
  // disabled by browsers until the element has a src + can-play, so deferring
  // until the 'play' event never fires.
  root.querySelectorAll('.rec-audio').forEach(async (el) => {
    const audio = el as HTMLAudioElement;
    const id = +(audio.closest('.rec-row') as HTMLElement).dataset.id!;
    try {
      const blob = await action('play', id);
      if (blob) audio.src = URL.createObjectURL(blob);
    } catch { /* ignore — row stays unplayable */ }
  });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function leftPad(s: string, n: number): string {
  return s.length >= n ? s : '0'.repeat(n - s.length) + s;
}

function formatFreqKHz(kHz: number): string {
  // Integer kHz + 3 decimals, no leading zero padding (e.g. "7200.000").
  const k = Math.floor(kHz);
  const frac = Math.round((kHz - k) * 1000);
  return k.toString() + '.' + leftPad(frac.toString(), 3);
}

function bandLabel(kHz: number): string {
  // Coarse ham/SWBC bands
  if (kHz < 1000) return 'LF';
  if (kHz < 1700) return 'MW';
  const m = [
    [1800, 2000, '160m'], [3500, 4000, '80m'], [5900, 6200, '49m'],
    [7000, 7300, '40m'], [9400, 9900, '31m'], [10100, 10150, '30m'],
    [11600, 12100, '25m'], [13570, 13870, '22m'], [14000, 14350, '20m'],
    [15100, 15800, '19m'], [17480, 17900, '16m'], [18068, 18168, '17m'],
    [21000, 21450, '15m'], [24890, 24990, '12m'], [28000, 29700, '10m'],
  ] as const;
  for (const [lo, hi, name] of m) if (kHz >= lo && kHz <= hi) return name;
  return `${(kHz/1000).toFixed(1)}M`;
}

function sUnit(dbm: number): string {
  // S9 ≈ -73 dBm on HF; each S unit is 6 dB; S0 ≈ -127 dBm
  if (dbm >= -73) return `S9+${Math.min(60, Math.round(dbm + 73))}`;
  const s = Math.max(0, Math.min(9, Math.round((dbm + 127) / 6)));
  return `S${s}`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

/** Olivia/Contestia variants — Jalocha MFSK with different tone counts
 *  and bandwidths. Contestia uses 2× Olivia tones for the same nominal
 *  setting (smaller per-symbol payload, faster transmission). The same
 *  WASM decodes both — only the tones / bandwidth configuration changes. */
interface OliviaPreset { name: string; tones: number; bandwidth: number; }
// Full set of 18 Olivia tone/bandwidth configurations supported by the
// vendored fldigi decoder. Contestia uses the same engine but has its
// own decoder + button; it's not part of this list anymore.
// `*` marks configurations that actually carry on-air HF traffic; the
// unmarked ones are spec-completeness modes that fldigi enumerates but
// are never (or extremely rarely) transmitted in practice.
/** HF watering holes for Olivia (USB dial, audio centered ~1500 Hz).
 *  `tones` / `bandwidth` is the recommended preset for each spot — the
 *  freq picker auto-selects it when the user taps a row. */
interface OliviaFreq { band: string; freqKHz: number; preset: string; tones: number; bandwidth: number; note: string; }
const OLIVIA_FREQS: OliviaFreq[] = [
  { band: '160 m', freqKHz:  1838.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'shared w/ PSK / RTTY' },
  { band: '80 m',  freqKHz:  3580.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'EU' },
  { band: '80 m',  freqKHz:  3582.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'NA / DX' },
  { band: '80 m',  freqKHz:  3584.000, preset: '16/500',  tones: 16, bandwidth:  500, note: 'wider variant' },
  { band: '40 m',  freqKHz:  7038.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'EU/JA primary calling' },
  { band: '40 m',  freqKHz:  7053.000, preset: '8/250',   tones:  8, bandwidth:  250, note: 'secondary' },
  { band: '40 m',  freqKHz:  7073.500, preset: '16/500',  tones: 16, bandwidth:  500, note: 'NA primary, ARRL emcomm' },
  { band: '30 m',  freqKHz: 10141.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'global calling' },
  { band: '30 m',  freqKHz: 10145.000, preset: '16/500',  tones: 16, bandwidth:  500, note: 'wider' },
  { band: '20 m',  freqKHz: 14106.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'WORLDWIDE WATERING HOLE' },
  { band: '20 m',  freqKHz: 14108.500, preset: '32/1000', tones: 32, bandwidth: 1000, note: 'wider QSOs after 14106.5 calling' },
  { band: '17 m',  freqKHz: 18103.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'calling' },
  { band: '17 m',  freqKHz: 18108.500, preset: '16/500',  tones: 16, bandwidth:  500, note: 'secondary' },
  { band: '15 m',  freqKHz: 21130.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'calling' },
  { band: '12 m',  freqKHz: 24923.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'sporadic' },
  { band: '10 m',  freqKHz: 28076.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'when band is open' },
  { band: '10 m',  freqKHz: 28078.500, preset: '8/250',   tones:  8, bandwidth:  250, note: 'secondary' },
  { band: '6 m',   freqKHz: 50293.000, preset: '16/500',  tones: 16, bandwidth:  500, note: 'sporadic-E events' },
];

const OLIVIA_PRESETS: OliviaPreset[] = [
  { name: 'Olivia 4/125',     tones:  4, bandwidth:  125 },
  { name: 'Olivia 4/250 *',   tones:  4, bandwidth:  250 },
  { name: 'Olivia 4/500',     tones:  4, bandwidth:  500 },
  { name: 'Olivia 4/1000',    tones:  4, bandwidth: 1000 },
  { name: 'Olivia 4/2000',    tones:  4, bandwidth: 2000 },
  { name: 'Olivia 8/125',     tones:  8, bandwidth:  125 },
  { name: 'Olivia 8/250 *',   tones:  8, bandwidth:  250 },
  { name: 'Olivia 8/500 *',   tones:  8, bandwidth:  500 },
  { name: 'Olivia 8/1000',    tones:  8, bandwidth: 1000 },
  { name: 'Olivia 8/2000',    tones:  8, bandwidth: 2000 },
  { name: 'Olivia 16/500 *',  tones: 16, bandwidth:  500 },
  { name: 'Olivia 16/1000 *', tones: 16, bandwidth: 1000 },
  { name: 'Olivia 16/2000',   tones: 16, bandwidth: 2000 },
  { name: 'Olivia 32/1000 *', tones: 32, bandwidth: 1000 },
  { name: 'Olivia 32/2000',   tones: 32, bandwidth: 2000 },
  { name: 'Olivia 64/500',    tones: 64, bandwidth:  500 },
  { name: 'Olivia 64/1000',   tones: 64, bandwidth: 1000 },
  { name: 'Olivia 64/2000',   tones: 64, bandwidth: 2000 },
];

/** Conventional PSK31 dial frequencies (USB) per ham band. */
/** Decoder pipeline rate. The fldigi-vendored decoders all expect 12 kHz
 *  int16 mono, matching what Kiwi sends. */
const TEST_TARGET_SR = 12000;

/** Decode any browser-supported audio file to a 12 kHz mono Int16 buffer
 *  using OfflineAudioContext, which performs proper anti-aliased
 *  resampling — much higher quality than a hand-rolled linear interp,
 *  which is critical for digital-mode decoders that need the carrier
 *  cleanly preserved after downsampling. */
async function decodeAndResampleTo12k(url: string): Promise<Int16Array> {
  const resp = await fetch(url);
  const arr  = await resp.arrayBuffer();
  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  const tmp = new Ctx();
  const buf = await tmp.decodeAudioData(arr.slice(0));
  await tmp.close();
  const durSec = buf.duration;
  const targetLen = Math.max(1, Math.floor(durSec * TEST_TARGET_SR));
  // OfflineAudioContext renders at the requested rate using the browser's
  // built-in polyphase resampler — this is what gives us proper LPF +
  // decimation rather than aliasing-prone linear interpolation.
  const off = new OfflineAudioContext({ numberOfChannels: 1, length: targetLen, sampleRate: TEST_TARGET_SR });
  const src = off.createBufferSource();
  // If the source has multiple channels, downmix to mono via a merger;
  // OfflineAudioContext will handle it because the destination is mono.
  src.buffer = buf;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  const f32 = rendered.getChannelData(0);
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = f32[i];
    out[i] = s >= 1 ? 32767 : s <= -1 ? -32768 : Math.round(s * 32767);
  }
  return out;
}

/** Decode any browser-supported audio file to a mono Float32 buffer at
 *  the requested sample rate. Used by the SID validator to feed test
 *  samples through the IQ classifier. */
async function decodeMonoFloat32(url: string, sampleRate: number): Promise<Float32Array> {
  const resp = await fetch(url);
  const arr  = await resp.arrayBuffer();
  const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
  const tmp = new Ctx();
  const buf = await tmp.decodeAudioData(arr.slice(0));
  await tmp.close();
  const durSec = buf.duration;
  const targetLen = Math.max(1, Math.floor(durSec * sampleRate));
  const off = new OfflineAudioContext({ numberOfChannels: 1, length: targetLen, sampleRate });
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  // Cap to ~10 s so long captures don't dominate FFT runtime.
  const max = sampleRate * 10;
  const f32 = rendered.getChannelData(0);
  const len = Math.min(f32.length, max);
  const out = new Float32Array(len);
  out.set(f32.subarray(0, len));
  return out;
}

/** Fuzzy match between SID's reported fingerprint name and the
 *  expected name / id from the server fingerprint table.
 *  Strategy: lower-case both, strip non-alphanumeric, extract numeric
 *  tokens, require the alphabetic prefix and the numeric tokens to
 *  overlap. Permissive enough that "RTTY 45.45 / 170 Hz shift (Baudot)"
 *  matches the table entry "RTTY 45.45 / 170". */
function fingerprintNameMatches(reported: string, expectedName: string, expectedId: string): boolean {
  const tok = (s: string): { letters: string[]; nums: string[] } => {
    const lower = s.toLowerCase();
    const letters = (lower.match(/[a-z]+/g) ?? []).filter(t => t.length >= 2);
    const nums    = (lower.match(/[0-9]+(?:\.[0-9]+)?/g) ?? []);
    return { letters, nums };
  };
  const got = tok(reported);
  for (const cand of [expectedName, expectedId]) {
    const exp = tok(cand);
    const letterOK = exp.letters.every(l => got.letters.some(g => g.includes(l) || l.includes(g)));
    const numOK    = exp.nums.length === 0 || exp.nums.every(n =>
      got.nums.some(g => Math.abs(parseFloat(g) - parseFloat(n)) < 0.5));
    if (letterOK && numOK) return true;
  }
  return false;
}

/** Pull the top-scoring entry out of analyzeLocalIQ's text report. The
 *  protocol-fingerprints section is formatted as
 *    "── Protocol fingerprints ──"
 *    "(... comment ...)"
 *    "  Name                       0.81  ★★★★   details"
 *  and we want the name from the first non-comment data row. */
function extractTopFingerprint(report: string): string {
  const lines = report.split('\n');
  let i = 0;
  while (i < lines.length && !/Protocol fingerprints/.test(lines[i])) i++;
  i++; // step past header
  // Skip comment block — comments start with '(' or have parens-only content.
  while (i < lines.length && /^\s*\(/.test(lines[i])) i++;
  // Now find the first data row (two leading spaces + name + score).
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (!/^\s{2}\S/.test(ln)) continue;
    if (/no protocol matched/i.test(ln)) return '(none above 1 %)';
    // Strip leading spaces, the trailing score/stars/details — name is
    // everything before the run of two-or-more spaces that precedes the
    // numeric score.
    const m = ln.match(/^\s{2}(.+?)\s{2,}\d/);
    if (m) return m[1].trim();
    return ln.trim();
  }
  return '(no fingerprint section)';
}

/** SSB passband width to apply when a PSK mode is activated, in Hz.
 *  Direct lookup so the values match the documented table — narrow modes
 *  intentionally use ~3× the symbol rate for noise rejection while wider
 *  modes drop to ~1× since their sidelobes carry meaningful energy. */
function pskPassbandFor(mode: string): number {
  const map: Record<string, number> = {
    // BPSK
    'bpsk31': 100, 'bpsk63': 150, 'bpsk63f': 150,
    'bpsk125': 250, 'bpsk250': 500, 'bpsk500': 600, 'bpsk1000': 1000,
    // QPSK
    'qpsk31': 100, 'qpsk63': 150,
    'qpsk125': 250, 'qpsk250': 500, 'qpsk500': 600,
    // PSK-R
    'psk125r': 250, 'psk250r': 500, 'psk500r': 600, 'psk1000r': 1000,
    // 8PSK
    '8psk125': 250, '8psk125f': 250, '8psk125fl': 250,
    '8psk250': 500, '8psk250f': 500, '8psk250fl': 500,
    '8psk500': 600, '8psk500f': 600,
    '8psk1000': 1000, '8psk1000f': 1000,
    '8psk1200f': 1200,
  };
  return map[mode] ?? 500;
}

/** SSB passband width to apply when an MFSK mode is activated, in Hz.
 *  Derived from the vendored fldigi formula
 *  `(numtones + 1) × samplerate / symlen` for each mode. Centered on
 *  `mfskPitchHz` (default 1500). */
function mfskBandwidthFor(mode: string): number {
  const map: Record<string, number> = {
    'mfsk4':   129,
    'mfsk8':   258,
    'mfsk11':  183,
    'mfsk16':  266,
    'mfsk22':  366,
    'mfsk31':  281,
    'mfsk32':  531,
    'mfsk64':  1063,
    'mfsk128': 2125,
  };
  return map[mode] ?? 500;
}

/** SSB passband width to apply when a THOR mode is activated, in Hz.
 *  Derived from `18 × samplerate × doublespaced / symlen`. THOR places
 *  the carrier at the LOWER edge (per THORBASEFREQ convention); the
 *  signal extends from `thorCarrierHz` upward by this bandwidth. */
function thorBandwidthFor(mode: string): number {
  const map: Record<string, number> = {
    'thormicro': 36,
    'thor4':     141,
    'thor5':     194,
    'thor8':     281,
    'thor11':    194,
    'thor16':    281,
    'thor22':    388,
    'thor25x4':  1800,
    'thor50x1':  900,
    'thor50x2':  1800,
    'thor100':   1800,
  };
  return map[mode] ?? 500;
}

interface PskBand { name: string; freqKHz: number; }
const PSK31_BANDS: PskBand[] = [
  { name: '160 m', freqKHz:  1838.150 },
  { name:  '80 m', freqKHz:  3580.000 },
  { name:  '40 m', freqKHz:  7035.150 },
  { name:  '40 m', freqKHz:  7070.000 },
  { name:  '30 m', freqKHz: 10142.000 },
  { name:  '20 m', freqKHz: 14070.000 },
  { name:  '17 m', freqKHz: 18100.000 },
  { name:  '15 m', freqKHz: 21070.000 },
  { name:  '12 m', freqKHz: 24920.000 },
  { name:  '10 m', freqKHz: 28120.000 },
];

/** HF WEFAX broadcast stations. `freqKHz` is the carrier / USB dial value
 *  (already shifted from the assigned RF carrier where applicable), so the
 *  receiver tunes directly to it — no further offset is applied at scan
 *  time. 70 frequencies across 21 stations. */
/** International NAVTEX broadcast frequencies. The big three are 490 kHz
 *  (national / local language), 518 kHz (international / English) and
 *  4209.5 kHz (tropical HF). Tuning convention: USB at carrier − 1.9 kHz
 *  so the 1615/1785 Hz mark/space tones land in the SSB passband. The
 *  numbers in this list are the published carrier frequencies; the picker
 *  applies the offset at tune time. */
interface NavtexStation { label: string; freqKHz: number; }
const NAVTEX_STATIONS: NavtexStation[] = [
  { label: 'National (local language)',  freqKHz:   490.00 },
  { label: 'International (English)',    freqKHz:   518.00 },
  { label: 'Tropical (HF)',              freqKHz:  4209.50 },
];

/** SITOR-B (FEC) maritime broadcast frequencies — same modulation as
 *  NAVTEX (170 Hz shift FSK, 100 baud) but on commercial / weather
 *  channels outside the dedicated NAVTEX bands. Carrier frequencies
 *  here are the published station carriers; the dial gets offset by
 *  −1.9 kHz at tune time so the mark/space tones land at 1815/1985 Hz
 *  in the audio passband. */
interface SitorStation { label: string; freqKHz: number; }
const SITOR_STATIONS: SitorStation[] = [
  // ── DDH (DWD Hamburg) German maritime weather, MFEC ────────────────
  { label: 'DDH47 — Hamburg wx',   freqKHz:  4583.00 },
  { label: 'DDK2  — Hamburg wx',   freqKHz:  7646.00 },
  { label: 'DDH9  — Hamburg wx',   freqKHz: 10100.80 },
  { label: 'DDH8  — Hamburg wx',   freqKHz: 11039.00 },
  { label: 'DDK6  — Hamburg wx',   freqKHz: 14467.30 },
  // ── French Navy (FUE/FUF/FUG/FUO/FUV) MFEC weather + bulletins ─────
  { label: 'FUE   — French Navy',  freqKHz:  4214.50 },
  { label: 'FUE   — French Navy',  freqKHz:  6328.50 },
  { label: 'FUE   — French Navy',  freqKHz:  8425.00 },
  { label: 'FUE   — French Navy',  freqKHz: 12603.50 },
  { label: 'FUE   — French Navy',  freqKHz: 16915.00 },
  // ── Russian Navy / RIW Moscow ───────────────────────────────────────
  { label: 'RIW   — Russian Navy', freqKHz:  6446.00 },
  { label: 'RIW   — Russian Navy', freqKHz: 12464.00 },
  // ── Generic SITOR-B "ship-to-shore" calling channels ───────────────
  { label: '4 MHz  generic',       freqKHz:  4214.50 },
  { label: '6 MHz  generic',       freqKHz:  6314.00 },
  { label: '8 MHz  generic',       freqKHz:  8424.00 },
  { label: '12 MHz generic',       freqKHz: 12579.00 },
  { label: '16 MHz generic',       freqKHz: 16806.50 },
  { label: '22 MHz generic',       freqKHz: 22376.00 },
];

interface WefaxStation { location: string; freqKHz: number; }
const WEFAX_STATIONS: WefaxStation[] = [
  { location: 'Athens, Greece',                      freqKHz:  4481.00 },
  { location: 'Athens, Greece',                      freqKHz:  8105.00 },
  { location: 'Bangkok, Thailand',                   freqKHz:  7393.10 },
  { location: 'Boston, Massachusetts, USA',          freqKHz:  4233.10 },
  { location: 'Boston, Massachusetts, USA',          freqKHz:  6338.60 },
  { location: 'Boston, Massachusetts, USA',          freqKHz:  9108.10 },
  { location: 'Boston, Massachusetts, USA',          freqKHz: 12748.10 },
  { location: 'Charleville, Australia',              freqKHz:  2626.10 },
  { location: 'Charleville, Australia',              freqKHz:  5098.10 },
  { location: 'Charleville, Australia',              freqKHz: 11028.10 },
  { location: 'Charleville, Australia',              freqKHz: 13918.10 },
  { location: 'Charleville, Australia',              freqKHz: 20467.10 },
  { location: 'Guangzhou Coast Radio, China',        freqKHz:  4197.85 },
  { location: 'Guangzhou Coast Radio, China',        freqKHz:  8410.60 },
  { location: 'Guangzhou Coast Radio, China',        freqKHz: 12627.35 },
  { location: 'Guangzhou Coast Radio, China',        freqKHz: 16824.35 },
  { location: 'Hamburg/Pinneberg, Germany',          freqKHz:  3853.10 },
  { location: 'Hamburg/Pinneberg, Germany',          freqKHz:  7878.10 },
  { location: 'Hamburg/Pinneberg, Germany',          freqKHz: 13880.60 },
  { location: 'Honolulu, Hawaii, USA',               freqKHz:  9980.60 },
  { location: 'Honolulu, Hawaii, USA',               freqKHz: 11088.10 },
  { location: 'Honolulu, Hawaii, USA',               freqKHz: 16133.10 },
  { location: 'Kagoshima, Japan',                    freqKHz:  4272.10 },
  { location: 'Kagoshima, Japan',                    freqKHz:  8656.10 },
  { location: 'Kagoshima, Japan',                    freqKHz: 13072.10 },
  { location: 'Kagoshima, Japan',                    freqKHz: 16905.60 },
  { location: 'Kagoshima, Japan',                    freqKHz: 22557.70 },
  { location: 'Kodiak, Alaska, USA',                 freqKHz:  2052.10 },
  { location: 'Kodiak, Alaska, USA',                 freqKHz:  4296.10 },
  { location: 'Kodiak, Alaska, USA',                 freqKHz:  8457.10 },
  { location: 'Kodiak, Alaska, USA',                 freqKHz: 12410.60 },
  { location: 'Kyodo News, Japan/Singapore',         freqKHz: 16969.10 },
  { location: 'Murmansk, Russia',                    freqKHz:  5334.10 },
  { location: 'Murmansk, Russia',                    freqKHz:  6443.60 },
  { location: 'Murmansk, Russia',                    freqKHz:  7906.90 },
  { location: 'Murmansk, Russia',                    freqKHz: 10128.10 },
  { location: 'New Orleans, Louisiana, USA',         freqKHz:  4316.00 },
  { location: 'New Orleans, Louisiana, USA',         freqKHz:  8502.00 },
  { location: 'New Orleans, Louisiana, USA',         freqKHz: 12788.00 },
  { location: 'New Orleans, Louisiana, USA',         freqKHz: 17144.50 },
  { location: 'Northwood, United Kingdom',           freqKHz:  2616.60 },
  { location: 'Northwood, United Kingdom',           freqKHz:  4608.10 },
  { location: 'Northwood, United Kingdom',           freqKHz:  8038.10 },
  { location: 'Northwood, United Kingdom',           freqKHz: 11084.60 },
  { location: 'Pevek, Chukotka Peninsula, Russia',   freqKHz:   148.00 },
  { location: 'Point Reyes, California, USA',        freqKHz:  4344.10 },
  { location: 'Point Reyes, California, USA',        freqKHz:  8680.10 },
  { location: 'Point Reyes, California, USA',        freqKHz: 12784.10 },
  { location: 'Point Reyes, California, USA',        freqKHz: 17149.30 },
  { location: 'Point Reyes, California, USA',        freqKHz: 22525.10 },
  { location: 'Punta Arenas Magallanes, Chile',      freqKHz:  4320.10 },
  { location: 'Punta Arenas Magallanes, Chile',      freqKHz:  8694.10 },
  { location: 'Seoul, Republic of Korea',            freqKHz:  3583.10 },
  { location: 'Seoul, Republic of Korea',            freqKHz:  5855.60 },
  { location: 'Seoul, Republic of Korea',            freqKHz:  7431.60 },
  { location: 'Seoul, Republic of Korea',            freqKHz:  9163.10 },
  { location: 'Seoul, Republic of Korea',            freqKHz: 13568.10 },
  { location: 'Sydney, Nova Scotia, Canada',         freqKHz:  4414.10 },
  { location: 'Sydney, Nova Scotia, Canada',         freqKHz:  6913.20 },
  { location: 'Tokyo, Japan',                        freqKHz:  3620.60 },
  { location: 'Tokyo, Japan',                        freqKHz:  7793.10 },
  { location: 'Tokyo, Japan',                        freqKHz: 13986.60 },
  { location: 'Valparaiso Playa Ancha, Chile',       freqKHz:  4226.10 },
  { location: 'Valparaiso Playa Ancha, Chile',       freqKHz:  8675.10 },
  { location: 'Valparaiso Playa Ancha, Chile',       freqKHz: 17144.50 },
  { location: 'Wiluna, Australia',                   freqKHz:  5753.10 },
  { location: 'Wiluna, Australia',                   freqKHz:  7533.10 },
  { location: 'Wiluna, Australia',                   freqKHz: 10553.10 },
  { location: 'Wiluna, Australia',                   freqKHz: 15613.10 },
  { location: 'Wiluna, Australia',                   freqKHz: 18058.10 },
];

/** RTTY demodulator configurations. Each entry only adjusts the decoder
 *  (mark / space / baud); the dial frequency is left to the operator. */
interface RttyPreset {
  name: string;
  markHz: number;
  spaceHz: number;
  baud: number;
}
/** HF dial frequencies carrying clear-text RTTY traffic. `markHz` /
 *  `spaceHz` are the audio tones produced when tuning USB (so the freq
 *  picker can hot-swap the RTTY decoder preset to match). */
interface RttyFreq {
  label: string; freqKHz: number;
  markHz: number; spaceHz: number; shift: number; baud: number;
  note: string;
}
const RTTY_FREQS: RttyFreq[] = [
  // DWD Pinneberg weather (50 baud, 450 Hz shift, USB at carrier−1.7 kHz).
  // Mark/space at 1925/1475 Hz audio (mark below space due to inverted shift).
  { label: 'DWD Hamburg (weather)',  freqKHz:  4583.000, markHz: 1925, spaceHz: 1475, shift: 450, baud: 50,    note: 'Weather' },
  { label: 'DWD Hamburg (weather)',  freqKHz:  7646.000, markHz: 1925, spaceHz: 1475, shift: 450, baud: 50,    note: 'Weather' },
  { label: 'DWD Hamburg (weather)',  freqKHz: 10100.800, markHz: 1925, spaceHz: 1475, shift: 450, baud: 50,    note: 'Weather' },
  { label: 'DWD Hamburg (weather)',  freqKHz: 11039.000, markHz: 1925, spaceHz: 1475, shift: 450, baud: 50,    note: 'Weather' },
  { label: 'DWD Hamburg (weather)',  freqKHz: 14467.000, markHz: 1925, spaceHz: 1475, shift: 450, baud: 50,    note: 'Weather' },
  // Amateur RTTY watering holes (45.45 baud, 170 Hz shift, low-pitch USB).
  { label: 'Amateur 160 m',          freqKHz:  1838.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: 'shared w/ PSK' },
  { label: 'Amateur 80 m (EU)',      freqKHz:  3590.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  { label: 'Amateur 40 m (EU)',      freqKHz:  7040.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  { label: 'Amateur 40 m (NA)',      freqKHz:  7080.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  { label: 'Amateur 30 m',           freqKHz: 10140.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: 'global' },
  { label: 'Amateur 20 m',           freqKHz: 14080.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: 'busiest' },
  { label: 'Amateur 20 m (contests)',freqKHz: 14090.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  { label: 'Amateur 17 m',           freqKHz: 18105.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  { label: 'Amateur 15 m',           freqKHz: 21080.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  { label: 'Amateur 12 m',           freqKHz: 24925.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  { label: 'Amateur 10 m',           freqKHz: 28080.000, markHz:  915, spaceHz: 1085, shift: 170, baud: 45.45, note: '' },
  // Press agencies (intermittent — confirm before relying).
  { label: 'TASS (Russia)',          freqKHz:  5070.000, markHz:  915, spaceHz: 1340, shift: 425, baud: 50,    note: 'press, intermittent' },
  { label: 'TASS (Russia)',          freqKHz:  9295.000, markHz:  915, spaceHz: 1340, shift: 425, baud: 50,    note: 'press' },
  { label: 'TASS (Russia)',          freqKHz: 13412.000, markHz:  915, spaceHz: 1340, shift: 425, baud: 50,    note: 'press' },
  { label: 'TASS (Russia)',          freqKHz: 14627.000, markHz:  915, spaceHz: 1340, shift: 425, baud: 50,    note: 'press' },
  { label: 'Xinhua (China)',         freqKHz: 11050.000, markHz:  915, spaceHz: 1340, shift: 425, baud: 50,    note: 'press, intermittent' },
  { label: 'Xinhua (China)',         freqKHz: 14400.000, markHz:  915, spaceHz: 1340, shift: 425, baud: 50,    note: 'press' },
];

/** Known HF beacon transmissions. Tapping a row tunes to the listed
 *  dial frequency in the listed mode (CW for ham beacons, USB / AM for
 *  utility / time-station carriers, the Buzzer in USB to hear the tone). */
/** Major worldwide VLF transmitters (3–30 kHz). Most are MSK at 50–200
 *  bd carrying military comms (the Submarine VLF channels), or are
 *  Russian/CIS Alpha-Beta navigation/timing signals. Tuning in CW mode
 *  with a wide filter typically reveals a steady carrier-like tone. */
interface VlfBeacon {
  label: string; freqKHz: number; note: string;
}
const VLF_BEACONS: VlfBeacon[] = [
  // ── Russian Alpha (RSDN-20) navigation system ──
  { label: 'Alpha (Krasnodar)',   freqKHz: 11.905, note: 'RSDN-20 · Russia' },
  { label: 'Alpha (Komsomolsk)',  freqKHz: 12.649, note: 'RSDN-20 · Russia' },
  { label: 'Alpha (Novosibirsk)', freqKHz: 14.881, note: 'RSDN-20 · Russia' },
  // ── Russian Beta time service ──
  { label: 'Beta RJH63',          freqKHz: 20.500, note: 'time · Krasnodar' },
  { label: 'Beta RJH99',          freqKHz: 25.000, note: 'time · Khabarovsk' },
  { label: 'Beta RAB99',          freqKHz: 25.100, note: 'time · Komsomolsk' },
  // ── Major military VLF MSK transmitters ──
  { label: 'GBZ Anthorn',         freqKHz: 19.580, note: 'UK Royal Navy · MSK' },
  { label: 'NWC Harold E. Holt',  freqKHz: 19.800, note: 'Australia · MSK 200 bd' },
  { label: 'GQD Anthorn',         freqKHz: 22.100, note: 'UK · MSK' },
  { label: 'JJI Ebino',           freqKHz: 22.200, note: 'Japan · MSK' },
  { label: 'DHO38 Rhauderfehn',   freqKHz: 23.400, note: 'Germany · MSK' },
  { label: 'NAA Cutler',          freqKHz: 24.000, note: 'USA Maine · MSK 200 bd' },
  { label: 'NLK Jim Creek',       freqKHz: 24.800, note: 'USA Washington · MSK' },
  { label: 'NPM Lualualei',       freqKHz: 21.400, note: 'USA Hawaii · MSK' },
  { label: 'TBB Bafa',            freqKHz: 26.700, note: 'Turkey · MSK' },
  { label: 'NAU Aguada',          freqKHz: 40.750, note: 'USA Puerto Rico · MSK' },
  { label: 'HWU Le Blanc',        freqKHz: 18.300, note: 'France · MSK' },
  { label: 'HWU Rosnay',          freqKHz: 21.750, note: 'France · MSK' },
  { label: 'ICV Tavolara',        freqKHz: 20.270, note: 'Italy · MSK' },
  { label: 'VTX3 Vijayanarayanam',freqKHz: 18.200, note: 'India · MSK' },
  // ── LF time stations (>30 kHz but commonly grouped with VLF) ──
  { label: 'WWVB Fort Collins',   freqKHz: 60.000, note: 'USA time · BPSK' },
  { label: 'MSF Anthorn',         freqKHz: 60.000, note: 'UK time' },
  { label: 'DCF77 Mainflingen',   freqKHz: 77.500, note: 'Germany time' },
  { label: 'JJY40 Ohtakadoya',    freqKHz: 40.000, note: 'Japan time' },
  { label: 'JJY60 Hagane',        freqKHz: 60.000, note: 'Japan time' },
  // ── Sferic / SID science targets (no transmitter, just listening) ──
  { label: 'Schumann band',       freqKHz:  0.020, note: 'sferic background · 7-30 Hz' },
];

interface BeaconFreq {
  label: string; freqKHz: number; mode: Mode; note: string;
}
const BEACON_FREQS: BeaconFreq[] = [
  // ── NCDXF / IARU International Beacon Network. Eighteen beacons per
  // frequency cycle 10 s each, 24/7. The dial freq stays the same;
  // each station identifies in CW with its callsign + 4 dashes at
  // descending power. Excellent for propagation assessment. ──
  { label: 'NCDXF/IARU 20 m', freqKHz: 14100.0, mode: 'cw', note: '18 beacons, 10s each' },
  { label: 'NCDXF/IARU 17 m', freqKHz: 18110.0, mode: 'cw', note: '18 beacons, 10s each' },
  { label: 'NCDXF/IARU 15 m', freqKHz: 21150.0, mode: 'cw', note: '18 beacons, 10s each' },
  { label: 'NCDXF/IARU 12 m', freqKHz: 24930.0, mode: 'cw', note: '18 beacons, 10s each' },
  { label: 'NCDXF/IARU 10 m', freqKHz: 28200.0, mode: 'cw', note: '18 beacons, 10s each' },
  // ── 28 MHz amateur beacon segment. Dense — dozens of personal
  // beacons identifying every few minutes. Best during high solar. ──
  { label: '10 m beacon segment',   freqKHz: 28190.0, mode: 'cw', note: 'low edge of beacon band' },
  { label: '10 m beacon segment',   freqKHz: 28200.0, mode: 'cw', note: '' },
  { label: '10 m beacon segment',   freqKHz: 28225.0, mode: 'cw', note: 'high edge' },
  // ── 1.8 / 3.5 / 7 / 14 MHz ham beacon spots. ──
  { label: '160 m beacons',         freqKHz:  1838.0, mode: 'cw', note: 'rare' },
  { label: '40 m beacons',          freqKHz:  7038.0, mode: 'cw', note: '' },
  // ── Time-station carriers (continuous unmodulated carrier with CW
  // ID at minute boundaries). Tune in AM to hear the announcements. ──
  { label: 'WWV 2.5 MHz',           freqKHz:  2500.0, mode: 'am', note: 'time, voice + CW ID' },
  { label: 'WWV 5 MHz',             freqKHz:  5000.0, mode: 'am', note: 'time, voice + CW ID' },
  { label: 'WWV 10 MHz',            freqKHz: 10000.0, mode: 'am', note: 'time, voice + CW ID' },
  { label: 'WWV 15 MHz',            freqKHz: 15000.0, mode: 'am', note: 'time, voice + CW ID' },
  { label: 'WWV 20 MHz',            freqKHz: 20000.0, mode: 'am', note: 'time, voice + CW ID' },
  { label: 'WWVH 2.5 MHz',          freqKHz:  2500.0, mode: 'am', note: 'Hawaii time' },
  { label: 'WWVH 5 MHz',            freqKHz:  5000.0, mode: 'am', note: 'Hawaii time' },
  { label: 'WWVH 10 MHz',           freqKHz: 10000.0, mode: 'am', note: 'Hawaii time' },
  { label: 'WWVH 15 MHz',           freqKHz: 15000.0, mode: 'am', note: 'Hawaii time' },
  { label: 'CHU 3.330 MHz',         freqKHz:  3330.0, mode: 'usb', note: 'Canada time, USB' },
  { label: 'CHU 7.850 MHz',         freqKHz:  7850.0, mode: 'usb', note: 'Canada time, USB' },
  { label: 'CHU 14.670 MHz',        freqKHz: 14670.0, mode: 'usb', note: 'Canada time, USB' },
  { label: 'BPM (China) 2.5 MHz',   freqKHz:  2500.0, mode: 'am', note: 'time' },
  { label: 'BPM (China) 5 MHz',     freqKHz:  5000.0, mode: 'am', note: 'time' },
  { label: 'BPM (China) 10 MHz',    freqKHz: 10000.0, mode: 'am', note: 'time' },
  { label: 'BPM (China) 15 MHz',    freqKHz: 15000.0, mode: 'am', note: 'time' },
  { label: 'JJY 2.5 MHz',           freqKHz:  2500.0, mode: 'am', note: 'Japan time' },
  { label: 'JJY 5 MHz',             freqKHz:  5000.0, mode: 'am', note: 'Japan time' },
  { label: 'JJY 8 MHz',             freqKHz:  8000.0, mode: 'am', note: 'Japan time' },
  { label: 'JJY 10 MHz',            freqKHz: 10000.0, mode: 'am', note: 'Japan time' },
  // ── Russian "Buzzer" UVB-76: continuous tone marker, occasional
  // voice messages. Iconic, runs 24/7. ──
  { label: 'UVB-76 "The Buzzer"',   freqKHz:  4625.0, mode: 'usb', note: 'continuous marker' },
  // ── HF marker / single-letter beacons ("S", "M", "K" — Russian
  // military, sources unconfirmed; signal is real and steady). ──
  { label: 'Letter beacon "C"',     freqKHz:  3593.0, mode: 'cw', note: 'Russian, intermittent' },
  { label: 'Letter beacon "S"',     freqKHz:  4558.0, mode: 'cw', note: 'Russian, continuous' },
  { label: 'Letter beacon "F"',     freqKHz:  4831.0, mode: 'cw', note: 'Russian, continuous' },
  { label: 'Letter beacon "M"',     freqKHz:  7039.0, mode: 'cw', note: 'Russian, continuous' },
  { label: 'Letter beacon "P"',     freqKHz:  8495.0, mode: 'cw', note: 'Russian, continuous' },
];

/** VOLMET = continuous aviation weather broadcasts on HF, scheduled in
 *  rotating 5-minute slots per station. Pilots use these en route over
 *  oceans where VHF ATIS is out of range. All upper sideband. */
interface VolmetStation { label: string; freqKHz: number; mode: Mode; note: string; }
const VOLMET_STATIONS: VolmetStation[] = [
  // ── North Atlantic family (Shanwick / Gander / New York share dials) ──
  { label: 'Shanwick VOLMET',  freqKHz:  3413.0, mode: 'usb', note: 'N Atlantic · night' },
  { label: 'Shanwick VOLMET',  freqKHz:  5505.0, mode: 'usb', note: 'N Atlantic' },
  { label: 'Shanwick VOLMET',  freqKHz:  8957.0, mode: 'usb', note: 'N Atlantic · best daytime' },
  { label: 'Shanwick VOLMET',  freqKHz: 13270.0, mode: 'usb', note: 'N Atlantic · daytime' },
  { label: 'Gander VOLMET',    freqKHz:  3485.0, mode: 'usb', note: 'Canada · night' },
  { label: 'Gander VOLMET',    freqKHz:  6604.0, mode: 'usb', note: 'Canada' },
  { label: 'Gander VOLMET',    freqKHz: 10051.0, mode: 'usb', note: 'Canada' },
  { label: 'Gander VOLMET',    freqKHz: 13270.0, mode: 'usb', note: 'Canada · daytime' },
  { label: 'New York VOLMET',  freqKHz:  3485.0, mode: 'usb', note: 'USA · night' },
  { label: 'New York VOLMET',  freqKHz:  6604.0, mode: 'usb', note: 'USA' },
  { label: 'New York VOLMET',  freqKHz: 10051.0, mode: 'usb', note: 'USA' },
  { label: 'New York VOLMET',  freqKHz: 13270.0, mode: 'usb', note: 'USA · daytime' },
  // ── North Pacific ──
  { label: 'San Francisco',    freqKHz:  3413.0, mode: 'usb', note: 'CA Pacific · night' },
  { label: 'San Francisco',    freqKHz:  6679.0, mode: 'usb', note: 'CA Pacific' },
  { label: 'San Francisco',    freqKHz:  8828.0, mode: 'usb', note: 'CA Pacific' },
  { label: 'San Francisco',    freqKHz: 13282.0, mode: 'usb', note: 'CA Pacific · daytime' },
  { label: 'Honolulu VOLMET',  freqKHz:  2863.0, mode: 'usb', note: 'Hawaii · night' },
  { label: 'Honolulu VOLMET',  freqKHz:  6679.0, mode: 'usb', note: 'Hawaii' },
  { label: 'Honolulu VOLMET',  freqKHz:  8828.0, mode: 'usb', note: 'Hawaii' },
  { label: 'Honolulu VOLMET',  freqKHz: 13282.0, mode: 'usb', note: 'Hawaii · daytime' },
  // ── South-east Asia / Western Pacific ──
  { label: 'Tokyo VOLMET',     freqKHz:  6679.0, mode: 'usb', note: 'Japan' },
  { label: 'Tokyo VOLMET',     freqKHz:  8828.0, mode: 'usb', note: 'Japan' },
  { label: 'Tokyo VOLMET',     freqKHz: 13282.0, mode: 'usb', note: 'Japan · daytime' },
  { label: 'Hong Kong VOLMET', freqKHz:  8828.0, mode: 'usb', note: 'HKG' },
  { label: 'Bangkok VOLMET',   freqKHz:  6676.0, mode: 'usb', note: 'Thailand' },
  { label: 'Bangkok VOLMET',   freqKHz: 11387.0, mode: 'usb', note: 'Thailand · daytime' },
  // ── South Asia ──
  { label: 'Karachi VOLMET',   freqKHz:  3413.0, mode: 'usb', note: 'Pakistan · night' },
  { label: 'Karachi VOLMET',   freqKHz:  5673.0, mode: 'usb', note: 'Pakistan' },
  { label: 'Karachi VOLMET',   freqKHz:  8919.0, mode: 'usb', note: 'Pakistan' },
  { label: 'Karachi VOLMET',   freqKHz: 13285.0, mode: 'usb', note: 'Pakistan · daytime' },
  { label: 'Mumbai VOLMET',    freqKHz:  6676.0, mode: 'usb', note: 'India' },
  // ── Oceania ──
  { label: 'Auckland VOLMET',  freqKHz:  6679.0, mode: 'usb', note: 'New Zealand' },
  { label: 'Auckland VOLMET',  freqKHz:  8867.0, mode: 'usb', note: 'New Zealand' },
  { label: 'Auckland VOLMET',  freqKHz: 13282.0, mode: 'usb', note: 'New Zealand · daytime' },
  // ── Europe — RAF Volmet (continuous military aviation wx) ──
  { label: 'RAF VOLMET',       freqKHz:  4742.0, mode: 'usb', note: 'UK · 24/7' },
  { label: 'RAF VOLMET',       freqKHz:  5450.0, mode: 'usb', note: 'UK · 24/7' },
  { label: 'RAF VOLMET',       freqKHz: 11247.0, mode: 'usb', note: 'UK · daytime' },
];

/** Maritime utility stations — high-seas voice weather, distress, MSI
 *  broadcasts. NAVTEX (RTTY 518 kHz), DSC, and SITOR-B have their own
 *  dedicated decoders/pickers; this list is for plain USB voice listening
 *  and CW utility traffic. */
/** Military / NATO HF voice — USAF Global HF System (GHFS), NATO air
 *  command, USCG/Navy aero-maritime. All USB; activity bursty, mostly
 *  ALE handshakes followed by short voice exchanges. */
/** Scientific / propagation research targets — Schumann resonances, ELF
 *  submarine carriers, OMEGA legacy, ionosonde sounders, ISM heating,
 *  HAARP. Sub-kHz entries are below the KiwiSDR's tuneable range and
 *  serve as documentation references. Range entries point at the band
 *  edge; the note carries the upper bound. */
interface ScienFreq { label: string; freqKHz: number; mode: Mode; note: string; }
const SCIEN_FREQS: ScienFreq[] = [
  // ── ELF / sub-kHz research targets (below Kiwi's tuning range; documentation) ──
  { label: 'Magnetospheric (1 Hz)',     freqKHz: 0.001,  mode: 'cw', note: 'geomagnetic research' },
  { label: 'Schumann fundamental',      freqKHz: 0.0078, mode: 'cw', note: '7.83 Hz' },
  { label: 'Schumann 2nd',              freqKHz: 0.0143, mode: 'cw', note: '14.3 Hz harmonic' },
  { label: 'Schumann 3rd',              freqKHz: 0.0208, mode: 'cw', note: '20.8 Hz harmonic' },
  { label: 'Schumann 4th',              freqKHz: 0.0273, mode: 'cw', note: '27.3 Hz harmonic' },
  { label: 'Schumann 5th',              freqKHz: 0.0338, mode: 'cw', note: '33.8 Hz harmonic' },
  { label: 'Sanguine/Seafarer',         freqKHz: 0.076,  mode: 'cw', note: 'US Navy submarine 76 Hz' },
  { label: 'Seismic correlation',       freqKHz: 0.300,  mode: 'cw', note: '0.3-1.0 kHz · seismic' },
  { label: 'Whistler research',         freqKHz: 1.000,  mode: 'cw', note: '1-2 kHz · ionospheric whistlers' },
  { label: 'ULF geomagnetic',           freqKHz: 1.000,  mode: 'cw', note: '1-3 kHz · storm research' },
  { label: 'Sferics band',              freqKHz: 3.000,  mode: 'cw', note: '3-30 kHz · lightning' },
  { label: 'Atmospherics/tweek',        freqKHz: 4.000,  mode: 'cw', note: 'tweek research' },
  { label: 'Lightning sferic',          freqKHz: 9.600,  mode: 'cw', note: 'detection band' },
  // ── OMEGA legacy navigation (decommissioned, still studied) ──
  { label: 'OMEGA',                     freqKHz: 10.200, mode: 'cw', note: 'decommissioned · studied' },
  { label: 'OMEGA research',            freqKHz: 11.333, mode: 'cw', note: 'research carrier' },
  { label: 'OMEGA',                     freqKHz: 13.600, mode: 'cw', note: 'decommissioned' },
  // ── VLF military / research carriers ──
  { label: 'NATO submarine',            freqKHz: 16.000, mode: 'cw', note: 'submarine research band' },
  { label: 'NWC Australia',             freqKHz: 19.800, mode: 'cw', note: 'ionospheric research' },
  { label: 'NPM Hawaii',                freqKHz: 20.900, mode: 'cw', note: 'ionospheric path studies' },
  { label: 'Whistler-mode',             freqKHz: 21.400, mode: 'cw', note: 'wave research' },
  { label: 'NAA Maine',                 freqKHz: 24.000, mode: 'cw', note: 'ionospheric monitoring' },
  { label: 'VLF propagation',           freqKHz: 25.200, mode: 'cw', note: 'propagation studies' },
  { label: 'Geophysical',               freqKHz: 37.500, mode: 'cw', note: 'geophysical research' },
  // ── LF time / propagation references ──
  { label: 'JJY/WWVB ionospheric',      freqKHz: 40.000, mode: 'cw', note: 'WWVB & JJY · ionospheric path' },
  { label: 'WWVB D-layer',              freqKHz: 60.000, mode: 'cw', note: 'D-layer absorption research' },
  { label: 'DCF77 propagation',         freqKHz: 77.500, mode: 'cw', note: 'propagation studies' },
  { label: 'LORAN-C reflection',        freqKHz: 100.000, mode: 'cw', note: 'ionospheric reflection studies' },
  { label: 'Alpha RSDN-20',             freqKHz: 129.100, mode: 'cw', note: 'Russia · VLF/LF propagation' },
  // ── MF / lower HF research ──
  { label: 'D-layer absorption',        freqKHz: 300.000, mode: 'am',  note: '300-500 kHz' },
  { label: 'AM band',                   freqKHz: 530.000, mode: 'am',  note: '530-1700 kHz · ionospheric studies' },
  { label: 'Reference ionosonde',       freqKHz: 1000.000, mode: 'cw', note: 'standard reference' },
  { label: 'Ionosonde sweep start',     freqKHz: 1800.000, mode: 'cw', note: 'lower sweep edge' },
  { label: 'WWV 2.5 MHz path',          freqKHz: 2500.000, mode: 'am', note: 'ionospheric path' },
  { label: 'Ionosonde sweep band',      freqKHz: 3000.000, mode: 'cw', note: '3-30 MHz swept sounding' },
  { label: 'CHU 3.330 propagation',     freqKHz: 3330.000, mode: 'usb', note: 'time standard · path' },
  { label: 'Ionospheric reference',     freqKHz: 4000.000, mode: 'cw', note: 'sounder reference' },
  { label: 'WWV/CHU 5 MHz',             freqKHz: 5000.000, mode: 'am', note: 'propagation research' },
  { label: 'HAARP ELF/VLF',             freqKHz: 6990.000, mode: 'cw', note: 'ionospheric modulation' },
  { label: 'CHU 7.335 MHz',             freqKHz: 7335.000, mode: 'usb', note: 'Canada time' },
  { label: 'Ionosonde 8 MHz',           freqKHz: 8000.000, mode: 'cw', note: 'common sounder freq' },
  { label: 'foF2 critical',             freqKHz: 9000.000, mode: 'cw', note: 'ionospheric critical freq' },
  { label: 'HAARP upper',               freqKHz: 9500.000, mode: 'cw', note: 'upper research band' },
  { label: 'WWV 10 MHz solar',          freqKHz: 10000.000, mode: 'am', note: 'solar flux / radio burst' },
  { label: 'Ionospheric sounding',      freqKHz: 11000.000, mode: 'cw', note: 'sounding band' },
  { label: 'ISM 13.56 MHz',             freqKHz: 13560.000, mode: 'cw', note: 'RF biological research' },
  { label: 'CHU 14.670 MHz',            freqKHz: 14670.000, mode: 'usb', note: 'Canada time' },
  { label: 'WWV 15 MHz solar',          freqKHz: 15000.000, mode: 'am', note: 'solar terrestrial data' },
  { label: 'Ionospheric scatter',       freqKHz: 17000.000, mode: 'cw', note: 'scatter research' },
  { label: 'WWV 20 MHz upper HF',       freqKHz: 20000.000, mode: 'am', note: 'upper HF propagation' },
  { label: 'WWV 25 MHz Es/F2',          freqKHz: 25000.000, mode: 'am', note: 'sporadic-E and F2' },
  { label: 'ISM 27.12 MHz',             freqKHz: 27120.000, mode: 'cw', note: 'RF heating / biological' },
  { label: 'Solar radio noise',         freqKHz: 28000.000, mode: 'cw', note: '10 m propagation beacon' },
];

interface MilvFreq { label: string; freqKHz: number; mode: Mode; note: string; }
const MILV_FREQS: MilvFreq[] = [
  { label: 'NATO/US military',    freqKHz:  3000.0, mode: 'usb', note: 'common HF channel' },
  { label: 'USAF Global HF',      freqKHz:  4724.0, mode: 'usb', note: 'GHFS night' },
  { label: 'NATO maritime',       freqKHz:  5703.0, mode: 'usb', note: 'maritime command' },
  { label: 'Aero military',       freqKHz:  6712.0, mode: 'usb', note: 'aeronautical mil' },
  { label: 'US mil air-ground',   freqKHz:  6739.0, mode: 'usb', note: 'air-ground' },
  { label: 'USAF GHFS primary',   freqKHz:  8992.0, mode: 'usb', note: 'GHFS · 24h' },
  { label: 'USAF GHFS secondary', freqKHz:  9016.0, mode: 'usb', note: 'GHFS' },
  { label: 'USAF GHFS primary',   freqKHz: 11175.0, mode: 'usb', note: 'most monitored · day' },
  { label: 'USAF secondary cmd',  freqKHz: 11226.0, mode: 'usb', note: 'secondary command' },
  { label: 'NATO air command',    freqKHz: 13200.0, mode: 'usb', note: 'NATO air' },
  { label: 'USAF GHFS',           freqKHz: 15016.0, mode: 'usb', note: 'GHFS day' },
  { label: 'Time/mil coord',      freqKHz: 20000.0, mode: 'usb', note: 'shared with WWV dial' },
];

interface MaritimeFreq { label: string; freqKHz: number; mode: Mode; note: string; }
const MARITIME_FREQS: MaritimeFreq[] = [
  // ── International distress / calling ──
  { label: 'Intl distress',    freqKHz:  2182.0, mode: 'usb', note: 'voice calling/distress' },
  // ── USCG high-seas weather (NMN Chesapeake / NMG New Orleans) ──
  { label: 'USCG NMN/NMG',     freqKHz:  4426.0, mode: 'usb', note: 'high-seas wx · night' },
  { label: 'USCG NMN/NMG',     freqKHz:  6501.0, mode: 'usb', note: 'high-seas wx' },
  { label: 'USCG NMN/NMG',     freqKHz:  8764.0, mode: 'usb', note: 'high-seas wx · 24/7' },
  { label: 'USCG NMN/NMG',     freqKHz: 13089.0, mode: 'usb', note: 'high-seas wx · daytime' },
  { label: 'USCG NMN/NMG',     freqKHz: 17314.0, mode: 'usb', note: 'high-seas wx · daytime' },
  // ── USCG Pacific (NMC Point Reyes / NOJ Kodiak) ──
  { label: 'USCG NMC',         freqKHz:  4426.0, mode: 'usb', note: 'Pacific wx · night' },
  { label: 'USCG NMC',         freqKHz:  8764.0, mode: 'usb', note: 'Pacific wx' },
  { label: 'USCG NMC',         freqKHz: 13089.0, mode: 'usb', note: 'Pacific wx · daytime' },
  { label: 'USCG NOJ Kodiak',  freqKHz:  6501.0, mode: 'usb', note: 'Alaska wx' },
  { label: 'USCG NOJ Kodiak',  freqKHz:  8764.0, mode: 'usb', note: 'Alaska wx' },
  // ── Australia BoM marine weather ──
  { label: 'VMC Charleville',  freqKHz:  2201.0, mode: 'usb', note: 'AU BoM · night' },
  { label: 'VMC Charleville',  freqKHz:  6230.0, mode: 'usb', note: 'AU BoM' },
  { label: 'VMC Charleville',  freqKHz:  8176.0, mode: 'usb', note: 'AU BoM' },
  { label: 'VMC Charleville',  freqKHz: 12365.0, mode: 'usb', note: 'AU BoM · daytime' },
  { label: 'VMW Wiluna',       freqKHz:  5755.0, mode: 'usb', note: 'AU BoM W coast' },
  { label: 'VMW Wiluna',       freqKHz:  8113.0, mode: 'usb', note: 'AU BoM W coast' },
  { label: 'VMW Wiluna',       freqKHz: 12362.0, mode: 'usb', note: 'AU BoM W coast' },
  // ── New Zealand MetService (ZLM) ──
  { label: 'ZLM Taupo',        freqKHz:  3247.0, mode: 'usb', note: 'NZ MetService · night' },
  { label: 'ZLM Taupo',        freqKHz:  6224.0, mode: 'usb', note: 'NZ MetService' },
  { label: 'ZLM Taupo',        freqKHz: 12356.0, mode: 'usb', note: 'NZ MetService · daytime' },
  // ── UK MCA marine weather (Falmouth) — USB voice ──
  { label: 'Falmouth Coast',   freqKHz:  2226.0, mode: 'usb', note: 'UK · night' },
  // ── Russian Navy CW (Cluster A — strategic broadcasts) ──
  { label: 'RUS Navy "F"',     freqKHz:  4831.0, mode: 'cw',  note: 'Cluster A · 24/7' },
  { label: 'RUS Navy "P"',     freqKHz:  8495.0, mode: 'cw',  note: 'Cluster A · 24/7' },
  // ── Cuba "V2" Spanish numbers (intelligence, but maritime-band) ──
  { label: 'V2A Cuba',         freqKHz:  6855.0, mode: 'usb', note: 'numbers · evenings' },
];

/** HF segments and point frequencies known to carry CW traffic. Mostly
 *  amateur band edges (where CW activity is concentrated) plus the
 *  IARU/NCDXF beacon network and time-station IDs that send CW idents. */
interface CwFreq {
  label: string;
  /** Start of the segment, in kHz. For point freqs, equals endKHz. */
  startKHz: number;
  /** End of the segment, in kHz. */
  endKHz: number;
  note: string;
}
const CW_FREQS: CwFreq[] = [
  // ── Amateur HF band CW segments (start & end, region-2 / IARU
  // standard). DX windows are at the low edge of each segment. ──
  { label: '160 m CW',         startKHz:  1810,    endKHz:  1838,    note: 'CW only sub-band' },
  { label: '80 m CW',          startKHz:  3500,    endKHz:  3570,    note: 'DX window 3500-3510' },
  { label: '60 m',             startKHz:  5330,    endKHz:  5410,    note: 'limited CW activity' },
  { label: '40 m CW',          startKHz:  7000,    endKHz:  7040,    note: 'DX window 7000-7010' },
  { label: '30 m CW',          startKHz: 10100,    endKHz: 10130,    note: 'CW exclusive band' },
  { label: '20 m CW',          startKHz: 14000,    endKHz: 14070,    note: 'DX window 14000-14010' },
  { label: '17 m CW',          startKHz: 18068,    endKHz: 18095,    note: '' },
  { label: '15 m CW',          startKHz: 21000,    endKHz: 21070,    note: 'DX window 21000-21010' },
  { label: '12 m CW',          startKHz: 24890,    endKHz: 24915,    note: '' },
  { label: '10 m CW',          startKHz: 28000,    endKHz: 28070,    note: 'DX window 28000-28010' },
  // ── NCDXF / IARU international beacon network. 18 beacons cycle
  // through 5 frequencies, ~10 s each, 24/7. Excellent for propagation
  // assessment — pick a freq, listen for the rotating IDs. ──
  { label: 'NCDXF/IARU 20 m',  startKHz: 14100.0,  endKHz: 14100.0,  note: 'beacon network' },
  { label: 'NCDXF/IARU 17 m',  startKHz: 18110.0,  endKHz: 18110.0,  note: 'beacon network' },
  { label: 'NCDXF/IARU 15 m',  startKHz: 21150.0,  endKHz: 21150.0,  note: 'beacon network' },
  { label: 'NCDXF/IARU 12 m',  startKHz: 24930.0,  endKHz: 24930.0,  note: 'beacon network' },
  { label: 'NCDXF/IARU 10 m',  startKHz: 28200.0,  endKHz: 28200.0,  note: 'beacon network' },
  // ── Time-station CW identifiers (each station also sends voice +
  // tones; CW ID at minute boundaries / specific intervals). ──
  { label: 'WWV 5 MHz',        startKHz:  5000.0,  endKHz:  5000.0,  note: 'CW ID' },
  { label: 'WWV 10 MHz',       startKHz: 10000.0,  endKHz: 10000.0,  note: 'CW ID' },
  { label: 'WWV 15 MHz',       startKHz: 15000.0,  endKHz: 15000.0,  note: 'CW ID' },
  { label: 'WWV 20 MHz',       startKHz: 20000.0,  endKHz: 20000.0,  note: 'CW ID' },
  { label: 'CHU 3.330',        startKHz:  3330.0,  endKHz:  3330.0,  note: 'Canada time, CW ID' },
  { label: 'CHU 7.850',        startKHz:  7850.0,  endKHz:  7850.0,  note: 'Canada time, CW ID' },
  { label: 'CHU 14.670',       startKHz: 14670.0,  endKHz: 14670.0,  note: 'Canada time, CW ID' },
  // ── Maritime / utility CW (mostly historical; a handful still on
  // the air for legacy ID or weather). ──
  { label: 'KSM (San Francisco)', startKHz: 6474.0, endKHz: 6474.0,  note: 'maritime, schedule only' },
  { label: 'KFS (San Francisco)', startKHz: 12808.5, endKHz: 12808.5, note: 'maritime, schedule only' },
];

/** HFDL (High Frequency Data Link) ground-station channel assignments.
 *  All entries are USB carrier frequency for the channel; for actual
 *  decoding switch the receiver to IQ mode (HFDL is 1800 baud 8-PSK and
 *  needs complex baseband, not SSB-demodulated audio). The 13 ground
 *  stations: 1 San Francisco, 2 Molokai, 3 Reykjavik, 4 Riverhead,
 *  5 Auckland, 6 Hat Yai, 7 Shannon, 8 Johannesburg, 9 Barrow,
 *  10 Al Muharraq, 11 Albrook, 13 Krasnoyarsk, 14 Las Palmas,
 *  15 Krasnoyarsk-Khabarovsk, 16 Cooperstown, 17 Canarias.
 *  Activity peaks during low solar — many channels are quiet daytime. */
interface HfdlFreq {
  label: string; freqKHz: number; note: string;
}
const HFDL_FREQS: HfdlFreq[] = [
  // ── 2 / 3 / 4 / 5 MHz (night band, regional / oceanic) ─────────────────
  { label: 'GS-2 Molokai',         freqKHz:  2944.0, note: 'night' },
  { label: 'GS-5 Auckland',        freqKHz:  2992.0, note: 'night' },
  { label: 'GS-13 Krasnoyarsk',    freqKHz:  3007.0, note: 'night' },
  { label: 'GS-1 San Francisco',   freqKHz:  3455.0, note: 'night' },
  { label: 'GS-7 Shannon',         freqKHz:  3497.0, note: 'night' },
  { label: 'GS-9 Barrow',          freqKHz:  4654.0, note: 'night' },
  { label: 'GS-3 Reykjavik',       freqKHz:  4681.0, note: 'night' },
  { label: 'GS-2 Molokai',         freqKHz:  5451.0, note: 'night' },
  { label: 'GS-4 Riverhead',       freqKHz:  5508.0, note: 'night' },
  { label: 'GS-7 Shannon',         freqKHz:  5514.0, note: 'night' },
  { label: 'GS-9 Barrow',          freqKHz:  5529.0, note: 'night' },
  { label: 'GS-5 Auckland',        freqKHz:  5547.0, note: 'night' },
  { label: 'GS-3 Reykjavik',       freqKHz:  5583.0, note: 'night' },
  { label: 'GS-13 Krasnoyarsk',    freqKHz:  5652.0, note: 'night' },
  { label: 'GS-1 San Francisco',   freqKHz:  5720.0, note: 'night' },
  { label: 'GS-11 Albrook',        freqKHz:  6529.0, note: 'transition' },
  { label: 'GS-1 San Francisco',   freqKHz:  6532.0, note: 'transition' },
  { label: 'GS-10 Al Muharraq',    freqKHz:  6535.0, note: 'transition' },
  { label: 'GS-3 Reykjavik',       freqKHz:  6559.0, note: 'transition' },
  { label: 'GS-2 Molokai',         freqKHz:  6565.0, note: 'transition' },
  { label: 'GS-9 Barrow',          freqKHz:  6589.0, note: 'transition' },
  { label: 'GS-7 Shannon',         freqKHz:  6596.0, note: 'transition' },
  { label: 'GS-4 Riverhead',       freqKHz:  6661.0, note: 'transition' },
  // ── 8 MHz (day/transition, very busy globally) ─────────────────────────
  { label: 'GS-1 San Francisco',   freqKHz:  8825.0, note: 'day' },
  { label: 'GS-11 Albrook',        freqKHz:  8834.0, note: 'day' },
  { label: 'GS-13 Krasnoyarsk',    freqKHz:  8843.0, note: 'day' },
  { label: 'GS-3 Reykjavik',       freqKHz:  8885.0, note: 'day' },
  { label: 'GS-7 Shannon',         freqKHz:  8886.0, note: 'day' },
  { label: 'GS-5 Auckland',        freqKHz:  8894.0, note: 'day' },
  { label: 'GS-2 Molokai',         freqKHz:  8912.0, note: 'day' },
  { label: 'GS-4 Riverhead',       freqKHz:  8927.0, note: 'day' },
  { label: 'GS-10 Al Muharraq',    freqKHz:  8936.0, note: 'day' },
  { label: 'GS-11 Albrook',        freqKHz:  8939.0, note: 'day' },
  { label: 'GS-1 San Francisco',   freqKHz:  8942.0, note: 'day · active' },
  { label: 'GS-13 Krasnoyarsk',    freqKHz:  8948.0, note: 'day' },
  { label: 'GS-9 Barrow',          freqKHz:  8957.0, note: 'day' },
  { label: 'GS-2 Molokai',         freqKHz:  8977.0, note: 'day' },
  // ── 10 MHz (day, oceanic) ─────────────────────────────────────────────
  { label: 'GS-3 Reykjavik',       freqKHz: 10027.0, note: 'day' },
  { label: 'GS-13 Krasnoyarsk',    freqKHz: 10066.0, note: 'day' },
  { label: 'GS-9 Barrow',          freqKHz: 10075.0, note: 'day' },
  { label: 'GS-5 Auckland',        freqKHz: 10084.0, note: 'day' },
  { label: 'GS-7 Shannon',         freqKHz: 10087.0, note: 'day' },
  { label: 'GS-2 Molokai',         freqKHz: 10093.0, note: 'day' },
  // ── 11 MHz (day, busy) ────────────────────────────────────────────────
  { label: 'GS-1 San Francisco',   freqKHz: 11184.0, note: 'day · very active' },
  { label: 'GS-13 Krasnoyarsk',    freqKHz: 11318.0, note: 'day' },
  { label: 'GS-3 Reykjavik',       freqKHz: 11348.0, note: 'day · active' },
  { label: 'GS-2 Molokai',         freqKHz: 11354.0, note: 'day' },
  { label: 'GS-7 Shannon',         freqKHz: 11387.0, note: 'day' },
  // ── 13 MHz (day, oceanic) ─────────────────────────────────────────────
  { label: 'GS-11 Albrook',        freqKHz: 13264.0, note: 'day' },
  { label: 'GS-13 Krasnoyarsk',    freqKHz: 13270.0, note: 'day' },
  { label: 'GS-1 San Francisco',   freqKHz: 13276.0, note: 'day · active' },
  { label: 'GS-9 Barrow',          freqKHz: 13303.0, note: 'day' },
  { label: 'GS-5 Auckland',        freqKHz: 13312.0, note: 'day' },
  { label: 'GS-3 Reykjavik',       freqKHz: 13321.0, note: 'day' },
  { label: 'GS-7 Shannon',         freqKHz: 13324.0, note: 'day' },
  // ── 15 MHz ────────────────────────────────────────────────────────────
  { label: 'GS-13 Krasnoyarsk',    freqKHz: 15025.0, note: 'day · high-sun' },
  // ── 17 MHz (high band, daylight DX) ───────────────────────────────────
  { label: 'GS-13 Krasnoyarsk',    freqKHz: 17901.0, note: 'high-sun' },
  { label: 'GS-5 Auckland',        freqKHz: 17916.0, note: 'high-sun' },
  { label: 'GS-3 Reykjavik',       freqKHz: 17919.0, note: 'high-sun' },
  { label: 'GS-2 Molokai',         freqKHz: 17928.0, note: 'high-sun' },
  { label: 'GS-1 San Francisco',   freqKHz: 17934.0, note: 'high-sun' },
  { label: 'GS-9 Barrow',          freqKHz: 17967.0, note: 'high-sun' },
  // ── 21 MHz (rare, only during peak solar) ─────────────────────────────
  { label: 'GS-13 Krasnoyarsk',    freqKHz: 21928.0, note: 'rare · peak solar' },
  { label: 'GS-1 San Francisco',   freqKHz: 21934.0, note: 'rare · peak solar' },
];

/** HF dial frequencies known to carry ALE 2G (MIL-STD-188-141B) traffic.
 *  USB; ALE occupies 0–3 kHz audio (8 tones 750–2500 Hz). Most active
 *  populations: USAF HFGCS, US MARS, SHARES, US Coast Guard, civilian
 *  amateur HFLINK net. Activity is bursty — sounds (single-station ID
 *  bursts) every few minutes, full handshakes are rarer. */
interface AleFreq {
  label: string; freqKHz: number; note: string;
}
const ALE_FREQS: AleFreq[] = [
  // ── HFLINK amateur net (most active for casual monitoring) ─────────────
  { label: 'HFLINK 80 m',     freqKHz:  3596.000, note: 'amateur net' },
  { label: 'HFLINK 40 m',     freqKHz:  7102.000, note: 'amateur net' },
  { label: 'HFLINK 30 m',     freqKHz: 10145.500, note: 'amateur net' },
  { label: 'HFLINK 20 m',     freqKHz: 14346.000, note: 'amateur net' },
  { label: 'HFLINK 17 m',     freqKHz: 18106.000, note: 'amateur net' },
  { label: 'HFLINK 15 m',     freqKHz: 21096.000, note: 'amateur net' },
  { label: 'HFLINK 10 m',     freqKHz: 28146.000, note: 'amateur net' },
  // ── USAF HFGCS (high probability of sounds, especially 11175) ──────────
  { label: 'HFGCS primary',   freqKHz: 11175.000, note: 'USAF, sounds' },
  { label: 'HFGCS 4724',      freqKHz:  4724.000, note: 'USAF' },
  { label: 'HFGCS 6739',      freqKHz:  6739.000, note: 'USAF' },
  { label: 'HFGCS 8992',      freqKHz:  8992.000, note: 'USAF' },
  { label: 'HFGCS 13200',     freqKHz: 13200.000, note: 'USAF' },
  { label: 'HFGCS 15016',     freqKHz: 15016.000, note: 'USAF' },
  // ── US MARS (active during exercises) ──────────────────────────────────
  { label: 'MARS 4039',       freqKHz:  4039.000, note: 'Army MARS' },
  { label: 'MARS 5358.5',     freqKHz:  5358.500, note: 'Army MARS' },
  { label: 'MARS 7635',       freqKHz:  7635.000, note: 'Army MARS' },
  // ── SHARES (FEMA/DHS interop) ──────────────────────────────────────────
  { label: 'SHARES 5211.5',   freqKHz:  5211.500, note: 'SHARES' },
  { label: 'SHARES 7556',     freqKHz:  7556.000, note: 'SHARES' },
  { label: 'SHARES 10493',    freqKHz: 10493.000, note: 'SHARES' },
  // ── US Coast Guard ─────────────────────────────────────────────────────
  { label: 'USCG 5732',       freqKHz:  5732.000, note: 'USCG' },
  { label: 'USCG 7527',       freqKHz:  7527.000, note: 'USCG' },
];

/** HF dial frequencies known to carry THOR amateur traffic.
 *  USB; THOR carrier is the LOWER edge of the band at 1500 Hz audio.
 *  Operators switch between THOR4/8/16/22/etc. within the same dial. */
interface ThorFreq {
  label: string; freqKHz: number; note: string;
}
const THOR_FREQS: ThorFreq[] = [
  { label: '160 m',          freqKHz:  1838.000, note: 'very rare' },
  { label: '80 m (EU)',      freqKHz:  3580.000, note: 'shared PSK' },
  { label: '80 m alt',       freqKHz:  3585.000, note: '' },
  { label: '40 m (EU)',      freqKHz:  7037.000, note: 'primary' },
  { label: '40 m (NA)',      freqKHz:  7080.000, note: '' },
  { label: '30 m',           freqKHz: 10143.000, note: 'shared PSK/MFSK' },
  { label: '20 m calling',   freqKHz: 14080.000, note: 'most active' },
  { label: '20 m alt',       freqKHz: 14083.000, note: '' },
  { label: '17 m',           freqKHz: 18103.000, note: 'rare' },
  { label: '15 m',           freqKHz: 21080.000, note: 'rare' },
  { label: '12 m',           freqKHz: 24923.000, note: 'rare' },
  { label: '10 m',           freqKHz: 28080.000, note: 'rare' },
];

/** HF dial frequencies known to carry Contestia amateur traffic.
 *  USB; carrier centred at 1500 Hz. Same family as Olivia (Contestia
 *  is the faster, narrower cousin) — uses similar watering holes.
 *  20 m calling 14076 is by far the most-active. */
interface ContestiaFreq {
  label: string; freqKHz: number; note: string;
}
const CONTESTIA_FREQS: ContestiaFreq[] = [
  { label: '160 m',         freqKHz:  1838.000, note: 'rare' },
  { label: '80 m',          freqKHz:  3580.000, note: 'shared with PSK/MFSK' },
  { label: '80 m alt',      freqKHz:  3590.000, note: '' },
  { label: '40 m (EU)',     freqKHz:  7037.000, note: '' },
  { label: '40 m (NA)',     freqKHz:  7045.000, note: '' },
  { label: '30 m',          freqKHz: 10142.000, note: '' },
  { label: '20 m calling',  freqKHz: 14076.000, note: 'most active' },
  { label: '20 m alt',      freqKHz: 14080.000, note: '' },
  { label: '17 m',          freqKHz: 18103.000, note: 'rare' },
  { label: '15 m',          freqKHz: 21080.000, note: 'rare' },
  { label: '12 m',          freqKHz: 24921.000, note: 'rare' },
  { label: '10 m',          freqKHz: 28080.000, note: 'rare' },
];

/** HF dial frequencies known to carry DominoEX amateur traffic.
 *  USB; carrier centred at 1500 Hz. Sparse — most activity clusters
 *  around the 20 m calling channel; expect long silences elsewhere. */
interface DominoexFreq {
  label: string; freqKHz: number; note: string;
}
const DOMINOEX_FREQS: DominoexFreq[] = [
  { label: '160 m',         freqKHz:  1838.000, note: 'very rare' },
  { label: '80 m',          freqKHz:  3580.000, note: 'shared PSK/MFSK' },
  { label: '40 m (EU)',     freqKHz:  7037.000, note: '' },
  { label: '40 m (NA)',     freqKHz:  7080.000, note: '' },
  { label: '30 m',          freqKHz: 10141.000, note: '' },
  { label: '20 m calling',  freqKHz: 14076.000, note: 'most active' },
  { label: '20 m alt',      freqKHz: 14080.000, note: '' },
  { label: '17 m',          freqKHz: 18103.000, note: 'rare' },
  { label: '15 m',          freqKHz: 21080.000, note: 'rare' },
  { label: '12 m',          freqKHz: 24921.000, note: 'rare' },
  { label: '10 m',          freqKHz: 28080.000, note: 'rare' },
];

/** HF dial frequencies known to carry FSQ amateur traffic.
 *  USB; carrier centred at 1500 Hz. ~330 Hz BW. 30 m is by far the most
 *  active; everything else is sparse / scheduled-net only. */
interface FsqFreq {
  label: string; freqKHz: number; note: string;
}
const FSQ_FREQS: FsqFreq[] = [
  { label: '160 m',         freqKHz:  1840.000, note: 'very rare' },
  { label: '80 m (EU)',     freqKHz:  3588.000, note: '' },
  { label: '40 m (EU)',     freqKHz:  7044.000, note: 'primary' },
  { label: '40 m (NA)',     freqKHz:  7105.000, note: 'occasional' },
  { label: '30 m primary',  freqKHz: 10144.000, note: 'most active' },
  { label: '20 m',          freqKHz: 14103.000, note: '' },
  { label: '17 m',          freqKHz: 18104.000, note: 'rare' },
  { label: '15 m',          freqKHz: 21104.000, note: 'rare' },
  { label: '12 m',          freqKHz: 24924.000, note: 'rare' },
  { label: '10 m',          freqKHz: 28104.000, note: 'rare' },
];

/** HF dial frequencies known to carry MFSK amateur traffic.
 *  USB; carrier centred at 1500 Hz. MFSK16/32 are most common; operators
 *  switch between MFSK16/32/64/128 within the same watering hole. */
interface MfskFreq {
  label: string; freqKHz: number; note: string;
}
const MFSK_FREQS: MfskFreq[] = [
  { label: '160 m',                 freqKHz:  1838.000, note: 'shared PSK/RTTY, rare' },
  { label: '80 m',                  freqKHz:  3580.000, note: 'shared PSK31' },
  { label: '80 m alt',              freqKHz:  3583.000, note: '' },
  { label: '40 m (EU)',             freqKHz:  7037.000, note: '' },
  { label: '40 m (NA)',             freqKHz:  7080.000, note: '' },
  { label: '40 m image',            freqKHz:  7110.000, note: 'occasional MFSK image' },
  { label: '30 m',                  freqKHz: 10147.000, note: 'shared PSK' },
  { label: '20 m calling',          freqKHz: 14080.000, note: 'primary' },
  { label: '20 m alt',              freqKHz: 14083.000, note: '' },
  { label: '20 m image',            freqKHz: 14109.000, note: 'occasional MFSK image' },
  { label: '17 m',                  freqKHz: 18105.000, note: '' },
  { label: '15 m',                  freqKHz: 21080.000, note: '' },
  { label: '12 m',                  freqKHz: 24929.000, note: '' },
  { label: '10 m',                  freqKHz: 28080.000, note: '' },
];

/** HF dial frequencies known to carry MT63 traffic. `mode` is the MT63
 *  bandwidth/integration variant typically used at that frequency so the
 *  freq picker can hot-swap the decoder. USB; carrier centred at 1500 Hz. */
interface Mt63Freq {
  label: string; freqKHz: number; mode: Mt63Mode; note: string;
}
const MT63_FREQS: Mt63Freq[] = [
  // ── MT63-1000L (1 kHz, long interleave) — emcomm standard ──────────────
  { label: '80 m emcomm / SHARES',  freqKHz:  3581.000, mode: '1000l', note: '1KL' },
  { label: '80 m alt',              freqKHz:  3586.000, mode: '1000l', note: '1KL' },
  { label: '40 m (shared FT8)',     freqKHz:  7073.000, mode: '1000l', note: '1KL — avoid' },
  { label: '40 m emcomm net',       freqKHz:  7110.000, mode: '1000l', note: '1KL' },
  { label: '20 m emcomm',           freqKHz: 14109.000, mode: '1000l', note: '1KL' },
  { label: '20 m SATERN/ARES',      freqKHz: 14346.000, mode: '1000l', note: '1KL' },
  { label: '15 m',                  freqKHz: 21073.000, mode: '1000l', note: '1KL' },
  { label: '10 m',                  freqKHz: 28073.000, mode: '1000l', note: '1KL' },
  // ── MT63-2000L (2 kHz, long) — SHARES / MARS / ARES ────────────────────
  { label: 'SHARES 80 m',           freqKHz:  3583.000, mode: '2000l', note: '2KL' },
  { label: 'MARS 80 m regional',    freqKHz:  3596.000, mode: '2000l', note: '2KL' },
  { label: '60 m ch1 FEMA/SHARES',  freqKHz:  5371.500, mode: '2000l', note: '2KL' },
  { label: '60 m ch3',              freqKHz:  5389.500, mode: '2000l', note: '2KL' },
  { label: '60 m ch5',              freqKHz:  5403.500, mode: '2000l', note: '2KL' },
  { label: 'SHARES 40 m',           freqKHz:  7103.000, mode: '2000l', note: '2KL' },
  { label: 'ARES/RACES 40 m',       freqKHz:  7108.000, mode: '2000l', note: '2KL' },
  { label: 'SHARES 20 m',           freqKHz: 14109.500, mode: '2000l', note: '2KL' },
];

const RTTY_PRESETS: RttyPreset[] = [
  // ── 170 Hz shift ───────────────────────────────────────────────────────
  { name: 'Amateur 170 (US, high)',   markHz: 2125, spaceHz: 2295, baud: 45.45 },
  { name: 'Amateur 170 (low pitch)',  markHz:  915, spaceHz: 1085, baud: 45.45 },
  { name: 'Amateur 170 (mid pitch)',  markHz: 1275, spaceHz: 1445, baud: 45.45 },
  { name: 'Amateur 75 baud',          markHz: 2125, spaceHz: 2295, baud: 75.00 },
  { name: 'Commercial 50 baud',       markHz: 1275, spaceHz: 1445, baud: 50.00 },
  { name: 'Commercial 75 baud',       markHz: 1275, spaceHz: 1445, baud: 75.00 },
  { name: 'Commercial 100 baud',      markHz: 2125, spaceHz: 2295, baud: 100.00 },
  { name: 'Murray 60 baud TWX',       markHz: 2125, spaceHz: 2295, baud: 60.00 },
  // ── 200 Hz shift ───────────────────────────────────────────────────────
  { name: 'UK 200 Hz, 50 baud',       markHz: 1275, spaceHz: 1475, baud: 50.00 },
  { name: 'Russian 200 Hz, 100 baud', markHz: 2125, spaceHz: 2325, baud: 100.00 },
  // ── 250 Hz shift ───────────────────────────────────────────────────────
  { name: 'Russian 250 Hz, 75 baud',  markHz: 1275, spaceHz: 1525, baud: 75.00 },
  // ── 425 Hz shift ───────────────────────────────────────────────────────
  { name: 'DWD 425 Hz weather',       markHz: 1275, spaceHz: 1700, baud: 50.00 },
  { name: 'TASS press 425 Hz',        markHz: 1275, spaceHz: 1700, baud: 50.00 },
  // ── 450 Hz shift ───────────────────────────────────────────────────────
  { name: 'Russian 450 Hz, 75 baud',  markHz: 1275, spaceHz: 1725, baud: 75.00 },
  // ── 850 Hz shift ───────────────────────────────────────────────────────
  { name: '850 Hz shift (older)',     markHz: 1275, spaceHz: 2125, baud: 45.45 },
  // ── 1000 Hz shift (generic; no published amateur/commercial standard) ──
  { name: '1000 Hz shift (custom)',   markHz: 1275, spaceHz: 2275, baud: 45.45 },
];

/** Filter bandwidths offered by the FILTERS picker, in kHz.
 *  Entries above 10 kHz only resolve to live audio when the active
 *  source's hardware actually samples that wide — KiwiSDR caps at
 *  ~12 kHz audio so 15/20/25 still work, while 100/150/200 kHz need
 *  an OWRX backend with WFM-capable hardware (RTL-SDR, Airspy, …). */
const FILTER_WIDTHS: number[] = [
  0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.5, 0.8,
  1.0, 1.2, 1.5, 1.8, 2.0, 2.1, 2.3, 2.4,
  2.7, 2.8, 3.0, 3.2, 3.6, 4.0, 4.5, 5.0, 6.0,
  9.0, 10.0, 12.5, 15.0, 20.0, 25.0,
  100.0, 150.0, 200.0,
];

/** FT4 dial frequencies (USB), kHz. */
const FT4_FREQS: Array<[string, number]> = [
  ['80 m', 3575],
  ['40 m', 7047.5],
  ['30 m', 10140],
  ['20 m', 14080],
  ['17 m', 18104],
  ['15 m', 21140],
  ['12 m', 24919],
  ['10 m', 28180],
];

/** FT8 dial frequencies (USB), kHz. */
const FT8_FREQS: Array<[string, number]> = [
  ['160 m', 1840],
  ['80 m',  3573],
  ['60 m',  5357],
  ['40 m',  7074],
  ['30 m',  10136],
  ['20 m',  14074],
  ['17 m',  18100],
  ['15 m',  21074],
  ['12 m',  24915],
  ['10 m',  28074],
];

/** Worldwide HF time / standard-frequency stations. All are AM (broadcast)
 *  carriers with voice + tick patterns; tuning USB / LSB on a Kiwi gets
 *  you the audio cleanly. CW-only stations (RWM, HLA) are flagged so the
 *  picker can hint at it. */
interface TimeStation {
  label:    string;
  freqKHz:  number;
  mode:     'usb' | 'lsb' | 'am' | 'cw';
  note:     string;
}
const TIME_STATIONS: TimeStation[] = [
  // Stations sharing a dial freq+mode are merged into one row — tapping
  // any of them tunes the same kHz, and propagation decides which one
  // you actually hear.
  { label: 'WWV/WWVH/BPM 2.5 MHz',     freqKHz:  2500.000, mode: 'am',  note: 'USA · Hawaii · China · night' },
  { label: 'WWV/WWVH/BPM/LOL 5 MHz',   freqKHz:  5000.000, mode: 'am',  note: 'USA · Hawaii · China · Argentina' },
  { label: 'WWV/WWVH/BPM/LOL 10 MHz',  freqKHz: 10000.000, mode: 'am',  note: 'USA · Hawaii · China · Argentina · 24h' },
  { label: 'WWV/WWVH/BPM/LOL 15 MHz',  freqKHz: 15000.000, mode: 'am',  note: 'USA · Hawaii · China · Argentina · day' },
  { label: 'WWV 20 MHz',               freqKHz: 20000.000, mode: 'am',  note: 'NIST Colorado · day' },
  // CHU — Canada, USB voice + bursts.
  { label: 'CHU 3.330 MHz',            freqKHz:  3330.000, mode: 'usb', note: 'NRC Ottawa · night' },
  { label: 'CHU 7.850 MHz',            freqKHz:  7850.000, mode: 'usb', note: 'NRC Ottawa · 24h' },
  { label: 'CHU 14.670 MHz',           freqKHz: 14670.000, mode: 'usb', note: 'NRC Ottawa · day' },
  // RWM Taldom — pure CW carriers + ID.
  { label: 'RWM 4.996 MHz',            freqKHz:  4996.000, mode: 'cw',  note: 'Russia · CW marker' },
  { label: 'RWM 9.996 MHz',            freqKHz:  9996.000, mode: 'cw',  note: 'Russia · CW marker' },
  { label: 'RWM 14.996 MHz',           freqKHz: 14996.000, mode: 'cw',  note: 'Russia · CW marker' },
  // HLA — South Korea, CW only on 5 MHz.
  { label: 'HLA 5 MHz',                freqKHz:  5000.000, mode: 'cw',  note: 'KRISS · CW only' },
];

/** WSPR-2 dial frequencies (USB conventionally; receiver tunes 1500 Hz
 *  below the WSPR sub-band centre so the signal lands in the 1400–1600
 *  Hz audio passband). Bands ranked by typical activity. */
interface WsprFreq {
  label: string; freqKHz: number; note: string;
}
const WSPR_FREQS: WsprFreq[] = [
  { label: '20 m WSPR',  freqKHz: 14095.600, note: 'most active' },
  { label: '40 m WSPR',  freqKHz:  7038.600, note: 'very active' },
  { label: '30 m WSPR',  freqKHz: 10138.700, note: 'active' },
  { label: '80 m WSPR',  freqKHz:  3568.600, note: 'overnight' },
  { label: '17 m WSPR',  freqKHz: 18104.600, note: 'daytime' },
  { label: '15 m WSPR',  freqKHz: 21094.600, note: 'daytime' },
  { label: '10 m WSPR',  freqKHz: 28124.600, note: 'sporadic E' },
  { label: '12 m WSPR',  freqKHz: 24924.600, note: 'rare' },
  { label: '160 m WSPR', freqKHz:  1836.600, note: 'overnight' },
  { label: '60 m WSPR',  freqKHz:  5287.200, note: 'rare' },
  { label: '6 m WSPR',   freqKHz: 50293.000, note: 'es / aurora' },
];

/** JS8Call calling-frequency dial spots. JS8 is conventionally USB
 *  with the keying centred at 1500 Hz audio offset; users tune the
 *  dial 1.5 kHz below the band activity centre. The values below are
 *  the standard JS8Call community frequencies (Normal mode, 15-s
 *  slots) per the js8call.com convention. */
interface Js8Freq {
  label: string; freqKHz: number; note: string;
}
const JS8_FREQS: Js8Freq[] = [
  { label: '40 m JS8',  freqKHz:  7078.000, note: 'most active' },
  { label: '20 m JS8',  freqKHz: 14078.000, note: 'very active' },
  { label: '30 m JS8',  freqKHz: 10130.000, note: 'active' },
  { label: '17 m JS8',  freqKHz: 18104.000, note: 'daytime' },
  { label: '80 m JS8',  freqKHz:  3578.000, note: 'overnight' },
  { label: '15 m JS8',  freqKHz: 21078.000, note: 'daytime' },
  { label: '60 m JS8',  freqKHz:  5358.000, note: 'limited regions' },
  { label: '12 m JS8',  freqKHz: 24922.000, note: 'sporadic' },
  { label: '10 m JS8',  freqKHz: 28078.000, note: 'es / aurora' },
  { label: '160 m JS8', freqKHz:  1842.000, note: 'overnight' },
  { label: '6 m JS8',   freqKHz: 50318.000, note: 'es / aurora' },
];

/** FST4W beacon dial frequencies. FST4W operates on the same dials
 *  as WSPR for HF, plus dedicated LF/MF allocations (2200m / 630m)
 *  where its sensitivity advantage matters most. */
interface Fst4Freq {
  label: string; freqKHz: number; note: string;
}
const FST4_FREQS: Fst4Freq[] = [
  { label: '2200 m FST4W', freqKHz:   136.000, note: 'LF DX · 1800-s slots' },
  { label: '630 m FST4W',  freqKHz:   474.200, note: 'MF DX · 900-s slots' },
  { label: '160 m FST4W',  freqKHz:  1836.800, note: 'overnight' },
  { label: '80 m FST4W',   freqKHz:  3568.600, note: 'overnight' },
  { label: '60 m FST4W',   freqKHz:  5287.200, note: 'limited regions' },
  { label: '40 m FST4W',   freqKHz:  7038.600, note: 'very active' },
  { label: '30 m FST4W',   freqKHz: 10138.700, note: 'active' },
  { label: '20 m FST4W',   freqKHz: 14095.600, note: 'most active' },
  { label: '17 m FST4W',   freqKHz: 18104.600, note: 'daytime' },
  { label: '15 m FST4W',   freqKHz: 21094.600, note: 'daytime' },
  { label: '12 m FST4W',   freqKHz: 24924.600, note: 'sporadic' },
  { label: '10 m FST4W',   freqKHz: 28124.600, note: 'es / aurora' },
];


/** Known centre frequencies of operational over-the-horizon radars
 *  (OTHR / OTH-B / OTH-FMCW). Frequencies are nominal — these systems
 *  are frequency-agile and hop across the HF band, but the entries
 *  below are commonly observed dial spots reported by HFU/UDXF. */
interface OthrFreq {
  label: string; freqKHz: number; note: string;
}
const OTHR_FREQS: OthrFreq[] = [
  // ── Russian "Container" 29B6 (Kovylkino) — wide FMCW sweep ─────────
  { label: 'Container 29B6',    freqKHz:  7045.0, note: '50 sps FMCW · Russia' },
  { label: 'Container 29B6',    freqKHz:  9430.0, note: '50 sps FMCW · Russia' },
  { label: 'Container 29B6',    freqKHz: 11110.0, note: '50 sps FMCW · Russia' },
  { label: 'Container 29B6',    freqKHz: 13580.0, note: '50 sps FMCW · Russia' },
  { label: 'Container 29B6',    freqKHz: 14380.0, note: '50 sps FMCW · Russia' },
  { label: 'Container 29B6',    freqKHz: 16150.0, note: '50 sps FMCW · Russia' },
  { label: 'Container 29B6',    freqKHz: 19680.0, note: '50 sps FMCW · Russia' },
  // ── ROTHR (US Navy, Virginia/Texas/Puerto Rico) — drug interdiction
  { label: 'ROTHR (US Navy)',   freqKHz:  5870.0, note: 'pulsed · Caribbean' },
  { label: 'ROTHR (US Navy)',   freqKHz:  7680.0, note: 'pulsed · Caribbean' },
  { label: 'ROTHR (US Navy)',   freqKHz: 10570.0, note: 'pulsed · Caribbean' },
  { label: 'ROTHR (US Navy)',   freqKHz: 13890.0, note: 'pulsed · Caribbean' },
  { label: 'ROTHR (US Navy)',   freqKHz: 16400.0, note: 'pulsed · Caribbean' },
  // ── JORN (Australia) — 5–30 MHz wide-band FMCW ─────────────────────
  { label: 'JORN (Australia)',  freqKHz:  5800.0, note: 'FMCW · RAAF' },
  { label: 'JORN (Australia)',  freqKHz: 12500.0, note: 'FMCW · RAAF' },
  { label: 'JORN (Australia)',  freqKHz: 16500.0, note: 'FMCW · RAAF' },
  { label: 'JORN (Australia)',  freqKHz: 19500.0, note: 'FMCW · RAAF' },
  // ── PLA / Chinese OTHR ─────────────────────────────────────────────
  { label: 'Chinese OTH',       freqKHz:  9290.0, note: 'pulsed · PLA' },
  { label: 'Chinese OTH',       freqKHz: 13900.0, note: 'pulsed · PLA' },
  { label: 'Chinese OTH',       freqKHz: 17480.0, note: 'pulsed · PLA' },
  // ── French Nostradamus (Dreux) ─────────────────────────────────────
  { label: 'Nostradamus (FR)',  freqKHz:  6700.0, note: 'FMCW · ONERA' },
  { label: 'Nostradamus (FR)',  freqKHz: 12200.0, note: 'FMCW · ONERA' },
  // ── Iranian "Sepehr" / unidentified ME OTH ────────────────────────
  { label: 'Sepehr / unid ME',  freqKHz:  8430.0, note: 'reported · Iran' },
  { label: 'Sepehr / unid ME',  freqKHz: 13420.0, note: 'reported · Iran' },
];

/** HF dial frequencies known to carry AX.25 / APRS packet traffic.
 *  HF packet is 300-baud F1A AFSK with 1600/1800 Hz tones. Convention is
 *  LSB on 80/40/30 m. 30 m carries the bulk of casual HF APRS activity;
 *  the others see only sporadic exchanges or net traffic. */
interface PacketFreq {
  label: string; freqKHz: number; mode: 'lsb' | 'usb' | 'nbfm'; note: string;
}
const PACKET_FREQS: PacketFreq[] = [
  // ── 30 m — by far the most active HF APRS band ──────────────────────
  { label: 'HF APRS (US/EU)', freqKHz: 10147.600, mode: 'lsb', note: 'most active' },
  { label: 'HF APRS alt',     freqKHz: 10149.200, mode: 'lsb', note: '300 bd APRS' },
  { label: '30 m packet',     freqKHz: 10147.000, mode: 'lsb', note: 'AX.25 calling' },
  // ── Other amateur bands ─────────────────────────────────────────────
  { label: '80 m packet',     freqKHz:  3596.000, mode: 'lsb', note: 'occasional' },
  { label: '40 m packet',     freqKHz:  7038.000, mode: 'lsb', note: 'rare' },
  { label: '40 m alt',        freqKHz:  7102.000, mode: 'lsb', note: 'rare' },
  { label: '20 m APRS',       freqKHz: 14103.000, mode: 'usb', note: 'rare' },
  { label: '17 m packet',     freqKHz: 18106.000, mode: 'usb', note: 'rare' },
  { label: '15 m packet',     freqKHz: 21146.000, mode: 'usb', note: 'rare' },
  { label: '10 m packet',     freqKHz: 28146.000, mode: 'usb', note: 'rare' },
];

/** VHF Bell-202 (1200 baud) APRS frequencies. NBFM mode. 144.390 MHz is
 *  by far the most active globally (US standard); 144.800 MHz dominates
 *  in Europe; 145.825 MHz is the ISS digipeater downlink. */
const PACKET_VHF_FREQS: PacketFreq[] = [
  { label: 'APRS (US/CA/AU)',  freqKHz: 144390.000, mode: 'nbfm', note: '1200 bd Bell-202' },
  { label: 'APRS (EU/UK)',     freqKHz: 144800.000, mode: 'nbfm', note: '1200 bd, IARU R1' },
  { label: 'APRS (NZ)',        freqKHz: 144575.000, mode: 'nbfm', note: '1200 bd, New Zealand' },
  { label: 'APRS (JP)',        freqKHz: 144640.000, mode: 'nbfm', note: '1200 bd, Japan' },
  { label: 'ISS digipeater',   freqKHz: 145825.000, mode: 'nbfm', note: 'orbital APRS downlink' },
  { label: '220 MHz packet',   freqKHz: 223400.000, mode: 'nbfm', note: 'US 1.25 m secondary' },
  { label: '70 cm packet',     freqKHz: 432650.000, mode: 'nbfm', note: 'US 9600 / 1200' },
];

/** 9600 G3RUH packet frequencies. NBFM mode. Mostly satellite
 *  downlinks since 9600 is dominant on FOX cubesats, plus a couple
 *  of 70 cm terrestrial calling channels. */
const PACKET_9600_FREQS: PacketFreq[] = [
  { label: 'FOX-1A AO-85',     freqKHz: 145978.000, mode: 'nbfm', note: 'cubesat downlink' },
  { label: 'FOX-1B AO-91',     freqKHz: 145960.000, mode: 'nbfm', note: 'cubesat downlink' },
  { label: 'FOX-1C AO-95',     freqKHz: 435300.000, mode: 'nbfm', note: 'cubesat downlink' },
  { label: 'FOX-1D AO-92',     freqKHz: 435350.000, mode: 'nbfm', note: 'cubesat downlink' },
  { label: 'FOX-1E AO-109',    freqKHz: 435750.000, mode: 'nbfm', note: 'cubesat downlink' },
  { label: 'ISS 9600 packet',  freqKHz: 437550.000, mode: 'nbfm', note: 'occasional / digipeater' },
  { label: '70 cm 9600 (US)',  freqKHz: 432650.000, mode: 'nbfm', note: 'terrestrial G3RUH' },
  { label: '70 cm 9600 (EU)',  freqKHz: 433625.000, mode: 'nbfm', note: 'terrestrial G3RUH' },
];

/** Common shape for the new generic-picker entries below. The existing
 *  decoder-specific tables (RTTY_FREQS, OLIVIA_FREQS, …) keep their own
 *  shapes — this is only used for the simpler frequency-list pickers
 *  added in the 0.3.66x series. */
interface FreqPickerEntry { label: string; freqKHz: number; mode: Mode; note: string; }

/** NDB — LF/MF aviation non-directional beacons. Slow Morse 1-3 letter
 *  idents, ~190–530 kHz. A representative cross-section of well-known
 *  monitoring targets across Europe / NA / Asia + band reference spots
 *  every 5–10 kHz so the operator can sweep the whole NDB allocation. */
const NDB_FREQS: FreqPickerEntry[] = [
  { label: 'NDB band start',      freqKHz: 190, mode: 'cw', note: 'LF aero NDB lower edge' },
  { label: 'LF sweep 200',        freqKHz: 200, mode: 'cw', note: 'lower NDB allocation' },
  { label: 'LF sweep 215',        freqKHz: 215, mode: 'cw', note: 'lower NDB allocation' },
  { label: 'LF sweep 230',        freqKHz: 230, mode: 'cw', note: 'lower NDB allocation' },
  { label: 'AY Calgary',          freqKHz: 245, mode: 'cw', note: 'Canada · Calgary AB' },
  { label: 'LF aero ref 250',     freqKHz: 250, mode: 'cw', note: 'common monitoring spot' },
  { label: 'AYR Ayr',             freqKHz: 268, mode: 'cw', note: 'UK · Ayr Scotland' },
  { label: 'NDB 280',             freqKHz: 280, mode: 'cw', note: 'mid-band activity' },
  { label: 'AKM Antwerp',         freqKHz: 296, mode: 'cw', note: 'Belgium · Antwerp' },
  { label: 'BPL Bath',            freqKHz: 305, mode: 'cw', note: 'UK · Bath' },
  { label: 'CHV Chiltern',        freqKHz: 320, mode: 'cw', note: 'UK · Chiltern' },
  { label: 'POL Pole Hill',       freqKHz: 339, mode: 'cw', note: 'UK · Pole Hill NDB · classic' },
  { label: 'LAU Laucha',          freqKHz: 343, mode: 'cw', note: 'Germany · Laucha' },
  { label: 'DTY Daventry',        freqKHz: 350, mode: 'cw', note: 'UK · Daventry · classic' },
  { label: 'LST Lasham',          freqKHz: 353, mode: 'cw', note: 'UK · Lasham' },
  { label: 'DRT Dover',           freqKHz: 360, mode: 'cw', note: 'UK · Dover' },
  { label: 'OL Ostend',           freqKHz: 365, mode: 'cw', note: 'Belgium · Ostend' },
  { label: 'GLP Prestwick',       freqKHz: 376, mode: 'cw', note: 'UK · Glasgow Prestwick' },
  { label: 'YHA Newfoundland',    freqKHz: 376, mode: 'cw', note: 'Canada · DX target' },
  { label: 'GLS / GW Gloucester', freqKHz: 386, mode: 'cw', note: 'UK · Gloucester area' },
  { label: 'LBY Lichtenberg',     freqKHz: 388, mode: 'cw', note: 'Germany · Lichtenberg' },
  { label: 'WL Wallasey',         freqKHz: 392, mode: 'cw', note: 'UK · Wallasey' },
  { label: 'WTC Watford',         freqKHz: 393, mode: 'cw', note: 'UK · Watford' },
  { label: 'PTH Perth',           freqKHz: 397, mode: 'cw', note: 'UK · Perth Scotland' },
  { label: 'HRN Heron',           freqKHz: 408, mode: 'cw', note: 'UK · Heron · classic' },
  { label: 'KEF Keflavik',        freqKHz: 408, mode: 'cw', note: 'Iceland · Keflavik' },
  { label: 'LIN Italy',           freqKHz: 412, mode: 'cw', note: 'Italy · LIN regional' },
  { label: 'SUM Sumburgh',        freqKHz: 415, mode: 'cw', note: 'UK · Shetland · classic DX' },
  { label: 'BNH UK',              freqKHz: 420, mode: 'cw', note: 'UK · Bournemouth area' },
  { label: 'EH Ehrwald',          freqKHz: 426, mode: 'cw', note: 'Austria · Ehrwald' },
  { label: 'NDB upper band',      freqKHz: 435, mode: 'cw', note: 'upper MF · less crowded' },
  { label: 'Aero hover 460',      freqKHz: 460, mode: 'cw', note: 'mostly retired' },
  { label: 'Aero hover 480',      freqKHz: 480, mode: 'cw', note: 'mostly retired' },
  { label: 'NDB band edge 510',   freqKHz: 510, mode: 'cw', note: 'beyond aero band · maritime CW' },
  { label: 'NDB band end',        freqKHz: 525, mode: 'cw', note: 'upper edge near AM' },
];

/** NUMBERS — Priyom-catalogued numbers / clandestine stations. Common
 *  monitoring frequencies; many stations rotate through several. */
const NUMBERS_FREQS: FreqPickerEntry[] = [
  { label: 'E07 English Man (poly)',      freqKHz:  5872,  mode: 'usb', note: 'Russian SVR · 5F groups' },
  { label: 'E07 alt',                      freqKHz:  6839,  mode: 'usb', note: 'rotating channel' },
  { label: 'E07 alt',                      freqKHz:  9079,  mode: 'usb', note: 'rotating channel' },
  { label: 'E07 alt',                      freqKHz: 10527,  mode: 'usb', note: 'rotating channel' },
  { label: 'E11 Oblique (UK)',             freqKHz:  4055,  mode: 'usb', note: 'British MI6' },
  { label: 'E11 alt',                      freqKHz:  5746,  mode: 'usb', note: 'British MI6' },
  { label: 'E11 alt',                      freqKHz:  6840,  mode: 'usb', note: 'British MI6' },
  { label: 'G06 German Lady',              freqKHz:  4480,  mode: 'usb', note: 'Russian SVR · 5F' },
  { label: 'G06 alt',                      freqKHz:  6225,  mode: 'usb', note: 'rotating' },
  { label: 'M14 Russian Mil',              freqKHz:  4940,  mode: 'cw',  note: 'Morse · GRU' },
  { label: 'M14 alt',                      freqKHz:  6890,  mode: 'cw',  note: 'Morse · GRU' },
  { label: 'V07 Russian Man',              freqKHz:  4625,  mode: 'usb', note: 'The Buzzer (UVB-76)' },
  { label: 'S06s "Stop"',                  freqKHz:  5811,  mode: 'usb', note: 'Russian SVR · cut-numbers' },
  { label: 'V13 Chinese New Star',         freqKHz: 11444,  mode: 'am',  note: 'PRC · Mandarin 4F' },
  { label: 'HM01 Cuban',                   freqKHz:  9240,  mode: 'usb', note: 'mixed voice + RDFT' },
  { label: 'HM01 alt',                     freqKHz: 11530,  mode: 'usb', note: 'Cuban DGI' },
  { label: 'HM01 alt',                     freqKHz: 12180,  mode: 'usb', note: 'Cuban DGI' },
  { label: 'XPA Russian polytone',         freqKHz:  9251,  mode: 'usb', note: 'SVR data · MFSK' },
  { label: 'XPA2 (variant)',               freqKHz: 11465,  mode: 'usb', note: 'SVR polytone v2' },
];

/** HFGCS — USAF HF Global Communications System (formerly GHFS). Six
 *  channels, all USB, monitored 24/7 worldwide. */
const HFGCS_FREQS: FreqPickerEntry[] = [
  { label: 'HF-GCS night',     freqKHz:  4724.0, mode: 'usb', note: 'night primary' },
  { label: 'HF-GCS air-ground',freqKHz:  6739.0, mode: 'usb', note: 'air/ground' },
  { label: 'HF-GCS 24h',       freqKHz:  8992.0, mode: 'usb', note: '24 h channel' },
  { label: 'HF-GCS day',       freqKHz: 11175.0, mode: 'usb', note: 'most monitored · day primary' },
  { label: 'HF-GCS NATO',      freqKHz: 13200.0, mode: 'usb', note: 'NATO secondary' },
  { label: 'HF-GCS day alt',   freqKHz: 15016.0, mode: 'usb', note: 'day alternate' },
];

/** AERO — non-VOLMET oceanic aero. Air-Ground HF voice on the major
 *  oceanic regions (NAT/CAR/EUR/SAM/NCA/CWP/SP/INO). All USB. */
const AERO_FREQS: FreqPickerEntry[] = [
  // NAT — North Atlantic Tracks
  { label: 'NAT-A 2899',  freqKHz:  2899.0, mode: 'usb', note: 'North Atlantic family A' },
  { label: 'NAT-C 3016',  freqKHz:  3016.0, mode: 'usb', note: 'North Atlantic family C' },
  { label: 'NAT-A 5598',  freqKHz:  5598.0, mode: 'usb', note: 'North Atlantic family A' },
  { label: 'NAT-A 5616',  freqKHz:  5616.0, mode: 'usb', note: 'North Atlantic family A' },
  { label: 'NAT-E 5649',  freqKHz:  5649.0, mode: 'usb', note: 'North Atlantic family E' },
  { label: 'NAT-C 6562',  freqKHz:  6562.0, mode: 'usb', note: 'North Atlantic family C' },
  { label: 'NAT-A 8825',  freqKHz:  8825.0, mode: 'usb', note: 'North Atlantic family A' },
  { label: 'NAT-C 8864',  freqKHz:  8864.0, mode: 'usb', note: 'North Atlantic family C' },
  { label: 'NAT-A 8879',  freqKHz:  8879.0, mode: 'usb', note: 'North Atlantic family A' },
  { label: 'NAT-E 8891',  freqKHz:  8891.0, mode: 'usb', note: 'North Atlantic family E' },
  { label: 'NAT-C 8906',  freqKHz:  8906.0, mode: 'usb', note: 'North Atlantic family C' },
  { label: 'NAT-C 13288', freqKHz: 13288.0, mode: 'usb', note: 'North Atlantic family C' },
  { label: 'NAT-A 13291', freqKHz: 13291.0, mode: 'usb', note: 'North Atlantic family A' },
  { label: 'NAT-E 13294', freqKHz: 13294.0, mode: 'usb', note: 'North Atlantic family E' },
  { label: 'NAT-C 17946', freqKHz: 17946.0, mode: 'usb', note: 'North Atlantic family C' },
  // CAR — Caribbean
  { label: 'CAR 5520',    freqKHz:  5520.0, mode: 'usb', note: 'Caribbean' },
  { label: 'CAR 5550',    freqKHz:  5550.0, mode: 'usb', note: 'Caribbean' },
  { label: 'CAR 6577',    freqKHz:  6577.0, mode: 'usb', note: 'Caribbean' },
  { label: 'CAR 8918',    freqKHz:  8918.0, mode: 'usb', note: 'Caribbean (most active)' },
  { label: 'CAR 11396',   freqKHz: 11396.0, mode: 'usb', note: 'Caribbean' },
  // CWP — Central West Pacific
  { label: 'CWP 2998',    freqKHz:  2998.0, mode: 'usb', note: 'Central West Pacific' },
  { label: 'CWP 6562',    freqKHz:  6562.0, mode: 'usb', note: 'Central West Pacific' },
  { label: 'CWP 8903',    freqKHz:  8903.0, mode: 'usb', note: 'Central West Pacific' },
  { label: 'CWP 13300',   freqKHz: 13300.0, mode: 'usb', note: 'Central West Pacific' },
  // SAM — South American
  { label: 'SAM 5526',    freqKHz:  5526.0, mode: 'usb', note: 'South American' },
  { label: 'SAM 8855',    freqKHz:  8855.0, mode: 'usb', note: 'South American' },
  { label: 'SAM 13297',   freqKHz: 13297.0, mode: 'usb', note: 'South American' },
  { label: 'SAM 17907',   freqKHz: 17907.0, mode: 'usb', note: 'South American' },
  // INO — Indian Ocean
  { label: 'INO 5634',    freqKHz:  5634.0, mode: 'usb', note: 'Indian Ocean' },
  { label: 'INO 13306',   freqKHz: 13306.0, mode: 'usb', note: 'Indian Ocean' },
];

/** GMDSS — Global Maritime Distress and Safety System. Distress voice,
 *  DSC calling, and medico channels. */
const GMDSS_FREQS: FreqPickerEntry[] = [
  { label: 'MF distress voice',  freqKHz:   2182.0, mode: 'usb', note: 'international MF distress' },
  { label: 'MF DSC',             freqKHz:   2187.5, mode: 'usb', note: 'DSC selective calling' },
  { label: 'MF medical (CIRM)',  freqKHz:   2191.5, mode: 'usb', note: 'medico-MF' },
  { label: 'HF distress 4 MHz',  freqKHz:   4125.0, mode: 'usb', note: 'HF distress band 1' },
  { label: 'HF DSC 4 MHz',       freqKHz:   4207.5, mode: 'usb', note: 'DSC calling' },
  { label: 'HF distress 6 MHz',  freqKHz:   6215.0, mode: 'usb', note: 'HF distress band 2' },
  { label: 'HF DSC 6 MHz',       freqKHz:   6312.0, mode: 'usb', note: 'DSC calling' },
  { label: 'HF medical 6 MHz',   freqKHz:   6230.0, mode: 'usb', note: 'CIRM medico' },
  { label: 'HF distress 8 MHz',  freqKHz:   8291.0, mode: 'usb', note: 'HF distress band 3' },
  { label: 'HF DSC 8 MHz',       freqKHz:   8414.5, mode: 'usb', note: 'DSC calling' },
  { label: 'HF distress 12 MHz', freqKHz:  12290.0, mode: 'usb', note: 'HF distress band 4' },
  { label: 'HF DSC 12 MHz',      freqKHz:  12577.0, mode: 'usb', note: 'DSC calling' },
  { label: 'HF medical 12 MHz',  freqKHz:  12356.0, mode: 'usb', note: 'CIRM medico' },
  { label: 'HF distress 16 MHz', freqKHz:  16420.0, mode: 'usb', note: 'HF distress band 5' },
  { label: 'HF DSC 16 MHz',      freqKHz:  16804.5, mode: 'usb', note: 'DSC calling' },
];

/** PIRATE — informal European pirate and US "freebander" stretches.
 *  Activity is concentrated weekend evenings on the lower edge of each
 *  band; legality varies by country. */
const PIRATE_FREQS: FreqPickerEntry[] = [
  { label: 'Europirate 76 m',    freqKHz:  3900.0, mode: 'am',  note: '3.9–4.0 MHz · weekend evenings' },
  { label: 'Europirate 76 m alt',freqKHz:  3925.0, mode: 'am',  note: 'common slot' },
  { label: 'Europirate 76 m up', freqKHz:  4025.0, mode: 'am',  note: 'upper Europirate edge' },
  { label: 'Europirate 60 m',    freqKHz:  4965.0, mode: 'am',  note: '4.95–5.0 MHz' },
  { label: 'Europirate 48 m',    freqKHz:  6210.0, mode: 'am',  note: '6.2–6.4 MHz (most active)' },
  { label: 'Europirate 48 m mid',freqKHz:  6275.0, mode: 'am',  note: 'common slot' },
  { label: 'Europirate 48 m up', freqKHz:  6310.0, mode: 'am',  note: 'upper edge' },
  { label: 'Europirate 48 m SSB',freqKHz:  6305.0, mode: 'lsb', note: 'LSB DX QSOs' },
  { label: 'US freebander 43 m', freqKHz:  6925.0, mode: 'am',  note: '6.9–7.0 MHz · most active US pirates' },
  { label: 'US freebander SSB',  freqKHz:  6925.0, mode: 'usb', note: 'USB variant' },
  { label: 'US freebander LSB',  freqKHz:  6910.0, mode: 'lsb', note: 'LSB freebander' },
  { label: 'Europirate 41 m',    freqKHz:  7600.0, mode: 'am',  note: '7.5–7.7 MHz · less active' },
  { label: 'High-band pirate',   freqKHz: 13975.0, mode: 'am',  note: 'rare upper-HF pirate' },
];

/** MARS — US Army / Navy / Air Force Military Auxiliary Radio Service
 *  and Canadian CFARS. Operates outside (but near) the amateur bands. */
const MARS_FREQS: FreqPickerEntry[] = [
  { label: 'USA MARS 3295',  freqKHz:  3295.0, mode: 'usb', note: 'Army MARS region' },
  { label: 'USA MARS 4035',  freqKHz:  4035.0, mode: 'usb', note: 'Army MARS net' },
  { label: 'USA MARS 4540',  freqKHz:  4540.0, mode: 'usb', note: 'Army MARS net' },
  { label: 'USA MARS 5302',  freqKHz:  5302.0, mode: 'usb', note: 'Army MARS' },
  { label: 'Navy MARS 4039', freqKHz:  4039.0, mode: 'usb', note: 'Navy/Marine MARS' },
  { label: 'AF MARS 5403',   freqKHz:  5403.5, mode: 'usb', note: 'Air Force MARS' },
  { label: 'AF MARS 6912',   freqKHz:  6912.0, mode: 'usb', note: 'Air Force MARS' },
  { label: 'AF MARS 9098',   freqKHz:  9098.0, mode: 'usb', note: 'Air Force MARS' },
  { label: 'Army MARS 7570', freqKHz:  7570.0, mode: 'usb', note: 'Army MARS day' },
  { label: 'Army MARS 13927',freqKHz: 13927.0, mode: 'usb', note: 'Army MARS DX' },
  { label: 'Navy MARS 14393',freqKHz: 14393.0, mode: 'usb', note: 'Navy MARS' },
  { label: 'AF MARS 14438',  freqKHz: 14438.0, mode: 'usb', note: 'AF MARS DX' },
  { label: 'CFARS 4 MHz',    freqKHz:  4146.0, mode: 'usb', note: 'Canadian Forces ARS' },
  { label: 'CFARS 7 MHz',    freqKHz:  7320.0, mode: 'usb', note: 'Canadian Forces ARS' },
];

/** WFAX — Weather-fax broadcast schedules. Same frequencies as the
 *  WEFAX station picker but oriented around time windows. The note
 *  carries the schedule and chart type. */
const WFAX_FREQS: FreqPickerEntry[] = [
  { label: 'DWD Pinneberg 3855',  freqKHz:  3855.0, mode: 'usb', note: 'Germany · 24h · sea / surface analysis' },
  { label: 'DWD Pinneberg 7880',  freqKHz:  7880.0, mode: 'usb', note: 'Germany · 24h · Atlantic charts' },
  { label: 'DWD Pinneberg 13883', freqKHz: 13882.5, mode: 'usb', note: 'Germany · 24h · upper HF' },
  { label: 'NOAA Boston 6340',    freqKHz:  6340.5, mode: 'usb', note: 'NMF Boston · 24h · NW Atlantic' },
  { label: 'NOAA Boston 9110',    freqKHz:  9110.0, mode: 'usb', note: 'NMF Boston · 24h' },
  { label: 'NOAA New Orleans',    freqKHz:  8503.9, mode: 'usb', note: 'NMG · 24h · Gulf of Mexico' },
  { label: 'NOAA NOL 12790',      freqKHz: 12789.9, mode: 'usb', note: 'NMG · 24h · Caribbean' },
  { label: 'NOAA Pt. Reyes 8682', freqKHz:  8682.0, mode: 'usb', note: 'NMC · 24h · NE Pacific' },
  { label: 'NOAA Pt. Reyes 12786',freqKHz: 12786.0, mode: 'usb', note: 'NMC · 24h · day' },
  { label: 'JMH Tokyo 3622',      freqKHz:  3622.5, mode: 'usb', note: 'Japan · 24h · NW Pacific' },
  { label: 'JMH Tokyo 7795',      freqKHz:  7795.0, mode: 'usb', note: 'Japan · 24h · primary' },
  { label: 'JMH Tokyo 13989',     freqKHz: 13988.5, mode: 'usb', note: 'Japan · day · upper HF' },
  { label: 'Honolulu 9982',       freqKHz:  9982.5, mode: 'usb', note: 'KVM70 · Hawaii' },
  { label: 'Honolulu 11090',      freqKHz: 11090.0, mode: 'usb', note: 'KVM70 · day' },
  { label: 'Bracknell 4610',      freqKHz:  4610.0, mode: 'usb', note: 'UK Met · EU North Atlantic' },
  { label: 'Bracknell 8040',      freqKHz:  8040.0, mode: 'usb', note: 'UK Met · day' },
  { label: 'Northwood (UK)',      freqKHz:  3652.0, mode: 'usb', note: 'GYA · UK Royal Navy fax' },
];

/** STANAG — known persistent MIL-STD-188-110 / STANAG 4285 / 4539 NATO
 *  data carriers seen on HF. Augments the existing S4285 / S4539
 *  detector buttons by parking the receiver on real activity. */
const STANAG_FREQS: FreqPickerEntry[] = [
  { label: 'STANAG carrier 4045', freqKHz:  4045.0, mode: 'usb', note: 'frequent 4285 activity' },
  { label: 'STANAG carrier 4180', freqKHz:  4180.0, mode: 'usb', note: '4285 ALE-paired' },
  { label: 'STANAG carrier 4232', freqKHz:  4232.0, mode: 'usb', note: 'common 4285' },
  { label: 'STANAG carrier 5260', freqKHz:  5260.0, mode: 'usb', note: '4285 net' },
  { label: 'STANAG carrier 5715', freqKHz:  5715.0, mode: 'usb', note: '4285 net' },
  { label: 'STANAG carrier 6783', freqKHz:  6783.0, mode: 'usb', note: '4285 / 4539 mix' },
  { label: 'STANAG carrier 6907', freqKHz:  6907.0, mode: 'usb', note: '4285 net' },
  { label: 'STANAG carrier 6920', freqKHz:  6920.0, mode: 'usb', note: '4285 net' },
  { label: 'STANAG carrier 9051', freqKHz:  9051.0, mode: 'usb', note: '4539 high-rate' },
  { label: 'STANAG carrier 11138',freqKHz: 11138.0, mode: 'usb', note: '4285 / 4539 mix' },
];

/** CB — 27 MHz Citizens Band core channels + freebander stretches. */
const CB_FREQS: FreqPickerEntry[] = [
  { label: 'CB ch 1',          freqKHz: 26965.0, mode: 'am',  note: 'US/EU CB band start' },
  { label: 'CB ch 9 emergency',freqKHz: 27065.0, mode: 'am',  note: 'monitored emergency' },
  { label: 'CB ch 14',         freqKHz: 27125.0, mode: 'am',  note: 'walkie-talkie default' },
  { label: 'CB ch 19 truckers',freqKHz: 27185.0, mode: 'am',  note: 'highway / trucker channel' },
  { label: 'CB ch 36 LSB DX',  freqKHz: 27365.0, mode: 'lsb', note: 'CB LSB DX calling' },
  { label: 'CB ch 38 LSB DX',  freqKHz: 27385.0, mode: 'lsb', note: 'CB LSB DX primary' },
  { label: 'CB ch 40 LSB',     freqKHz: 27405.0, mode: 'lsb', note: 'CB band upper edge' },
  { label: 'UK CB 27.601',     freqKHz: 27601.25,mode: 'nbfm',note: 'UK CB Mid-band channel 14' },
  { label: 'Downbander start', freqKHz: 26515.0, mode: 'am',  note: 'below CB · pirates/DX' },
  { label: 'Downbander mid',   freqKHz: 26735.0, mode: 'am',  note: 'common downbander spot' },
  { label: 'Upbander start',   freqKHz: 27500.0, mode: 'usb', note: 'above CB · DXers' },
  { label: 'Upbander 27.700',  freqKHz: 27700.0, mode: 'usb', note: 'upbander DX' },
  { label: 'Upbander 28 MHz',  freqKHz: 27905.0, mode: 'usb', note: 'edge to 10 m amateur' },
];

/** DRM — Digital Radio Mondiale broadcasters. Currently / recently
 *  active transmitters worldwide. Listen with the DRM demod mode. */
const DRM_FREQS: FreqPickerEntry[] = [
  { label: 'AIR Bengaluru DRM',     freqKHz:  4760.0, mode: 'drm', note: 'India · regional service' },
  { label: 'AIR Aligarh DRM',       freqKHz:  4810.0, mode: 'drm', note: 'India · domestic' },
  { label: 'AIR Delhi DRM',         freqKHz:  9870.0, mode: 'drm', note: 'India · external' },
  { label: 'AIR Delhi DRM 11620',   freqKHz: 11620.0, mode: 'drm', note: 'India · external' },
  { label: 'Vatican Radio DRM',     freqKHz:  9645.0, mode: 'drm', note: 'Italy · Vatican (intermittent)' },
  { label: 'Romania DRM 5910',      freqKHz:  5910.0, mode: 'drm', note: 'Radio Romania · European service' },
  { label: 'Romania DRM 6030',      freqKHz:  6030.0, mode: 'drm', note: 'Radio Romania · DRM30' },
  { label: 'Romania DRM 7220',      freqKHz:  7220.0, mode: 'drm', note: 'Radio Romania · evening' },
  { label: 'WINB DRM',              freqKHz:  9265.0, mode: 'drm', note: 'USA · DRM trial' },
  { label: 'WINB DRM alt',          freqKHz: 13845.0, mode: 'drm', note: 'USA · DRM30' },
  { label: 'KTWR Guam DRM',         freqKHz:  9910.0, mode: 'drm', note: 'Guam · Asia DRM' },
  { label: 'KBS World DRM',         freqKHz:  9760.0, mode: 'drm', note: 'Korea · trial' },
  { label: 'BBC DRM legacy 9410',   freqKHz:  9410.0, mode: 'drm', note: 'historical · spectrum reference' },
  { label: 'HCJB DRM',              freqKHz:  3995.0, mode: 'drm', note: 'Ecuador legacy reference' },
  { label: 'Brazil Aparecida DRM',  freqKHz:  6135.0, mode: 'drm', note: 'Radio Aparecida' },
];

/** MWDX — clear-channel medium-wave DX targets. North American Class A,
 *  major European LW/MW broadcasters, and a few Asian giants. Most
 *  audible after sunset on the receive end. */
const MWDX_FREQS: FreqPickerEntry[] = [
  // North American clear channels (Class A · 50 kW)
  { label: 'CBK Watrous SK',        freqKHz:  540.0,  mode: 'am', note: 'Canada · 50 kW clear' },
  { label: 'KFI Los Angeles',       freqKHz:  640.0,  mode: 'am', note: 'USA · 50 kW clear' },
  { label: 'WSM Nashville',         freqKHz:  650.0,  mode: 'am', note: 'USA · Grand Ole Opry' },
  { label: 'WFAN New York',         freqKHz:  660.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WLW Cincinnati',        freqKHz:  700.0,  mode: 'am', note: 'USA · 50 kW clear' },
  { label: 'WGN Chicago',           freqKHz:  720.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WSB Atlanta',           freqKHz:  750.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WJR Detroit',           freqKHz:  760.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WABC New York',         freqKHz:  770.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WCCO Minneapolis',      freqKHz:  830.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WHAS Louisville',       freqKHz:  840.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WCBS New York',         freqKHz:  880.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WBZ Boston',            freqKHz: 1030.0,  mode: 'am', note: 'USA · 50 kW clear' },
  { label: 'WHO Des Moines',        freqKHz: 1040.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'KMOX St. Louis',        freqKHz: 1120.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WHAM Rochester',        freqKHz: 1180.0,  mode: 'am', note: 'USA · 50 kW' },
  { label: 'WOAI San Antonio',      freqKHz: 1200.0,  mode: 'am', note: 'USA · 50 kW' },
  // European
  { label: 'NHK1 Tokyo',            freqKHz:  594.0,  mode: 'am', note: 'Japan · 300 kW' },
  { label: 'BBC R5 / talkSPORT 693',freqKHz:  693.0,  mode: 'am', note: 'UK · 150 kW' },
  { label: 'Radio Romania 855',     freqKHz:  855.0,  mode: 'am', note: 'Romania · 50 kW' },
  { label: 'Vatican 1611',          freqKHz: 1611.0,  mode: 'am', note: 'Vatican · special-event' },
];

/** LW — European longwave broadcast (153–279 kHz). Many shutdowns in
 *  the last decade; entries note current status. */
const LW_FREQS: FreqPickerEntry[] = [
  { label: 'Antena Satelor 153',    freqKHz:  153.0, mode: 'am', note: 'Romania · active' },
  { label: 'RTÉ R1 LW 252',         freqKHz:  252.0, mode: 'am', note: 'Ireland · low power 2024+' },
  { label: 'Algerian Chaîne 1',     freqKHz:  153.0, mode: 'am', note: 'Algeria · active' },
  { label: 'Medi 1 (Maroc)',        freqKHz:  171.0, mode: 'am', note: 'Morocco · active' },
  { label: 'BBC R4 LW',             freqKHz:  198.0, mode: 'am', note: 'UK · last UK LW · winding down' },
  { label: 'Polskie Radio 225',     freqKHz:  225.0, mode: 'am', note: 'Poland · active' },
  { label: 'RTL Luxembourg 234',    freqKHz:  234.0, mode: 'am', note: 'Luxembourg · shut 2023 · legacy' },
  { label: 'Algeria 252',           freqKHz:  252.0, mode: 'am', note: 'Algeria · 1500 kW' },
  { label: 'Czech R 270',           freqKHz:  270.0, mode: 'am', note: 'Czechia · low power' },
  { label: 'Belarus 279',           freqKHz:  279.0, mode: 'am', note: 'Belarus · sporadic' },
];

/** DGPS — LF/MF Differential GPS reference beacons. MSK-encoded data
 *  at 100/200 bps, overlapping the NDB band but distinct signal type. */
const DGPS_FREQS: FreqPickerEntry[] = [
  { label: 'DGPS band start',       freqKHz:  283.5, mode: 'cw', note: 'lower edge of DGPS allocation' },
  { label: 'Tory Island DGPS',      freqKHz:  287.5, mode: 'cw', note: 'Ireland · operational' },
  { label: 'US DGPS Annapolis',     freqKHz:  287.0, mode: 'cw', note: 'USCG · decommissioned 2020 · legacy' },
  { label: 'US DGPS Reedy Pt.',     freqKHz:  305.0, mode: 'cw', note: 'USCG · decommissioned' },
  { label: 'US DGPS Sandy Hook',    freqKHz:  304.0, mode: 'cw', note: 'USCG · decommissioned' },
  { label: 'US DGPS Hawk Inlet',    freqKHz:  289.0, mode: 'cw', note: 'USCG · decommissioned' },
  { label: 'Loop Head DGPS',        freqKHz:  297.5, mode: 'cw', note: 'Ireland · operational' },
  { label: 'European DGPS 296',     freqKHz:  296.0, mode: 'cw', note: 'common EU reference' },
  { label: 'European DGPS 308',     freqKHz:  308.0, mode: 'cw', note: 'common EU reference' },
  { label: 'DGPS band upper',       freqKHz:  325.0, mode: 'cw', note: 'upper edge' },
];

/** SWBROAD — marquee shortwave broadcasters. Goal is fast station →
 *  freq access ("go to BBC now"), complementing EIBI's freq → schedule
 *  lookup. */
const SWBROAD_FREQS: FreqPickerEntry[] = [
  { label: 'BBC WS 5875',           freqKHz:  5875.0, mode: 'am', note: 'World Service · English' },
  { label: 'BBC WS 6190',           freqKHz:  6190.0, mode: 'am', note: 'World Service · English' },
  { label: 'BBC WS 9410',           freqKHz:  9410.0, mode: 'am', note: 'World Service · classic' },
  { label: 'BBC WS 12095',          freqKHz: 12095.0, mode: 'am', note: 'World Service · day' },
  { label: 'VOA Africa 4960',       freqKHz:  4960.0, mode: 'am', note: 'Voice of America · Africa' },
  { label: 'VOA 7430',              freqKHz:  7430.0, mode: 'am', note: 'Voice of America · ME / Africa' },
  { label: 'VOA 11580',             freqKHz: 11580.0, mode: 'am', note: 'Voice of America · day' },
  { label: 'RFI 9790',              freqKHz:  9790.0, mode: 'am', note: 'Radio France · French' },
  { label: 'CRI 5990',              freqKHz:  5990.0, mode: 'am', note: 'China Radio Int · English' },
  { label: 'CRI 7325',              freqKHz:  7325.0, mode: 'am', note: 'China Radio Int' },
  { label: 'CRI 9570',              freqKHz:  9570.0, mode: 'am', note: 'China Radio Int' },
  { label: 'CRI 15125',             freqKHz: 15125.0, mode: 'am', note: 'China Radio Int · day' },
  { label: 'Radio Romania 7325',    freqKHz:  7325.0, mode: 'am', note: 'RRI · Europe' },
  { label: 'Radio Romania 9610',    freqKHz:  9610.0, mode: 'am', note: 'RRI · day' },
  { label: 'KBS World 9690',        freqKHz:  9690.0, mode: 'am', note: 'Korea · external' },
  { label: 'NHK World 5985',        freqKHz:  5985.0, mode: 'am', note: 'Japan · external' },
  { label: 'NHK World 11705',       freqKHz: 11705.0, mode: 'am', note: 'Japan · external' },
  { label: 'WRMI 5950',             freqKHz:  5950.0, mode: 'am', note: 'USA · independent SW' },
  { label: 'WRMI 9395',             freqKHz:  9395.0, mode: 'am', note: 'USA · independent SW' },
  { label: 'Vatican 7250',          freqKHz:  7250.0, mode: 'am', note: 'Vatican Radio' },
  { label: 'Vatican 9645',          freqKHz:  9645.0, mode: 'am', note: 'Vatican Radio' },
  { label: 'RTI Taiwan 11600',      freqKHz: 11600.0, mode: 'am', note: 'Radio Taiwan · English' },
  { label: 'WWCR Nashville',        freqKHz:  4840.0, mode: 'am', note: 'USA · religious / opinion' },
  { label: 'WWCR Nashville 9350',   freqKHz:  9350.0, mode: 'am', note: 'USA · religious / opinion' },
  { label: 'WBCQ The Planet',       freqKHz:  7490.0, mode: 'am', note: 'USA · indie · varied prog' },
];

/** TRAFNETS — amateur traffic / maritime / mobile nets. Distinct from
 *  PSKR/RBN spots in that these are scheduled voice/CW exchanges. */
const TRAFNETS_FREQS: FreqPickerEntry[] = [
  { label: 'Maritime Mobile Net',   freqKHz: 14300.0, mode: 'usb', note: '1700–0200 UTC · weather, traffic' },
  { label: 'Pacific Maritime Mobile',freqKHz: 14313.0, mode: 'usb', note: 'Pacific Ocean coverage' },
  { label: 'Pacific Seafarers',     freqKHz: 14300.0, mode: 'usb', note: '0300–0500 UTC · vessel pos' },
  { label: 'SATERN HF Net',         freqKHz: 14265.0, mode: 'usb', note: 'Salvation Army emergency' },
  { label: 'SATERN backup',         freqKHz:  7262.0, mode: 'lsb', note: 'Salvation Army emergency' },
  { label: 'ARES West net',         freqKHz:  3940.0, mode: 'lsb', note: 'ARRL emergency services' },
  { label: 'Mickey Mouse Net (CW)', freqKHz:  3555.0, mode: 'cw',  note: 'CW traffic relay' },
  { label: '40 m ARRL phone',       freqKHz:  7243.0, mode: 'lsb', note: 'eastern US phone net' },
  { label: '80 m ARRL phone',       freqKHz:  3873.0, mode: 'lsb', note: 'eastern US phone net' },
  { label: 'Healthcare/Welfare',    freqKHz:  7290.0, mode: 'lsb', note: 'Red Cross-style' },
  { label: 'Cuba H&W (Spanish)',    freqKHz:  7150.0, mode: 'lsb', note: 'Cuban traffic' },
  { label: 'IARU R3 Asia/Pacific',  freqKHz: 14110.0, mode: 'usb', note: 'IARU region 3 net' },
  { label: 'HFLINK ALE call',       freqKHz: 14346.0, mode: 'usb', note: 'amateur ALE calling channel' },
];

/** PACTOR — listenable Winlink / Pactor message-gateway HF calling
 *  channels. Pactor itself isn't decodable as a passive listener, but
 *  the activity is monitorable. */
const PACTOR_FREQS: FreqPickerEntry[] = [
  { label: 'Winlink 80 m',          freqKHz:  3596.5, mode: 'usb', note: 'WL2K calling' },
  { label: 'Winlink 40 m',          freqKHz:  7104.5, mode: 'usb', note: 'WL2K calling' },
  { label: 'Winlink 30 m',          freqKHz: 10145.5, mode: 'usb', note: 'WL2K calling' },
  { label: 'Winlink 20 m',          freqKHz: 14111.5, mode: 'usb', note: 'WL2K calling · most active' },
  { label: 'Winlink 17 m',          freqKHz: 18105.5, mode: 'usb', note: 'WL2K calling' },
  { label: 'Winlink 15 m',          freqKHz: 21097.5, mode: 'usb', note: 'WL2K calling' },
  { label: 'Winlink 12 m',          freqKHz: 24929.5, mode: 'usb', note: 'WL2K calling' },
  { label: 'Pactor maritime 4 MHz', freqKHz:  4193.5, mode: 'usb', note: 'SailMail · maritime' },
  { label: 'Pactor maritime 6 MHz', freqKHz:  6326.5, mode: 'usb', note: 'SailMail · maritime' },
  { label: 'Pactor maritime 8 MHz', freqKHz:  8408.5, mode: 'usb', note: 'SailMail · maritime' },
  { label: 'Pactor maritime 12 MHz',freqKHz: 12553.5, mode: 'usb', note: 'SailMail · maritime' },
  { label: 'Pactor maritime 16 MHz',freqKHz: 16668.5, mode: 'usb', note: 'SailMail · maritime' },
];

/** STANAG-3G — MIL-STD-188-141C / STANAG 4538 (3G ALE) network freqs.
 *  Distinct from the existing 2G ALE list — 3G uses orthogonal
 *  waveforms and tends to occupy its own channel set. */
const STANAG3G_FREQS: FreqPickerEntry[] = [
  { label: '3G ALE 5418',           freqKHz:  5418.5, mode: 'usb', note: 'common 3G calling' },
  { label: '3G ALE 6809',           freqKHz:  6809.0, mode: 'usb', note: '3G ALE net' },
  { label: '3G ALE 7102',           freqKHz:  7102.0, mode: 'usb', note: '3G ALE net' },
  { label: '3G ALE 8995',           freqKHz:  8995.5, mode: 'usb', note: '3G ALE · most active' },
  { label: '3G ALE 9087',           freqKHz:  9087.5, mode: 'usb', note: '3G ALE net' },
  { label: '3G ALE 10220',          freqKHz: 10220.0, mode: 'usb', note: '3G ALE day' },
  { label: '3G ALE 13245',          freqKHz: 13245.0, mode: 'usb', note: '3G ALE day' },
  { label: '3G ALE 18099',          freqKHz: 18099.0, mode: 'usb', note: '3G ALE upper HF' },
];

/** COAST — coastal-station HF broadcast voice (weather, NAVAREAs,
 *  high-seas bulletins). Distinct from MRINE's calling/distress focus. */
const COAST_FREQS: FreqPickerEntry[] = [
  { label: 'USCG NMN 4426',         freqKHz:  4426.0, mode: 'usb', note: 'Chesapeake · WX / safety' },
  { label: 'USCG NMN 6501',         freqKHz:  6501.0, mode: 'usb', note: 'Chesapeake · 24h' },
  { label: 'USCG NMN 8764',         freqKHz:  8764.0, mode: 'usb', note: 'Chesapeake · day band' },
  { label: 'USCG NMN 13089',        freqKHz: 13089.0, mode: 'usb', note: 'Chesapeake · day band' },
  { label: 'USCG NMG New Orleans',  freqKHz:  4316.0, mode: 'usb', note: 'Gulf · NMG broadcast' },
  { label: 'USCG NMG 6501',         freqKHz:  6501.0, mode: 'usb', note: 'Gulf coast' },
  { label: 'USCG NMC Pt. Reyes',    freqKHz:  4426.0, mode: 'usb', note: 'California · WX' },
  { label: 'USCG NMC 8764',         freqKHz:  8764.0, mode: 'usb', note: 'California · day band' },
  { label: 'USCG NOJ Kodiak',       freqKHz:  6501.0, mode: 'usb', note: 'Alaska · WX' },
  { label: 'USCG NOJ 8764',         freqKHz:  8764.0, mode: 'usb', note: 'Alaska · WX' },
];

/** EMCOMM — formal emergency / disaster nets (Red Cross, RACES, IARU
 *  region emergency channels). Activates during real events; the freqs
 *  are kept clear for that purpose. */
const EMCOMM_FREQS: FreqPickerEntry[] = [
  { label: 'IARU R1 emergency',     freqKHz:  3760.0, mode: 'lsb', note: 'European emergency calling' },
  { label: 'IARU R1 emergency 7',   freqKHz:  7060.0, mode: 'lsb', note: 'European emergency calling' },
  { label: 'IARU global emergency', freqKHz: 14300.0, mode: 'usb', note: 'global emergency / traffic' },
  { label: 'IARU R2 SA emergency',  freqKHz:  7060.0, mode: 'lsb', note: 'South American' },
  { label: 'IARU R3 emergency',     freqKHz: 14300.0, mode: 'usb', note: 'Asia / Pacific' },
  { label: 'ARRL RACES net',        freqKHz:  3873.0, mode: 'lsb', note: 'Radio Amateur Civil Emergency' },
  { label: 'ARRL RACES 7245',       freqKHz:  7245.0, mode: 'lsb', note: 'Radio Amateur Civil Emergency' },
  { label: 'Red Cross HF',          freqKHz:  7250.0, mode: 'lsb', note: 'Red Cross national net' },
  { label: 'SATERN primary',        freqKHz: 14265.0, mode: 'usb', note: 'Salvation Army emergency primary' },
  { label: 'SATERN secondary',      freqKHz:  7262.0, mode: 'lsb', note: 'Salvation Army emergency backup' },
];

/** EMBASSY — diplomatic / state-department HF carriers (RTTY, Pactor,
 *  voice). Mostly Russian and Chinese embassy nets that survive in
 *  open monitoring logs (UDXF / WUN). */
const EMBASSY_FREQS: FreqPickerEntry[] = [
  { label: 'Russian embassy 4615',    freqKHz:  4615.0, mode: 'usb', note: 'MFA Moscow · RTTY-75 baud' },
  { label: 'Russian embassy 5470',    freqKHz:  5470.0, mode: 'usb', note: 'MFA Moscow · RTTY' },
  { label: 'Russian embassy 6757',    freqKHz:  6757.0, mode: 'usb', note: 'MFA Moscow · most active' },
  { label: 'Russian embassy 8118',    freqKHz:  8118.0, mode: 'usb', note: 'MFA Moscow · RTTY' },
  { label: 'Russian embassy 13855',   freqKHz: 13855.0, mode: 'usb', note: 'MFA Moscow · day RTTY' },
  { label: 'Chinese embassy 6770',    freqKHz:  6770.0, mode: 'usb', note: 'PRC MFA · data bursts' },
  { label: 'Chinese embassy 12130',   freqKHz: 12130.0, mode: 'usb', note: 'PRC MFA · day' },
  { label: 'Iranian MFA 11185',       freqKHz: 11185.0, mode: 'usb', note: 'Tehran · sporadic' },
  { label: 'Diplomatic 5410',         freqKHz:  5410.0, mode: 'usb', note: 'mixed diplomatic RTTY' },
  { label: 'Diplomatic 8120',         freqKHz:  8120.0, mode: 'usb', note: 'mixed diplomatic RTTY' },
  { label: 'Diplomatic 10520',        freqKHz: 10520.0, mode: 'usb', note: 'mixed diplomatic data' },
  { label: 'Diplomatic 14441',        freqKHz: 14441.0, mode: 'usb', note: 'mixed diplomatic data' },
];

/** CLANDESTINE — broadcasts aimed at censored regions (mainland China,
 *  North Korea, Tibet, Iran, Cuba). Schedules rotate frequently; the
 *  entries are anchor channels seen most often. */
const CLANDESTINE_FREQS: FreqPickerEntry[] = [
  { label: 'Sound of Hope 7310',       freqKHz:  7310.0, mode: 'am', note: 'Falun Gong → PRC · rotates' },
  { label: 'Sound of Hope 9200',       freqKHz:  9200.0, mode: 'am', note: 'Falun Gong → PRC' },
  { label: 'Sound of Hope 11500',      freqKHz: 11500.0, mode: 'am', note: 'Falun Gong → PRC · day' },
  { label: 'Sound of Hope 14600',      freqKHz: 14600.0, mode: 'am', note: 'Falun Gope → PRC · upper HF' },
  { label: 'Voice of Tibet 11515',     freqKHz: 11515.0, mode: 'am', note: 'India / Norway → Tibet' },
  { label: 'Voice of Tibet 15535',     freqKHz: 15535.0, mode: 'am', note: 'India / Norway → Tibet · day' },
  { label: 'Echo of Hope 3985',        freqKHz:  3985.0, mode: 'am', note: 'ROK → DPRK · night' },
  { label: 'Echo of Hope 6250',        freqKHz:  6250.0, mode: 'am', note: 'ROK → DPRK' },
  { label: 'Echo of Hope 9095',        freqKHz:  9095.0, mode: 'am', note: 'ROK → DPRK · day' },
  { label: 'Voice of Korea 9425',      freqKHz:  9425.0, mode: 'am', note: 'DPRK external · multilingual' },
  { label: 'Voice of Korea 11910',     freqKHz: 11910.0, mode: 'am', note: 'DPRK external · English' },
  { label: 'Voice of Korea 13760',     freqKHz: 13760.0, mode: 'am', note: 'DPRK external · day' },
  { label: 'Voice of Wilderness 7530', freqKHz:  7530.0, mode: 'am', note: 'Christian → DPRK' },
  { label: 'NK Reform Radio 7615',     freqKHz:  7615.0, mode: 'am', note: 'ROK NGO → DPRK' },
  { label: 'Radio Marti',              freqKHz:  6030.0, mode: 'am', note: 'USA → Cuba (jammed)' },
];

/** RUSMIL — Russian strategic / fleet military HF networks. Distinct
 *  from MILV (NATO-centric) and from NUM (numbers stations). */
const RUSMIL_FREQS: FreqPickerEntry[] = [
  { label: 'Briz net 8345',            freqKHz:  8345.0, mode: 'usb', note: 'strategic command' },
  { label: 'Briz net 9163',            freqKHz:  9163.0, mode: 'usb', note: 'strategic command' },
  { label: 'Briz net 10238',           freqKHz: 10238.0, mode: 'usb', note: 'strategic command' },
  { label: 'Briz net 12464',           freqKHz: 12464.0, mode: 'usb', note: 'strategic command' },
  { label: 'Akula Pacific 7765',       freqKHz:  7765.0, mode: 'usb', note: 'Pacific Fleet · voice' },
  { label: 'Akula Pacific 9028',       freqKHz:  9028.0, mode: 'usb', note: 'Pacific Fleet · voice' },
  { label: 'Krug data 8083',           freqKHz:  8083.0, mode: 'usb', note: 'HF data bursts' },
  { label: 'Krug data 10980',          freqKHz: 10980.0, mode: 'usb', note: 'HF data bursts' },
  { label: 'Krug data 12188',          freqKHz: 12188.0, mode: 'usb', note: 'HF data bursts' },
  { label: 'Sviaz net 11018',          freqKHz: 11018.0, mode: 'usb', note: 'mil control' },
];

/** CAP — US Civil Air Patrol HF. Auxiliary US Air Force; cadet,
 *  emergency, and SAR comms. */
const CAP_FREQS: FreqPickerEntry[] = [
  { label: 'CAP 3.295',                freqKHz:  3295.0, mode: 'usb', note: 'national / regional' },
  { label: 'CAP 4.467',                freqKHz:  4467.0, mode: 'usb', note: 'national command' },
  { label: 'CAP 4.585',                freqKHz:  4585.0, mode: 'usb', note: 'national command alt' },
  { label: 'CAP 7.633',                freqKHz:  7633.0, mode: 'usb', note: 'national net' },
  { label: 'CAP 14.342',               freqKHz: 14342.0, mode: 'usb', note: 'national / DX net' },
  { label: 'CAP cadet 7.622',          freqKHz:  7622.0, mode: 'usb', note: 'cadet net' },
  { label: 'CAP NW region 4.502',      freqKHz:  4502.0, mode: 'usb', note: 'NW region SAR' },
  { label: 'CAP SAR coordination',     freqKHz:  4585.0, mode: 'usb', note: 'SAR primary' },
];

/** MEPT — Manned Experimental Propagation Test QRPp / QRSS beacons.
 *  Tiny sub-segments at the bottom of each ham band where slow-CW
 *  transmissions (≤ 100 mW, minutes per dot) live. */
const MEPT_FREQS: FreqPickerEntry[] = [
  { label: 'MEPT 137 kHz LF',     freqKHz:   137.778, mode: 'cw', note: 'European LF QRSS window' },
  { label: 'MEPT 475 kHz MF',     freqKHz:   475.700, mode: 'cw', note: '630 m QRSS window' },
  { label: 'MEPT 80 m QRSS',      freqKHz:  3593.400, mode: 'cw', note: '80 m QRSS window' },
  { label: 'MEPT 40 m QRSS',      freqKHz:  7000.800, mode: 'cw', note: '40 m QRSS window (upper edge)' },
  { label: 'MEPT 30 m QRSS',      freqKHz: 10138.700, mode: 'cw', note: '30 m · most active QRSS' },
  { label: 'MEPT 30 m alt',       freqKHz: 10140.000, mode: 'cw', note: '30 m · upper QRSS edge' },
  { label: 'MEPT 20 m QRSS',      freqKHz: 14000.800, mode: 'cw', note: '20 m QRSS window' },
  { label: 'MEPT 17 m QRSS',      freqKHz: 18106.000, mode: 'cw', note: '17 m QRSS window' },
  { label: 'MEPT 15 m QRSS',      freqKHz: 21000.800, mode: 'cw', note: '15 m QRSS window' },
  { label: 'MEPT 12 m QRSS',      freqKHz: 24890.800, mode: 'cw', note: '12 m QRSS' },
  { label: 'MEPT 10 m QRSS',      freqKHz: 28000.800, mode: 'cw', note: '10 m QRSS window' },
  { label: 'MEPT 6 m edge',       freqKHz: 28321.000, mode: 'cw', note: 'upper 10 m experimental' },
];

/** COASTCW — Museum / special-event commercial coastal CW stations.
 *  Most are inactive day-to-day; KSM and K6KPH run regular Saturday
 *  schedules and the annual "Night of Nights" event each July. */
const COASTCW_FREQS: FreqPickerEntry[] = [
  { label: 'KSM Pt. Reyes 426',   freqKHz:   426.0, mode: 'cw', note: 'museum coastal · MF' },
  { label: 'KSM Pt. Reyes 6474',  freqKHz:  6474.0, mode: 'cw', note: 'museum coastal · HF' },
  { label: 'KSM Pt. Reyes 12808', freqKHz: 12808.5, mode: 'cw', note: 'museum coastal · HF' },
  { label: 'KSM Pt. Reyes 17184', freqKHz: 17184.4, mode: 'cw', note: 'museum coastal · day band' },
  { label: 'K6KPH 80 m',          freqKHz:  3550.0, mode: 'cw', note: 'amateur Morse · Pt. Reyes' },
  { label: 'K6KPH 40 m',          freqKHz:  7050.0, mode: 'cw', note: 'amateur Morse · Pt. Reyes' },
  { label: 'K6KPH 20 m',          freqKHz: 14050.0, mode: 'cw', note: 'amateur Morse · Pt. Reyes' },
  { label: 'K6KPH 15 m',          freqKHz: 21050.0, mode: 'cw', note: 'amateur Morse · Pt. Reyes' },
];

/** SKYNET — RAF / NATO Skynet UK military HF. UK MoD strategic /
 *  tactical voice and data; distinct from USAF HFGCS. */
const SKYNET_FREQS: FreqPickerEntry[] = [
  { label: 'Skynet 3.146',        freqKHz:  3146.0, mode: 'usb', note: 'UK MoD · night' },
  { label: 'Skynet 4.742',        freqKHz:  4742.0, mode: 'usb', note: 'UK MoD · most active' },
  { label: 'Skynet 6.733',        freqKHz:  6733.0, mode: 'usb', note: 'UK MoD · transition' },
  { label: 'Skynet 9.031',        freqKHz:  9031.0, mode: 'usb', note: 'UK MoD · day' },
  { label: 'Skynet 11.205',       freqKHz: 11205.0, mode: 'usb', note: 'UK MoD · day' },
  { label: 'Skynet 14.353',       freqKHz: 14353.0, mode: 'usb', note: 'UK MoD · upper HF' },
  { label: 'Skynet 18.018',       freqKHz: 18018.0, mode: 'usb', note: 'UK MoD · day · less active' },
];

/** DXCLUSTER — DX-cluster voice / CW calling frequencies. The CW
 *  centers are where DXers congregate to chase rare entities; the SSB
 *  DX windows are the SSB equivalents. */
const DXCLUSTER_FREQS: FreqPickerEntry[] = [
  { label: '160 m CW DX',         freqKHz:  1825.0, mode: 'cw',  note: '160 m DX window' },
  { label: '80 m CW DX',          freqKHz:  3505.0, mode: 'cw',  note: '80 m CW DX center' },
  { label: '80 m SSB DX',         freqKHz:  3793.0, mode: 'lsb', note: '80 m SSB DX window' },
  { label: '40 m CW DX',          freqKHz:  7005.0, mode: 'cw',  note: '40 m CW DX window' },
  { label: '40 m QRP CW',         freqKHz:  7030.0, mode: 'cw',  note: '40 m QRP CW center' },
  { label: '40 m SSB DX',         freqKHz:  7190.0, mode: 'lsb', note: '40 m SSB DX window' },
  { label: '30 m CW DX',          freqKHz: 10105.0, mode: 'cw',  note: '30 m CW DX' },
  { label: '20 m CW DX',          freqKHz: 14020.0, mode: 'cw',  note: '20 m CW DX center' },
  { label: '20 m QRP CW',         freqKHz: 14060.0, mode: 'cw',  note: '20 m QRP / DX hunting' },
  { label: '20 m SSB DX',         freqKHz: 14195.0, mode: 'usb', note: '20 m SSB DX window' },
  { label: '17 m CW DX',          freqKHz: 18075.0, mode: 'cw',  note: '17 m CW DX' },
  { label: '17 m SSB DX',         freqKHz: 18130.0, mode: 'usb', note: '17 m SSB DX' },
  { label: '15 m CW DX',          freqKHz: 21025.0, mode: 'cw',  note: '15 m CW DX' },
  { label: '15 m SSB DX',         freqKHz: 21300.0, mode: 'usb', note: '15 m SSB DX' },
  { label: '12 m CW DX',          freqKHz: 24910.0, mode: 'cw',  note: '12 m CW DX' },
  { label: '10 m CW DX',          freqKHz: 28020.0, mode: 'cw',  note: '10 m CW DX' },
  { label: '10 m SSB DX',         freqKHz: 28500.0, mode: 'usb', note: '10 m SSB DX' },
];

/** AIRDRILL — NATO / USAF HF exercise nets (Cope Tiger, Red Flag, Bold
 *  Quest, etc.). Bursty but well-cataloged; channels are HFGCS-adjacent
 *  but reserved for drill traffic. */
const AIRDRILL_FREQS: FreqPickerEntry[] = [
  { label: 'USAF exercise 5696',  freqKHz:  5696.0, mode: 'usb', note: 'common drill calling' },
  { label: 'USAF exercise 6712',  freqKHz:  6712.0, mode: 'usb', note: 'aero mil drill' },
  { label: 'USAF exercise 6739',  freqKHz:  6739.0, mode: 'usb', note: 'HFGCS-adjacent drill' },
  { label: 'USAF exercise 7567',  freqKHz:  7567.0, mode: 'usb', note: 'NATO drill channel' },
  { label: 'USAF exercise 8987',  freqKHz:  8987.0, mode: 'usb', note: 'HFGCS-adjacent drill' },
  { label: 'USAF secondary 11226',freqKHz: 11226.0, mode: 'usb', note: 'secondary command · drills' },
  { label: 'Army MARS exercise',  freqKHz: 13927.0, mode: 'usb', note: 'MARS exercise primary' },
  { label: 'NATO drill 4721',     freqKHz:  4721.0, mode: 'usb', note: 'NATO exercise channel' },
  { label: 'NATO drill 6731',     freqKHz:  6731.0, mode: 'usb', note: 'NATO exercise channel' },
  { label: 'NATO drill 11271',    freqKHz: 11271.0, mode: 'usb', note: 'NATO exercise channel' },
];

/** AFRICA-BC — African regional shortwave broadcasters. Continent-
 *  focused programming, distinct from the global marquee broadcasters
 *  in SWBROAD. */
const AFRICA_BC_FREQS: FreqPickerEntry[] = [
  { label: 'TWR Africa 6135',      freqKHz:  6135.0, mode: 'am', note: 'Trans World Radio · Eswatini' },
  { label: 'TWR Africa 9500',      freqKHz:  9500.0, mode: 'am', note: 'Trans World Radio · day' },
  { label: 'TWR Africa 11750',     freqKHz: 11750.0, mode: 'am', note: 'Trans World Radio · day' },
  { label: 'Channel Africa 9555',  freqKHz:  9555.0, mode: 'am', note: 'SABC · external service' },
  { label: 'Channel Africa 11760', freqKHz: 11760.0, mode: 'am', note: 'SABC · external service' },
  { label: 'Voice of Nigeria',     freqKHz:  7255.0, mode: 'am', note: 'Lagos · English/French' },
  { label: 'Voice of Nigeria 9690',freqKHz:  9690.0, mode: 'am', note: 'Lagos · day band' },
  { label: 'Radio Cairo 9305',     freqKHz:  9305.0, mode: 'am', note: 'Egypt · Arabic / English' },
  { label: 'Radio Cairo 9965',     freqKHz:  9965.0, mode: 'am', note: 'Egypt · external' },
  { label: 'Radio Algiers Intl',   freqKHz:  7295.0, mode: 'am', note: 'Algeria · French / Arabic' },
  { label: 'Voice of Algeria',     freqKHz:  9500.0, mode: 'am', note: 'Algiers · external' },
  { label: 'ETHA Eritrea',         freqKHz:  7100.0, mode: 'am', note: 'Eritrea · domestic SW' },
  { label: 'Radio Sudan',          freqKHz:  7200.0, mode: 'am', note: 'Sudan · domestic SW' },
  { label: 'Radio Sawa Arabic',    freqKHz:  9415.0, mode: 'am', note: 'USAGM Arabic to ME / N Africa' },
  { label: 'BBC Africa relay',     freqKHz:  6005.0, mode: 'am', note: 'BBC African Service · Ascension' },
];

/** ASIA-BC — Asian regional shortwave broadcasters. Region-focused
 *  programming, distinct from CRI / NHK / KBS already in SWBROAD. */
const ASIA_BC_FREQS: FreqPickerEntry[] = [
  { label: 'Voice of Vietnam 7220',freqKHz:  7220.0, mode: 'am', note: 'VOV · external' },
  { label: 'Voice of Vietnam 9550',freqKHz:  9550.0, mode: 'am', note: 'VOV · external' },
  { label: 'Voice of Vietnam 12020',freqKHz:12020.0, mode: 'am', note: 'VOV · day' },
  { label: 'Thai NBT 9540',        freqKHz:  9540.0, mode: 'am', note: 'Thailand · external' },
  { label: 'Thai NBT 13745',       freqKHz: 13745.0, mode: 'am', note: 'Thailand · day' },
  { label: 'AIR World Service',    freqKHz:  9445.0, mode: 'am', note: 'India · external English' },
  { label: 'AIR 11620',            freqKHz: 11620.0, mode: 'am', note: 'India · external' },
  { label: 'Voice of Bangladesh',  freqKHz:  7250.0, mode: 'am', note: 'Dhaka · external' },
  { label: 'Voice of Bangladesh 15105', freqKHz: 15105.0, mode: 'am', note: 'Dhaka · day' },
  { label: 'Pakistan Radio',       freqKHz:  9425.0, mode: 'am', note: 'PBC external · English/Urdu' },
  { label: 'Voice of Iran',        freqKHz:  7235.0, mode: 'am', note: 'Tehran · external' },
  { label: 'Saudi Arabia 9555',    freqKHz:  9555.0, mode: 'am', note: 'BSKSA external · Arabic' },
  { label: 'Voice of Israel',      freqKHz:  9455.0, mode: 'am', note: 'Kol Israel · external · sporadic' },
  { label: 'TRT Voice of Turkey',  freqKHz:  7240.0, mode: 'am', note: 'TRT Ankara · external' },
  { label: 'China Plus 6080',      freqKHz:  6080.0, mode: 'am', note: 'CRI regional English' },
];

/** LATAM-BC — Latin American shortwave broadcasters. Spanish /
 *  Portuguese regional programming, distinct from CRI / VOA / BBC. */
const LATAM_BC_FREQS: FreqPickerEntry[] = [
  { label: 'Radio Habana Cuba 5040',freqKHz:  5040.0, mode: 'am', note: 'Cuba external · English/Spanish' },
  { label: 'Radio Habana 6000',    freqKHz:  6000.0, mode: 'am', note: 'Cuba external' },
  { label: 'Radio Habana 11760',   freqKHz: 11760.0, mode: 'am', note: 'Cuba external · day' },
  { label: 'Radio Aparecida 6135', freqKHz:  6135.0, mode: 'am', note: 'Brazil · religious · also DRM' },
  { label: 'Radio Aparecida 11855',freqKHz: 11855.0, mode: 'am', note: 'Brazil · day' },
  { label: 'Radio Verdad',         freqKHz:  4055.0, mode: 'am', note: 'Guatemala · classic LA DX' },
  { label: 'Voz tu Conciencia',    freqKHz:  6010.0, mode: 'am', note: 'Colombia · evangelical' },
  { label: 'Radio Marumby',        freqKHz:  6080.0, mode: 'am', note: 'Brazil · religious' },
  { label: 'Radio Cancao Nova',    freqKHz:  4825.0, mode: 'am', note: 'Brazil · religious' },
  { label: 'Radio Educacao Rural', freqKHz:  5950.0, mode: 'am', note: 'Brazil · educational' },
  { label: 'Radio Bandeirantes',   freqKHz:  6090.0, mode: 'am', note: 'Brazil · talk' },
  { label: 'Radio Nacional Argentina',freqKHz:6060.0, mode: 'am', note: 'Buenos Aires · domestic' },
  { label: 'RAE Argentina',        freqKHz: 11710.0, mode: 'am', note: 'Argentina · external multilingual' },
  { label: 'Radio Pio XII Bolivia',freqKHz:  5952.0, mode: 'am', note: 'Bolivia · Catholic' },
  { label: 'Radio Cultura Brazil', freqKHz: 17815.0, mode: 'am', note: 'São Paulo · day band' },
];

/** MARPAC — Pacific-specific maritime nets and coast stations,
 *  augmenting MRINE which is global. */
const MARPAC_FREQS: FreqPickerEntry[] = [
  { label: 'AMSA Charleville VMC', freqKHz:  6507.0, mode: 'usb', note: 'Australia · weather / safety' },
  { label: 'AMSA VMC 8176',        freqKHz:  8176.0, mode: 'usb', note: 'Australia · weather' },
  { label: 'AMSA Wiluna VMW',      freqKHz: 12365.0, mode: 'usb', note: 'Australia · day band' },
  { label: 'AMSA Wiluna 16546',    freqKHz: 16546.0, mode: 'usb', note: 'Australia · day band' },
  { label: 'NZ Maritime 6516',     freqKHz:  6516.0, mode: 'usb', note: 'New Zealand · Maritime Radio' },
  { label: 'NZ Maritime 8291',     freqKHz:  8291.0, mode: 'usb', note: 'New Zealand · safety' },
  { label: 'NZ Maritime 12290',    freqKHz: 12290.0, mode: 'usb', note: 'New Zealand · day' },
  { label: 'Tokyo JCS 8195',       freqKHz:  8195.0, mode: 'usb', note: 'Japan · coastal' },
  { label: 'Indonesia maritime',   freqKHz:  4146.0, mode: 'usb', note: 'Jakarta region' },
  { label: 'Pacific maritime calling',freqKHz:14313.0, mode: 'usb', note: 'PMSN · vessel position' },
];

/** MARS-EU — European MARS-equivalent amateur radio societies. */
const MARS_EU_FREQS: FreqPickerEntry[] = [
  { label: 'RNARS net',            freqKHz: 14225.0, mode: 'usb', note: 'Royal Naval ARS (UK)' },
  { label: 'RAFARS 14123',         freqKHz: 14123.0, mode: 'usb', note: 'RAF ARS (UK) primary' },
  { label: 'RAFARS 14135',         freqKHz: 14135.0, mode: 'usb', note: 'RAF ARS alternate' },
  { label: 'BARS 14290',           freqKHz: 14290.0, mode: 'usb', note: 'British Amateur Radio Society' },
  { label: 'DARS 7090',            freqKHz:  7090.0, mode: 'lsb', note: 'German DARS net' },
  { label: 'DARS 14350',           freqKHz: 14350.0, mode: 'usb', note: 'German DARS net' },
  { label: 'NARS 3700',            freqKHz:  3700.0, mode: 'lsb', note: 'Netherlands ARS' },
  { label: 'DBO Swiss 14347',      freqKHz: 14347.0, mode: 'usb', note: 'Swiss military ARS' },
  { label: 'HAMARS HU 7090',       freqKHz:  7090.0, mode: 'lsb', note: 'Hungarian MARS' },
  { label: 'IARC 14270',           freqKHz: 14270.0, mode: 'usb', note: 'Intl ARC worldwide net' },
];

/** HFDM — HF data-modem fixed-station carriers, distinct from STANAG
 *  4285/4538. Includes MIL-STD-188-110A/B and various national HF
 *  data networks (French Navy, Russian Smerch, Iranian, etc.). */
const HFDM_FREQS: FreqPickerEntry[] = [
  { label: 'MIL-110 4045',         freqKHz:  4045.0, mode: 'usb', note: 'MIL-STD-188-110 data' },
  { label: 'MIL-110 6957',         freqKHz:  6957.0, mode: 'usb', note: 'MIL-STD-188-110 data' },
  { label: 'MIL-110 9044',         freqKHz:  9044.0, mode: 'usb', note: 'MIL-STD-188-110 data' },
  { label: 'MIL-141C 6998',        freqKHz:  6998.0, mode: 'usb', note: 'MIL-STD-188-141C' },
  { label: 'French Navy data',     freqKHz:  6435.0, mode: 'usb', note: 'French Navy data link' },
  { label: 'Russian Smerch',       freqKHz:  8345.0, mode: 'usb', note: 'Russian Navy data' },
  { label: 'Iranian data 11270',   freqKHz: 11270.0, mode: 'usb', note: 'Iranian HF data' },
  { label: 'SMG Vatican data',     freqKHz:  5950.0, mode: 'usb', note: 'Vatican data link' },
  { label: 'NATO data 7102',       freqKHz:  7102.0, mode: 'usb', note: 'NATO data carrier' },
  { label: 'HF data 13245',        freqKHz: 13245.0, mode: 'usb', note: 'mixed mil data day' },
];

/** SITOR-A — Maritime SITOR-A interactive (ARQ) calling channels.
 *  Distinct from SITOR-B FEC which is the NAVTEX waveform. */
const SITOR_A_FREQS: FreqPickerEntry[] = [
  { label: 'SITOR-A 4178',         freqKHz:  4178.0, mode: 'usb', note: 'maritime ARQ calling' },
  { label: 'SITOR-A 4195',         freqKHz:  4195.0, mode: 'usb', note: 'maritime ARQ' },
  { label: 'SITOR-A 6263',         freqKHz:  6263.0, mode: 'usb', note: 'maritime ARQ' },
  { label: 'SITOR-A 6315',         freqKHz:  6315.0, mode: 'usb', note: 'maritime ARQ' },
  { label: 'SITOR-A 8425',         freqKHz:  8425.0, mode: 'usb', note: 'maritime ARQ · most active' },
  { label: 'SITOR-A 8438',         freqKHz:  8438.0, mode: 'usb', note: 'maritime ARQ' },
  { label: 'SITOR-A 8443',         freqKHz:  8443.0, mode: 'usb', note: 'maritime ARQ' },
  { label: 'SITOR-A 12477',        freqKHz: 12477.0, mode: 'usb', note: 'maritime ARQ' },
  { label: 'SITOR-A 12579',        freqKHz: 12579.0, mode: 'usb', note: 'maritime ARQ' },
  { label: 'SITOR-A 16678',        freqKHz: 16678.0, mode: 'usb', note: 'maritime ARQ · day band' },
  { label: 'Greek HEC Athens',     freqKHz:  4172.5, mode: 'usb', note: 'Greek coast SITOR-A' },
  { label: 'Russian SITOR-A',      freqKHz:  8431.5, mode: 'usb', note: 'Russian maritime ARQ' },
];

/** AMTOR — Amateur AMTOR / SITOR FEC nets. Mostly historical but a few
 *  channels remain occasionally active. */
const AMTOR_FREQS: FreqPickerEntry[] = [
  { label: 'AMTOR 80 m',           freqKHz:  3625.0, mode: 'usb', note: '80 m AMTOR/SITOR FEC' },
  { label: 'AMTOR 80 m alt',       freqKHz:  3655.0, mode: 'usb', note: '80 m alternate' },
  { label: 'AMTOR 40 m',           freqKHz:  7038.0, mode: 'usb', note: '40 m AMTOR' },
  { label: 'AMTOR 40 m alt',       freqKHz:  7082.0, mode: 'usb', note: '40 m alternate' },
  { label: 'AMTOR 30 m',           freqKHz: 10130.0, mode: 'usb', note: '30 m AMTOR' },
  { label: 'AMTOR 20 m calling',   freqKHz: 14075.0, mode: 'usb', note: '20 m AMTOR calling · primary' },
  { label: 'AMTOR 20 m alt',       freqKHz: 14080.0, mode: 'usb', note: '20 m alternate' },
  { label: 'AMTOR 17 m',           freqKHz: 18106.0, mode: 'usb', note: '17 m AMTOR' },
  { label: 'AMTOR 15 m',           freqKHz: 21080.0, mode: 'usb', note: '15 m AMTOR' },
  { label: 'AMTOR 10 m',           freqKHz: 28090.0, mode: 'usb', note: '10 m AMTOR' },
];

/** S-meter plot horizon — the rolling window of RSSI samples shown. */
const SPLOT_WINDOW_MS = 60_000;
/** Carrier-drift plot horizon — longer than SPLOT because drift is
 *  inherently slow (oscillator drift over minutes, not seconds). */
const DRIFT_WINDOW_MS = 5 * 60_000;

/** Walk an HFDL JSON message and pull out a one-line summary —
 *  timestamp, callsign/ICAO, lat/lon, altitude, peer ground station —
 *  if the PDU carries position data. Returns null when nothing useful
 *  is found (most HFDL frames don't carry positions: squitters,
 *  frequency data, sounds, etc.).
 *
 *  The dumphfdl JSON tree is deeply nested and varies by PDU type, so
 *  we walk recursively looking for known field names rather than
 *  binding to a specific path. That tolerates schema drift across
 *  dumphfdl/libacars versions and across the many HFNPDU variants. */
function summarizeHfdl(msg: unknown): string | null {
  if (!msg || typeof msg !== 'object') return null;
  let lat: number | null = null, lon: number | null = null;
  let alt: number | null = null;
  let icao: string | null = null;
  let flight: string | null = null;
  let regnr: string | null = null;
  let gs: string | null = null;
  // Recursive walk; keys we care about are leaf-level numbers/strings.
  const visit = (o: unknown) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) visit(v); return; }
    const r = o as Record<string, unknown>;
    for (const k in r) {
      const v = r[k];
      // Position fields: dumphfdl uses lat/lon (top-level on pos / location)
      // and sometimes nested under {pos:{lat,lon}}. Accept either spelling.
      if ((k === 'lat' || k === 'latitude') && typeof v === 'number' && lat == null) lat = v;
      else if ((k === 'lon' || k === 'lng' || k === 'longitude') && typeof v === 'number' && lon == null) lon = v;
      else if ((k === 'alt' || k === 'altitude' || k === 'alt_ft') && typeof v === 'number' && alt == null) alt = v;
      else if (k === 'icao' && typeof v === 'string' && icao == null) icao = v;
      else if ((k === 'flight_id' || k === 'flight' || k === 'callsign') && typeof v === 'string' && flight == null) flight = v.trim();
      else if ((k === 'regnr' || k === 'reg' || k === 'tail') && typeof v === 'string' && regnr == null) regnr = v.trim();
      // Ground station name appears at pdu.src.name or pdu.dst.name; the
      // src/dst structure also has a `type` ("ground"/"aircraft") so we
      // can pick the ground one. Easiest: just remember any "name" tied
      // to type=ground, last write wins.
      else if (k === 'name' && typeof v === 'string' && r['type'] === 'Ground station' && gs == null) gs = v;
      visit(v);
    }
  };
  visit(msg);
  if (lat == null || lon == null) return null;
  // Format: [HH:MM:SS UTC] CALLSIGN (ICAO/REG) ##.##°N ##.##°E FL### · GS-name
  const tsec = (() => {
    const t = (msg as Record<string, unknown>).t;
    if (t && typeof t === 'object') {
      const sec = (t as Record<string, unknown>).sec;
      if (typeof sec === 'number') return sec;
    }
    return null;
  })();
  const time = tsec != null ? new Date(tsec * 1000).toISOString().slice(11, 19) : '';
  const id = flight || icao || regnr || '???';
  const idTail = (icao || regnr) && flight ? ` (${icao || regnr})` : '';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const latStr = `${Math.abs(lat).toFixed(3)}°${ns}`;
  const lonStr = `${Math.abs(lon).toFixed(3)}°${ew}`;
  const altStr = alt != null ? ` FL${Math.round(alt / 100)}` : '';
  const gsStr  = gs ? ` · ${gs}` : '';
  return `→ ${time} ${id}${idTail} ${latStr} ${lonStr}${altStr}${gsStr}`;
}

function defaultPassbandFor(mode: Mode): { lowCut: number; highCut: number } {
  const [lowCut, highCut] = DEFAULT_PASSBANDS[mode];
  return { lowCut, highCut };
}

/** Map an AnalyserNode byte (0..255) back to dB inside its configured
 *  minDecibels (-100) .. maxDecibels (-20) range. Used by the auto-notch
 *  detector to compare bin magnitudes in physical units. */
function byteToDb(b: number): number {
  return -100 + (b / 255) * 80;
}

/** In-place radix-2 Cooley-Tukey FFT for any power-of-two length up
 *  to ~64k. Used by the page-5 ZOOM panel for its long-window
 *  sub-Hz spectrogram. */
/** Exponential integral E1(x) = ∫_x^∞ (e^-t / t) dt for x > 0.
 *  Piecewise rational approximation from Abramowitz & Stegun 5.1.53
 *  (small-x series) and 5.1.56 (large-x asymptotic) — accurate to ~5e-5,
 *  more than enough for the MMSE-LSA gain in WUSB/WLSB. */
function expint1(x: number): number {
  if (x <= 0) return 50;             // saturate gain when v ≈ 0
  if (x < 1) {
    // 5.1.53: E1(x) = -ln(x) + Σ a_i x^i, valid for 0 ≤ x ≤ 1
    return -Math.log(x)
      - 0.57721566
      + 0.99999193 * x
      - 0.24991055 * x * x
      + 0.05519968 * x * x * x
      - 0.00976004 * x * x * x * x
      + 0.00107857 * x * x * x * x * x;
  }
  // 5.1.56: x·e^x·E1(x) ≈ num/den
  const x2 = x * x, x3 = x2 * x, x4 = x3 * x;
  const num = x4 + 8.5733287401 * x3 + 18.059016973 * x2 + 8.6347608925 * x + 0.2677737343;
  const den = x4 + 9.5733223454 * x3 + 25.6329561486 * x2 + 21.0996530827 * x + 3.9584969228;
  return (num / den) * Math.exp(-x) / x;
}

function fft32k(re: Float32Array, im: Float32Array): void {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const tRe = cRe * re[i + k + half] - cIm * im[i + k + half];
        const tIm = cRe * im[i + k + half] + cIm * re[i + k + half];
        re[i + k + half] = re[i + k] - tRe;
        im[i + k + half] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

