import { loadPresets, savePresets, type Preset } from './presets';
import { getLogs, clearLogs, type LogEntry } from '../util/log-capture';
import { getToken, setToken } from '../util/auth';

export interface Settings {
  callSign: string;
  /** Free-form location string sent to Kiwi as `SET geoloc=…`; appears
   *  next to the user's name in the server's online-users list. */
  geoLocation: string;
  keepAudioSettings: boolean;
  /** Milliseconds of audio left in the playback queue after a manual
   *  FLUSH. Higher = safer (no underrun) but laggier; lower = snappier
   *  but more likely to glitch on a slow tick. */
  flushKeepMs: number;
  /** When true, duplicated waterfall rows fade between previous and
   *  current bins. When false, duplicates are painted as-is. */
  wfInterpolate: boolean;
  /** Show the Kiwi connection-diagnostic band under the LED panel. */
  showKiwiDiag: boolean;
  fftAveraging: number;          // 0..100 — UI slider; maps to wf_speed
  wfSpeed: number;               // Kiwi waterfall FPS, 0=slowest..4=fastest
  fftAutoNoiseOffset: number;    // dBm offset added when auto-scaling
  fftAutoRangeThreshold: number; // dBm threshold for auto-range
  showPresetsOnDisplay: boolean;
  scanStopOnSquelch: boolean;
  scanIntervalMs: number;
  whisperEnabled: boolean;
  whisperApiKey: string;
  whisperSourceLang: string;     // ISO-639-1 or 'auto' — controlled by FROM button
  whisperTargetLang: string;     // 'none' | ISO-639-1 — controlled by TO button
  whisperChunkSeconds: number;   // 5..60
  whisperMaxMinutes: number;     // 15..60 — auto-stop after this many minutes
  /** OpenAI chat-completion model used by the AI panel (SCRIBE summary
   *  / SID analysis). Speed-for-intelligence trade-off; smaller models
   *  reply in a few seconds, gpt-5 takes 30–90 s. */
  aiModel: string;

  // ── Decoder parameters (persisted between sessions) ───────────────
  // ── CW ──────────────────────────────────────────────────────────
  cwPitch: number;               // sweetspot Hz (200..2500)
  cwWpm: number;                 // initial speed (5..50)
  cwLowerLimit: number;          // adaptive WPM low clamp
  cwUpperLimit: number;          // adaptive WPM high clamp
  cwRange: number;               // ± WPM tracking range
  cwBandwidth: number;           // matched-filter BW Hz (50..500)
  cwMatchedFilter: boolean;
  cwAttack: number;              // 0=fast 1=med 2=slow
  cwDecay: number;
  cwLowercase: boolean;
  cwDashDot: number;             // dash/dot ratio (default 3.0)
  cwUseSOM: boolean;             // self-organising-map decoding

  // ── PSK ─────────────────────────────────────────────────────────
  pskPitch: number;              // sweetspot Hz
  psk31bMode:
    | 'bpsk31' | 'bpsk63' | 'bpsk63f' | 'bpsk125' | 'bpsk250' | 'bpsk500' | 'bpsk1000'
    | 'qpsk31' | 'qpsk63' | 'qpsk125' | 'qpsk250' | 'qpsk500'
    | '8psk125' | '8psk125fl' | '8psk125f'
    | '8psk250' | '8psk250fl' | '8psk250f'
    | '8psk500' | '8psk500f'
    | '8psk1000' | '8psk1000f' | '8psk1200f'
    | 'psk125r' | 'psk250r' | 'psk500r' | 'psk1000r';
  pskAcqSn: number;              // sigsearch S/N threshold (dB)
  pskSearchRange: number;        // ± Hz around pitch for sigsearch

  // ── Olivia ──────────────────────────────────────────────────────
  oliviaCarrierHz: number;
  oliviaSmargin: number;         // search margin in tones (default 8)
  oliviaSinteg: number;          // integration period (default 4)

  // ── MFSK ────────────────────────────────────────────────────────
  mfskMode: 'mfsk4' | 'mfsk8' | 'mfsk11' | 'mfsk16' | 'mfsk22' | 'mfsk31' | 'mfsk32' | 'mfsk64' | 'mfsk128';
  mfskPitchHz: number;

  // ── MT63 ────────────────────────────────────────────────────────
  mt63Mode: '500s' | '500l' | '1000s' | '1000l' | '2000s' | '2000l';
  mt63CarrierHz: number;
  mt63Integration: 'short' | 'long';
  mt63EightBit: boolean;

  // ── FSQ ─────────────────────────────────────────────────────────
  fsqCarrierHz: number;
  fsqBaud: 1.5 | 2 | 3 | 4.5 | 6;

  // ── THOR ────────────────────────────────────────────────────────
  thorMode: 'thor4' | 'thor5' | 'thor8' | 'thor11' | 'thor16' | 'thor22' | 'thor25x4' | 'thor50x1' | 'thor50x2' | 'thor100';
  thorCarrierHz: number;

  // ── DominoEX ────────────────────────────────────────────────────
  dominoexMode: 'dominoex4' | 'dominoex5' | 'dominoex8' | 'dominoex11' | 'dominoex16' | 'dominoex22' | 'dominoex44' | 'dominoex88';
  dominoexCarrierHz: number;

  // ── Contestia ───────────────────────────────────────────────────
  contestiaTones: 4 | 8 | 16 | 32 | 64;
  contestiaBandwidth: 125 | 250 | 500 | 1000 | 2000;
  contestiaCarrierHz: number;

  // ── RTTY ────────────────────────────────────────────────────────
  rttyMarkHz: number;            // 915 default (USB)
  rttySpaceHz: number;           // 1085 default (170 Hz shift)
  rttyBaud: number;              // 45.45 default

  // ── NAVTEX / SITOR-B ────────────────────────────────────────────
  navtexCarrierHz: number;       // audio centre (1900 default)
  navtexMode: 'navtex' | 'sitorb';
}

const KEY = 'radiom.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  callSign: 'radiom',
  geoLocation: '',
  keepAudioSettings: true,
  flushKeepMs: 500,
  wfInterpolate: true,
  showKiwiDiag: true,
  fftAveraging: 80,
  wfSpeed: 2,
  fftAutoNoiseOffset: -2,
  fftAutoRangeThreshold: 5,
  showPresetsOnDisplay: true,
  scanStopOnSquelch: true,
  scanIntervalMs: 3000,
  whisperEnabled: false,
  whisperApiKey: '',
  whisperSourceLang: 'auto',
  whisperTargetLang: 'none',
  whisperChunkSeconds: 15,
  whisperMaxMinutes: 30,
  aiModel: 'gpt-5-mini',
  cwPitch: 800,
  cwWpm: 18,
  cwLowerLimit: 5,
  cwUpperLimit: 50,
  cwRange: 10,
  cwBandwidth: 150,
  cwMatchedFilter: true,
  cwAttack: 1,
  cwDecay: 1,
  cwLowercase: false,
  cwDashDot: 3.0,
  cwUseSOM: false,

  pskPitch: 1000,
  psk31bMode: 'bpsk31',
  pskAcqSn: 9.0,
  pskSearchRange: 200,

  oliviaCarrierHz: 1500,
  oliviaSmargin: 8,
  oliviaSinteg: 4,

  mfskMode: 'mfsk16',
  mfskPitchHz: 1500,

  mt63Mode: '1000l',
  mt63CarrierHz: 1500,
  mt63Integration: 'long',
  mt63EightBit: false,

  fsqCarrierHz: 1500,
  fsqBaud: 3,

  thorMode: 'thor16',
  thorCarrierHz: 1500,

  dominoexMode: 'dominoex16',
  dominoexCarrierHz: 1500,

  contestiaTones: 8,
  contestiaBandwidth: 250,
  contestiaCarrierHz: 1500,

  rttyMarkHz: 915,
  rttySpaceHz: 1085,
  rttyBaud: 45.45,

  navtexCarrierHz: 1900,
  navtexMode: 'navtex',
};

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...raw, whisperEnabled: false };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Lightweight DTO for the Settings → "Kiwi Users" panel. Mirrors
 *  KiwiClient's `KiwiUser` so we don't pull a kiwi-only import in here. */
export interface KiwiUserInfo {
  slot: number;
  name: string;
  geo: string;
  freqKHz: number | null;
  mode: string;
  ext: string;
  idleSec: number | null;
}

export interface SettingsModalOpts {
  current?: Settings;
  /** Returns the latest snapshot of every Kiwi MSG kv key the shell has seen. */
  getStats?: () => Record<string, string>;
  /** Asks the shell to fetch the Kiwi user list. The callback fires
   *  once with the parsed records, or null if the shell can't fulfil
   *  the request (e.g. no active connection). */
  fetchKiwiUsers?: (cb: (users: KiwiUserInfo[] | null) => void) => void;
  onChange: (s: Settings) => void;
  onInstallTry?: () => void;
}

export function openSettingsModal(opts: SettingsModalOpts): void {
  let s: Settings = opts.current ? { ...opts.current } : loadSettings();

  const root = document.createElement('div');
  root.className = 'settings-modal';
  root.innerHTML = `
    <div class="settings-card">
      <div class="settings-bar">
        <button class="btn-close" aria-label="back">&lt;</button>
        <h2>Settings</h2>
        <span class="settings-version">v${__APP_VERSION__}</span>
      </div>
      <div class="settings-body">

        <div class="settings-section">
          <div class="settings-section-title">Display</div>
          <label class="settings-row toggle-row">
            <span>Show Kiwi connection diagnostic band</span>
            <input type="checkbox" id="showKiwiDiag" ${s.showKiwiDiag ? 'checked' : ''} />
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">General Settings</div>
          <label class="settings-row">
            <span>Name or CallSign</span>
            <input type="text" id="callSign" value="${escapeAttr(s.callSign)}" maxlength="40" />
          </label>
          <label class="settings-row">
            <span>Location (sent to Kiwi)</span>
            <input type="text" id="geoLocation" value="${escapeAttr(s.geoLocation)}" maxlength="60"
                   placeholder="e.g. Toronto, Canada" />
          </label>
          <div class="settings-row">
            <button id="installBtn" class="settings-btn">Install as App</button>
            <span id="installHint">Add to your home screen</span>
          </div>
          <div class="settings-row">
            <button id="kiwiUsersBtn" class="settings-btn">Show Kiwi Users</button>
            <span id="kiwiUsersHint">Fetches the connected server's online list</span>
          </div>
          <pre id="kiwiUsersOut" style="margin:4px 0 0;font-size:11px;line-height:1.35;
                white-space:pre-wrap;word-break:break-word;
                max-height:140px;overflow:auto;display:none;
                background:rgba(0,0,0,0.35);border:1px solid #555;border-radius:6px;padding:6px 8px"></pre>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Diagnostics</div>
          <div class="settings-row">
            <button id="showStats" class="settings-btn">Show Kiwi Stats</button>
            <span style="font-size:12px;opacity:0.7">latest value per MSG key</span>
          </div>
          <div class="settings-row">
            <button id="showLogs" class="settings-btn">Show Console Logs</button>
            <span style="font-size:12px;opacity:0.7">last 500 lines · for in-app debugging</span>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Audio Settings</div>
          <label class="settings-row toggle-row">
            <span>Keep Audio Settings</span>
            <input type="checkbox" id="keepAudio" ${s.keepAudioSettings ? 'checked' : ''} />
          </label>
          <label class="settings-row">
            <span>FLUSH keeps last (ms)</span>
            <input type="number" id="flushKeepMs" min="0" max="5000" step="50" value="${s.flushKeepMs}" />
          </label>
          <label class="settings-row toggle-row">
            <span>Waterfall row interpolation</span>
            <input type="checkbox" id="wfInterpolate" ${s.wfInterpolate ? 'checked' : ''} />
          </label>
          <!-- Waterfall FPS now lives on the FPS button in the function row. -->
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Frequency Presets</div>
          <div class="settings-row">
            <button id="presetExport" class="settings-btn">Export</button>
            <span>Frequency Presets to Clipboard</span>
          </div>
          <div class="settings-row">
            <button id="presetImport" class="settings-btn">Import</button>
            <span>Frequency Presets from Clipboard</span>
          </div>
          <label class="settings-row toggle-row">
            <span>Show Frequency Presets on Display</span>
            <input type="checkbox" id="showPresets" ${s.showPresetsOnDisplay ? 'checked' : ''} />
          </label>
          <label class="settings-row toggle-row">
            <span>Scan Stop on Squelch Threshold</span>
            <input type="checkbox" id="scanStop" ${s.scanStopOnSquelch ? 'checked' : ''} />
          </label>
          <label class="settings-row">
            <span>Frequency Scan Interval (s)</span>
            <input type="number" id="scanInt" min="1" max="60" step="1" value="${Math.round(s.scanIntervalMs / 1000)}" />
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">CW Decoder</div>
          <label class="settings-row"><span>Pitch (Hz)</span>
            <input type="number" id="cwPitch" min="200" max="2500" step="10" value="${s.cwPitch}" /></label>
          <label class="settings-row"><span>WPM</span>
            <input type="number" id="cwWpm" min="5" max="50" value="${s.cwWpm}" /></label>
          <label class="settings-row"><span>Lower WPM limit</span>
            <input type="number" id="cwLowerLimit" min="5" max="50" value="${s.cwLowerLimit}" /></label>
          <label class="settings-row"><span>Upper WPM limit</span>
            <input type="number" id="cwUpperLimit" min="5" max="50" value="${s.cwUpperLimit}" /></label>
          <label class="settings-row"><span>WPM tracking range (±)</span>
            <input type="number" id="cwRange" min="0" max="30" value="${s.cwRange}" /></label>
          <label class="settings-row"><span>Bandwidth (Hz)</span>
            <input type="number" id="cwBandwidth" min="50" max="500" step="10" value="${s.cwBandwidth}" /></label>
          <label class="settings-row toggle-row"><span>Matched filter</span>
            <input type="checkbox" id="cwMatchedFilter" ${s.cwMatchedFilter ? 'checked' : ''} /></label>
          <label class="settings-row"><span>Attack (0=fast, 2=slow)</span>
            <input type="number" id="cwAttack" min="0" max="2" value="${s.cwAttack}" /></label>
          <label class="settings-row"><span>Decay (0=fast, 2=slow)</span>
            <input type="number" id="cwDecay" min="0" max="2" value="${s.cwDecay}" /></label>
          <label class="settings-row toggle-row"><span>Lowercase output</span>
            <input type="checkbox" id="cwLowercase" ${s.cwLowercase ? 'checked' : ''} /></label>
          <label class="settings-row"><span>Dash/dot ratio</span>
            <input type="number" id="cwDashDot" min="2.0" max="4.0" step="0.1" value="${s.cwDashDot}" /></label>
          <label class="settings-row toggle-row"><span>SOM decoding</span>
            <input type="checkbox" id="cwUseSOM" ${s.cwUseSOM ? 'checked' : ''} /></label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">PSK Decoder</div>
          <!-- Pitch is fixed at 1000 Hz (fldigi convention). -->
          <label class="settings-row"><span>ACQ S/N threshold (dB)</span>
            <input type="number" id="pskAcqSn" min="0" max="30" step="0.5" value="${s.pskAcqSn}" /></label>
          <label class="settings-row"><span>Search range (± Hz)</span>
            <input type="number" id="pskSearchRange" min="10" max="1000" step="10" value="${s.pskSearchRange}" /></label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">DominoEX Decoder</div>
          <label class="settings-row"><span>Mode</span>
            <select id="dominoexMode">
              ${[['dominoex4','DominoEX-4'],['dominoex5','DominoEX-5'],['dominoex8','DominoEX-8'],['dominoex11','DominoEX-11'],['dominoex16','DominoEX-16'],['dominoex22','DominoEX-22'],['dominoex44','DominoEX-44'],['dominoex88','DominoEX-88']]
                .map(([v,lbl]) => `<option value="${v}" ${s.dominoexMode === v ? 'selected' : ''}>${lbl}</option>`).join('')}
            </select>
          </label>
          <label class="settings-row"><span>Carrier (Hz)</span>
            <input type="number" id="dominoexCarrier" min="500" max="3000" step="10" value="${s.dominoexCarrierHz}" /></label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Contestia Decoder</div>
          <label class="settings-row"><span>Tones</span>
            <select id="contestiaTones">
              ${[4,8,16,32,64].map(v => `<option value="${v}" ${s.contestiaTones === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <label class="settings-row"><span>Bandwidth (Hz)</span>
            <select id="contestiaBandwidth">
              ${[125,250,500,1000,2000].map(v => `<option value="${v}" ${s.contestiaBandwidth === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <label class="settings-row"><span>Carrier (Hz)</span>
            <input type="number" id="contestiaCarrier" min="500" max="3000" step="10" value="${s.contestiaCarrierHz}" /></label>
        </div>

        <!-- THOR section removed: mode is picked via long-press on the
             THOR button, and the carrier is fixed at 1500 Hz (THORBASEFREQ). -->

        <div class="settings-section">
          <div class="settings-section-title">FSQ Decoder</div>
          <label class="settings-row"><span>Carrier (Hz)</span>
            <input type="number" id="fsqCarrier" min="500" max="3000" step="10" value="${s.fsqCarrierHz}" /></label>
          <label class="settings-row"><span>Baud</span>
            <select id="fsqBaud">
              ${[1.5, 2, 3, 4.5, 6].map(b => `<option value="${b}" ${s.fsqBaud === b ? 'selected' : ''}>${b}</option>`).join('')}
            </select>
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">MT63 Decoder</div>
          <!-- Mode (incl. short/long integration suffix) is picked via
               long-press on MT63; carrier fixed at 1500 Hz. -->
          <label class="settings-row toggle-row"><span>8-bit characters</span>
            <input type="checkbox" id="mt63EightBit" ${s.mt63EightBit ? 'checked' : ''} /></label>
        </div>

        <!-- MFSK section removed: mode is picked via long-press on the
             MFSK button, pitch fixed at 1500 Hz (fldigi convention). -->

        <div class="settings-section">
          <div class="settings-section-title">RTTY Decoder</div>
          <label class="settings-row"><span>Mark (Hz)</span>
            <input type="number" id="rttyMark" min="100" max="3000" step="5" value="${s.rttyMarkHz}" /></label>
          <label class="settings-row"><span>Space (Hz)</span>
            <input type="number" id="rttySpace" min="100" max="3000" step="5" value="${s.rttySpaceHz}" /></label>
          <label class="settings-row"><span>Baud</span>
            <input type="number" id="rttyBaud" min="20" max="200" step="0.05" value="${s.rttyBaud}" /></label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">NAVTEX / SITOR-B Decoder</div>
          <label class="settings-row"><span>Audio carrier (Hz)</span>
            <input type="number" id="navtexCarrier" min="500" max="3000" step="10" value="${s.navtexCarrierHz}" /></label>
          <label class="settings-row"><span>Mode</span>
            <select id="navtexMode">
              <option value="navtex" ${s.navtexMode === 'navtex' ? 'selected' : ''}>NAVTEX</option>
              <option value="sitorb" ${s.navtexMode === 'sitorb' ? 'selected' : ''}>SITOR-B</option>
            </select>
          </label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Olivia Decoder</div>
          <label class="settings-row"><span>Carrier (Hz)</span>
            <input type="number" id="oliviaCarrier" min="200" max="3000" step="10" value="${s.oliviaCarrierHz}" /></label>
          <label class="settings-row"><span>Search margin (tones)</span>
            <input type="number" id="oliviaSmargin" min="1" max="32" value="${s.oliviaSmargin}" /></label>
          <label class="settings-row"><span>Integration period</span>
            <input type="number" id="oliviaSinteg" min="1" max="16" value="${s.oliviaSinteg}" /></label>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Backend Access</div>
          <label class="settings-row">
            <span>Server token</span>
            <input type="password" id="backendToken" autocomplete="off" placeholder="(empty = no auth)" value="${escapeAttr(getToken())}" />
          </label>
          <div class="settings-row" style="opacity:0.7">
            <span style="font-size:12px">Bearer token sent on /ws/decode/* upgrades. Must match the server's RADIOM_TOKEN env var. Stored locally only.</span>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Live Transcription (OpenAI Whisper)</div>
          <div class="settings-row" style="opacity:0.7">
            <span style="font-size:12px">Toggle with the TRANSCRIBE button at the bottom of the main interface.</span>
          </div>
          <label class="settings-row">
            <span>OpenAI API Key</span>
            <input type="password" id="whisperKey" autocomplete="off" placeholder="sk-..." value="${escapeAttr(s.whisperApiKey)}" />
          </label>
          <label class="settings-row">
            <span>Chunk seconds (5..60)</span>
            <input type="number" id="whisperChunk" min="5" max="60" step="1" value="${s.whisperChunkSeconds}" />
          </label>
          <label class="settings-row">
            <span>Max transcription time (mins)</span>
            <input type="number" id="whisperMaxMins" min="15" max="60" step="1" value="${s.whisperMaxMinutes}" />
          </label>
          <label class="settings-row">
            <span>AI panel model (SCRIBE / SID)</span>
            <select id="aiModel">
              ${[
                ['gpt-4o-mini', 'gpt-4o-mini — fastest (~3 s)'],
                ['gpt-4o',      'gpt-4o — general (~10 s)'],
                ['gpt-5-mini',  'gpt-5-mini — sweet spot (~20 s)'],
                ['gpt-5',       'gpt-5 — best reasoning (~60 s)'],
                ['gpt-5-pro',   'gpt-5-pro — deepest (~120 s)'],
              ].map(([v, label]) =>
                `<option value="${escapeAttr(v)}"${v === s.aiModel ? ' selected' : ''}>${label}</option>`
              ).join('')}
            </select>
          </label>
          <div class="settings-row" style="opacity:0.7">
            <span style="font-size:12px">~ \$0.006 USD per minute of audio (whisper-1). Key stored locally only.</span>
          </div>
        </div>

      </div>
    </div>
  `;
  document.body.appendChild(root);

  const $ = (id: string) => root.querySelector('#' + id) as HTMLElement;
  const update = () => {
    s = {
      ...s,
      callSign: ($('callSign') as HTMLInputElement).value.trim() || DEFAULT_SETTINGS.callSign,
      geoLocation: ($('geoLocation') as HTMLInputElement).value.trim().slice(0, 60),
      keepAudioSettings: ($('keepAudio') as HTMLInputElement).checked,
      flushKeepMs: (() => {
        const v = parseInt(($('flushKeepMs') as HTMLInputElement).value, 10);
        return Number.isFinite(v) ? Math.max(0, Math.min(5000, v)) : DEFAULT_SETTINGS.flushKeepMs;
      })(),
      wfInterpolate: ($('wfInterpolate') as HTMLInputElement).checked,
      showKiwiDiag: ($('showKiwiDiag') as HTMLInputElement).checked,
      // FFT settings UI was removed; preserve whatever was last persisted.
      fftAveraging: opts.current?.fftAveraging ?? s.fftAveraging,
      wfSpeed: opts.current?.wfSpeed ?? 2,
      fftAutoNoiseOffset: opts.current?.fftAutoNoiseOffset ?? s.fftAutoNoiseOffset,
      fftAutoRangeThreshold: opts.current?.fftAutoRangeThreshold ?? s.fftAutoRangeThreshold,
      showPresetsOnDisplay: ($('showPresets') as HTMLInputElement).checked,
      scanStopOnSquelch: ($('scanStop') as HTMLInputElement).checked,
      scanIntervalMs: clamp(+($('scanInt') as HTMLInputElement).value, 1, 60) * 1000,
      whisperApiKey: ($('whisperKey') as HTMLInputElement).value.trim(),
      // Backend token isn't part of the Settings struct (it isn't synced
      // anywhere); persist it directly via auth.ts so it's available before
      // Settings load on the next page reload.
      ...(() => {
        const tokInput = $('backendToken') as HTMLInputElement | null;
        if (tokInput) setToken(tokInput.value.trim());
        return {};
      })(),
      whisperChunkSeconds: clamp(+($('whisperChunk') as HTMLInputElement).value, 5, 60),
      whisperMaxMinutes: clamp(+($('whisperMaxMins') as HTMLInputElement).value, 15, 60),
      aiModel: ($('aiModel') as HTMLSelectElement).value || DEFAULT_SETTINGS.aiModel,
      cwPitch: clamp(+($('cwPitch') as HTMLInputElement).value, 200, 2500),
      cwWpm: clamp(+($('cwWpm') as HTMLInputElement).value, 5, 50),
      cwLowerLimit: clamp(+($('cwLowerLimit') as HTMLInputElement).value, 5, 50),
      cwUpperLimit: clamp(+($('cwUpperLimit') as HTMLInputElement).value, 5, 50),
      cwRange: clamp(+($('cwRange') as HTMLInputElement).value, 0, 30),
      cwBandwidth: clamp(+($('cwBandwidth') as HTMLInputElement).value, 50, 500),
      cwMatchedFilter: ($('cwMatchedFilter') as HTMLInputElement).checked,
      cwAttack: clamp(+($('cwAttack') as HTMLInputElement).value, 0, 2),
      cwDecay: clamp(+($('cwDecay') as HTMLInputElement).value, 0, 2),
      cwLowercase: ($('cwLowercase') as HTMLInputElement).checked,
      cwDashDot: Math.max(2.0, Math.min(4.0, +($('cwDashDot') as HTMLInputElement).value || 3.0)),
      cwUseSOM: ($('cwUseSOM') as HTMLInputElement).checked,
      pskPitch: 1000,  // fixed (fldigi convention); UI control removed.
      pskAcqSn: Math.max(0, Math.min(30, +($('pskAcqSn') as HTMLInputElement).value || 9)),
      pskSearchRange: clamp(+($('pskSearchRange') as HTMLInputElement).value, 10, 1000),
      oliviaCarrierHz: clamp(+($('oliviaCarrier') as HTMLInputElement).value, 200, 3000),
      oliviaSmargin: clamp(+($('oliviaSmargin') as HTMLInputElement).value, 1, 32),
      oliviaSinteg: clamp(+($('oliviaSinteg') as HTMLInputElement).value, 1, 16),
      rttyMarkHz: clamp(+($('rttyMark') as HTMLInputElement).value, 100, 3000),
      rttySpaceHz: clamp(+($('rttySpace') as HTMLInputElement).value, 100, 3000),
      rttyBaud: Math.max(20, Math.min(200, +($('rttyBaud') as HTMLInputElement).value || 45.45)),
      navtexCarrierHz: clamp(+($('navtexCarrier') as HTMLInputElement).value, 500, 3000),
      navtexMode: (($('navtexMode') as HTMLSelectElement).value === 'sitorb' ? 'sitorb' : 'navtex'),
      // mfskMode is set by the long-press picker; mfskPitchHz fixed at
      // 1500 Hz (fldigi convention).
      mfskMode: opts.current?.mfskMode ?? 'mfsk16',
      mfskPitchHz: 1500,
      // mt63Mode is set by the long-press picker, not exposed in Settings.
      mt63Mode: opts.current?.mt63Mode ?? '1000l',
      // Carrier hardcoded at 1500 Hz; integration is encoded in the mode
      // suffix ('s' / 'l') already, so we mirror it here for downstream
      // code that still reads mt63Integration.
      mt63CarrierHz: 1500,
      mt63Integration: ((opts.current?.mt63Mode ?? '1000l').endsWith('s') ? 'short' : 'long'),
      mt63EightBit: ($('mt63EightBit') as HTMLInputElement).checked,
      fsqCarrierHz: clamp(+($('fsqCarrier') as HTMLInputElement).value, 500, 3000),
      fsqBaud: (() => {
        const v = +($('fsqBaud') as HTMLSelectElement).value;
        const valid = new Set([1.5, 2, 3, 4.5, 6]);
        return (valid.has(v) ? v : 3) as Settings['fsqBaud'];
      })(),
      // thorMode is set by the long-press picker; thorCarrierHz fixed at
      // 1500 Hz (THORBASEFREQ).
      thorMode: opts.current?.thorMode ?? 'thor16',
      thorCarrierHz: 1500,
      dominoexMode: (() => {
        const v = ($('dominoexMode') as HTMLSelectElement).value;
        const valid = new Set(['dominoex4','dominoex5','dominoex8','dominoex11','dominoex16','dominoex22','dominoex44','dominoex88']);
        return (valid.has(v) ? v : 'dominoex16') as Settings['dominoexMode'];
      })(),
      dominoexCarrierHz: clamp(+($('dominoexCarrier') as HTMLInputElement).value, 500, 3000),
      contestiaTones: (() => {
        const v = +($('contestiaTones') as HTMLSelectElement).value;
        return (new Set([4,8,16,32,64]).has(v) ? v : 8) as Settings['contestiaTones'];
      })(),
      contestiaBandwidth: (() => {
        const v = +($('contestiaBandwidth') as HTMLSelectElement).value;
        return (new Set([125,250,500,1000,2000]).has(v) ? v : 250) as Settings['contestiaBandwidth'];
      })(),
      contestiaCarrierHz: clamp(+($('contestiaCarrier') as HTMLInputElement).value, 500, 3000),
    };
    saveSettings(s);
    opts.onChange(s);
  };

  for (const id of [
    // FFT settings inputs were removed; their IDs are no longer in the DOM.
    'callSign','geoLocation','scanInt','backendToken','whisperKey','whisperChunk','whisperMaxMins','aiModel','flushKeepMs',
    'cwPitch','cwWpm','cwLowerLimit','cwUpperLimit','cwRange','cwBandwidth','cwAttack','cwDecay','cwDashDot',
    'pskAcqSn','pskSearchRange',
    'oliviaCarrier','oliviaSmargin','oliviaSinteg',
    'rttyMark','rttySpace','rttyBaud',
    'navtexCarrier','navtexMode',
    'fsqCarrier','fsqBaud',
    'dominoexMode','dominoexCarrier',
    'contestiaTones','contestiaBandwidth','contestiaCarrier',
  ]) {
    $(id).addEventListener('change', update);
  }
  for (const id of ['keepAudio','wfInterpolate','showKiwiDiag','showPresets','scanStop','cwMatchedFilter','cwLowercase','cwUseSOM','mt63EightBit']) {
    $(id).addEventListener('change', update);
  }

  $('presetExport').addEventListener('click', async () => {
    const json = JSON.stringify(loadPresets(), null, 2);
    try { await navigator.clipboard.writeText(json); flash($('presetExport'), 'Copied!'); }
    catch {
      // Fallback: select-all in a textarea
      const ta = document.createElement('textarea');
      ta.value = json; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      flash($('presetExport'), 'Copied!');
    }
  });
  $('showStats').addEventListener('click', () => {
    if (opts.getStats) openStatsViewer(opts.getStats);
  });
  $('showLogs').addEventListener('click', () => openLogsViewer());

  $('presetImport').addEventListener('click', async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); }
    catch { text = prompt('Paste presets JSON:') || ''; }
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as Preset[];
      if (Array.isArray(parsed)) { savePresets(parsed); flash($('presetImport'), `Imported ${parsed.length}`); }
    } catch { flash($('presetImport'), 'Invalid JSON', true); }
  });

  // Install button — always visible. Behavior depends on platform:
  // - Chrome/Edge with a captured beforeinstallprompt → native prompt
  // - Already-installed → "Already installed"
  // - iOS Safari / others → instructions
  const ib = $('installBtn') as HTMLButtonElement;
  const ih = $('installHint') as HTMLSpanElement;
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (isStandalone) {
    ib.disabled = true;
    ib.textContent = 'Installed';
    ih.textContent = 'You\'re running the installed app';
  } else if (isIOS) {
    ih.textContent = 'iOS: Share → Add to Home Screen';
  } else if (!opts.onInstallTry) {
    ih.textContent = 'Open in Chrome / Edge — then revisit this menu';
  }
  ib.addEventListener('click', () => {
    if (isStandalone) return;
    if (opts.onInstallTry) {
      opts.onInstallTry();
    } else if (isIOS) {
      ih.textContent = 'Tap Safari\'s share icon, then "Add to Home Screen"';
    } else {
      ih.textContent = 'Use your browser\'s install option (often in the address bar)';
    }
  });

  // ── Kiwi user-list fetcher ──
  const ku = $('kiwiUsersBtn') as HTMLButtonElement;
  const kuOut = $('kiwiUsersOut') as HTMLPreElement;
  ku.addEventListener('click', () => {
    if (!opts.fetchKiwiUsers) {
      kuOut.style.display = '';
      kuOut.textContent = 'No fetch hook available.';
      return;
    }
    ku.disabled = true; ku.textContent = 'Fetching…';
    kuOut.style.display = '';
    kuOut.textContent = '…';
    let done = false;
    const finish = (text: string) => {
      if (done) return;
      done = true;
      ku.disabled = false; ku.textContent = 'Show Kiwi Users';
      kuOut.textContent = text;
    };
    // 5 s safety in case the server never replies (e.g. socket dropped
    // between request and response).
    const tmo = setTimeout(() => finish('No reply from server (timed out).'), 5000);
    opts.fetchKiwiUsers((users) => {
      clearTimeout(tmo);
      if (!users) { finish('Not connected — power on the receiver first.'); return; }
      if (users.length === 0) { finish('Server reports zero users online.'); return; }
      // Render every field for every slot — one record per block.
      const lines: string[] = [`${users.length} user${users.length === 1 ? '' : 's'} online`, ''];
      for (const u of users) {
        const f = u.freqKHz != null ? u.freqKHz.toFixed(3) + ' kHz' : '—';
        const idle = u.idleSec != null ? u.idleSec + ' s' : '—';
        lines.push(`#${u.slot}  ${u.name || '(anon)'}`);
        lines.push(`    geo:   ${u.geo  || '—'}`);
        lines.push(`    freq:  ${f}`);
        lines.push(`    mode:  ${u.mode || '—'}`);
        lines.push(`    ext:   ${u.ext  || '—'}`);
        lines.push(`    idle:  ${idle}`);
        lines.push('');
      }
      finish(lines.join('\n').trimEnd());
    });
  });

  (root.querySelector('.btn-close') as HTMLButtonElement).addEventListener('click', close);
  function close() { root.remove(); }
}

export const LANGS_SRC: Array<[string, string]> = [
  ['auto','Auto-detect'], ['en','English'], ['fr','French'], ['es','Spanish'],
  ['de','German'], ['it','Italian'], ['pt','Portuguese'], ['nl','Dutch'],
  ['ru','Russian'], ['pl','Polish'], ['ja','Japanese'], ['zh','Chinese'],
  ['ko','Korean'], ['ar','Arabic'], ['hi','Hindi'], ['tr','Turkish'],
];
export const LANGS_DST: Array<[string, string]> = [
  ['none','No Translation'], ['en','English'], ['fr','French'], ['es','Spanish'],
  ['de','German'], ['it','Italian'], ['pt','Portuguese'], ['ja','Japanese'],
  ['zh','Chinese'],
];

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function flash(el: HTMLElement, text: string, error = false): void {
  const orig = el.textContent || '';
  el.textContent = text;
  el.style.color = error ? '#f04e3a' : '#2ecc71';
  setTimeout(() => { el.textContent = orig; el.style.color = ''; }, 1500);
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

/** Floating panel showing the latest value of every Kiwi MSG kv key.
 *  Refreshes every second while open; tap outside to close. */
function openStatsViewer(getStats: () => Record<string, string>): void {
  const root = document.createElement('div');
  root.className = 'band-modal stats-modal';
  root.innerHTML = `
    <div class="stats-card">
      <div class="stats-bar">
        <h3>Kiwi MSG keys (last value)</h3>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="settings-btn" id="statsCopy" type="button" style="padding:4px 10px;font-size:11px">Copy</button>
          <button class="stats-close" aria-label="close">✕</button>
        </div>
      </div>
      <div class="stats-list"></div>
    </div>
  `;
  document.body.appendChild(root);
  const list = root.querySelector('.stats-list') as HTMLElement;
  const copyBtn = root.querySelector('#statsCopy') as HTMLButtonElement;

  const render = () => {
    const kv = getStats();
    const keys = Object.keys(kv).sort();
    if (keys.length === 0) {
      list.innerHTML = '<div class="stats-empty">No MSG yet — power on a receiver.</div>';
      return;
    }
    list.innerHTML = keys.map(k => {
      const v = kv[k] ?? '';
      const trim = v.length > 200 ? v.slice(0, 197) + '…' : v;
      return `<div class="stats-row"><span class="stats-key">${escapeAttr(k)}</span><span class="stats-val">${escapeAttr(trim)}</span></div>`;
    }).join('');
  };
  render();
  const tick = setInterval(render, 1000);

  copyBtn.addEventListener('click', async () => {
    const kv = getStats();
    const keys = Object.keys(kv).sort();
    const text = keys.length === 0
      ? '(no MSG kv yet)'
      : keys.map(k => `${k} = ${kv[k] ?? ''}`).join('\n');
    let ok = false;
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall through */ }
    }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    copyBtn.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
  });

  const close = () => { clearInterval(tick); root.remove(); };
  (root.querySelector('.stats-close') as HTMLButtonElement).addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
}

/** Floating panel showing the captured console output (last ~500 lines).
 *  Refreshes every 500 ms while open. Has Copy / Clear / × controls. */
function openLogsViewer(): void {
  const root = document.createElement('div');
  root.className = 'band-modal stats-modal logs-modal';
  root.innerHTML = `
    <div class="stats-card">
      <div class="stats-bar">
        <h3>Console logs</h3>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="settings-btn" id="logsCopy" type="button" style="padding:4px 10px;font-size:11px">Copy</button>
          <button class="settings-btn" id="logsClear" type="button" style="padding:4px 10px;font-size:11px">Clear</button>
          <button class="stats-close" aria-label="close">✕</button>
        </div>
      </div>
      <div class="stats-list logs-list"></div>
    </div>
  `;
  document.body.appendChild(root);
  const list = root.querySelector('.logs-list') as HTMLElement;

  const fmt = (e: LogEntry) => {
    const t = new Date(e.ts).toLocaleTimeString();
    return `<div class="logs-row logs-${e.level}"><span class="logs-ts">${t}</span><span class="logs-lvl">${e.level}</span><span class="logs-msg">${escapeAttr(e.msg)}</span></div>`;
  };
  let lastCount = -1;
  const render = () => {
    const entries = getLogs();
    if (entries.length === lastCount) return;
    lastCount = entries.length;
    if (entries.length === 0) {
      list.innerHTML = '<div class="stats-empty">No logs captured yet.</div>';
      return;
    }
    list.innerHTML = entries.map(fmt).join('');
    list.scrollTop = list.scrollHeight;
  };
  render();
  const tick = setInterval(render, 500);

  const close = () => { clearInterval(tick); root.remove(); };
  (root.querySelector('.stats-close') as HTMLButtonElement).addEventListener('click', close);
  (root.querySelector('#logsCopy') as HTMLButtonElement).addEventListener('click', async () => {
    const text = getLogs().map(e => `${new Date(e.ts).toISOString()} ${e.level} ${e.msg}`).join('\n');
    try { await navigator.clipboard.writeText(text); flash(root.querySelector('#logsCopy') as HTMLElement, 'Copied!'); }
    catch { flash(root.querySelector('#logsCopy') as HTMLElement, 'Copy failed', true); }
  });
  (root.querySelector('#logsClear') as HTMLButtonElement).addEventListener('click', () => {
    clearLogs(); lastCount = -1; render();
  });
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
}
