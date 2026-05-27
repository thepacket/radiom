// Copyright (c) Andre Paquette
//
// rtl_tcp server picker. There's no central registry for these
// (unlike receiverbook.de for KiwiSDR / OpenWebRX), so the list is
// purely user-curated: type a host:port, tap Add, tap to connect.
// Same minimal modal shape as the Kiwi server-list picker.

export interface RtlEntry {
  /** host:port — e.g. "192.168.1.50:1234". */
  url: string;
  name?: string;
  favorite?: boolean;
}

const LS_KEY = 'radiom.rtl.servers.v1';
const FAV_KEY = 'radiom.rtl.favs.v1';
const SEARCH_KEY = 'radiom.rtl.search';

function loadCustom(): RtlEntry[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function saveCustom(list: RtlEntry[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(list));
}
function loadFavs(): Map<string, RtlEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    if (Array.isArray(raw)) {
      const m = new Map<string, RtlEntry>();
      for (const e of raw as RtlEntry[]) if (e?.url) m.set(e.url, { ...e, favorite: true });
      return m;
    }
  } catch {}
  return new Map();
}
function saveFavs(m: Map<string, RtlEntry>) {
  localStorage.setItem(FAV_KEY, JSON.stringify([...m.values()]));
}

export function findRtlEntry(url: string): RtlEntry | undefined {
  const favs = loadFavs();
  if (favs.has(url)) return favs.get(url);
  return loadCustom().find(s => s.url === url);
}

export function openRtlList(onPick: (url: string, entry?: RtlEntry) => void): void {
  const favs = loadFavs();
  let custom = loadCustom();
  let filter = localStorage.getItem(SEARCH_KEY) || '';

  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `
    <div class="modal-card">
      <div class="modal-bar">
        <input class="srv-search" placeholder="host:port (e.g. 192.168.1.50:1234) — type and tap Add" />
        <button class="btn-add">Add</button>
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
    const all: RtlEntry[] = [];
    for (const s of favs.values()) { if (seen.has(s.url)) continue; seen.add(s.url); all.push(s); }
    for (const s of custom) { if (seen.has(s.url)) continue; seen.add(s.url); all.push(s); }
    all.sort((a, b) => {
      const af = favs.has(a.url) ? 0 : 1, bf = favs.has(b.url) ? 0 : 1;
      if (af !== bf) return af - bf;
      return (a.name || a.url).localeCompare(b.name || b.url);
    });
    const f = filter.toLowerCase().trim();
    const filtered = f
      ? all.filter(s => `${s.url} ${s.name ?? ''}`.toLowerCase().includes(f))
      : all;
    list.innerHTML = filtered.length
      ? filtered.map(s => `
        <div class="srv-row" data-url="${escapeHtml(s.url)}">
          <button class="srv-fav" data-fav="${escapeHtml(s.url)}">${favs.has(s.url) ? '★' : '☆'}</button>
          <div class="srv-meta">
            <div class="srv-title">${escapeHtml(s.name || s.url)}</div>
            <div class="srv-sub">${escapeHtml(s.url)}</div>
            <button class="srv-del" data-del="${escapeHtml(s.url)}">Remove</button>
          </div>
        </div>`).join('')
      : '<div class="srv-empty">No rtl_tcp servers yet. Type host:port above and tap Add.</div>';
  };

  search.addEventListener('input', () => {
    filter = search.value;
    localStorage.setItem(SEARCH_KEY, filter);
    render();
  });

  const findEntry = (url: string): RtlEntry | undefined =>
    favs.get(url) ?? custom.find(s => s.url === url) ?? { url };

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
    if (!custom.some(s => s.url === url)) {
      custom = [...custom, { url, name: url }];
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
