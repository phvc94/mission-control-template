// Production entry point: `npm start`, or the Docker image. Configuration comes from MC_* variables (see .env.example).
import {fileURLToPath} from 'node:url';
import {createApp} from './http.mjs';
import {createAuth} from './auth.mjs';
import {configFromEnv} from './config.mjs';
import {createWorkspace, createMissingWorkspace} from './workspace.mjs';
import {createGateway, gatewayConfigFromEnv} from './gateway.mjs';
import {createMonitor} from './monitor.mjs';

let config, server, gateway;
try {
  config = configFromEnv(process.env);
  const {origin, stateDir} = config;
  const workspace = config.workspace ? createWorkspace({root: config.workspace, stateDir}) : createMissingWorkspace();
  // The Gateway's device identity lives in the same state directory the rest of the dashboard uses.
  gateway = createGateway(gatewayConfigFromEnv({...process.env, MC_STATE_DIR: stateDir}));
  const monitor = createMonitor({stateDir, workspaceDir: config.workspace});
  server = createApp({origin, auth: createAuth(config.auth, {origin}), workspace, gateway, monitor, stateDir, publicDir: fileURLToPath(new URL('../public/', import.meta.url))});
} catch (error) {
  // Configuration problems are explained in one line, without a stack trace.
  console.error(`Mission Control cannot start: ${error?.message || error}`);
  process.exit(1);
}
for (const warning of config.warnings) console.warn(`WARNING: ${warning}`);
if (!config.workspace) console.warn('No workspace connected (MC_WORKSPACE is not set): tasks, projects and documents stay empty.');
server.requestTimeout = 30000; server.headersTimeout = 10000;
server.on('error', error => { console.error(`Mission Control cannot listen on ${config.host}:${config.port}: ${error.code || error.message}`); process.exit(1); });
server.listen(config.port, config.host, () => console.log(`Mission Control ready at ${config.origin} (listening on ${config.host}:${config.port}; sign-in: ${config.auth.mode}).`));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  gateway.close?.();
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
