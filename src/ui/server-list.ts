export interface ServerEntry {
  url: string;       // host:port
  name?: string;
  location?: string;
  antenna?: string;
  users?: string;    // "1/4"
  snr?: string;      // "48,48"
  /** Full surrounding block text — search corpus when fields are empty. */
  description?: string;
  favorite?: boolean;
  custom?: boolean;  // user-added
}

const LS_KEY = 'radiom.servers.v1';
const FAV_KEY = 'radiom.favs.v1';
const FETCHED_KEY = 'radiom.fetched.v5'; // bumped when parser changes
const SEARCH_KEY = 'radiom.serverSearch';


function loadCustom(): ServerEntry[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveCustom(list: ServerEntry[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}
/** Favorites: full ServerEntry per URL so the entry stays self-contained
 *  even after the public list is refreshed. Migrates from the legacy
 *  string-array format (URLs only) on first read. */
function loadFavs(): Map<string, ServerEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'string') {
      const m = new Map<string, ServerEntry>();
      for (const url of raw as string[]) m.set(url, { url, favorite: true });
      return m;
    }
    if (Array.isArray(raw)) {
      const m = new Map<string, ServerEntry>();
      for (const e of raw as ServerEntry[]) if (e?.url) m.set(e.url, { ...e, favorite: true });
      return m;
    }
  } catch {}
  return new Map();
}
function saveFavs(m: Map<string, ServerEntry>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...m.values()]));
}
function loadFetched(): ServerEntry[] {
  try { return JSON.parse(localStorage.getItem(FETCHED_KEY) || '[]'); } catch { return []; }
}
function saveFetched(list: ServerEntry[]) {
  localStorage.setItem(FETCHED_KEY, JSON.stringify(list));
}

/** Neither kiwisdr.com/public/ nor rx.kiwisdr.com sends CORS headers, so we
 *  route through public proxies. We try multiple targets (rx.kiwisdr.com first
 *  — it's the registry; sometimes serves JSON) × multiple proxies. First
 *  successful parse wins. */
async function fetchPublicList(): Promise<ServerEntry[]> {
  // Same-origin paths are proxied by the Vite dev server (see vite.config.ts).
  // External CORS proxies are last-resort fallback for when the app isn't
  // served by the dev server.
  const sources: Array<{ url: string; label: string }> = [
    { url: '/api/kiwi-public', label: 'kiwisdr.com/public (proxy)' },
    { url: '/api/kiwi-rx',     label: 'rx.kiwisdr.com (proxy)' },
    { url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent('http://kiwisdr.com/public/'), label: 'allorigins → public' },
    { url: 'https://corsproxy.io/?' + encodeURIComponent('http://kiwisdr.com/public/'),               label: 'corsproxy.io → public' },
  ];
  const errs: string[] = [];
  for (const s of sources) {
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 15000);
      // cache: 'no-store' bypasses the PWA service worker so a previously
      // cached failure (e.g. 404 from an older deploy) doesn't stick.
      const res = await fetch(s.url, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(tm);
      if (!res.ok) { errs.push(`${s.label}: HTTP ${res.status}`); continue; }
      const body = await res.text();
      const trim = body.trim();
      const list = trim.startsWith('[') || trim.startsWith('{')
        ? parsePublicJson(body)
        : parsePublicHtml(body);
      if (list.length > 0) return list;
      errs.push(`${s.label}: parsed 0 entries (${body.length}B body, starts: ${trim.slice(0, 60).replace(/\s+/g, ' ')})`);
    } catch (e) { errs.push(`${s.label}: ${(e as Error).message}`); }
  }
  throw new Error('all sources failed — ' + errs.join(' | '));
}

/** Parse the rx.kiwisdr.com JSON payload (if available). The exact schema
 *  isn't documented; we accept either an array of records or `{ kiwis: [...] }`
 *  with whichever fields look like host/port/name/location. */
function parsePublicJson(body: string): ServerEntry[] {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return []; }
  const arr = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).kiwis))
      ? (data as { kiwis: unknown[] }).kiwis
      : [];
  const out: ServerEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const url = pickUrl(r);
    if (!url) continue;
    out.push({
      url,
      name: str(r.name) || str(r.title) || url,
      location: str(r.loc) || str(r.location) || str(r.geo),
      antenna: str(r.antenna) || str(r.ant),
    });
  }
  return out;
}

function pickUrl(r: Record<string, unknown>): string | undefined {
  const direct = str(r.url) || str(r.host_port) || str(r.host) ;
  if (direct) {
    const m = direct.match(/^(?:https?:\/\/)?([\w.-]+)(?::(\d+))?\/?/i);
    if (m) return `${m[1]}:${m[2] || '8073'}`;
  }
  const host = str(r.hostname) || str(r.ip);
  const port = num(r.port);
  if (host && port) return `${host}:${port}`;
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && v > 0 ? v : (typeof v === 'string' && /^\d+$/.test(v) ? +v : undefined);
}

/** Parser for the kiwisdr.com/public/ HTML. Each Kiwi is a
 *  `<div class="cl-entry">` containing an anchor + a `.cl-info` block with
 *  HTML comments holding all the metadata (`<!-- name=… --> <!-- loc=… -->`
 *  etc.) — way more reliable than scraping rendered text. */
function parsePublicHtml(html: string): ServerEntry[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: ServerEntry[] = [];
  const seen = new Set<string>();
  const entries = doc.querySelectorAll('.cl-entry');
  for (const entry of Array.from(entries)) {
    const a = entry.querySelector('a[href^="http"]');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    const m = href.match(/^https?:\/\/([\w.-]+)(?::(\d+))?/i);
    if (!m) continue;
    // Default port 80 for proxy URLs that omit it (e.g. NNN.proxy.kiwisdr.com).
    const url = `${m[1]}:${m[2] ?? '80'}`;
    if (seen.has(url)) continue;
    seen.add(url);

    const meta = readMetaComments(entry);
    const cl_name = entry.querySelector('.cl-name')?.textContent?.trim();
    const users = meta.users && meta.users_max ? `${meta.users}/${meta.users_max}` : undefined;
    const description = (entry.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1500);

    out.push({
      url,
      name: cl_name || meta.name || url,
      location: meta.loc,
      antenna: meta.antenna,
      users,
      snr: meta.snr,
      description,
    });
  }
  // Fallback to a generic anchor scan if the structure changed.
  if (out.length === 0) return parsePublicHtmlLoose(doc);
  return out;
}

/** Walk an element's descendant Comment nodes, collecting `key=value` pairs. */
function readMetaComments(root: Element): Record<string, string> {
  const meta: Record<string, string> = {};
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue || '').trim();
    const eq = text.indexOf('=');
    if (eq > 0) meta[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return meta;
}

/** Loose fallback when the page doesn't use `.cl-entry` (older/changed markup). */
function parsePublicHtmlLoose(doc: Document): ServerEntry[] {
  const out: ServerEntry[] = [];
  const seen = new Set<string>();
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const m = (a.getAttribute('href') || '').match(/^https?:\/\/([\w.-]+)(?::(\d+))?/i);
    if (!m) continue;
    const url = `${m[1]}:${m[2] ?? '80'}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const block = a.closest('div, li, tr') ?? a.parentElement ?? a;
    const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
    out.push({ url, name: text.slice(0, 160) || url, description: text.slice(0, 1500) });
  }
  return out;
}

/** Look up a server entry by URL across favorites, fetched and custom lists.
 *  Returns undefined if no info is known. */
export function findServerEntry(url: string): ServerEntry | undefined {
  const favs = loadFavs();
  if (favs.has(url)) return favs.get(url);
  const f = loadFetched().find(s => s.url === url);
  if (f) return f;
  return loadCustom().find(s => s.url === url);
}

export function openServerList(onPick: (url: string, entry?: ServerEntry) => void): void {
  const favs = loadFavs();
  let custom = loadCustom();
  let fetched: ServerEntry[] = loadFetched();
  // Persisted across sessions so the user doesn't have to re-type their
  // last filter every time they re-open the list.
  let filter = localStorage.getItem(SEARCH_KEY) || '';
  let favsOnly = false;

  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `
    <div class="modal-card">
      <div class="modal-bar">
        <input class="srv-search" placeholder="Search list / Add Server …" />
        <button class="btn-favs" title="Show favorites only" aria-pressed="false">★</button>
        <button class="btn-add">Add</button>
        <button class="btn-refresh" title="Fetch live list from kiwisdr.com">↻</button>
        <button class="btn-close" aria-label="close">✕</button>
      </div>
      <div class="srv-list"></div>
    </div>
  `;
  document.body.appendChild(root);

  const search = root.querySelector('.srv-search') as HTMLInputElement;
  // Restore the persisted filter into the input so the UI matches the
  // initial render's `filter` value.
  search.value = filter;
  const list = root.querySelector('.srv-list') as HTMLDivElement;

  const render = () => {
    const seen = new Set<string>();
    const all: ServerEntry[] = [];
    if (favsOnly) {
      for (const s of favs.values()) { seen.add(s.url); all.push(s); }
    } else {
      // Dedupe across favs → fetched → custom by URL; favs win so the
      // stored snapshot (with name/location/etc.) is shown even if the
      // public list dropped the entry.
      for (const s of favs.values()) { if (seen.has(s.url)) continue; seen.add(s.url); all.push(s); }
      for (const s of [...fetched, ...custom]) {
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        all.push(s);
      }
    }
    // favorites first, then by name
    all.sort((a, b) => {
      const af = favs.has(a.url) ? 0 : 1, bf = favs.has(b.url) ? 0 : 1;
      if (af !== bf) return af - bf;
      return (a.name || a.url).localeCompare(b.name || b.url);
    });
    const f = filter.toLowerCase().trim();
    const filtered = f
      ? all.filter(s => [s.url, s.name, s.location, s.antenna, s.users, s.snr, s.description]
          .filter(Boolean).join(' ').toLowerCase().includes(f))
      : all;
    list.innerHTML = filtered.map(s => {
      const stats = [
        s.users ? `Users: ${escapeHtml(s.users)}` : '',
        s.snr ? `SNR: ${escapeHtml(s.snr)}` : '',
      ].filter(Boolean).join(' · ');
      return `
        <div class="srv-row" data-url="${s.url}">
          <button class="srv-fav" data-fav="${s.url}">${favs.has(s.url) ? '★' : '☆'}</button>
          <div class="srv-meta">
            <div class="srv-title">${escapeHtml(s.name || s.url)}</div>
            <div class="srv-sub">${escapeHtml(s.url)}</div>
            ${s.location ? `<div class="srv-sub">Location: ${escapeHtml(s.location)}</div>` : ''}
            ${stats ? `<div class="srv-sub">${stats}</div>` : ''}
            ${s.antenna ? `<div class="srv-sub">Antenna: ${escapeHtml(s.antenna)}</div>` : ''}
            ${s.custom ? `<button class="srv-del" data-del="${s.url}">Remove</button>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div class="srv-empty">No matches.</div>';
  };

  search.addEventListener('input', () => {
    filter = search.value;
    localStorage.setItem(SEARCH_KEY, filter);
    render();
  });

  const findEntry = (url: string): ServerEntry | undefined =>
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
  favsBtn.textContent = favsOnly ? '★' : '☆';

  (root.querySelector('.btn-refresh') as HTMLButtonElement).addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.textContent = '…';
    list.innerHTML = '<div class="srv-empty">Fetching list from kiwisdr.com (via CORS proxy)…</div>';
    try {
      const got = await fetchPublicList();
      fetched = got;
      saveFetched(got);
      // Refresh stored favorites with any newer info from the public list.
      let touched = false;
      for (const s of got) {
        if (favs.has(s.url)) { favs.set(s.url, { ...s, favorite: true }); touched = true; }
      }
      if (touched) saveFavs(favs);
      render();
    } catch (err) {
      list.innerHTML = `<div class="srv-empty">Refresh failed: ${escapeHtml((err as Error).message)}<br><br>Showing built-in list.</div>`;
      setTimeout(render, 2500);
    } finally {
      btn.disabled = false; btn.textContent = '↻';
    }
  });

  (root.querySelector('.btn-add') as HTMLButtonElement).addEventListener('click', () => {
    const url = search.value.trim();
    if (!url || !/^[\w.-]+:\d+$/.test(url)) { search.focus(); return; }
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
