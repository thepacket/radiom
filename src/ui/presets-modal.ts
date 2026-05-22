import type { Mode } from '../kiwi/types';
import {
  loadPresets, deletePresetByFreq, upsertPreset, type Preset,
} from './presets';

export interface PresetsModalOpts {
  current: { freqKHz: number; mode: Mode; lowCut: number; highCut: number };
  onPick: (p: Preset) => void;
}

export function openPresetsModal(opts: PresetsModalOpts): void {
  let list = loadPresets();
  const root = document.createElement('div');
  root.className = 'modal';
  root.innerHTML = `
    <div class="modal-card">
      <div class="modal-bar">
        <button class="btn-add">Save current (${formatKHz(opts.current.freqKHz)} ${opts.current.mode.toUpperCase()})</button>
        <button class="btn-close" aria-label="close">✕</button>
      </div>
      <div class="srv-list" id="presets-list"></div>
    </div>
  `;
  document.body.appendChild(root);
  const listEl = root.querySelector('#presets-list') as HTMLElement;

  const render = () => {
    if (list.length === 0) {
      listEl.innerHTML = `<div class="srv-empty">No presets yet.<br>Tap "Save current" to add one.</div>`;
      return;
    }
    listEl.innerHTML = list.map(p => `
      <div class="srv-row" data-freq="${p.freqKHz}">
        <div class="srv-meta">
          <div class="srv-title">${formatKHz(p.freqKHz)} <span class="srv-sub" style="margin-left:8px">${p.mode.toUpperCase()}</span></div>
          <div class="srv-sub">Lo ${p.lowCut} Hz · Hi ${p.highCut} Hz${p.name ? ' · ' + escapeHtml(p.name) : ''}</div>
        </div>
        <button class="srv-del" data-del="${p.freqKHz}">Remove</button>
      </div>
    `).join('');
  };

  listEl.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const delF = t.getAttribute('data-del');
    if (delF) {
      list = deletePresetByFreq(+delF);
      render();
      e.stopPropagation();
      return;
    }
    const row = t.closest('.srv-row') as HTMLElement | null;
    if (row) {
      const p = list.find(x => x.freqKHz === +row.dataset.freq!);
      if (p) { opts.onPick(p); close(); }
    }
  });

  (root.querySelector('.btn-add') as HTMLButtonElement).addEventListener('click', () => {
    upsertPreset({
      freqKHz: opts.current.freqKHz,
      mode: opts.current.mode,
      lowCut: opts.current.lowCut,
      highCut: opts.current.highCut,
    });
    close();
  });
  (root.querySelector('.btn-close') as HTMLButtonElement).addEventListener('click', close);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });

  function close() { root.remove(); }
  render();
}

function formatKHz(k: number): string {
  return k.toFixed(2) + ' kHz';
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}
