export type Mode =
  | 'am'  | 'amn' | 'amw'
  | 'cw'  | 'cwn'
  | 'drm'
  | 'iq'
  | 'lsb' | 'lsn'
  | 'nbfm'| 'nnfm'
  | 'wfm'
  | 'qam'
  | 'sal' | 'sam' | 'sas' | 'sau'
  | 'usb' | 'usn';

export interface TuneParams {
  mode: Mode;
  freqKHz: number;
  lowCutHz: number;
  highCutHz: number;
}

export interface AudioFrame {
  seq: number;
  smeter: number;
  rssiDbm: number;
  flags: number;
  /** raw payload after header — int16 BE PCM if !adpcm, else ADPCM nibbles */
  payload: Uint8Array;
  adpcm: boolean;
}

export interface WaterfallFrame {
  xBinServer: number;
  flags: number;
  seq: number;
  /** one byte per FFT bin; convert to dBm via dbmFromByte() */
  bins: Uint8Array;
}

export interface KiwiStatus {
  connected: boolean;
  audioRate?: number;
  sampleRate?: number;
  centerFreq?: number;
  bandwidth?: number;
  version?: string;
  message?: string;
}

export interface KiwiHandlers {
  onStatus?: (s: KiwiStatus) => void;
  onMessage?: (kv: Record<string, string>) => void;
  onAudio?: (f: AudioFrame) => void;
  onWaterfall?: (f: WaterfallFrame) => void;
  onError?: (err: Error) => void;
  onClose?: () => void;
}

/** Rough conversion — KiwiSDR sends 1 byte/bin where 0..255 maps to a dBm range
 *  bounded by mindb/maxdb the client requested. With defaults maxdb=-10, mindb=-110:
 *    dBm ≈ mindb + (byte / 255) * (maxdb - mindb)
 */
export function dbmFromByte(b: number, mindb = -110, maxdb = -10): number {
  return mindb + (b / 255) * (maxdb - mindb);
}
