import type { Mode } from '../kiwi/types';

export interface Preset {
  freqKHz: number;
  mode: Mode;
  lowCut: number;
  highCut: number;
  name?: string;
}

const KEY = 'radiom.presets.v1';

export function loadPresets(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function savePresets(list: Preset[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Insert/replace by exact frequency match. Returns the updated list. */
export function upsertPreset(p: Preset): Preset[] {
  const list = loadPresets();
  const i = list.findIndex(x => x.freqKHz === p.freqKHz);
  if (i >= 0) list[i] = p; else list.push(p);
  list.sort((a, b) => a.freqKHz - b.freqKHz);
  savePresets(list);
  return list;
}

export function deletePresetByFreq(freqKHz: number): Preset[] {
  const list = loadPresets().filter(x => x.freqKHz !== freqKHz);
  savePresets(list);
  return list;
}

export function findPresetByFreq(freqKHz: number): Preset | undefined {
  return loadPresets().find(x => Math.abs(x.freqKHz - freqKHz) < 0.001);
}

/** Index in (sorted) list. Returns -1 if not found. */
export function indexOfFreq(freqKHz: number): number {
  return loadPresets().findIndex(x => Math.abs(x.freqKHz - freqKHz) < 0.001);
}

/** Cycle to next/previous preset given a current freq. Wraps at ends. */
export function cyclePreset(currentKHz: number, dir: 1 | -1): Preset | null {
  const list = loadPresets();
  if (list.length === 0) return null;
  let i = list.findIndex(x => x.freqKHz >= currentKHz);
  if (i < 0) i = list.length; // beyond the last preset → behave like "after last"
  const onExact = i < list.length && Math.abs(list[i].freqKHz - currentKHz) < 0.001;
  let next: number;
  if (dir > 0) next = (onExact ? i + 1 : i) % list.length;
  else         next = (i - 1 + list.length) % list.length;
  return list[next];
}
