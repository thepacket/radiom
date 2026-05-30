// Copyright (c) Andre Paquette
//
// Airspy SpyServer picker.
//
// The live directory lives at https://airspy.com/directory/status.json
// and is proxied by the radiom Node server at /api/airspy-list (with a
// 5-minute server-side cache so we don't hammer the upstream). The
// picker fetches that on open, falls back to whatever's in
// localStorage / favourites / a small built-in seed if the network
// call fails, and merges user-curated entries on top.

export interface AirspyEntry {
  /** host:port — e.g. "spy.example.com:5555". */
  url: string;
  /** Display name shown in the picker row. */
  name?: string;
  /** "AirspyHF+" / "AirspyOne" / "RTLSDR" / unknown / etc. */
  deviceType?: string;
  /** Free-text description from the operator. */
  description?: string;
  /** Antenna lat/lon if the operator filed it. */
  lat?: number;
  lon?: number;
  /** Tuner frequency range in Hz, if the directory reports it. */
  minHz?: number;
  maxHz?: number;
  /** Current connected clients / capacity. */
  clients?: number;
  maxClients?: number;
  /** "Registered" servers are operator-vouched; unregistered listings
   *  are anonymous and often flakier. */
  registered?: boolean;
  /** Max session duration in minutes (0 = no cap). */
  maxSession?: number;
  /** Display tag — 'live' (came from the directory this session),
   *  'custom' (user-added), 'seed' (built-in fallback). */
  src?: 'live' | 'custom' | 'seed';
  favorite?: boolean;
}

const LS_KEY     = 'radiom.airspy.servers.v1';
const FAV_KEY    = 'radiom.airspy.favs.v1';
const SEARCH_KEY = 'radiom.airspy.search';
const HAM_KEY    = 'radiom.airspy.hamonly';
const CACHE_KEY  = 'radiom.airspy.directory.cache.v1';
const CACHE_TTL_MS = 10 * 60_000;     // honour our own cache for 10 min

// Amateur-radio callsign matcher (ITU structure): a prefix of two letters,
// a letter+digit, or a digit+letter (covers G, DL, K, 2E0, 9A1, …), then the
// call-area digit, then a 1–4 letter suffix. Used by the "Ham" toggle to keep
// only operator stations whose name/description carries a callsign, filtering
// out the noise of unnamed / broadcast / test listings.
const CALLSIGN_RE = /\b(?:[A-Z]{1,2}|[A-Z]\d|\d[A-Z])\d[A-Z]{1,4}\b/;
function hasCallsign(e: AirspyEntry): boolean {
  const hay = `${e.name ?? ''} ${e.description ?? ''} ${e.url}`.toUpperCase();
  return CALLSIGN_RE.test(hay);
}

// Built-in fallback. Used only when the live fetch fails AND the
// local-cache copy is missing/stale. Kept deliberately small — the
// real list comes from airspy.com/directory at runtime.
const SEED_SERVERS: AirspyEntry[] = [
  { url: 'airspy.us:5555',         name: 'Airspy US Reference',     deviceType: 'AirspyHF+', src: 'seed' },
  { url: 'sdr1.utwente.nl:5555',   name: 'University of Twente',    deviceType: 'AirspyHF+', src: 'seed' },
  { url: 'sdr.ik1xpv.it:5555',     name: 'IK1XPV Italy',            deviceType: 'AirspyHF+', src: 'seed' },
];

function loadCustom(): AirspyEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(arr) ? arr.map(e => ({ ...e, src: 'custom' as const })) : [];
  } catch { return []; }
}
function saveCustom(list: AirspyEntry[]) {
  // Persist only what the user provided; strip the synthesised `src` tag.
  const cleaned = list.map(({ src, favorite, ...rest }) => { void src; void favorite; return rest; });
  localStorage.setItem(LS_KEY, JSON.stringify(cleaned));
}
function loadFavs(): Map<string, AirspyEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    if (Array.isArray(raw)) {
      const m = new Map<string, AirspyEntry>();
      for (const e of raw as AirspyEntry[]) if (e?.url) m.set(e.url, { ...e, favorite: true });
      return m;
    }
  } catch { /* ignore */ }
  return new Map();
}
function saveFavs(m: Map<string, AirspyEntry>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...m.values()].map(({ src, ...rest }) => { void src; return rest; })));
}

function loadDirectoryCache(): AirspyEntry[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj.servers)) return null;
    if (Date.now() - (+obj.ts || 0) > CACHE_TTL_MS) return null;
    return obj.servers as AirspyEntry[];
  } catch { return null; }
}
function saveDirectoryCache(servers: AirspyEntry[]) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), servers })); } catch { /* quota */ }
}

/** Returns whatever entry we can find about `url`, in priority order:
 *  favourites → custom → directory cache → seed. Used by the connect
 *  path to surface the display name in the recent-server log when a
 *  user reconnects from the ↺ picker. */
export function findAirspyEntry(url: string): AirspyEntry | undefined {
  const favs = loadFavs();
  if (favs.has(url)) return favs.get(url);
  const cust = loadCustom().find(s => s.url === url);
  if (cust) return cust;
  const cache = loadDirectoryCache() || [];
  const live = cache.find(s => s.url === url);
  if (live) return live;
  return SEED_SERVERS.find(s => s.url === url);
}

interface DirectoryRow {
  host: string;
  port: number;
  owner?: string;
  deviceType?: string;
  description?: string;
  antenna?: string;
  lat?: number;
  lon?: number;
  minHz?: number;
  maxHz?: number;
  maxClients?: number;
  clients?: number;
  registered?: boolean;
  maxSession?: number;
  maxIqSr?: number;
}

async function fetchDirectory(): Promise<AirspyEntry[] | null> {
  try {
    const r = await fetch('/api/airspy-list');
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j?.servers)) return null;
    const out: AirspyEntry[] = (j.servers as DirectoryRow[]).map((s) => {
      const url = `${s.host}:${s.port}`;
      const tag = s.deviceType || 'unknown';
      const owner = (s.owner || '').trim();
      const desc  = (s.description || '').trim();
      // Build a display name: prefer owner; then description; then url.
      const name = owner || (desc && desc !== 'no description' ? desc : url);
      return {
        url, name,
        deviceType:  s.deviceType,
        description: desc,
        lat:         s.lat,
        lon:         s.lon,
        minHz:       s.minHz,
        maxHz:       s.maxHz,
        clients:     s.clients,
        maxClients:  s.maxClients,
        registered:  !!s.registered,
        maxSession:  s.maxSession,
        src: 'live' as const,
      };
      void tag;
    });
    saveDirectoryCache(out);
    return out;
  } catch {
    return null;
  }
}

function fmtHz(hz?: number): string {
  if (!Number.isFinite(hz) || !hz) return '';
  const v = hz!;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)} GHz`;
  if (v >= 1_000_000)     return `${(v / 1_000_000).toFixed(0)} MHz`;
  if (v >= 1_000)         return `${(v / 1_000).toFixed(0)} kHz`;
  return `${v} Hz`;
}

function rangeLabel(e: AirspyEntry): string {
  if (Number.isFinite(e.minHz) && Number.isFinite(e.maxHz) && e.maxHz! > 0) {
    return `${fmtHz(e.minHz)} – ${fmtHz(e.maxHz)}`;
  }
  return '';
}

function clientsLabel(e: AirspyEntry): string {
  if (e.maxClients == null) return '';
  const used = e.clients ?? 0, cap = e.maxClients ?? 0;
  if (cap <= 0) return '';
  return `${used}/${cap} clients`;
}

export function openAirspyList(onPick: (url: string, entry?: AirspyEntry) => void): void {
  const favs = loadFavs();
  let custom = loadCustom();
  let directory: AirspyEntry[] = loadDirectoryCache() || SEED_SERVERS;
  let loading = !loadDirectoryCache();      // true on first open of the session
  let lastErr = '';
  let filter = localStorage.getItem(SEARCH_KEY) || '';
  let hamOnly = localStorage.getItem(HAM_KEY) === '1';

  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `
    <div class="modal-card">
      <div class="modal-bar">
        <input class="srv-search" placeholder="host:port (e.g. airspy.us:5555) — or filter the live directory" />
        <button class="btn-ham" title="Ham only — show only stations whose name carries an amateur-radio callsign">Ham</button>
        <button class="btn-add">Add</button>
        <button class="btn-refresh" title="Re-fetch the live directory from airspy.com">↺</button>
        <button class="btn-close" aria-label="close">✕</button>
      </div>
      <div class="srv-status"></div>
      <div class="srv-list"></div>
    </div>
  `;
  document.body.appendChild(root);

  const search   = root.querySelector('.srv-search') as HTMLInputElement;
  const list     = root.querySelector('.srv-list') as HTMLDivElement;
  const statusEl = root.querySelector('.srv-status') as HTMLDivElement;
  const hamBtn   = root.querySelector('.btn-ham') as HTMLButtonElement;
  search.value = filter;
  hamBtn.classList.toggle('active', hamOnly);

  const merge = (): AirspyEntry[] => {
    const seen = new Set<string>();
    const all: AirspyEntry[] = [];
    for (const s of favs.values())   { if (!seen.has(s.url)) { seen.add(s.url); all.push(s); } }
    for (const s of custom)           { if (!seen.has(s.url)) { seen.add(s.url); all.push(s); } }
    for (const s of directory)        { if (!seen.has(s.url)) { seen.add(s.url); all.push(s); } }
    return all;
  };

  const updateStatus = () => {
    const liveCount = directory.filter(s => s.src === 'live').length;
    if (loading) {
      statusEl.textContent = 'Fetching live directory from airspy.com …';
    } else if (lastErr) {
      statusEl.textContent = `Live directory fetch failed (${lastErr}). Showing local cache + seed list.`;
    } else if (liveCount) {
      statusEl.textContent = `${liveCount} live SpyServers · favourites and your custom entries are on top.`;
    } else {
      statusEl.textContent = 'No live directory available. Showing local cache + seed list.';
    }
  };

  const render = () => {
    updateStatus();
    const all = merge();
    // Sort: favourites first, then registered+live, then unregistered+live, then custom-only, then seed.
    all.sort((a, b) => {
      const af = favs.has(a.url) ? 0 : 1, bf = favs.has(b.url) ? 0 : 1;
      if (af !== bf) return af - bf;
      const ar = a.registered ? 0 : 1, br = b.registered ? 0 : 1;
      if (ar !== br) return ar - br;
      const ord: Record<string, number> = { live: 0, custom: 1, seed: 2 };
      const at = ord[a.src ?? 'live'] ?? 3, bt = ord[b.src ?? 'live'] ?? 3;
      if (at !== bt) return at - bt;
      return (a.name || a.url).localeCompare(b.name || b.url);
    });
    const f = filter.toLowerCase().trim();
    let filtered = f
      ? all.filter(s => `${s.url} ${s.name ?? ''} ${s.deviceType ?? ''} ${s.description ?? ''}`.toLowerCase().includes(f))
      : all;
    // "Ham" toggle: keep only stations carrying a callsign — but never hide
    // the user's own favourites / custom entries, which they curated on purpose.
    if (hamOnly) filtered = filtered.filter(s => favs.has(s.url) || custom.some(c => c.url === s.url) || hasCallsign(s));
    list.innerHTML = filtered.length
      ? filtered.map(s => {
        const isCustom = custom.some(c => c.url === s.url);
        const tag = s.deviceType ? `<span class="srv-pill">${escapeHtml(s.deviceType)}</span>` : '';
        const reg = s.registered === false ? `<span class="srv-pill srv-pill-anon">anon</span>` : '';
        const cl  = clientsLabel(s);
        const fr  = rangeLabel(s);
        const meta = [cl, fr].filter(Boolean).join(' · ');
        return `
          <div class="srv-row" data-url="${escapeHtml(s.url)}">
            <button class="srv-fav" data-fav="${escapeHtml(s.url)}">${favs.has(s.url) ? '★' : '☆'}</button>
            <div class="srv-meta">
              <div class="srv-title">${escapeHtml(s.name || s.url)} ${tag}${reg}</div>
              <div class="srv-sub">${escapeHtml(s.url)}${meta ? ` · ${escapeHtml(meta)}` : ''}</div>
              ${isCustom ? `<button class="srv-del" data-del="${escapeHtml(s.url)}">Remove</button>` : ''}
            </div>
          </div>`;
      }).join('')
      : '<div class="srv-empty">No SpyServers match. Type host:port above and tap Add, or hit ↺ to re-fetch the directory.</div>';
  };

  search.addEventListener('input', () => {
    filter = search.value;
    localStorage.setItem(SEARCH_KEY, filter);
    render();
  });

  hamBtn.addEventListener('click', () => {
    hamOnly = !hamOnly;
    localStorage.setItem(HAM_KEY, hamOnly ? '1' : '0');
    hamBtn.classList.toggle('active', hamOnly);
    render();
  });

  const findEntry = (url: string): AirspyEntry | undefined =>
    favs.get(url) ?? custom.find(s => s.url === url) ?? directory.find(s => s.url === url) ?? { url };

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const favUrl = t.getAttribute('data-fav');
    const delUrl = t.getAttribute('data-del');
    if (favUrl) {
      if (favs.has(favUrl)) favs.delete(favUrl);
      else favs.set(favUrl, { ...findEntry(favUrl)!, favorite: true });
      saveFavs(favs); render(); return;
    }
    if (delUrl) {
      custom = custom.filter(s => s.url !== delUrl); saveCustom(custom); render(); return;
    }
    const row = t.closest('.srv-row') as HTMLElement | null;
    if (row) {
      const url = row.dataset.url!;
      onPick(url, findEntry(url));
      close();
    }
  });

  (root.querySelector('.btn-add') as HTMLButtonElement).addEventListener('click', () => {
    const url = search.value.trim();
    if (!url || !/^[\w.-]+:\d+$/.test(url)) { search.focus(); return; }
    if (!custom.some(s => s.url === url) && !directory.some(s => s.url === url)) {
      custom = [...custom, { url, name: url, src: 'custom' }];
      saveCustom(custom);
    }
    search.value = ''; filter = '';
    localStorage.setItem(SEARCH_KEY, '');
    render();
  });

  (root.querySelector('.btn-refresh') as HTMLButtonElement).addEventListener('click', () => {
    loading = true; lastErr = '';
    render();
    fetchDirectory().then((rows) => {
      loading = false;
      if (rows) directory = rows;
      else lastErr = 'no response';
      render();
    });
  });

  (root.querySelector('.btn-close') as HTMLButtonElement).addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });

  function close() { root.remove(); }
  render();
  // Kick off a live fetch on every open, unless we have a fresh cache
  // already (10 min TTL — same as the server-side cache, so the picker
  // doesn't fetch twice in a row).
  if (loading) {
    fetchDirectory().then((rows) => {
      loading = false;
      if (rows) directory = rows;
      else lastErr = 'no response';
      render();
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
