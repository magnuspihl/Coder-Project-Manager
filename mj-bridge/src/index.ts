import { config } from './config.js';
import { createApp } from './server.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`[mj-bridge] listening on :${config.port}${config.bridgeToken ? ' (token-protected)' : ' (open — set MJ_BRIDGE_TOKEN to protect it)'}`);
});
