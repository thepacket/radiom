/** Live transcription/translation via OpenAI Whisper API.
 *
 *  Audio (12 kHz int16 PCM from the Kiwi) is buffered into chunks and POSTed
 *  to /v1/audio/transcriptions. Optional follow-up translation goes through
 *  /v1/chat/completions for non-English targets. Cost is roughly $0.006/min
 *  of audio (whisper-1) plus a fraction of a cent per chunk for translation.
 */

export interface WhisperOptions {
  apiKey: string;
  /** ISO-639-1 code, or "auto". */
  sourceLang: string;
  /** "none" = transcribe only; "en" uses Whisper's translation endpoint;
   *  other codes use a follow-up chat translation. */
  targetLang: string;
  chunkSeconds?: number;
  onText?: (line: string) => void;
  onError?: (err: Error) => void;
  onStatus?: (status: 'idle' | 'recording' | 'sending' | 'error') => void;
}

const DEFAULT_CHUNK = 15;
const SAMPLE_RATE = 12000;

/** Whisper's verbose_json reports language as a full lowercased name
 *  ("english", "french", …) while UI settings carry ISO-639-1 codes
 *  ("en", "fr", …). Map the names whisper-1 actually emits to codes. */
const LANG_NAME_TO_CODE: Record<string, string> = {
  english: 'en', french: 'fr', spanish: 'es', german: 'de', italian: 'it',
  portuguese: 'pt', dutch: 'nl', russian: 'ru', polish: 'pl', japanese: 'ja',
  chinese: 'zh', korean: 'ko', arabic: 'ar', hindi: 'hi', turkish: 'tr',
};
function langNameToCode(name: string): string {
  const n = name.toLowerCase().trim();
  return LANG_NAME_TO_CODE[n] ?? n;
}

export class WhisperTranscriber {
  private buffer: Int16Array;
  private bufLen = 0;
  private opts: WhisperOptions;
  private chunkSamples: number;
  private inFlight = false;
  /** Set after the first successful transcription so we only emit the
   *  "(detected language: …)" header once per WhisperTranscriber instance. */
  private langReported = false;

  constructor(opts: WhisperOptions) {
    this.opts = opts;
    this.chunkSamples = SAMPLE_RATE * (opts.chunkSeconds ?? DEFAULT_CHUNK);
    this.buffer = new Int16Array(this.chunkSamples);
  }

  setOptions(opts: Partial<WhisperOptions>) {
    this.opts = { ...this.opts, ...opts };
    if (opts.chunkSeconds && opts.chunkSeconds !== (this.opts.chunkSeconds ?? DEFAULT_CHUNK)) {
      this.chunkSamples = SAMPLE_RATE * opts.chunkSeconds;
      this.buffer = new Int16Array(this.chunkSamples);
      this.bufLen = 0;
    }
  }

  /** Feed raw int16 samples (12 kHz mono). */
  feed(samples: Int16Array): void {
    if (!this.opts.apiKey) return;
    const room = this.chunkSamples - this.bufLen;
    if (samples.length <= room) {
      this.buffer.set(samples, this.bufLen);
      this.bufLen += samples.length;
    } else {
      this.buffer.set(samples.subarray(0, room), this.bufLen);
      this.bufLen = this.chunkSamples;
    }
    if (this.bufLen >= this.chunkSamples) this.flush();
  }

  /** Force-send whatever is buffered (called on disable / disconnect). */
  flush(): void {
    if (this.inFlight || this.bufLen < SAMPLE_RATE) return;  // need ≥ 1 s
    const chunk = this.buffer.slice(0, this.bufLen);
    this.bufLen = 0;
    this.transcribe(chunk).catch(e => this.opts.onError?.(e as Error));
  }

  private async transcribe(chunk: Int16Array): Promise<void> {
    this.inFlight = true;
    this.opts.onStatus?.('sending');
    try {
      const wav = encodeWav(chunk, SAMPLE_RATE);
      const fd = new FormData();
      fd.append('file', wav, 'audio.wav');
      fd.append('model', 'whisper-1');
      // Use verbose_json so the response includes the detected source
      // language; we show it once at the start of the transcription so
      // the operator knows which language Whisper auto-picked.
      fd.append('response_format', 'verbose_json');
      // Always use /transcriptions so we get the detected source language
      // back. When a non-source target is needed (including English), the
      // translation step below runs gpt-4o-mini over the source text. The
      // /translations endpoint is avoided — it locks output to English and
      // doesn't report the detected source.
      const url = 'https://api.openai.com/v1/audio/transcriptions';
      if (this.opts.sourceLang && this.opts.sourceLang !== 'auto') {
        fd.append('language', this.opts.sourceLang);
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: fd,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Whisper ${res.status}: ${body.slice(0, 200)}`);
      }
      const payload = await res.json() as { text?: string; language?: string };
      let text = (payload.text ?? '').trim();
      // Whisper emits the language as a full name ("english", "spanish");
      // settings carry ISO codes. Normalize so the equality check below is
      // not always false.
      const detectedLangCode = langNameToCode(payload.language ?? '');
      // Translate only when the target differs from the source. If the
      // operator chose an explicit source we trust it; otherwise we use
      // the detected language to decide whether translation is needed.
      const effectiveSource = (this.opts.sourceLang && this.opts.sourceLang !== 'auto')
        ? this.opts.sourceLang
        : detectedLangCode;
      if (text && this.opts.targetLang !== 'none'
          && this.opts.targetLang !== effectiveSource) {
        text = await this.translateText(text, this.opts.targetLang);
      }
      // Emit a one-shot "(detected language: …)" header at the start of
      // the transcription so the operator can see which language Whisper
      // auto-picked. Skipped when sourceLang was explicitly set (the
      // operator already knows) or when /translations was used (the
      // translations endpoint doesn't report the source language).
      if (text && !this.langReported) {
        this.langReported = true;
        // Prefer the human-readable name Whisper returned; fall back to
        // the operator's explicit source code if no detection was reported.
        const lang = (payload.language ?? '').trim()
          || (this.opts.sourceLang && this.opts.sourceLang !== 'auto' ? this.opts.sourceLang : '');
        if (lang) {
          this.opts.onText?.(`(detected language: ${lang})`);
        }
      }
      if (text) this.opts.onText?.(text);
      this.opts.onStatus?.('idle');
    } catch (e) {
      this.opts.onError?.(e as Error);
      this.opts.onStatus?.('error');
    } finally {
      this.inFlight = false;
    }
  }

  /** Translate transcribed text to a non-English target via gpt-4o-mini. */
  private async translateText(text: string, lang: string): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `Translate the user's text to ${lang}. Output only the translation.` },
          { role: 'user', content: text },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Translate ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json() as { choices: Array<{ message: { content: string } }> };
    return j.choices?.[0]?.message?.content?.trim() ?? text;
  }
}

/** Pack int16 mono PCM into a WAV blob. */
function encodeWav(samples: Int16Array, sampleRate: number): Blob {
  const dataLen = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  let p = 0;
  const writeStr = (s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(p++, s.charCodeAt(i)); };
  writeStr('RIFF');         v.setUint32(p, 36 + dataLen, true); p += 4;
  writeStr('WAVE');
  writeStr('fmt ');         v.setUint32(p, 16, true); p += 4;
  v.setUint16(p, 1, true);  p += 2;            // PCM
  v.setUint16(p, 1, true);  p += 2;            // mono
  v.setUint32(p, sampleRate, true); p += 4;
  v.setUint32(p, sampleRate * 2, true); p += 4;
  v.setUint16(p, 2, true);  p += 2;
  v.setUint16(p, 16, true); p += 2;
  writeStr('data');         v.setUint32(p, dataLen, true); p += 4;
  // sample data (already int16 little-endian on most platforms via DataView)
  for (let i = 0; i < samples.length; i++, p += 2) v.setInt16(p, samples[i], true);
  return new Blob([buf], { type: 'audio/wav' });
}
