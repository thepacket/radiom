import type { Mode } from '../kiwi/types';

export interface Band {
  name: string;
  loKHz: number;
  hiKHz: number;
  mode: Mode;
}

const BANDS: Band[] = [
  { name: 'LW',   loKHz: 153,    hiKHz: 279,    mode: 'am'  },
  { name: 'MW',   loKHz: 530,    hiKHz: 1700,   mode: 'am'  },
  { name: '160M', loKHz: 1810,   hiKHz: 2000,   mode: 'lsb' },
  { name: '120M', loKHz: 2300,   hiKHz: 2495,   mode: 'am'  },
  { name: '90M',  loKHz: 3200,   hiKHz: 3400,   mode: 'am'  },
  { name: '80M',  loKHz: 3500,   hiKHz: 4000,   mode: 'lsb' },

  { name: '75M',  loKHz: 3900,   hiKHz: 4000,   mode: 'am'  },
  { name: '60M',  loKHz: 5250,   hiKHz: 5450,   mode: 'usb' },
  { name: '49M',  loKHz: 5900,   hiKHz: 6200,   mode: 'am'  },
  { name: '41M',  loKHz: 7200,   hiKHz: 7450,   mode: 'am'  },
  { name: '40M',  loKHz: 7000,   hiKHz: 7300,   mode: 'lsb' },
  { name: '31M',  loKHz: 9400,   hiKHz: 9900,   mode: 'am'  },

  { name: '30M',  loKHz: 10100,  hiKHz: 10150,  mode: 'cw'  },
  { name: '25M',  loKHz: 11600,  hiKHz: 12100,  mode: 'am'  },
  { name: '22M',  loKHz: 13570,  hiKHz: 13870,  mode: 'am'  },
  { name: '20M',  loKHz: 14000,  hiKHz: 14350,  mode: 'usb' },
  { name: '19M',  loKHz: 15100,  hiKHz: 15800,  mode: 'am'  },
  { name: '17M',  loKHz: 18068,  hiKHz: 18168,  mode: 'usb' },

  { name: '16M',  loKHz: 17480,  hiKHz: 17900,  mode: 'am'  },
  { name: '15M',  loKHz: 21000,  hiKHz: 21450,  mode: 'usb' },
  { name: '13M',  loKHz: 21450,  hiKHz: 21850,  mode: 'am'  },
  { name: '12M',  loKHz: 24890,  hiKHz: 24990,  mode: 'usb' },
  { name: '11M',  loKHz: 25600,  hiKHz: 26100,  mode: 'am'  },
  { name: '10M',  loKHz: 28000,  hiKHz: 29700,  mode: 'usb' },
];

export function findBand(freqKHz: number): Band | undefined {
  return BANDS.find(b => freqKHz >= b.loKHz && freqKHz <= b.hiKHz);
}

export function openBandModal(currentKHz: number, onPick: (b: Band) => void): void {
  const active = findBand(currentKHz);
  const root = document.createElement('div');
  root.className = 'band-modal';
  root.innerHTML = `
    <div class="band-grid">
      ${BANDS.map(b => `
        <button class="band-btn ${b === active ? 'active' : ''}" data-name="${b.name}">${b.name}</button>
      `).join('')}
    </div>
  `;
  document.body.appendChild(root);

  root.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
    if (t) {
      const b = BANDS.find(x => x.name === t.dataset.name);
      if (b) { onPick(b); root.remove(); return; }
    }
    if (e.target === root) root.remove();
  });
}
