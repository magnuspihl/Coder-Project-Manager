import { config } from './config.js';
import { createApp } from './server.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`[mj-bridge] listening on :${config.port}${config.bridgeToken ? ' (token-protected)' : ' (open — set MJ_BRIDGE_TOKEN to protect it)'}`);
  if (!config.publicBaseUrl) {
    console.warn('[mj-bridge] MJ_PUBLIC_BASE_URL is not set — /upload-reference will fail until it is set to this bridge\'s public URL.');
  }
});
