export function openLangModal(
  langs: Array<[string, string]>,
  currentCode: string,
  onPick: (code: string) => void,
): void {
  const root = document.createElement('div');
  root.className = 'band-modal lang-modal';
  root.innerHTML = `
    <div class="band-grid lang-grid">
      ${langs.map(([c, l]) => `
        <button class="band-btn lang-btn ${c === currentCode ? 'active' : ''}" data-code="${c}">${l}</button>
      `).join('')}
    </div>
  `;
  document.body.appendChild(root);

  root.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button.band-btn') as HTMLElement | null;
    if (t) {
      onPick(t.dataset.code!);
      root.remove();
      return;
    }
    if (e.target === root) root.remove();
  });
}

export function langLabel(langs: Array<[string, string]>, code: string): string {
  return langs.find(([c]) => c === code)?.[1] ?? code;
}
