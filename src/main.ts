import './style.css';
import { installLogCapture } from './util/log-capture';
import { installWsAuth } from './util/auth';
import { Shell } from './ui/shell';

// Capture console output into an in-memory ring buffer before anything else
// runs, so Settings → Show Console Logs has a complete history.
installLogCapture();
// Intercept WebSocket construction to auto-attach the backend bearer token
// on /ws/decode/* URLs. Must run before any decoder client is instantiated.
installWsAuth();

new Shell(document.getElementById('app')!);
