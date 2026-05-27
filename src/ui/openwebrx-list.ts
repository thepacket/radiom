// Copyright (c) Andre Paquette
//
// OpenWebRX server picker. Parallel to ui/server-list.ts but stores full
// URLs (https://host:port/ws/) rather than host:port pairs, since the WS
// endpoint isn't a fixed format across OpenWebRX deployments.

export interface OwrxEntry {
  /** Receiver web URL — e.g. http://host:port/ . The WS URL is derived
   *  by appending "ws/" (with scheme upgrade ws:→ws / https:→wss). */
  url: string;
  name?: string;
  software?: string;
  /** Receiver categories (HAM / BC / 2W / AIR / MAR / …) scraped from
   *  receiverbook.de bandtag badges. */
  categories?: string[];
  /** Union of bands listed under any category badge. */
  bands?: string[];
  /** From each server's /status.json (best-effort, may be absent). */
  location?: string;
  lat?: number;
  lon?: number;
  asl?: number;
  admin?: string;
  /** SDR connector class names from /status.json `sdrs[].type`
   *  (e.g. `RtlSdrSource`, `AirspySource`, `RxsdrSource`,
   *  `SdrplaySource`, `KiwiSdrSource`). Multiple entries when the
   *  server runs more than one SDR. Absent when the server didn't
   *  expose `sdrs[]` or the scrape failed. */
  sdrTypes?: string[];
  favorite?: boolean;
  custom?: boolean;
}

/** Heuristic — true if every SDR backend on this server is an
 *  RTL-SDR variant. Used to hide low-quality HF receivers from the
 *  picker by default. Direct-sampling RTL on HF is 8-bit, has no
 *  real RF filtering, and is consistently reviewed as the weakest
 *  common OWRX HF backend. Servers running mixed hardware (e.g.
 *  RTL + Airspy) are NOT treated as RTL-only — the operator likely
 *  uses the better rig for HF and reserves the RTL for VHF. */
export function isRtlOnly(e: OwrxEntry): boolean {
  const types = e.sdrTypes;
  if (!types || !types.length) return false;
  return types.every(t => /^rtl/i.test(t));
}

const LS_KEY = 'radiom.owrx.servers.v1';
const FAV_KEY = 'radiom.owrx.favs.v1';
// Bumped to v5: payload now also carries `sdrTypes[]` from each
// server's /status.json `sdrs[].type`. Earlier cached entries lacked
// it, which would have made the RTL-rejection filter dark-list
// everything until the user manually refreshed.
const FETCHED_KEY = 'radiom.owrx.fetched.v5';
const SEARCH_KEY = 'radiom.owrx.serverSearch';
const HIDE_RTL_KEY = 'radiom.owrx.hideRtl';

function loadCustom(): OwrxEntry[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveCustom(list: OwrxEntry[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}
function loadFavs(): Map<string, OwrxEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    if (Array.isArray(raw)) {
      const m = new Map<string, OwrxEntry>();
      for (const e of raw as OwrxEntry[]) if (e?.url) m.set(e.url, { ...e, favorite: true });
      return m;
    }
  } catch {}
  return new Map();
}
function saveFavs(m: Map<string, OwrxEntry>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...m.values()]));
}
function loadFetched(): OwrxEntry[] {
  try { return JSON.parse(localStorage.getItem(FETCHED_KEY) || '[]'); } catch { return []; }
}
function saveFetched(list: OwrxEntry[]) {
  localStorage.setItem(FETCHED_KEY, JSON.stringify(list));
}

/** Derive the WebSocket endpoint from a receiver web URL.
 *  Always routes through our /ws/<host>:<port>/ws/ proxy so an HTTPS-served
 *  page can reach an HTTP-only OpenWebRX without tripping the mixed-content
 *  blocker, and so the upstream sees a Node-side handshake (matters less for
 *  OpenWebRX than KiwiSDR, but it's the same plumbing). */
export function owrxWsUrl(receiverUrl: string): string {
  const m = receiverUrl.match(/^(https?):\/\/([\w.-]+)(?::(\d+))?\/?/i);
  if (!m) return receiverUrl;
  const host = m[2];
  const port = m[3] ? +m[3] : (m[1].toLowerCase() === 'https' ? 443 : 80);
  if (typeof location !== 'undefined') {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/ws/${host}:${port}/ws/`;
  }
  return `ws://${host}:${port}/ws/`;
}

async function fetchPublicList(): Promise<OwrxEntry[]> {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 60_000);  // crawl can take a while on cold cache
  try {
    const r = await fetch('/api/owrx-public', { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    return data as OwrxEntry[];
  } finally { clearTimeout(tm); }
}

export function findOwrxEntry(url: string): OwrxEntry | undefined {
  const favs = loadFavs();
  if (favs.has(url)) return favs.get(url);
  const f = loadFetched().find(s => s.url === url);
  if (f) return f;
  return loadCustom().find(s => s.url === url);
}

export function openOwrxList(onPick: (url: string, entry?: OwrxEntry) => void): void {
  const favs = loadFavs();
  let custom = loadCustom();
  let fetched: OwrxEntry[] = loadFetched();
  let filter = localStorage.getItem(SEARCH_KEY) || '';
  let favsOnly = false;
  // Default ON — hides RTL-SDR-only servers (poor HF performance).
  // Toggle persists across sessions.
  let hideRtl = (localStorage.getItem(HIDE_RTL_KEY) ?? '1') !== '0';

  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `
    <div class="modal-card">
      <div class="modal-bar">
        <input class="srv-search" placeholder="Search (ham+europe …) / Add URL" />
        <button class="btn-favs" title="Show favorites only" aria-pressed="false">★</button>
        <button class="btn-no-rtl" title="Hide RTL-SDR-only servers (typically poor on HF)" aria-pressed="false">noRTL</button>
        <button class="btn-add">Add</button>
        <button class="btn-refresh" title="Fetch live list from receiverbook.de">↻</button>
        <button class="btn-close" aria-label="close">✕</button>
      </div>
      <div class="srv-list"></div>
    </div>
  `;
  document.body.appendChild(root);

  const search = root.querySelector('.srv-search') as HTMLInputElement;
  search.value = filter;
  const list = root.querySelector('.srv-list') as HTMLDivElement;

  const render = () => {
    const seen = new Set<string>();
    const all: OwrxEntry[] = [];
    if (favsOnly) {
      for (const s of favs.values()) { seen.add(s.url); all.push(s); }
    } else {
      for (const s of favs.values()) { if (seen.has(s.url)) continue; seen.add(s.url); all.push(s); }
      for (const s of [...fetched, ...custom]) {
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        all.push(s);
      }
    }
    all.sort((a, b) => {
      const af = favs.has(a.url) ? 0 : 1, bf = favs.has(b.url) ? 0 : 1;
      if (af !== bf) return af - bf;
      return (a.name || a.url).localeCompare(b.name || b.url);
    });
    const f = filter.toLowerCase().trim();
    // Split on "+" so the user can combine substrings with AND
    // semantics — every non-empty term must appear somewhere in the
    // row's searchable text. " " is treated as a separator too so
    // "ham europe" works the same as "ham+europe".
    const terms = f
      ? f.split(/[+\s]+/).map(t => t.trim()).filter(Boolean)
      : [];
    // RTL-rejection — always honoured for fetched entries; favourites
    // are spared so the user can keep a known RTL station they like.
    const rtlFiltered = hideRtl
      ? all.filter(s => favs.has(s.url) || !isRtlOnly(s))
      : all;
    const filtered = terms.length
      ? rtlFiltered.filter(s => {
          const hay = [
            s.url, s.name, s.software,
            (s.categories ?? []).join(' '),
            (s.bands ?? []).join(' '),
            (s.sdrTypes ?? []).join(' '),
            s.location, s.admin,
            s.lat != null ? String(s.lat) : '',
            s.lon != null ? String(s.lon) : '',
          ].filter(Boolean).join(' ').toLowerCase();
          return terms.every(t => hay.includes(t));
        })
      : rtlFiltered;
    list.innerHTML = filtered.map(s => {
      const cats  = (s.categories && s.categories.length) ? s.categories.join(' · ') : '';
      const bands = (s.bands      && s.bands.length)      ? s.bands.join(', ')        : '';
      const locParts = [
        s.location,
        (s.lat != null && s.lon != null) ? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}` : '',
        (s.asl != null) ? `${s.asl} m ASL` : '',
      ].filter(Boolean);
      const loc = locParts.join(' · ');
      return `
      <div class="srv-row" data-url="${escapeHtml(s.url)}">
        <button class="srv-fav" data-fav="${escapeHtml(s.url)}">${favs.has(s.url) ? '★' : '☆'}</button>
        <div class="srv-meta">
          <div class="srv-title">${escapeHtml(s.name || s.url)}</div>
          <div class="srv-sub">${escapeHtml(s.url)}</div>
          ${s.software ? `<div class="srv-sub">${escapeHtml(s.software)}</div>` : ''}
          ${(s.sdrTypes && s.sdrTypes.length)
              ? `<div class="srv-sub">SDR: ${escapeHtml(s.sdrTypes.join(', '))}</div>`
              : ''}
          ${loc   ? `<div class="srv-sub">Location: ${escapeHtml(loc)}</div>`    : ''}
          ${cats  ? `<div class="srv-sub">Categories: ${escapeHtml(cats)}</div>`  : ''}
          ${bands ? `<div class="srv-sub">Bands: ${escapeHtml(bands)}</div>` : ''}
          ${s.admin ? `<div class="srv-sub">Admin: ${escapeHtml(s.admin)}</div>` : ''}
          ${s.custom ? `<button class="srv-del" data-del="${escapeHtml(s.url)}">Remove</button>` : ''}
        </div>
      </div>`;
    }).join('') || '<div class="srv-empty">No matches. Tap ↻ to fetch the public list.</div>';
  };

  search.addEventListener('input', () => {
    filter = search.value;
    localStorage.setItem(SEARCH_KEY, filter);
    render();
  });

  const findEntry = (url: string): OwrxEntry | undefined =>
    favs.get(url)
    ?? fetched.find(s => s.url === url)
    ?? custom.find(s => s.url === url)
    ?? { url };

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

  const favsBtn = root.querySelector('.btn-favs') as HTMLButtonElement;
  favsBtn.addEventListener('click', () => {
    favsOnly = !favsOnly;
    favsBtn.classList.toggle('active', favsOnly);
    favsBtn.setAttribute('aria-pressed', String(favsOnly));
    favsBtn.textContent = favsOnly ? '★' : '☆';
    render();
  });

  const noRtlBtn = root.querySelector('.btn-no-rtl') as HTMLButtonElement;
  noRtlBtn.classList.toggle('active', hideRtl);
  noRtlBtn.setAttribute('aria-pressed', String(hideRtl));
  noRtlBtn.addEventListener('click', () => {
    hideRtl = !hideRtl;
    localStorage.setItem(HIDE_RTL_KEY, hideRtl ? '1' : '0');
    noRtlBtn.classList.toggle('active', hideRtl);
    noRtlBtn.setAttribute('aria-pressed', String(hideRtl));
    render();
  });

  (root.querySelector('.btn-refresh') as HTMLButtonElement).addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.textContent = '…';
    list.innerHTML = '<div class="srv-empty">Crawling receiverbook.de — this can take ~10 s on first hit.</div>';
    try {
      const got = await fetchPublicList();
      fetched = got;
      saveFetched(got);
      let touched = false;
      for (const s of got) {
        if (favs.has(s.url)) { favs.set(s.url, { ...s, favorite: true }); touched = true; }
      }
      if (touched) saveFavs(favs);
      render();
    } catch (err) {
      list.innerHTML = `<div class="srv-empty">Refresh failed: ${escapeHtml((err as Error).message)}</div>`;
      setTimeout(render, 2500);
    } finally {
      btn.disabled = false; btn.textContent = '↻';
    }
  });

  (root.querySelector('.btn-add') as HTMLButtonElement).addEventListener('click', () => {
    const url = search.value.trim();
    if (!url || !/^https?:\/\/[\w.-]+(:\d+)?(\/.*)?$/.test(url)) { search.focus(); return; }
    if (![...fetched, ...custom].some(s => s.url === url)) {
      custom = [...custom, { url, name: url, custom: true }];
      saveCustom(custom);
    }
    search.value = ''; filter = '';
    localStorage.setItem(SEARCH_KEY, '');
    render();
  });

  (root.querySelector('.btn-close') as HTMLButtonElement).addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });

  function close() { root.remove(); }
  render();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
