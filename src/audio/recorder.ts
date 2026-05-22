/** In-memory chunk buffer that captures live 12 kHz int16 mono PCM and,
 *  on stop, emits a WAV Blob. Storage is IndexedDB. */

const SAMPLE_RATE = 12000;

export interface RecordingMeta {
  id: number;
  ts: number;          // unix ms
  durationSec: number;
  bytes: number;       // WAV blob size
  freqKHz: number;
  mode: string;
  server: string;
}

export class Recorder {
  private chunks: Int16Array[] = [];
  private samples = 0;            // total int16 values written (mono samples or stereo L+R pairs × 2)
  private active = false;
  private channels: 1 | 2 = 1;

  /** Start capturing. `channels` is 1 for mono audio or 2 for stereo
   *  IQ (interleaved L=I, R=Q). */
  start(channels: 1 | 2 = 1): void {
    this.chunks = [];
    this.samples = 0;
    this.channels = channels;
    this.active = true;
  }

  /** Feed already-native-endian int16 PCM. For stereo, the buffer must
   *  be interleaved L,R,L,R… and have an even length. */
  feed(s: Int16Array): void {
    if (!this.active) return;
    // copy: the player reuses its scratch buffer between frames
    const c = new Int16Array(s.length);
    c.set(s);
    this.chunks.push(c);
    this.samples += s.length;
  }

  isActive(): boolean { return this.active; }

  /** Seconds of audio captured so far. */
  durationSec(): number { return this.samples / (SAMPLE_RATE * this.channels); }

  /** Stop capture and return a WAV blob. Returns null if no audio. */
  stop(): Blob | null {
    if (!this.active) return null;
    this.active = false;
    if (this.samples === 0) return null;

    const flat = new Int16Array(this.samples);
    let p = 0;
    for (const c of this.chunks) { flat.set(c, p); p += c.length; }
    this.chunks = [];
    return encodeWav(flat, SAMPLE_RATE, this.channels);
  }
}

/** Pack int16 PCM into a WAV blob. Supports mono or stereo (channels = 1 or 2). */
function encodeWav(samples: Int16Array, sampleRate: number, channels: 1 | 2 = 1): Blob {
  const dataLen = samples.length * 2;
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  let p = 0;
  const writeStr = (s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); };
  writeStr('RIFF');         v.setUint32(p, 36 + dataLen, true); p += 4;
  writeStr('WAVE');
  writeStr('fmt ');         v.setUint32(p, 16, true); p += 4;
  v.setUint16(p, 1, true);  p += 2;                   // PCM
  v.setUint16(p, channels, true);  p += 2;
  v.setUint32(p, sampleRate, true); p += 4;
  v.setUint32(p, byteRate, true);   p += 4;
  v.setUint16(p, blockAlign, true); p += 2;
  v.setUint16(p, 16, true); p += 2;
  writeStr('data');         v.setUint32(p, dataLen, true); p += 4;
  for (let i = 0; i < samples.length; i++, p += 2) v.setInt16(p, samples[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}

/* ─────────────── IndexedDB store ─────────────── */

const DB_NAME = 'radiom-recordings';
const DB_VERSION = 1;
const STORE = 'recordings';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

interface StoredRow extends RecordingMeta {
  blob: Blob;
}

export async function saveRecording(blob: Blob, info: Omit<RecordingMeta, 'id' | 'bytes' | 'ts'>): Promise<number> {
  const db = await openDB();
  return new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const row: Omit<StoredRow, 'id'> = {
      ts: Date.now(),
      durationSec: info.durationSec,
      bytes: blob.size,
      freqKHz: info.freqKHz,
      mode: info.mode,
      server: info.server,
      blob,
    };
    const req = tx.objectStore(STORE).add(row);
    req.onsuccess = () => resolve(req.result as number);
    req.onerror = () => reject(req.error);
  });
}

export async function listRecordings(): Promise<RecordingMeta[]> {
  const db = await openDB();
  return new Promise<RecordingMeta[]>((resolve, reject) => {
    const out: RecordingMeta[] = [];
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { resolve(out); return; }
      const r = c.value as StoredRow;
      out.push({ id: r.id, ts: r.ts, durationSec: r.durationSec, bytes: r.bytes, freqKHz: r.freqKHz, mode: r.mode, server: r.server });
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getRecordingBlob(id: number): Promise<Blob | null> {
  const db = await openDB();
  return new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => {
      const r = req.result as StoredRow | undefined;
      resolve(r?.blob ?? null);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRecording(id: number): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
