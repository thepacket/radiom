/** Backend-access token plumbing.
 *
 *  The server (server.mjs) optionally checks a shared bearer token on every
 *  /ws/decode/* upgrade. To keep each decoder client untouched, we monkey-
 *  patch the global WebSocket constructor at startup so that any URL pointing
 *  at /ws/decode/* automatically picks up `?token=…` from localStorage.
 *
 *  Three token sources, checked once at module load:
 *    1. URL hash  (#token=…)  — used for one-tap onboarding from a shared link;
 *                              the token is persisted to localStorage and the
 *                              fragment is stripped from history.
 *    2. localStorage `radiom.token` — the persistent source after onboarding.
 *    3. (none) — fall through; the server may reject /ws/decode/* upgrades.
 *
 *  The token is *not* sent on /audio/* or other HTTP routes; those are
 *  considered low-cost and remain open.
 */

const STORAGE_KEY = 'radiom.token';

function readHashToken(): string | null {
  if (typeof location === 'undefined' || !location.hash) return null;
  const m = location.hash.match(/(?:^#|&)token=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function consumeHashToken(): void {
  const hashTok = readHashToken();
  if (!hashTok) return;
  try { localStorage.setItem(STORAGE_KEY, hashTok); } catch {}
  // Strip the fragment so reloads don't keep re-storing it and so the URL
  // bar doesn't leak the token onto screenshots / screen-shares.
  const hash = location.hash.replace(/(?:^#|&)token=[^&]+/, '').replace(/^#&/, '#');
  history.replaceState(null, '', location.pathname + location.search + (hash === '#' ? '' : hash));
}

export function getToken(): string {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}

export function setToken(tok: string): void {
  try {
    if (tok) localStorage.setItem(STORAGE_KEY, tok);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/** Install the WebSocket auth shim. Call once, very early. */
export function installWsAuth(): void {
  consumeHashToken();
  const OriginalWS = window.WebSocket;
  const shim = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
    let u = typeof url === 'string' ? url : url.toString();
    // Inject the bearer token on every /ws/* URL — covers both the decoder
    // bridges (/ws/decode/*) and the Kiwi audio proxy (/ws/<host>:<port>/...)
    // so the server can gate both. Pattern is "same-origin /ws/" — we don't
    // touch fully-qualified WSes to third-party services.
    if (/^[^?]*\/ws\//.test(u.replace(/^wss?:\/\/[^/]+/, ''))) {
      const tok = getToken();
      if (tok && !/[?&]token=/.test(u)) {
        u += (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok);
      }
    }
    return new OriginalWS(u, protocols as string | string[] | undefined);
  } as unknown as { -readonly [K in keyof typeof WebSocket]: typeof WebSocket[K] };
  // Preserve readyState constants so `WebSocket.OPEN` etc. still work.
  shim.CONNECTING = OriginalWS.CONNECTING;
  shim.OPEN       = OriginalWS.OPEN;
  shim.CLOSING    = OriginalWS.CLOSING;
  shim.CLOSED     = OriginalWS.CLOSED;
  (shim as unknown as { prototype: WebSocket }).prototype = OriginalWS.prototype;
  window.WebSocket = shim as unknown as typeof WebSocket;
}
