import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import mkcert from 'vite-plugin-mkcert';
import { WebSocketServer, WebSocket as WS } from 'ws';
import { readFileSync } from 'node:fs';

const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string;

/** Custom Kiwi WebSocket proxy built on `ws` so we control every frame the
 *  way QiwiQ does. http-proxy was eating something the Kiwi cared about. */
function kiwiWsProxy(): Plugin {
  return {
    name: 'kiwi-ws-proxy',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

      server.httpServer?.on('upgrade', (req, socket, head) => {
        const m = (req.url || '').match(/^\/ws\/([\w.-]+):(\d+)(\/.*)?$/);
        if (!m) return;

        const host = m[1], port = +m[2], path = m[3] || '/';

        // Accept the browser-side handshake first.
        wss.handleUpgrade(req, socket, head, (clientWs) => {
          // Now open an upstream WS to the Kiwi with QiwiQ-style headers.
          const upstreamUrl = `ws://${host}:${port}${path}`;
          const upstream = new WS(upstreamUrl, {
            headers: {
              'Origin': 'null',
              'User-Agent': 'Mozilla/5.0 (Linux; Android 16; SM-S938W Build/BP2A.250605.031.A3; wv) ' +
                            'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 ' +
                            'Chrome/147.0.7727.55 Mobile Safari/537.36',
              'X-Requested-With': 'com.xplorr.qiwiq',
              'Pragma': 'no-cache',
              'Cache-Control': 'no-cache',
              'Accept-Encoding': 'gzip, deflate',
              'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7,en-US;q=0.6',
            },
            perMessageDeflate: false,
            // Follow 307 redirects (used by NNN.proxy.kiwisdr.com hosts).
            followRedirects: true,
            maxRedirects: 5,
          });

          let opened = false;
          const t0 = Date.now();
          const lifeMs = () => Date.now() - t0;

          // Browser may begin sending frames before upstream is connected.
          // Buffer them so nothing is lost.
          const pending: Array<{ data: WS.Data; isBinary: boolean }> = [];

          upstream.on('open', () => {
            opened = true;
            console.log(`[kiwi-ws] upstream open ${host}:${port}${path}`);
            for (const m of pending) upstream.send(m.data, { binary: m.isBinary });
            pending.length = 0;
          });

          clientWs.on('message', (data, isBinary) => {
            if (upstream.readyState === WS.OPEN) upstream.send(data, { binary: isBinary });
            else if (upstream.readyState === WS.CONNECTING) pending.push({ data, isBinary });
          });
          upstream.on('message', (data, isBinary) => {
            if (clientWs.readyState === WS.OPEN) clientWs.send(data, { binary: isBinary });
          });
          clientWs.on('ping',  (data) => { try { upstream.ping(data);  } catch {} });
          clientWs.on('pong',  (data) => { try { upstream.pong(data);  } catch {} });
          upstream.on('ping',  (data) => { try { clientWs.ping(data);  } catch {} });
          upstream.on('pong',  (data) => { try { clientWs.pong(data);  } catch {} });

          const closePair = (who: string, code: number, reason: Buffer) => {
            console.log(`[kiwi-ws] ${who} close after ${lifeMs()}ms code=${code} reason="${reason.toString()}"`);
            try { if (clientWs.readyState !== WS.CLOSED) clientWs.close(code === 1006 ? 1000 : code, reason); } catch {}
            try { if (upstream.readyState !== WS.CLOSED) upstream.close(1000); } catch {}
          };
          clientWs.on('close', (code, reason) => closePair('client', code, reason));
          upstream.on('close', (code, reason) => closePair('upstream', code, reason));

          clientWs.on('error', (e) => console.log('[kiwi-ws] client error:', e.message));
          upstream.on('error', (e) => console.log(`[kiwi-ws] upstream error after ${opened ? lifeMs()+'ms' : 'never opening'}:`, e.message));
        });
      });
    },
  };
}

// RADIOM_HTTP=1 disables the HTTPS dev server (and skips the mkcert
// plugin). Useful for headless browsers that don't trust the local
// mkcert root CA. The default dev workflow keeps HTTPS so secure-context
// APIs (Web Crypto, MediaDevices, AudioContext on iOS, PWA install)
// match production.
const useHttp = process.env.RADIOM_HTTP === '1';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [
    ...(useHttp ? [] : [mkcert()]),
    kiwiWsProxy(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      devOptions: { enabled: false },
      manifest: {
        name: 'radiom',
        short_name: 'radiom',
        description: 'KiwiSDR web client',
        theme_color: '#0d0d0d',
        background_color: '#0d0d0d',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        icons: [
          { src: '/icon.svg',          sizes: 'any',     type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-maskable.svg', sizes: 'any',     type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}']
      }
    })
  ],
  server: {
    host: true,
    ...(useHttp ? {} : { https: {} }),
    // COOP+COEP enable SharedArrayBuffer, required for onnxruntime-web
    // multi-threaded WASM. Matches the production server.mjs headers.
    headers: {
      'Cross-Origin-Opener-Policy':   'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      // Route Kiwi list proxies through server.mjs (port 8080) so the
      // captcha-solving + caching in fetchKiwiList runs. Hitting
      // kiwisdr.com directly returns a click-captcha stub since 2026.
      '/api/kiwi-public': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      // OpenWebRX directory — receiverbook.de scrape, OpenWebRX-only.
      '/api/owrx-public': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/kiwi-rx': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      // /audio/* served by the Node server (server.mjs) so the audio library
      // isn't bundled into the static client. In dev, run `node server.mjs`
      // alongside `vite` and this proxy forwards to it.
      '/audio': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      // /api/fingerprints — SID signal-fingerprint table served by
      // server.mjs. Same Node-side rationale as /audio above.
      '/api/fingerprints': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/pskreporter': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/eibi': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/nets': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/dxspots': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/dxwatch': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/wsprnet': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/kiwi-status': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      '/api/kiwi-touch': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
      // Decoder WS endpoints (wefax, cw, rtty, psk, navtex, hfdl, wspr,
      // packet, rsid, …) all live on the Node server. Without this
      // proxy, /ws/decode/* connections from the Vite dev server resolve
      // to nothing — the receiver looks live but the FAX panel stays
      // blank, CW prints no chars, etc. `ws: true` enables the WS
      // upgrade pass-through.
      '/ws/decode': {
        target: 'http://localhost:8080',
        changeOrigin: false,
        ws: true,
      },
    },
  }
});
