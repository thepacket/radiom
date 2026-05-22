// Production server for radiom.
//
//   • Serves the built SPA from ./dist (immutable hashed assets cached hard,
//     index.html / sw.js no-cache).
//   • Reverse-proxies WebSocket upgrades on /ws/{host}:{port}/<path> to the
//     plain ws:// upstream Kiwi, mirroring vite.config.ts's kiwiWsProxy so
//     the browser can connect over wss:// without mixed-content errors.
//   • Reverse-proxies /api/kiwi-public and /api/kiwi-rx for the live server
//     list refresh (kiwisdr.com sends no CORS headers).

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { CWDecoder } from './decoder/cw.mjs';
import { RTTYDecoder } from './decoder/rtty.mjs';
import { PSKDecoder } from './decoder/psk.mjs';
import { WefaxDecoder } from './decoder/wefax.mjs';
import { RsidDecoder } from './decoder/rsid.mjs';
import { PacketDecoder } from './decoder/packet.mjs';
import { WsprDecoder } from './decoder/wspr.mjs';
import { Wspr15Decoder } from './decoder/wspr15.mjs';
import { Jt9Decoder } from './decoder/jt9.mjs';
import { Jt65Decoder } from './decoder/jt65.mjs';
import { Q65Decoder } from './decoder/q65.mjs';
import { Jt4Decoder } from './decoder/jt4.mjs';
import { Fst4wDecoder } from './decoder/fst4w.mjs';
import { SstvDecoder } from './decoder/sstv.mjs';
import { FreedvDecoder } from './decoder/freedv.mjs';
import { SelcalDecoder } from './decoder/selcal.mjs';
import { PocsagDecoder } from './decoder/pocsag.mjs';
import { Js8Decoder }  from './decoder/js8.mjs';
import { Fst4Decoder } from './decoder/fst4.mjs';
import { NAVTEXDecoder } from './decoder/navtex.mjs';
import { ALE2GDecoder } from './decoder/ale-2g.mjs';
import { HFDLDecoder } from './decoder/hfdl.mjs';
import { PSKFldigiDecoder } from './decoder/psk-fldigi.mjs';
import { OliviaFldigiDecoder } from './decoder/olivia-fldigi.mjs';
import { MfskFldigiDecoder } from './decoder/mfsk-fldigi.mjs';
import { ThrobFldigiDecoder } from './decoder/throb-fldigi.mjs';
import { Mt63FldigiDecoder } from './decoder/mt63-fldigi.mjs';
import { FsqFldigiDecoder } from './decoder/fsq-fldigi.mjs';
import { ThorFldigiDecoder } from './decoder/thor-fldigi.mjs';
import { DominoexFldigiDecoder } from './decoder/dominoex-fldigi.mjs';
import { RttyFldigiDecoder } from './decoder/rtty-fldigi.mjs';
import { ContestiaFldigiDecoder } from './decoder/contestia-fldigi.mjs';
import { WwvFldigiDecoder } from './decoder/wwv-fldigi.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Belt-and-suspenders: keep the server alive when a decoder subprocess
// throws an ENOENT (missing binary) or some other 'error' event slips
// past a per-decoder handler. Without these handlers, one bad decoder
// (e.g. wsprd missing from the local dev build) takes down the whole
// node process and every other endpoint goes 502 with it.
process.on('uncaughtException', (err) => {
  console.error('[radiom] uncaughtException:', err && err.message, err && err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[radiom] unhandledRejection:', reason);
});
const DIST = path.join(__dirname, 'dist');
const AUDIO = path.join(__dirname, 'audio');
const PORT = +(process.env.PORT || 8080);

// ── /ws/decode/* access control ──────────────────────────────────────────
// Shared bearer token. When empty, the endpoint is open (dev / self-host).
// When set, clients must include `?token=<RADIOM_TOKEN>` on the WS URL.
const RADIOM_TOKEN = (process.env.RADIOM_TOKEN || '').trim();
// Comma-separated allow-list of acceptable Origin headers. Empty = any
// origin (useful for native / curl clients that don't send Origin at all).
// Supports both exact match and `.suffix` substring match.
const ALLOWED_ORIGINS = (process.env.RADIOM_ALLOWED_ORIGINS || '').trim()
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_WS_PER_IP = +(process.env.RADIOM_MAX_WS_PER_IP || 4);
const MAX_WS_GLOBAL = +(process.env.RADIOM_MAX_WS_GLOBAL || 32);

if (!RADIOM_TOKEN) {
  console.warn('[auth] RADIOM_TOKEN not set — /ws/decode/* is OPEN. Set RADIOM_TOKEN in env to require a bearer token.');
}

// Live counters. Both are decremented from the socket 'close' listener
// attached in guardDecoderUpgrade.
const wsByIp = new Map();
let wsGlobal = 0;

function clientIp(req) {
  // Behind fly.io the real client IP is in Fly-Client-IP. Fall back to
  // X-Forwarded-For (first hop) and then the raw remote address for
  // local dev.
  return (
    (req.headers['fly-client-ip'] || '').trim() ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    ''
  );
}

/** Validate a /ws/decode/* upgrade and, on success, register the socket in
 *  the per-IP / global counters (decremented on socket close). Returns a
 *  { code, text } error to reject the upgrade, or `null` to allow. */
function guardDecoderUpgrade(req, socket) {
  if (ALLOWED_ORIGINS.length) {
    const origin = (req.headers.origin || '').trim();
    const ok = origin && ALLOWED_ORIGINS.some(o =>
      o === origin || (o.startsWith('.') && origin.endsWith(o))
    );
    if (!ok) return { code: 403, text: 'Forbidden Origin' };
  }
  if (RADIOM_TOKEN) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    if ((q.get('token') || '') !== RADIOM_TOKEN) {
      return { code: 401, text: 'Unauthorized' };
    }
  }
  if (wsGlobal >= MAX_WS_GLOBAL) return { code: 503, text: 'Too Many Decoders' };
  const ip = clientIp(req);
  if ((wsByIp.get(ip) || 0) >= MAX_WS_PER_IP) return { code: 429, text: 'Too Many Requests' };
  // Reserve the slot now; release on socket close. Counters use the raw
  // tcp socket rather than the WS instance so we don't have to plumb the
  // tracker through every per-decoder attach callback.
  wsByIp.set(ip, (wsByIp.get(ip) || 0) + 1);
  wsGlobal++;
  socket.once('close', () => {
    const n = (wsByIp.get(ip) || 1) - 1;
    if (n <= 0) wsByIp.delete(ip); else wsByIp.set(ip, n);
    wsGlobal--;
  });
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map':  'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
};

function sendAudio(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath.replace(/^\/audio\/?/, '');
  const abs = path.normalize(path.join(AUDIO, rel));
  if (!abs.startsWith(AUDIO) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(abs).pipe(res);
}

// ── /api/propagation — solar / band-conditions feed.
// Fetches Paul Herrman / N0NBH's public XML at hamqsl.com (refreshed by
// NOAA SWPC every ~3 hours), parses to JSON, caches for 30 min so
// repeated client opens don't hammer the upstream.
let propagationCache = { data: null, ts: 0, etag: '' };
const PROPAGATION_TTL_MS = 30 * 60 * 1000;

async function fetchPropagationXml() {
  const r = await fetch('https://www.hamqsl.com/solarxml.php', {
    headers: { 'User-Agent': 'radiom/0.3 (https://github.com/-)' },
  });
  if (!r.ok) throw new Error(`hamqsl ${r.status}`);
  return r.text();
}

function parsePropagationXml(xml) {
  const tag = (name) => {
    const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
    return m ? m[1].trim() : '';
  };
  const num = (name) => { const t = tag(name); const n = parseFloat(t); return Number.isFinite(n) ? n : null; };
  // <band name="80m-40m" time="day">Poor</band>
  const bands = [];
  const bandRe = /<band\s+name="([^"]+)"\s+time="([^"]+)">([^<]*)<\/band>/gi;
  let m;
  while ((m = bandRe.exec(xml))) bands.push({ band: m[1], time: m[2], cond: m[3].trim() });
  // <phenomenon name="E-Skip" location="europe">Band Closed</phenomenon>
  const vhf = [];
  const phRe = /<phenomenon\s+name="([^"]+)"\s+location="([^"]+)">([^<]*)<\/phenomenon>/gi;
  while ((m = phRe.exec(xml))) vhf.push({ name: m[1], location: m[2], cond: m[3].trim() });
  return {
    source:        tag('source'),
    updated:       tag('updated'),
    solarflux:     num('solarflux'),
    aindex:        num('aindex'),
    kindex:        num('kindex'),
    sunspots:      num('sunspots'),
    xray:          tag('xray'),
    heliumline:    num('heliumline'),
    protonflux:    num('protonflux'),
    electronflux: num('electonflux'),    // upstream typo preserved as-is
    aurora:        num('aurora'),
    solarwind:     num('solarwind'),
    magneticfield: num('magneticfield'),
    geomagfield:   tag('geomagfield'),
    signalnoise:   tag('signalnoise'),
    muf:           tag('muf'),
    bands,
    vhf,
  };
}

/** Serve the SID signal-fingerprint table. Read fresh on every request
 *  while we're tuning thresholds; switch to a TTL cache once the table
 *  stabilizes. */
function sendFingerprints(res) {
  try {
    const txt = fs.readFileSync(path.join(__dirname, 'decoders/fingerprints.json'), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(txt);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'fingerprints read failed: ' + e.message }));
  }
}

/** Proxy + 60-second cache for PSK Reporter reception reports.
 *  Query: ?freqKHz=14074&halfBandKHz=5&windowMin=15
 *  Returns: { reports: [{ when, senderCallsign, freqHz, mode, snr,
 *  senderLocator, receiverCallsign, receiverLocator }] } */
const pskCache = new Map(); // key → { ts, body }
const PSK_CACHE_TTL_MS = 60_000;
async function sendPskReporter(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const freqKHz = parseFloat(u.searchParams.get('freqKHz') ?? '0');
    const halfBandKHz = parseFloat(u.searchParams.get('halfBandKHz') ?? '5');
    const windowMin = Math.min(60, parseFloat(u.searchParams.get('windowMin') ?? '15'));
    if (!Number.isFinite(freqKHz) || freqKHz <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing freqKHz' }));
    }
    const flowHz = Math.round((freqKHz - halfBandKHz) * 1000);
    const fhighHz = Math.round((freqKHz + halfBandKHz) * 1000);
    const cacheKey = `${flowHz}-${fhighHz}-${windowMin}`;
    const c = pskCache.get(cacheKey);
    if (c && Date.now() - c.ts < PSK_CACHE_TTL_MS) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      });
      return res.end(c.body);
    }
    // PSK Reporter retrieve API. Returns XML with <receptionReport> rows.
    // flowStartSeconds is negative to look BACK in time from now.
    const params = new URLSearchParams({
      frange: `${flowHz}-${fhighHz}`,
      flowStartSeconds: String(-Math.round(windowMin * 60)),
      nolocator: '0',
      noactive: '1',
    });
    const url = `https://retrieve.pskreporter.info/query?${params}`;
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 10_000);
    let xml = '';
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
        signal: ctl.signal,
      });
      if (!resp.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `upstream HTTP ${resp.status}` }));
      }
      xml = await resp.text();
    } finally { clearTimeout(tm); }
    // Parse XML reports — small enough that a regex pass beats pulling in a parser.
    const reports = [];
    const re = /<receptionReport\s+([^/]*?)\/>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1];
      const get = (k) => {
        const a = attrs.match(new RegExp(`${k}="([^"]*)"`));
        return a ? a[1] : '';
      };
      const freqHzReport = parseInt(get('frequency') || '0', 10);
      // PSK Reporter's `frange` filter is loose (returns reports
      // ~90 kHz around the request). Apply a strict server-side
      // filter so the client only sees reports actually inside the
      // requested ±halfBandKHz window.
      if (freqHzReport < flowHz || freqHzReport > fhighHz) continue;
      reports.push({
        when: parseInt(get('flowStartSeconds') || '0', 10),
        senderCallsign:   get('senderCallsign'),
        senderLocator:    get('senderLocator'),
        receiverCallsign: get('receiverCallsign'),
        receiverLocator:  get('receiverLocator'),
        freqHz: freqHzReport,
        mode:   get('mode'),
        snr:    parseInt(get('sNR') || '0', 10),
      });
    }
    const body = JSON.stringify({ reports });
    pskCache.set(cacheKey, { ts: Date.now(), body });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'pskreporter fetch failed: ' + e.message }));
  }
}

/** EIBI shortwave broadcast schedule lookup.
 *  Query: ?freqKHz=6075&windowKHz=10
 *  Returns: { entries: [{ freqKHz, startUTC, endUTC, days, country,
 *               station, language, target, txSite, remarks }] }
 *  filtered by current UTC time + weekday + frequency window.
 *  CSV format (semicolon-separated, see eibispace.de):
 *    freq;HHMM-HHMM;days;ITU;station;lang;target;txSite;persist;start;end;remarks
 */
const EIBI_URL = 'http://eibispace.de/dx/sked-a26.csv';
const EIBI_TTL_MS = 24 * 60 * 60 * 1000;
let eibiCache = { ts: 0, entries: [] };
async function fetchEibi() {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 30_000);
  try {
    const resp = await fetch(EIBI_URL, {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
      signal: ctl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    const entries = [];
    for (const ln of txt.split(/\r?\n/)) {
      if (!ln || ln.startsWith('#')) continue;
      const f = ln.split(';');
      if (f.length < 8) continue;
      const freqKHz = parseFloat(f[0]);
      if (!Number.isFinite(freqKHz) || freqKHz <= 0) continue;
      const time = (f[1] || '').trim();
      const m = time.match(/^(\d{4})-(\d{4})$/);
      if (!m) continue;
      entries.push({
        freqKHz,
        startUTC: parseInt(m[1], 10),
        endUTC:   parseInt(m[2], 10),
        days:     (f[2] || '').trim(),
        country:  (f[3] || '').trim(),
        station:  (f[4] || '').trim(),
        language: (f[5] || '').trim(),
        target:   (f[6] || '').trim(),
        txSite:   (f[7] || '').trim(),
        remarks:  (f[11] || '').trim(),
      });
    }
    return entries;
  } finally { clearTimeout(tm); }
}

/** Match EiBi days field against a JS UTC day number (0=Sun..6=Sat).
 *  EiBi uses 1-7 for Mon-Sun and also two-letter codes Sa/Su/Mo/Tu/We/Th/Fr.
 *  Blank or "1234567" means every day. */
function eibiDayMatches(daysField, utcDay) {
  const d = daysField.trim();
  if (!d || d === '1234567') return true;
  // Map JS day (0=Sun..6=Sat) to EiBi digit (1=Mon..7=Sun).
  const eibiDigit = String(utcDay === 0 ? 7 : utcDay);
  if (d.includes(eibiDigit)) return true;
  const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  if (d.includes(names[utcDay])) return true;
  return false;
}

async function sendEibi(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const freqKHz = parseFloat(u.searchParams.get('freqKHz') ?? '0');
    const windowKHz = parseFloat(u.searchParams.get('windowKHz') ?? '10');
    if (!Number.isFinite(freqKHz) || freqKHz <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing freqKHz' }));
    }
    // Refresh cache if expired.
    if (Date.now() - eibiCache.ts > EIBI_TTL_MS || eibiCache.entries.length === 0) {
      console.log('[eibi] fetching ' + EIBI_URL);
      const entries = await fetchEibi();
      eibiCache = { ts: Date.now(), entries };
      console.log(`[eibi] cached ${entries.length} entries`);
    }
    const now = new Date();
    const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes();
    const utcDay = now.getUTCDay();
    const fLo = freqKHz - windowKHz;
    const fHi = freqKHz + windowKHz;
    const out = [];
    for (const e of eibiCache.entries) {
      if (e.freqKHz < fLo || e.freqKHz > fHi) continue;
      const start = e.startUTC, end = e.endUTC;
      // Time window — handle wrap across midnight.
      const inWindow = (end > start)
        ? (hhmm >= start && hhmm < end)
        : (hhmm >= start || hhmm < end);
      if (!inWindow) continue;
      if (!eibiDayMatches(e.days, utcDay)) continue;
      out.push(e);
    }
    out.sort((a, b) => Math.abs(a.freqKHz - freqKHz) - Math.abs(b.freqKHz - freqKHz));
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    });
    res.end(JSON.stringify({
      total: eibiCache.entries.length,
      matches: out.length,
      entries: out,
      utc: { hhmm, day: utcDay },
    }));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'eibi fetch failed: ' + e.message }));
  }
}

/** NETS — aggregate the last N minutes of PSK Reporter activity into
 *  a per-band / per-mode summary. Answers "where on the bands is
 *  there amateur activity right now?". Cached 60 s. */
let netsCache = { ts: 0, body: '' };
const NETS_CACHE_TTL_MS = 60_000;
async function sendNets(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const windowMin = Math.min(60, parseFloat(u.searchParams.get('windowMin') ?? '15'));
    if (Date.now() - netsCache.ts < NETS_CACHE_TTL_MS && netsCache.body) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' });
      return res.end(netsCache.body);
    }
    // Pull all HF reports (1.8 MHz - 30 MHz). PSK Reporter's frange
    // is in Hz.
    const params = new URLSearchParams({
      frange: '1800000-30000000',
      flowStartSeconds: String(-Math.round(windowMin * 60)),
      noactive: '1',
    });
    const url = `https://retrieve.pskreporter.info/query?${params}`;
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 25_000);
    let xml = '';
    const serveStaleOrFail = (msg) => {
      if (netsCache.body) {
        // Graceful degradation: serve the previous successful payload
        // tagged with a stale flag so the client can show it.
        const stale = netsCache.body.replace(/^\{/, `{"stale":true,"upstreamError":${JSON.stringify(msg)},`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(stale);
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: msg }));
    };
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
        signal: ctl.signal,
      });
      if (!r.ok) return serveStaleOrFail(`PSK Reporter HTTP ${r.status}`);
      xml = await r.text();
    } catch (e) {
      return serveStaleOrFail(
        e.name === 'AbortError'
          ? 'PSK Reporter timeout (>25 s)'
          : `PSK Reporter fetch: ${e.message}`
      );
    } finally { clearTimeout(tm); }

    // Canonical HF ham bands (lower-MHz, upper-MHz, label).
    const BANDS = [
      [1.800,  2.000, '160 m'],
      [3.500,  4.000,  '80 m'],
      [5.330,  5.405,  '60 m'],
      [7.000,  7.300,  '40 m'],
     [10.100, 10.150,  '30 m'],
     [14.000, 14.350,  '20 m'],
     [18.068, 18.168,  '17 m'],
     [21.000, 21.450,  '15 m'],
     [24.890, 24.990,  '12 m'],
     [28.000, 29.700,  '10 m'],
    ];
    const bands = BANDS.map(([lo, hi, label]) => ({
      lo, hi, label,
      reports: 0,
      senders: new Set(),
      modes: {},
    }));

    const re = /<receptionReport\s+([^/]*?)\/>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const a = m[1];
      const get = (k) => {
        const x = a.match(new RegExp(`${k}="([^"]*)"`));
        return x ? x[1] : '';
      };
      const f = parseInt(get('frequency') || '0', 10) / 1e6; // MHz
      const mode = get('mode');
      const sender = get('senderCallsign');
      if (!f || !mode || !sender) continue;
      for (const b of bands) {
        if (f >= b.lo && f < b.hi) {
          b.reports++;
          b.senders.add(sender);
          b.modes[mode] = (b.modes[mode] || 0) + 1;
          break;
        }
      }
    }

    // Voice nets — match the curated list against current UTC time.
    let voiceNets = [];
    try {
      const vTxt = fs.readFileSync(path.join(__dirname, 'decoders/voice-nets.json'), 'utf8');
      const vData = JSON.parse(vTxt);
      const now = new Date();
      const hhmm = now.getUTCHours() * 100 + now.getUTCMinutes();
      const utcDay = now.getUTCDay();
      const eibiDigit = String(utcDay === 0 ? 7 : utcDay);
      voiceNets = (vData.nets || []).filter((n) => {
        const inWindow = (n.endUTC > n.startUTC)
          ? (hhmm >= n.startUTC && hhmm < n.endUTC)
          : (hhmm >= n.startUTC || hhmm < n.endUTC);
        if (!inWindow) return false;
        const days = (n.days || '').trim();
        if (!days) return true;
        return days.includes(eibiDigit);
      }).sort((a, b) => a.freqKHz - b.freqKHz);
    } catch (e) {
      console.warn('[nets] voice-nets read failed:', e.message);
    }
    const body = JSON.stringify({
      windowMin,
      bands: bands
        .filter(b => b.reports > 0)
        .map(b => ({
          band: b.label,
          loMHz: b.lo,
          hiMHz: b.hi,
          reports: b.reports,
          uniqueSenders: b.senders.size,
          modes: Object.entries(b.modes)
            .sort((a, b) => b[1] - a[1])
            .map(([mode, count]) => ({ mode, count })),
        })),
      voiceNets,
    });
    netsCache = { ts: Date.now(), body };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'nets fetch failed: ' + e.message }));
  }
}

/* ─────────────  DX cluster client (real-time spot feed)  ──────────
 *  Opens a long-lived telnet connection to a public DX cluster node,
 *  parses standard AR/CC/DX Spider spot lines, and keeps the latest
 *  ~500 spots in memory (last 60 minutes). Public nodes accept any
 *  string as the login prompt — no real callsign is checked. We
 *  identify as "radiom" for politeness. Auto-reconnect with backoff.
 *
 *  Endpoint: /api/dxspots?freqKHz=14205&halfBandKHz=10&windowMin=60
 *  Returns: { spots: [{ when, spotter, freqKHz, callsign, comment }] }
 */
const DX_NODES = [
  { host: 'dxc.ve7cc.net',  port: 23   },   // CC Cluster, lenient
  { host: 'cluster.dl9gtb.de', port: 8000 },// DX Spider, lenient
  { host: 'dxc.k1ttt.net',  port: 7373 },
  { host: 'dxc.w3lpl.net',  port: 7373 },   // AR-Cluster, validates calls
  { host: 'dxc.w8wts.net',  port: 7373 },
];
// Most public DX cluster nodes (AR-Cluster V6, CC Cluster) validate
// the login against a real-callsign regex. Without a callsign the
// nodes either reject the login or never start streaming spots.
// Set RADIOM_DX_CALLSIGN in env to enable this feature with your
// own callsign. If unset, the cluster client stays inactive.
const DX_LOGIN = process.env.RADIOM_DX_CALLSIGN || '';
const DX_ENABLED = DX_LOGIN.length > 0;
const DX_MAX_SPOTS = 500;
const DX_MAX_AGE_MS = 60 * 60_000;
const dxSpots = [];           // { when, spotter, freqKHz, callsign, comment }
let dxClient = null;
let dxNodeIdx = 0;
let dxReconnectTimer = null;
let dxBuf = '';

function dxParseSpot(line) {
  // Live spot:
  //   DX de K1ABC:    14205.5  DX5XYZ      comment                 1845Z
  let m = line.match(/^DX de (\S+?):\s+([\d.]+)\s+(\S+)\s*(.*?)\s+(\d{4})Z/);
  if (m) {
    const freqKHz = parseFloat(m[2]);
    if (Number.isFinite(freqKHz) && freqKHz > 0) {
      return {
        when: Date.now(),
        spotter:  m[1].replace(/-#$/, ''),
        freqKHz,
        callsign: m[3],
        comment:  (m[4] || '').trim(),
      };
    }
  }
  // sh/dx history:
  //   14205.5  DX5XYZ      18-Nov-2025 1845Z  comment            <K1ABC>
  m = line.match(/^\s*([\d.]+)\s+(\S+)\s+\d{1,2}-\w{3}-\d{4}\s+(\d{4})Z\s+(.*?)\s*<(\S+?)>\s*$/);
  if (m) {
    const freqKHz = parseFloat(m[1]);
    if (Number.isFinite(freqKHz) && freqKHz > 0) {
      return {
        when: Date.now(),
        spotter:  m[5].replace(/-#$/, ''),
        freqKHz,
        callsign: m[2],
        comment:  (m[4] || '').trim(),
      };
    }
  }
  return null;
}

function dxConnect() {
  if (!DX_ENABLED) return;
  if (dxClient) return;
  const node = DX_NODES[dxNodeIdx % DX_NODES.length];
  console.log(`[dx] connecting to ${node.host}:${node.port}`);
  dxClient = net.createConnection({ host: node.host, port: node.port });
  let loggedIn = false;
  let primed = false;
  dxClient.setEncoding('utf8');
  // Keep the long-lived connection alive without firing 'timeout' on
  // quiet stretches between spots.
  dxClient.setKeepAlive(true, 60_000);
  dxClient.on('connect', () => {
    console.log(`[dx] connected to ${node.host}`);
    // Send login eagerly. Most DX Spider/AR clusters accept any text
    // even before the prompt is rendered; the few that buffer it just
    // re-emit the prompt next.
    try { dxClient.write(DX_LOGIN + '\n'); } catch {}
    // Schedule the history dump after a short delay so the login
    // settles. Don't wait for a prompt match — different cluster
    // implementations use different prompts.
    setTimeout(() => {
      if (!dxClient) return;
      try { dxClient.write('sh/dx 50\n'); } catch {}
      primed = true;
    }, 2000);
  });
  dxClient.on('data', (chunk) => {
    dxBuf += chunk;
    // Print first 600 bytes of stream once for diagnostic; remove later.
    if (!loggedIn) loggedIn = true;
    let nl;
    while ((nl = dxBuf.indexOf('\n')) >= 0) {
      const line = dxBuf.slice(0, nl).replace(/\r$/, '');
      dxBuf = dxBuf.slice(nl + 1);
      const spot = dxParseSpot(line);
      if (spot) {
        dxSpots.push(spot);
        while (dxSpots.length > DX_MAX_SPOTS) dxSpots.shift();
      }
    }
  });
  const restart = (why) => {
    console.log(`[dx] ${node.host} ${why}, reconnecting in 15 s`);
    try { dxClient?.destroy(); } catch {}
    dxClient = null;
    dxNodeIdx++;
    if (dxReconnectTimer) clearTimeout(dxReconnectTimer);
    dxReconnectTimer = setTimeout(() => { dxReconnectTimer = null; dxConnect(); }, 15_000);
  };
  dxClient.on('error',   (e) => restart('error: ' + e.message));
  dxClient.on('close',   ()  => restart('closed'));
}

function sendDxSpots(req, res) {
  if (!DX_ENABLED) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'DX cluster disabled — set RADIOM_DX_CALLSIGN in env to a real amateur callsign to enable',
      enabled: false,
    }));
  }
  // Lazy connect on first request.
  if (!dxClient && !dxReconnectTimer) dxConnect();
  const u = new URL(req.url, 'http://x');
  const freqKHz = parseFloat(u.searchParams.get('freqKHz') ?? '0');
  const halfBandKHz = parseFloat(u.searchParams.get('halfBandKHz') ?? '10');
  const windowMin = Math.min(60, parseFloat(u.searchParams.get('windowMin') ?? '30'));
  const minWhen = Date.now() - windowMin * 60_000;
  // Drop expired spots.
  while (dxSpots.length && dxSpots[0].when < Date.now() - DX_MAX_AGE_MS) dxSpots.shift();
  let out = dxSpots.filter(s => s.when >= minWhen);
  if (freqKHz > 0) {
    const lo = freqKHz - halfBandKHz, hi = freqKHz + halfBandKHz;
    out = out.filter(s => s.freqKHz >= lo && s.freqKHz <= hi);
  }
  out = out.slice().reverse();    // newest first
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({
    connected: !!dxClient,
    bufferSize: dxSpots.length,
    windowMin,
    spots: out,
  }));
}

/* ─────────  WSPRnet — via wspr.live public ClickHouse DB  ────────
 *  WSPRnet itself has no callsign-free machine-readable API for
 *  recent spots, but the community runs db1.wspr.live (a public
 *  read-only ClickHouse mirror of every WSPR spot since 2008). We
 *  query that for the last N minutes of spots near a frequency
 *  and aggregate by transmitter.
 *
 *  Endpoint: /api/wsprnet?freqKHz=14097&halfBandKHz=10&windowMin=60
 *  Returns:  { transmitters: [{ tx_sign, tx_loc, count, bestSnr,
 *              lastHeardAgoSec, maxDistanceKm, freqHz }],
 *              total, windowMin }
 */
const WSPR_CACHE_TTL_MS = 60_000;
const wsprCache = new Map();   // key → { ts, body }
async function sendWspr(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const freqKHz = parseFloat(u.searchParams.get('freqKHz') ?? '0');
    const halfBandKHz = parseFloat(u.searchParams.get('halfBandKHz') ?? '10');
    const windowMin = Math.min(360, Math.max(5,
      parseFloat(u.searchParams.get('windowMin') ?? '60')));
    if (!Number.isFinite(freqKHz) || freqKHz <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing freqKHz' }));
    }
    const fLoHz = Math.round((freqKHz - halfBandKHz) * 1000);
    const fHiHz = Math.round((freqKHz + halfBandKHz) * 1000);
    const cacheKey = `${fLoHz}-${fHiHz}-${windowMin}`;
    const c = wsprCache.get(cacheKey);
    if (c && Date.now() - c.ts < WSPR_CACHE_TTL_MS) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      });
      return res.end(c.body);
    }
    // Aggregate by transmitter inside the frequency + time window.
    // wspr.live is a public, read-only ClickHouse mirror. The frequency
    // column is in Hz.
    const sql = `
      SELECT tx_sign, tx_loc,
             count() AS hits,
             max(snr) AS bestSnr,
             max(distance) AS maxDistanceKm,
             max(toUnixTimestamp(time)) AS lastUnix,
             round(avg(frequency)) AS freqHz
      FROM wspr.rx
      WHERE time > now() - INTERVAL ${windowMin} MINUTE
        AND frequency BETWEEN ${fLoHz} AND ${fHiHz}
      GROUP BY tx_sign, tx_loc
      ORDER BY hits DESC
      LIMIT 500
      FORMAT JSON
    `.replace(/\s+/g, ' ');
    const url = 'https://db1.wspr.live/?' + new URLSearchParams({ query: sql });
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 15_000);
    let rows = [];
    let total = 0;
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
        signal: ctl.signal,
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`wspr.live HTTP ${r.status}: ${text.slice(0, 200)}`);
      }
      const data = await r.json();
      rows = data.data || [];
      total = rows.reduce((s, x) => s + (+x.hits || 0), 0);
    } finally { clearTimeout(tm); }
    const now = Math.floor(Date.now() / 1000);
    const transmitters = rows.map(r => ({
      tx_sign: r.tx_sign,
      tx_loc:  r.tx_loc,
      hits:    +r.hits,
      bestSnr: +r.bestSnr,
      maxDistanceKm: Math.round(+r.maxDistanceKm),
      lastHeardAgoSec: now - (+r.lastUnix),
      freqHz: +r.freqHz,
    }));
    const body = JSON.stringify({
      total, windowMin,
      freqKHz, halfBandKHz,
      transmitters,
    });
    wsprCache.set(cacheKey, { ts: Date.now(), body });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'wspr.live fetch failed: ' + e.message }));
  }
}

async function sendPropagation(res) {
  try {
    const now = Date.now();
    if (!propagationCache.data || now - propagationCache.ts > PROPAGATION_TTL_MS) {
      const xml = await fetchPropagationXml();
      propagationCache = { data: parsePropagationXml(xml), ts: now, etag: String(now) };
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(JSON.stringify(propagationCache.data));
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'propagation fetch failed: ' + e.message }));
  }
}

function sendStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  let abs = path.normalize(path.join(DIST, urlPath));
  if (!abs.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    abs = path.join(DIST, 'index.html');
  }
  const ext = path.extname(abs).toLowerCase();
  const ct = MIME[ext] || 'application/octet-stream';
  // Hashed assets in /assets/ are immutable; the rest must revalidate.
  const cache = abs.includes(`${path.sep}assets${path.sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  // Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy enable
  // SharedArrayBuffer in the browser, which onnxruntime-web needs to
  // run multi-threaded WASM (DeepFilterNet inference is 2-3× faster).
  // require-corp is the strict variant — all cross-origin resources
  // (jsdelivr-hosted ORT wasm sidecars, etc.) must respond with
  // Cross-Origin-Resource-Policy: cross-origin. jsdelivr already does.
  res.writeHead(200, {
    'Content-Type': ct,
    'Cache-Control': cache,
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  });
  fs.createReadStream(abs).pipe(res);
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate',
};

/** Cache the public list so we only fight the captcha once per TTL. */
const cache = new Map(); // url → { ts, status, ct, body }
const CACHE_TTL_MS = 5 * 60_000;

/** Fetch /public/ from kiwisdr.com, transparently solving the click-captcha
 *  if it's served (the page embeds an x-kiwi-auth token; resending the
 *  request with that header bypasses the gate). */
async function fetchKiwiList(targetUrl) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 20_000);
  try {
    let resp = await fetch(targetUrl, { headers: BROWSER_HEADERS, redirect: 'follow', signal: ctl.signal });
    let body = await resp.text();

    // Captcha detection: small HTML page that asks the user to click "play".
    const m = body.match(/setRequestHeader\(\s*['"]x-kiwi-auth['"]\s*,\s*['"]([0-9a-f]+)['"]/i);
    if (m && body.length < 8_000) {
      console.log(`[kiwi-proxy] captcha detected, replaying with x-kiwi-auth`);
      resp = await fetch(targetUrl, {
        headers: { ...BROWSER_HEADERS, 'x-kiwi-auth': m[1], 'Referer': targetUrl },
        redirect: 'follow',
        signal: ctl.signal,
      });
      body = await resp.text();
    }

    return {
      status: resp.status,
      ct: resp.headers.get('content-type') || 'text/html; charset=utf-8',
      body: Buffer.from(body, 'utf8'),
    };
  } finally {
    clearTimeout(tm);
  }
}

async function proxyKiwiHttp(targetUrl, res) {
  console.log(`[kiwi-proxy] GET ${targetUrl}`);
  try {
    const c = cache.get(targetUrl);
    let result;
    if (c && Date.now() - c.ts < CACHE_TTL_MS) {
      console.log(`[kiwi-proxy] cache hit (${c.body.length}B)`);
      result = c;
    } else {
      result = await fetchKiwiList(targetUrl);
      cache.set(targetUrl, { ts: Date.now(), ...result });
      console.log(`[kiwi-proxy] ← ${targetUrl} status=${result.status} bytes=${result.body.length}`);
    }
    res.writeHead(result.status, {
      'access-control-allow-origin': '*',
      'content-type': result.ct,
      'content-length': result.body.length,
    });
    res.end(result.body);
  } catch (e) {
    console.warn(`[kiwi-proxy] error ${targetUrl}: ${e.message}`);
    if (!res.headersSent) { res.writeHead(502); res.end('upstream error: ' + e.message); }
  }
}

/** Proxy a KiwiSDR /status preflight. The Kiwi serves
 *  `http://HOST:PORT/status` as plain `key=value\n` lines, no auth, no
 *  captcha. We surface a parsed JSON view so the client can refuse to
 *  open WebSockets when the receiver is full / password-protected /
 *  marked down. Short-cached so rapid retries don't hammer the kiwi. */
const kiwiStatusCache = new Map(); // hostport → { ts, data }
const KIWI_STATUS_TTL_MS = 10_000;
/** Generic kiwi HTTP-asset proxy. Hits `http://<host>:<port><path>` and
 *  returns 204 on success (we don't care about the body — the goal is
 *  just to establish an HTTP session footprint on the kiwi before the
 *  WS opens, since v1.817+ won't stream audio to clients without one).
 *  Used by the browser-side preflight from radiom over HTTPS where a
 *  direct ws/http to the kiwi would be blocked by mixed-content rules. */
async function sendKiwiTouch(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const host = u.searchParams.get('host');
    const port = +(u.searchParams.get('port') || '8073');
    const path = u.searchParams.get('path') || '/';
    if (!host || !Number.isFinite(port) || !path.startsWith('/')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('host, port, path required');
      return;
    }
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 4_000);
    try {
      await fetch(`http://${host}:${port}${path}`, { signal: ctl.signal });
    } finally { clearTimeout(tm); }
    res.writeHead(204, { 'access-control-allow-origin': '*' });
    res.end();
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('touch failed: ' + (e.message || e));
  }
}

async function sendKiwiStatus(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const host = u.searchParams.get('host');
    const port = +(u.searchParams.get('port') || '8073');
    if (!host || !Number.isFinite(port)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'host and port required' }));
      return;
    }
    const key = `${host}:${port}`;
    const cached = kiwiStatusCache.get(key);
    if (cached && Date.now() - cached.ts < KIWI_STATUS_TTL_MS) {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(cached.data));
      return;
    }
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 6_000);
    let text = '';
    let httpStatus = 0;
    try {
      const r = await fetch(`http://${host}:${port}/status`, { signal: ctl.signal });
      httpStatus = r.status;
      text = await r.text();
    } finally { clearTimeout(tm); }
    const kv = {};
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    // The owner-side "user time limit" admin flag isn't exposed as its
    // own field; it shows up as a "⏳ Limits" badge inside `sdr_hw`.
    // Catching it lets us warn the operator that short sessions are by
    // design, not by accident.
    const limitsEnabled = /limits/i.test(kv.sdr_hw || '');
    const data = {
      ok: httpStatus === 200,
      httpStatus,
      kv,
      users: kv.users != null ? +kv.users : null,
      usersMax: kv.users_max != null ? +kv.users_max : null,
      chanNoPwd: kv.chan_no_pwd != null ? +kv.chan_no_pwd : null,
      passwordRequired: kv.passwd === '1' || kv.auth_user_required === '1',
      down: kv.down === '1',
      limitsEnabled,
      version: kv.version_maj && kv.version_min ? `${kv.version_maj}.${kv.version_min}` : (kv.version || null),
      name: kv.name || null,
    };
    kiwiStatusCache.set(key, { ts: Date.now(), data });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || String(e) }));
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/kiwi-public')) {
    const tail = url.slice('/api/kiwi-public'.length).replace(/^\//, '');
    return proxyKiwiHttp(`http://kiwisdr.com/public/${tail}`, res);
  }
  if (url.startsWith('/api/kiwi-rx')) {
    const tail = url.slice('/api/kiwi-rx'.length).replace(/^\//, '');
    return proxyKiwiHttp(`http://rx.kiwisdr.com/${tail}`, res);
  }
  if (url.startsWith('/api/propagation')) return sendPropagation(res);
  if (url.startsWith('/api/fingerprints')) return sendFingerprints(res);
  if (url.startsWith('/api/pskreporter')) return sendPskReporter(req, res);
  if (url.startsWith('/api/eibi')) return sendEibi(req, res);
  if (url.startsWith('/api/nets')) return sendNets(req, res);
  if (url.startsWith('/api/dxspots')) return sendDxSpots(req, res);
  if (url.startsWith('/api/wsprnet')) return sendWspr(req, res);
  if (url.startsWith('/api/kiwi-status')) return sendKiwiStatus(req, res);
  if (url.startsWith('/api/kiwi-touch')) return sendKiwiTouch(req, res);
  if (url.startsWith('/audio/')) return sendAudio(req, res);
  return sendStatic(req, res);
});

// ── /ws/decode/cw — server-side CW decoder.
//    Browser sends 12 kHz int16 mono PCM as binary frames. Each connection
//    gets its own CWDecoder instance (so multiple users decode independently
//    on whatever they're tuned to).
const cwWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachCwDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const num = (k, def) => {
    const v = +query?.get(k);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const numOrUndef = (k) => {
    const v = +query?.get(k);
    return Number.isFinite(v) ? v : undefined;
  };
  const boolOrUndef = (k) => {
    const v = query?.get(k);
    return v == null ? undefined : (v === '1' || v === 'true');
  };
  const decoder = new CWDecoder({
    sampleRate: 12000,
    pitchHz:       num('pitch', 800),
    wpm:           num('wpm',   18),
    lowerLimit:    numOrUndef('lower'),
    upperLimit:    numOrUndef('upper'),
    range:         numOrUndef('range'),
    bandwidth:     numOrUndef('bw'),
    matchedFilter: boolOrUndef('mfilt'),
    attack:        numOrUndef('attack'),
    decay:         numOrUndef('decay'),
    lowercase:     boolOrUndef('lowercase'),
    dashDot:       numOrUndef('dashdot'),
    useSOM:        boolOrUndef('som'),
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
    onPitch: (hz) => {
      console.log(`[cw-decoder] pitch → ${hz} Hz`);
    },
  });

  const hb = setInterval(() => {
    console.log(`[cw-decoder] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const inLen = buf.length / 2;
    if (inLen <= 0) return;
    const samples = new Int16Array(buf.buffer, buf.byteOffset, inLen);
    decoder.feed(samples);
    bytesIn += buf.length;
  });

  ws.on('close', () => clearInterval(hb));
}

// ── /ws/decode/rtty — server-side RTTY decoder.
//    Same architecture as CW: per-connection decoder instance.
const rttyWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachRttyDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const num = (k, def) => {
    const v = +query.get(k);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const decoder = new RTTYDecoder({
    sampleRate: 12000,
    markHz:  num('mark',  915),
    spaceHz: num('space', 1085),
    baud:    num('baud',  45.45),
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[rtty-decoder] mark=${decoder.markHz} space=${decoder.spaceHz} baud=${decoder.baud}`);
  const hb = setInterval(() => {
    console.log(`[rtty-decoder] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const inLen = buf.length / 2;
    if (inLen <= 0) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, inLen));
    bytesIn += buf.length;
  });
  ws.on('close', () => clearInterval(hb));
}

// ── /ws/decode/psk — server-side PSK31 decoder.
const pskWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachPskDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const num = (k, def) => {
    const v = +query.get(k);
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const decoder = new PSKDecoder({
    sampleRate: 12000,
    pitchHz: num('pitch', 1000),
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[psk-decoder] pitch=${decoder.pitch}`);
  const hb = setInterval(() => {
    console.log(`[psk-decoder] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const inLen = buf.length / 2;
    if (inLen <= 0) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, inLen));
    bytesIn += buf.length;
  });
  ws.on('close', () => clearInterval(hb));
}

// ── /ws/decode/wefax — server-side HF WEFAX decoder.
//
// Stage-1: spawns the native wefax-decoder binary which currently emits a
// synthetic gradient image. The wire protocol (NDJSON events) is what the
// real decoder will use too, so the client / panel won't change when the
// real fldigi port lands.
const wefaxWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachWefaxDecoder(ws) {
  let bytesIn = 0, rowsOut = 0;
  const decoder = new WefaxDecoder({
    onEvent: (ev) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(ev));
      if (ev.t === 'row') rowsOut++;
    },
  });
  console.log('[wefax-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[wefax-decoder] hb bytesIn=${bytesIn} rowsOut=${rowsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/navtex — server-side NAVTEX / SITOR-B decoder.
const navtexWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachNavtexDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const mode = (query?.get('mode') === 'sitorb') ? 'sitorb' : 'navtex';
  const carrierHz = Number(query?.get('carrier'));
  const decoder = new NAVTEXDecoder({
    sampleRate: 12000,
    mode,
    carrierHz: Number.isFinite(carrierHz) ? carrierHz : undefined,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[navtex-decoder] session started (mode=${mode})`);
  const hb = setInterval(() => {
    console.log(`[navtex-decoder] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/hfdl — server-side dumphfdl HFDL decoder.
// Client streams raw IQ bytes (int16 BE, interleaved I/Q — KiwiSDR
// stereo wire format). The bridge byte-swaps and pipes to dumphfdl.
const hfdlWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachHfdlDecoder(ws, query) {
  const freqKHz = Number(query?.get('freq'));
  if (!Number.isFinite(freqKHz)) {
    ws.close(1008, 'missing freq');
    return;
  }
  const centerArg = Number(query?.get('center'));
  let bytesIn = 0, linesOut = 0;
  const decoder = new HFDLDecoder({
    freqKHz,
    centerKHz: Number.isFinite(centerArg) ? centerArg : freqKHz,
    sampleRate: 12000,
    onLine: (line) => {
      linesOut++;
      if (ws.readyState === WS.OPEN) ws.send(line + '\n');
    },
  });
  console.log(`[hfdl-decoder] session started (freq=${freqKHz} kHz)`);
  const hb = setInterval(() => {
    console.log(`[hfdl-decoder] hb bytesIn=${bytesIn} linesOut=${linesOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 4) return;
    decoder.feed(buf);
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/ale-2g — server-side LinuxALE-vendored ALE 2G decoder.
const ale2gWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachAle2gDecoder(ws, _query) {
  let bytesIn = 0, linesOut = 0;
  const decoder = new ALE2GDecoder({
    sampleRate: 12000,
    onLine: (line) => {
      linesOut++;
      if (ws.readyState === WS.OPEN) ws.send(line + '\n');
    },
  });
  console.log('[ale-2g-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[ale-2g-decoder] hb bytesIn=${bytesIn} linesOut=${linesOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/psk-fldigi — server-side fldigi-vendored PSK decoder (BPSK31 default).
const pskFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachPskFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const mode  = query?.get('mode')  || 'bpsk31';
  const pitch = Number(query?.get('pitch')) || 1000;
  const acqSn       = Number(query?.get('acqsn'));
  const searchRange = Number(query?.get('search'));
  const decoder = new PSKFldigiDecoder({
    sampleRate: 12000,
    mode,
    pitch,
    acqSn:       Number.isFinite(acqSn) ? acqSn : undefined,
    searchRange: Number.isFinite(searchRange) ? searchRange : undefined,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[psk-fldigi] session started (mode=${mode} pitch=${pitch})`);
  const hb = setInterval(() => {
    console.log(`[psk-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/rtty-fldigi — server-side fldigi-vendored RTTY decoder.
const rttyFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachRttyFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const carrierHz = Number(query?.get('carrier')) || 1500;
  const baud      = Number(query?.get('baud'))    || 45.45;
  const shift     = Number(query?.get('shift'))   || 170;
  const bits      = Number(query?.get('bits'))    || 5;
  const stop      = Number(query?.get('stop'))    || 1.5;
  const decoder = new RttyFldigiDecoder({
    sampleRate: 12000,
    carrierHz, baud, shift, bits, stop,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[rtty-fldigi] session started (carrier=${carrierHz} baud=${baud} shift=${shift} bits=${bits} stop=${stop})`);
  const hb = setInterval(() => {
    console.log(`[rtty-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/wwv-fldigi — server-side fldigi-vendored WWV scope.
// Forwards 1000-byte (or 200-byte zoomed) video frames as binary WS messages.
const wwvFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachWwvFldigiDecoder(ws) {
  let bytesIn = 0, framesOut = 0;
  const decoder = new WwvFldigiDecoder({
    onFrame: (frame) => {
      framesOut++;
      if (ws.readyState === WS.OPEN) ws.send(frame, { binary: true });
    },
  });
  console.log(`[wwv-fldigi] session started`);
  const hb = setInterval(() => {
    console.log(`[wwv-fldigi] hb bytesIn=${bytesIn} framesOut=${framesOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/contestia-fldigi — server-side fldigi-vendored Contestia decoder.
const contestiaFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachContestiaFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const tones     = Number(query?.get('tones'))     || 8;
  const bandwidth = Number(query?.get('bandwidth')) || 250;
  const carrierHz = Number(query?.get('carrier'))   || 1500;
  const decoder = new ContestiaFldigiDecoder({
    sampleRate: 12000,
    tones, bandwidth, carrierHz,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[contestia-fldigi] session started (tones=${tones} bw=${bandwidth} carrier=${carrierHz})`);
  const hb = setInterval(() => {
    console.log(`[contestia-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/dominoex-fldigi — server-side fldigi-vendored DominoEX decoder.
const dominoexFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachDominoexFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const mode      = query?.get('mode')      || 'dominoex16';
  const carrierHz = Number(query?.get('carrier')) || 1500;
  const decoder = new DominoexFldigiDecoder({
    sampleRate: 12000,
    mode, carrierHz,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[dominoex-fldigi] session started (mode=${mode} carrier=${carrierHz})`);
  const hb = setInterval(() => {
    console.log(`[dominoex-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/thor-fldigi — server-side fldigi-vendored THOR decoder.
const thorFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachThorFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const mode      = query?.get('mode')      || 'thor16';
  const carrierHz = Number(query?.get('carrier')) || 1500;
  const decoder = new ThorFldigiDecoder({
    sampleRate: 12000,
    mode, carrierHz,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[thor-fldigi] session started (mode=${mode} carrier=${carrierHz})`);
  const hb = setInterval(() => {
    console.log(`[thor-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/fsq-fldigi — server-side fldigi-vendored FSQ decoder.
const fsqFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachFsqFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const carrierHz = Number(query?.get('carrier')) || 1500;
  const baud      = Number(query?.get('baud'))    || 3;
  const decoder = new FsqFldigiDecoder({
    sampleRate: 12000,
    carrierHz, baud,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[fsq-fldigi] session started (carrier=${carrierHz} baud=${baud})`);
  const hb = setInterval(() => {
    console.log(`[fsq-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/mt63-fldigi — server-side fldigi-vendored MT63 decoder.
const mt63FldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachMt63FldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const mode      = query?.get('mode')      || '1000l';
  const carrierHz = Number(query?.get('carrier')) || 1500;
  const integration = query?.get('integration');
  const eightBitS = query?.get('8bit');
  const eightBit  = eightBitS == null ? undefined : (eightBitS === '1' || eightBitS === 'true');
  const decoder = new Mt63FldigiDecoder({
    sampleRate: 12000,
    mode, carrierHz,
    integration: (integration === 'short' || integration === 'long') ? integration : undefined,
    eightBit,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[mt63-fldigi] session started (mode=${mode} carrier=${carrierHz})`);
  const hb = setInterval(() => {
    console.log(`[mt63-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/mfsk-fldigi — server-side fldigi-vendored MFSK decoder.
const mfskFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachMfskFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const mode    = query?.get('mode')    || 'mfsk16';
  const pitchHz = Number(query?.get('pitch')) || 1500;
  const decoder = new MfskFldigiDecoder({
    sampleRate: 12000,
    mode, pitchHz,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[mfsk-fldigi] session started (mode=${mode} pitch=${pitchHz})`);
  const hb = setInterval(() => {
    console.log(`[mfsk-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/throb-fldigi — server-side fldigi-vendored Throb decoder.
const throbFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachThrobFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const mode    = query?.get('mode')    || 'throb1';
  const pitchHz = Number(query?.get('pitch')) || 1000;
  const decoder = new ThrobFldigiDecoder({
    sampleRate: 12000,
    mode, pitchHz,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log(`[throb-fldigi] session started (mode=${mode} pitch=${pitchHz})`);
  const hb = setInterval(() => {
    console.log(`[throb-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/olivia-fldigi — server-side fldigi-vendored Olivia decoder.
const oliviaFldigiWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachOliviaFldigiDecoder(ws, query) {
  let bytesIn = 0, charsOut = 0;
  const tones     = Number(query?.get('tones'))     || 32;
  const bandwidth = Number(query?.get('bandwidth')) || 1000;
  const carrierHz = Number(query?.get('carrier'))   || 1500;
  const smargin   = Number(query?.get('smargin'));
  const sinteg    = Number(query?.get('sinteg'));
  const decoder = new OliviaFldigiDecoder({
    sampleRate: 12000,
    tones, bandwidth, carrierHz,
    smargin: Number.isFinite(smargin) ? smargin : undefined,
    sinteg:  Number.isFinite(sinteg)  ? sinteg  : undefined,
    onChar: (ch) => {
      charsOut++;
      if (ws.readyState === WS.OPEN) ws.send(ch);
    },
  });
  console.log(`[olivia-fldigi] session started (tones=${tones} bw=${bandwidth} carrier=${carrierHz})`);
  const hb = setInterval(() => {
    console.log(`[olivia-fldigi] hb bytesIn=${bytesIn} charsOut=${charsOut}`);
  }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/rsid — autonomous HF digital-mode classifier.
//
// Always-on companion to whatever decoder is active: feeds the same audio
// stream into fldigi's RSID detector and forwards every detection event
// (mode + frequency offset) over the socket. The client uses these to
// auto-switch the active decoder.
const rsidWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachRsidDecoder(ws) {
  let bytesIn = 0, detectsOut = 0;
  const decoder = new RsidDecoder({
    onEvent: (ev) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(ev));
      if (ev.t === 'detect') detectsOut++;
    },
  });
  console.log('[rsid-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[rsid-decoder] hb bytesIn=${bytesIn} detectsOut=${detectsOut}`);
  }, 30_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/packet — HF AX.25 / APRS packet decoder via direwolf.
const packetWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachPacketDecoder(ws) {
  let bytesIn = 0, framesOut = 0;
  const decoder = new PacketDecoder({
    onLine: (line) => {
      framesOut++;
      if (ws.readyState === WS.OPEN) ws.send(line);
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(`[status] ${msg}`);
    },
  });
  console.log('[packet-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[packet-decoder] hb bytesIn=${bytesIn} framesOut=${framesOut}`);
  }, 30_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/wspr — WSPR (2-minute period) decoder via wsprd.
//
// Client sends 12 kHz int16 PCM (continuous) plus an optional `dial=<kHz>`
// query parameter for output annotation. Server buffers each 2-minute
// period, runs `wsprd` against the captured WAV, and pushes spot lines
// back as text.
const wsprWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachWsprDecoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14097.1');
  if (!Number.isFinite(dialKHz)) dialKHz = 14097.1;
  let bytesIn = 0, spotsOut = 0;
  const decoder = new WsprDecoder({
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[wspr-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[wspr-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      // Tolerate optional retune messages: {"t":"dial","kHz":14097.1}
      // and INJECT-test resync trigger:    {"t":"trigger"}
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/wspr15 — WSPR-15 (15-minute period) decoder via wsprd -m.
//
// Identical shape to the 2-min WSPR endpoint; just longer batches and
// the `-m` flag passed to wsprd downstream. Useful for the LF/MF beacon
// crowd that still uses WSPR-15 over FST4W.
const wspr15Wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachWspr15Decoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '137.5');
  if (!Number.isFinite(dialKHz)) dialKHz = 137.5;
  let bytesIn = 0, spotsOut = 0;
  const decoder = new Wspr15Decoder({
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[wspr15-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[wspr15-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/jt9 — JT9 (1-minute slot) decoder via jt9 binary.
//
// Same shape as WSPR/FST4: client streams 12 kHz int16 PCM; server
// buffers each UTC-minute period and runs `jt9 -9 <wav>` at the end.
const jt9Wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachJt9Decoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14078');
  if (!Number.isFinite(dialKHz)) dialKHz = 14078;
  let bytesIn = 0, spotsOut = 0;
  const decoder = new Jt9Decoder({
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[jt9-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[jt9-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/jt65 — JT65 (1-min slot) decoder via `jt9 -65 <wav>`.
//
// Same shape as the JT9 endpoint; only difference is the wsjt-x binary
// flag. JT65's standard 20 m HF watering hole is 14.076 MHz USB.
const jt65Wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachJt65Decoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14076');
  if (!Number.isFinite(dialKHz)) dialKHz = 14076;
  let bytesIn = 0, spotsOut = 0;
  const decoder = new Jt65Decoder({
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[jt65-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[jt65-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/q65 — Q65 (1-min default slot) decoder via `jt9 -q`.
//
// Modern WSJT-X weak-signal mode. Default Q65-60 (1-min slots); the
// `?period=<sec>` query parameter accepts 15/30/60/120/300 if the
// client wants a different submode.
const q65Wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachQ65Decoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14080');
  if (!Number.isFinite(dialKHz)) dialKHz = 14080;
  const periodSec = parseInt(query?.get('period') ?? '60', 10);
  let bytesIn = 0, spotsOut = 0;
  const decoder = new Q65Decoder({
    periodSec,
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log(`[q65-decoder] session started (period=${periodSec}s)`);
  const hb = setInterval(() => {
    console.log(`[q65-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz} period=${periodSec}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/fst4w — FST4W (beacon) decoder via `fst4d -W`.
//
// Beacon protocol carried on the FST4 modulation; same shape as the
// other batch decoders. `?period=<sec>` accepts 60/120/300/900/1800;
// default 120 (FST4W-120 — the WSPR-aligned 2-min slot).
const fst4wWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachFst4wDecoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14095.6');
  if (!Number.isFinite(dialKHz)) dialKHz = 14095.6;
  const periodSec = parseInt(query?.get('period') ?? '120', 10);
  let bytesIn = 0, spotsOut = 0;
  const decoder = new Fst4wDecoder({
    periodSec,
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log(`[fst4w-decoder] session started (period=${periodSec}s)`);
  const hb = setInterval(() => {
    console.log(`[fst4w-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz} period=${periodSec}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/sstv — analog SSTV (Robot/Scottie/Martin/PD/…) via
// the slowrxd binary. Streaming, image-out: client streams 12 kHz
// PCM up, server batches one SSTV transmission per ~90-180 s and
// ships back a base64 PNG when each image completes.
const sstvWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachSstvDecoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14230');
  if (!Number.isFinite(dialKHz)) dialKHz = 14230;
  let bytesIn = 0, imagesOut = 0;
  const decoder = new SstvDecoder({
    dialFreqKHz: () => dialKHz,
    onImage: (img) => {
      imagesOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'image', ...img }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[sstv-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[sstv-decoder] hb bytesIn=${bytesIn} imagesOut=${imagesOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/freedv — open-source HF digital voice (FreeDV) via
// David Rowe's freedv_rx. Streaming, audio-out: client streams 12 kHz
// PCM up, server decimates to 8 kHz, feeds the codec2 modem, and
// streams decoded 8 kHz speech back as raw binary frames. Status
// (sync state, SNR) is interleaved as JSON text messages.
const freedvWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachFreedvDecoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14236');
  if (!Number.isFinite(dialKHz)) dialKHz = 14236;
  const mode = query?.get('mode') ?? '700D';
  let bytesIn = 0, bytesOut = 0;
  const decoder = new FreedvDecoder({
    mode,
    dialFreqKHz: () => dialKHz,
    onAudio: (pcm) => {
      bytesOut += pcm.length;
      if (ws.readyState === WS.OPEN) ws.send(pcm, { binary: true });
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log(`[freedv-decoder] session started (mode=${mode})`);
  const hb = setInterval(() => {
    console.log(`[freedv-decoder] hb bytesIn=${bytesIn} bytesOut=${bytesOut} mode=${decoder.mode} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'mode' && typeof msg.mode === 'string') decoder.setMode(msg.mode);
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/jt4 — JT4 (1-min slot) decoder via `jt9 -4 <wav>`.
//
// Same shape as the JT9 / JT65 endpoints; the wsjt-x jt9 binary
// handles all of them via different flags. JT4 is the EME / weak-
// tropo mode; HF dial spots are sparse but exist.
const jt4Wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachJt4Decoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14078');
  if (!Number.isFinite(dialKHz)) dialKHz = 14078;
  let bytesIn = 0, spotsOut = 0;
  const decoder = new Jt4Decoder({
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[jt4-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[jt4-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/selcal — aviation HF SELCAL decoder via multimon-ng.
// Streaming, text-out: client streams 12 kHz PCM up, bridge resamples
// to 22050 Hz (multimon-ng's expected rate) and pipes through the
// SELCAL demodulator. Decoded 4-letter calls come back as JSON.
const selcalWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachSelcalDecoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '8891');
  if (!Number.isFinite(dialKHz)) dialKHz = 8891;
  let bytesIn = 0, callsOut = 0;
  const decoder = new SelcalDecoder({
    dialFreqKHz: () => dialKHz,
    onCall: (call) => {
      callsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'call', ...call }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[selcal-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[selcal-decoder] hb bytesIn=${bytesIn} callsOut=${callsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/pocsag — POCSAG pager decoder via multimon-ng.
// Same multimon-ng binary as SELCAL; -a POCSAG{512,1200,2400} catches
// all three baud variants. Emits {t:'page', baud, address, fn, kind,
// payload, raw, tsMs} JSON frames.
const pocsagWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachPocsagDecoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '0');
  if (!Number.isFinite(dialKHz)) dialKHz = 0;
  let bytesIn = 0, pagesOut = 0;
  const decoder = new PocsagDecoder({
    dialFreqKHz: () => dialKHz,
    onPage: (page) => {
      pagesOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'page', ...page }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[pocsag-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[pocsag-decoder] hb bytesIn=${bytesIn} pagesOut=${pagesOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/js8 — JS8Call (15-second slot) decoder via js8 binary.
//
// Same shape as the WSPR endpoint: client streams 12 kHz int16 PCM and
// optionally sends `{"t":"dial","kHz":...}` text frames; server batches
// into 15-sec UTC-aligned slots and runs the js8 decoder per slot.
const js8Wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachJs8Decoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '7078');
  if (!Number.isFinite(dialKHz)) dialKHz = 7078;
  let bytesIn = 0, msgsOut = 0;
  const decoder = new Js8Decoder({
    dialFreqKHz: () => dialKHz,
    onSpot: (spot) => {
      msgsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log('[js8-decoder] session started');
  const hb = setInterval(() => {
    console.log(`[js8-decoder] hb bytesIn=${bytesIn} msgsOut=${msgsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── /ws/decode/fst4 — FST4 / FST4W (LF/MF DX) decoder via fst4d.
//
// Same shape as WSPR/JS8: audio in, JSON spots/status out. Period
// length is set via the `?period=120` query parameter (defaults to
// 120 = FST4W-120, 2-min slots). Valid: 60, 120, 300, 900, 1800.
const fst4Wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function attachFst4Decoder(ws, query) {
  let dialKHz = parseFloat(query?.get('dial') ?? '14095.6');
  if (!Number.isFinite(dialKHz)) dialKHz = 14095.6;
  const periodSec = parseInt(query?.get('period') ?? '120', 10);
  let bytesIn = 0, spotsOut = 0;
  const decoder = new Fst4Decoder({
    dialFreqKHz: () => dialKHz,
    periodSec,
    onSpot: (spot) => {
      spotsOut++;
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'spot', ...spot }));
    },
    onStatus: (msg) => {
      if (ws.readyState === WS.OPEN) ws.send(JSON.stringify({ t: 'status', msg }));
    },
  });
  console.log(`[fst4-decoder] session started period=${periodSec}`);
  const hb = setInterval(() => {
    console.log(`[fst4-decoder] hb bytesIn=${bytesIn} spotsOut=${spotsOut} dial=${dialKHz}`);
  }, 60_000);
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.t === 'dial' && Number.isFinite(msg.kHz)) dialKHz = msg.kHz;
        else if (msg?.t === 'trigger') decoder.forceStartNow();
      } catch {}
      return;
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 2) return;
    decoder.feed(new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2));
    bytesIn += buf.length;
  });
  ws.on('close', () => {
    clearInterval(hb);
    decoder.close();
  });
}

// ── WebSocket reverse proxy: /ws/{host}:{port}/<path> → ws://{host}:{port}/<path>
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  // Gate every /ws/* upgrade — covers both decoder bridges (/ws/decode/*)
  // AND the Kiwi audio/waterfall proxy (/ws/<host>:<port>/...). Without
  // this, the server functions as an open Kiwi proxy for anyone who can
  // reach it, billing the bandwidth to the operator.
  if (req.url && req.url.startsWith('/ws/')) {
    const reason = guardDecoderUpgrade(req, socket);
    if (reason) {
      socket.write(`HTTP/1.1 ${reason.code} ${reason.text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
  }
  // Server-side audio decoder endpoint(s) take priority over the Kiwi proxy.
  if (req.url && req.url.startsWith('/ws/decode/cw')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    cwWss.handleUpgrade(req, socket, head, (clientWs) => attachCwDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/rtty-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    rttyFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachRttyFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/rtty')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    rttyWss.handleUpgrade(req, socket, head, (clientWs) => attachRttyDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/psk-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    pskFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachPskFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/psk')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    pskWss.handleUpgrade(req, socket, head, (clientWs) => attachPskDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/wefax')) {
    wefaxWss.handleUpgrade(req, socket, head, (clientWs) => attachWefaxDecoder(clientWs));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/rsid')) {
    rsidWss.handleUpgrade(req, socket, head, (clientWs) => attachRsidDecoder(clientWs));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/packet')) {
    packetWss.handleUpgrade(req, socket, head, (clientWs) => attachPacketDecoder(clientWs));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/wspr15')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    wspr15Wss.handleUpgrade(req, socket, head, (clientWs) => attachWspr15Decoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/wspr')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    wsprWss.handleUpgrade(req, socket, head, (clientWs) => attachWsprDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/pocsag')) {
    const query = new URL(req.url, 'http://x').searchParams;
    pocsagWss.handleUpgrade(req, socket, head, (clientWs) => attachPocsagDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/selcal')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    selcalWss.handleUpgrade(req, socket, head, (clientWs) => attachSelcalDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/freedv')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    freedvWss.handleUpgrade(req, socket, head, (clientWs) => attachFreedvDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/sstv')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    sstvWss.handleUpgrade(req, socket, head, (clientWs) => attachSstvDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/q65')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    q65Wss.handleUpgrade(req, socket, head, (clientWs) => attachQ65Decoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/jt4')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    jt4Wss.handleUpgrade(req, socket, head, (clientWs) => attachJt4Decoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/jt65')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    jt65Wss.handleUpgrade(req, socket, head, (clientWs) => attachJt65Decoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/jt9')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    jt9Wss.handleUpgrade(req, socket, head, (clientWs) => attachJt9Decoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/js8')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    js8Wss.handleUpgrade(req, socket, head, (clientWs) => attachJs8Decoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/fst4w')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    fst4wWss.handleUpgrade(req, socket, head, (clientWs) => attachFst4wDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/fst4')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    fst4Wss.handleUpgrade(req, socket, head, (clientWs) => attachFst4Decoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/wwv-fldigi')) {
    wwvFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachWwvFldigiDecoder(clientWs));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/contestia-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    contestiaFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachContestiaFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/dominoex-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    dominoexFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachDominoexFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/thor-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    thorFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachThorFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/fsq-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    fsqFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachFsqFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/mt63-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    mt63FldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachMt63FldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/throb-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    throbFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachThrobFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/mfsk-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    mfskFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachMfskFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/olivia-fldigi')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    oliviaFldigiWss.handleUpgrade(req, socket, head, (clientWs) => attachOliviaFldigiDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/navtex')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    navtexWss.handleUpgrade(req, socket, head, (clientWs) => attachNavtexDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/ale-2g')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    ale2gWss.handleUpgrade(req, socket, head, (clientWs) => attachAle2gDecoder(clientWs, query));
    return;
  }
  if (req.url && req.url.startsWith('/ws/decode/hfdl')) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    hfdlWss.handleUpgrade(req, socket, head, (clientWs) => attachHfdlDecoder(clientWs, query));
    return;
  }
  const m = (req.url || '').match(/^\/ws\/([\w.-]+):(\d+)(\/.*)?$/);
  if (!m) { socket.destroy(); return; }
  const host = m[1], port = +m[2], upPath = m[3] || '/';
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const upstream = new WS(`ws://${host}:${port}${upPath}`, {
      headers: {
        // QiwiQ-style headers — some Kiwi firmware closes the connection
        // immediately if these aren't present.
        'Origin': 'null',
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 16; SM-S938W Build/BP2A.250605.031.A3; wv) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 ' +
          'Chrome/147.0.7727.55 Mobile Safari/537.36',
        'X-Requested-With': 'com.xplorr.qiwiq',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7,en-US;q=0.6',
      },
      perMessageDeflate: false,
      followRedirects: true,
      maxRedirects: 5,
    });

    const pending = [];
    upstream.on('open', () => {
      for (const m of pending) upstream.send(m.data, { binary: m.isBinary });
      pending.length = 0;
    });

    clientWs.on('message', (data, isBinary) => {
      if (upstream.readyState === WS.OPEN) upstream.send(data, { binary: isBinary });
      else if (upstream.readyState === WS.CONNECTING) pending.push({ data, isBinary });
    });
    upstream.on('message', (data, isBinary) => {
      if (clientWs.readyState === WS.OPEN) clientWs.send(data, { binary: isBinary });
    });
    clientWs.on('ping', (d) => { try { upstream.ping(d); } catch {} });
    clientWs.on('pong', (d) => { try { upstream.pong(d); } catch {} });
    upstream.on('ping', (d) => { try { clientWs.ping(d); } catch {} });
    upstream.on('pong', (d) => { try { clientWs.pong(d); } catch {} });

    const closePair = (code, reason) => {
      try { if (clientWs.readyState !== WS.CLOSED) clientWs.close(code === 1006 ? 1000 : code, reason); } catch {}
      try { if (upstream.readyState !== WS.CLOSED) upstream.close(1000); } catch {}
    };
    clientWs.on('close', closePair);
    upstream.on('close', closePair);
    clientWs.on('error', () => {});
    upstream.on('error', () => {});
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`radiom listening on :${PORT}`);
});
