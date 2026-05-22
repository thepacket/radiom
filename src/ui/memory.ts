/** Channel memory store.
 *
 *  Stores a numbered list of "channels" — frequency / mode / passband /
 *  name. Persisted to localStorage so memories survive reloads. Each
 *  channel has a stable id (independent of frequency) so renaming or
 *  moving a channel doesn't break references.
 *
 *  This supersedes the older `presets.ts` flat-list-keyed-by-frequency
 *  store; the boot path migrates any legacy entries on first load.
 */

import type { Mode } from '../kiwi/types';
import { loadPresets, savePresets } from './presets';

export interface MemoryChannel {
  id: string;
  freqKHz: number;
  mode: Mode;
  lowCut: number;
  highCut: number;
  name: string;
  notes?: string;
  added: number; // epoch ms
}

const KEY = 'radiom.memory.v1';
const MIGRATED_FLAG = 'radiom.memory.v1.migrated';

function newId(): string {
  // 8-char base36 ID — plenty of room for the few-hundred-channel scale
  // we expect, no collision risk in practice.
  return (Math.random().toString(36) + Math.random().toString(36)).slice(2, 10);
}

export function loadMemory(): MemoryChannel[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.map(coerce).filter((x): x is MemoryChannel => x != null);
    }
  } catch { /* ignored */ }
  // First load — migrate old presets.ts entries.
  if (localStorage.getItem(MIGRATED_FLAG) !== '1') {
    const legacy = loadPresets();
    const migrated: MemoryChannel[] = legacy.map(p => ({
      id: newId(),
      freqKHz: p.freqKHz,
      mode: p.mode,
      lowCut: p.lowCut,
      highCut: p.highCut,
      name: p.name ?? '',
      added: Date.now(),
    }));
    localStorage.setItem(MIGRATED_FLAG, '1');
    if (migrated.length) {
      saveMemory(migrated);
      // Wipe the legacy store to avoid double-display once SEEK / preset
      // helpers eventually move to MemoryChannel.
      savePresets([]);
    }
    return migrated;
  }
  return [];
}

export function saveMemory(list: MemoryChannel[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Logbook semantics: every call appends a new entry — no dedup. Same
 *  frequency + mode can appear many times; each capture is its own row
 *  with its own timestamp. Use updateChannel / deleteChannel by id to
 *  edit or remove individual entries. */
export function addChannel(partial: Omit<MemoryChannel, 'id' | 'added'>): MemoryChannel {
  const list = loadMemory();
  const ch: MemoryChannel = { ...partial, id: newId(), added: Date.now() };
  list.push(ch);
  saveMemory(list);
  return ch;
}

export function updateChannel(id: string, patch: Partial<Omit<MemoryChannel, 'id'>>): MemoryChannel | null {
  const list = loadMemory();
  const i = list.findIndex(c => c.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  saveMemory(list);
  return list[i];
}

export function deleteChannel(id: string): void {
  saveMemory(loadMemory().filter(c => c.id !== id));
}

export function exportMemoryJson(): string {
  return JSON.stringify(loadMemory(), null, 2);
}

/** Replace the entire memory store from a JSON payload. Returns the
 *  parsed count or throws on malformed input. */
export function importMemoryJson(text: string): number {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('not an array');
  const coerced = arr.map(coerce).filter((x): x is MemoryChannel => x != null);
  saveMemory(coerced);
  return coerced.length;
}

function coerce(raw: unknown): MemoryChannel | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.freqKHz !== 'number' || !Number.isFinite(r.freqKHz)) return null;
  if (typeof r.mode !== 'string') return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    freqKHz: r.freqKHz,
    mode: r.mode as Mode,
    lowCut: typeof r.lowCut === 'number' ? r.lowCut : -3000,
    highCut: typeof r.highCut === 'number' ? r.highCut : 3000,
    name: typeof r.name === 'string' ? r.name : '',
    notes: typeof r.notes === 'string' ? r.notes : undefined,
    added: typeof r.added === 'number' ? r.added : Date.now(),
  };
}
