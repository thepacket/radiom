import type { Mode } from '../kiwi/types';

export interface Station {
  kHz: number;
  mode: Mode;
  name: string;
  /** Tolerance for matching, in kHz (default 5). */
  tol?: number;
}

/** Hand-picked common SW broadcast / utility / time stations. Not exhaustive,
 *  but useful for SEEK demos until we parse the Kiwi server's dx_db. */
export const STATIONS: Station[] = [
  { kHz: 2500,  mode: 'amn', name: 'WWV (Time 2.5)' },
  { kHz: 3330,  mode: 'usb', name: 'CHU Canada' },
  { kHz: 5000,  mode: 'amn', name: 'WWV/WWVH 5 MHz' },
  { kHz: 5025,  mode: 'am',  name: 'Radio Rebelde' },
  { kHz: 6000,  mode: 'am',  name: 'CRI English' },
  { kHz: 6080,  mode: 'am',  name: 'Radio NZ Pacific' },
  { kHz: 7200,  mode: 'lsb', name: '40m amateur band' },
  { kHz: 7335,  mode: 'usb', name: 'CHU Canada' },
  { kHz: 9420,  mode: 'am',  name: 'Voice of Greece' },
  { kHz: 9580,  mode: 'am',  name: 'BBC / Radio Australia' },
  { kHz: 9750,  mode: 'am',  name: 'NHK Japan' },
  { kHz: 9955,  mode: 'am',  name: 'WRMI' },
  { kHz: 10000, mode: 'amn', name: 'WWV/WWVH 10 MHz' },
  { kHz: 11500, mode: 'am',  name: 'Radio Habana' },
  { kHz: 11800, mode: 'am',  name: 'RAI Italy' },
  { kHz: 12095, mode: 'am',  name: 'BBC' },
  { kHz: 13362, mode: 'am',  name: 'Radio Martí' },
  { kHz: 14070, mode: 'usb', name: 'PSK31 net (20 m)' },
  { kHz: 14100, mode: 'cw',  name: 'IBP beacons (20 m)' },
  { kHz: 14200, mode: 'usb', name: '20 m amateur SSB' },
  { kHz: 14670, mode: 'usb', name: 'CHU Canada' },
  { kHz: 15000, mode: 'amn', name: 'WWV 15 MHz' },
  { kHz: 15580, mode: 'am',  name: 'Voice of America' },
  { kHz: 17775, mode: 'am',  name: 'KVOH' },
  { kHz: 17830, mode: 'am',  name: 'WHRA' },
  { kHz: 20000, mode: 'amn', name: 'WWV 20 MHz' },
  { kHz: 21000, mode: 'cw',  name: 'IBP beacons (15 m)' },
  { kHz: 28200, mode: 'cw',  name: 'IBP beacons (10 m)' },
];

export function findStationNear(freqKHz: number, defaultTol = 5): Station | null {
  let best: Station | null = null;
  let bestDelta = Infinity;
  for (const s of STATIONS) {
    const delta = Math.abs(s.kHz - freqKHz);
    const tol = s.tol ?? defaultTol;
    if (delta <= tol && delta < bestDelta) { best = s; bestDelta = delta; }
  }
  return best;
}
