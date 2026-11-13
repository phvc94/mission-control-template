import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getGatewayIdentity, loadOrCreateGatewayIdentity } from './gateway-identity.mjs';
import { createGatewayClient, validateGatewayUrl } from './gateway-client.mjs';

const execute = promisify(execFile);
const PAGE_SIZE = 200;
const MAX_PAGES = 25;
const ID = /^[a-z0-9][a-z0-9_-]{0,99}$/i;
const own = (o, key) => Object.prototype.hasOwnProperty.call(o || {}, key);
const list = value => Array.isArray(value) ? value : [];
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : null;
const num = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
const stamp = value => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') { const n = Date.parse(value); if (Number.isFinite(n)) return n; }
  return null;
};

export class GatewayError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = this.statusCode = status;
  }
}

function badInput(message) { throw new GatewayError('INVALID_INPUT', message, 400); }
function requireId(value) {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) badInput('Invalid agent.');
  return value;
}
function requireSession(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^agent:[a-z0-9][a-z0-9_-]{0,99}:[^\s\u0000-\u001f]+$/i.test(value)) badInput('Invalid session identifier.');
  return value;
}
function requireCron(value) {
  if (typeof value !== 'string' || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) badInput('Invalid routine identifier.');
  return value;
}

// CLI warnings may precede JSON. Never include stdout/stderr in a thrown error:
// either may contain private configuration, message text, or provider credentials.
export function parseJsonOutput(output) {
  if (typeof output !== 'string') throw new GatewayError('INVALID_RESPONSE', 'OpenClaw returned a response without valid JSON.');
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const starts = [...clean.matchAll(/(?:^|\n)(?=[\[{])/g)].map(m => m.index + (m[0] === '\n' ? 1 : 0));
  for (const i of starts) {
    try { return JSON.parse(clean.slice(i)); } catch {}
  }
  throw new GatewayError('INVALID_RESPONSE', 'OpenClaw returned a response without valid JSON.');
}

const TIMEOUT_MESSAGE = mutation => mutation ? 'OpenClaw did not confirm the operation in time. Check the current state before trying again.' : 'Collecting data from OpenClaw took too long. Try refreshing.';
const UNAVAILABLE_MESSAGE = mutation => mutation ? 'Could not confirm the operation in OpenClaw. Check the state before repeating it.' : 'Could not collect this information from OpenClaw.';

// Structured failures from the WebSocket client (server/gateway-client.mjs).
// Messages are fixed English literals; Gateway text is only used to classify.
function wsFailure(error, mutation) {
  switch (error.code) {
    case 'GATEWAY_PAIRING_REQUIRED': return new GatewayError('GATEWAY_PAIRING', 'This dashboard is waiting for approval in OpenClaw. Approve its device on the Gateway host.', 503);
    case 'GATEWAY_AUTH_REJECTED': return new GatewayError('GATEWAY_AUTH', 'The OpenClaw Gateway rejected the dashboard credentials. Check the Gateway token configured for Mission Control.', 503);
    case 'GATEWAY_AUTH_RATE_LIMITED': return new GatewayError('GATEWAY_AUTH', 'The OpenClaw Gateway is temporarily refusing connection attempts after failed logins. Wait and try again.', 503);
    case 'GATEWAY_DEVICE_REJECTED': return new GatewayError('GATEWAY_AUTH', 'The OpenClaw Gateway rejected the dashboard device signature. Check the Mission Control identity file.', 503);
    case 'GATEWAY_SCOPE_REJECTED': return new GatewayError('GATEWAY_SCOPE', 'The OpenClaw Gateway did not grant the permissions this dashboard needs. Approve the pending request in OpenClaw.', 503);
    case 'GATEWAY_HANDSHAKE_FAILED': return new GatewayError('GATEWAY_AUTH', 'The OpenClaw Gateway refused the dashboard connection.', 503);
    case 'GATEWAY_PROTOCOL_MISMATCH': return new GatewayError('INCOMPATIBLE', 'This OpenClaw version uses a Gateway protocol this dashboard does not support.', 502);
    case 'GATEWAY_STARTING': return new GatewayError('GATEWAY_UNREACHABLE', 'The OpenClaw Gateway is starting. Try again in a moment.', 503);
    case 'GATEWAY_UNREACHABLE':
    case 'GATEWAY_HANDSHAKE_TIMEOUT': return new GatewayError('GATEWAY_UNREACHABLE', 'Could not connect to the OpenClaw Gateway at the configured address.', 503);
    case 'GATEWAY_TIMEOUT': return new GatewayError('GATEWAY_TIMEOUT', TIMEOUT_MESSAGE(mutation), 504);
    case 'GATEWAY_PAYLOAD_TOO_LARGE': return new GatewayError('INVALID_INPUT', 'The request is larger than the OpenClaw Gateway accepts.', 413);
    case 'GATEWAY_CONNECTION_LOST':
    case 'GATEWAY_CLOSED': return new GatewayError('GATEWAY_UNAVAILABLE', UNAVAILABLE_MESSAGE(mutation), 503);
    case 'GATEWAY_REQUEST_FAILED':
      if (error.detailCode === 'MISSING_SCOPE' || (error.gatewayCode === 'FORBIDDEN' && /missing.scope/i.test(error.message))) return new GatewayError('GATEWAY_SCOPE', 'The dashboard device was approved without a permission this action needs. Approve the scope upgrade in OpenClaw.', 403);
      if (error.gatewayCode === 'UNAVAILABLE' && !/unknown method/i.test(error.message)) return new GatewayError('GATEWAY_UNAVAILABLE', UNAVAILABLE_MESSAGE(mutation), 503);
      return null; // classify the Gateway's own message below
    default: return null;
  }
}

function safeFailure(error, mutation = false) {
  if (error instanceof GatewayError) return error;
  if (['GATEWAY_DEVICE_UNAVAILABLE', 'GATEWAY_DEVICE_INVALID'].includes(error?.code)) return new GatewayError('GATEWAY_AUTH', 'The dashboard connection identity needs to be checked.', 503);
  if (error?.name === 'GatewayClientError') { const mapped = wsFailure(error, mutation); if (mapped) return mapped; }
  const description = `${error?.stderr || ''} ${error?.message || ''}`;
  if (/unknown method|method not found|not implemented/i.test(description)) return new GatewayError('UNSUPPORTED', 'This operation is not supported by the installed OpenClaw version.', 501);
  if (/base hash|revision.conflict|config.*changed|expectedConfigRevision|another lifecycle mutation/i.test(description)) return new GatewayError('CONFLICT', 'The data changed while you were editing. Refresh the page before saving again.', 409);
  if (/unauthorized|forbidden|missing.scope|pairing required|authentication/i.test(description)) return new GatewayError('GATEWAY_AUTH', 'The Gateway did not authorize the dashboard connection. The internal authentication needs to be checked.', 503);
  if (/invalid.*params|schema validation/i.test(description)) return new GatewayError('INCOMPATIBLE', 'The installed version rejected the operation format. No result was confirmed.', 502);
  if (error?.killed || error?.code === 'ETIMEDOUT' || /timeout|timed out/i.test(description)) return new GatewayError('GATEWAY_TIMEOUT', TIMEOUT_MESSAGE(mutation), 504);
  return new GatewayError('GATEWAY_UNAVAILABLE', UNAVAILABLE_MESSAGE(mutation), 503);
}

function startupError(code, message) { const error = new Error(message); error.code = code; return error; }

function readToken(env) {
  const check = value => {
    const token = value.trim();
    if (!token || token.length > 65_536 || /[\u0000\r\n]/.test(token)) throw startupError('GATEWAY_CREDENTIAL_INVALID', 'The Gateway connection credential has an invalid format.');
    return token;
  };
  if (env.MC_GATEWAY_TOKEN) return check(env.MC_GATEWAY_TOKEN);
  if (env.MC_GATEWAY_TOKEN_FILE) {
    let contents;
    try { contents = readFileSync(env.MC_GATEWAY_TOKEN_FILE, 'utf8'); }
    catch {
      // Fall back to OPENCLAW_GATEWAY_TOKEN when the file is not readable by this process.
      if (env.OPENCLAW_GATEWAY_TOKEN) return check(env.OPENCLAW_GATEWAY_TOKEN);
      throw startupError('GATEWAY_CREDENTIAL_UNREADABLE', 'The Gateway connection credential is not available to the service.');
    }
    if (contents.length > 70_000) throw startupError('GATEWAY_CREDENTIAL_INVALID', 'The Gateway connection credential has an invalid format.');
    return check(contents);
  }
  if (env.OPENCLAW_GATEWAY_TOKEN) return check(env.OPENCLAW_GATEWAY_TOKEN);
  return null; // a Gateway in auth mode "none" or behind identity-aware ingress
}

/**
 * Gateway options from the environment, for createGateway(gatewayConfigFromEnv()).
 * Without MC_GATEWAY_URL nothing changes: the in-image 'runtime' transport is used.
 * MC_GATEWAY_URL            ws://127.0.0.1:18789 or wss://gateway.example.ts.net
 * MC_GATEWAY_TOKEN          shared Gateway token (or MC_GATEWAY_TOKEN_FILE, Docker-secrets style)
 * MC_GATEWAY_DEVICE_FILE    optional existing Ed25519 identity; otherwise
 * MC_STATE_DIR              holds gateway-device.json, created on first start (0600)
 * MC_GATEWAY_ALLOW_PRIVATE_WS=1  allow ws:// to Docker service names and host.docker.internal
 * The token is returned behind a function so spreading or logging the
 * options never prints it.
 */
export function gatewayConfigFromEnv(env = process.env) {
  const raw = typeof env.MC_GATEWAY_URL === 'string' ? env.MC_GATEWAY_URL.trim() : '';
  if (!raw) return {};
  let url;
  try { url = validateGatewayUrl(raw, { allowPrivateNames: env.MC_GATEWAY_ALLOW_PRIVATE_WS === '1' }); }
  catch (error) { throw startupError(error.code, error.message); }
  const secret = readToken(env);
  const identity = loadOrCreateGatewayIdentity({ file: env.MC_GATEWAY_DEVICE_FILE || undefined, stateDir: env.MC_STATE_DIR });
  return { transport: 'ws', url, token: () => secret, identity, allowPrivateNames: env.MC_GATEWAY_ALLOW_PRIVATE_WS === '1' };
}

function defaultLog(message) { process.stderr.write(`${message}\n`); }

function effectiveModel(value) {
  if (typeof value === 'string') return { primary: str(value), fallbacks: null };
  const v = record(value);
  return { primary: str(v.primary), fallbacks: Array.isArray(v.fallbacks) ? v.fallbacks.map(x => str(x)).filter(Boolean) : null };
}

function modelKey(model) {
  const id = str(model.key || model.id);
  const provider = str(model.provider, 100);
  return id && provider && !id.includes('/') ? `${provider}/${id}` : id;
}

function configuredFallbacks(config, agentId) {
  const agents = record(config.agents);
  const entries = record(agents.entries);
  const agent = own(entries, agentId) ? entries[agentId] : list(agents.list).find(a => a.id === agentId);
  if (!agent) return { fallbacks: null, fallbackSource: 'unknown' };
  if (Array.isArray(agent.model?.fallbacks)) return { fallbacks: agent.model.fallbacks.map(x => str(x)).filter(Boolean), fallbackSource: 'agent' };
  if (Array.isArray(agents.defaults?.model?.fallbacks)) return { fallbacks: agents.defaults.model.fallbacks.map(x => str(x)).filter(Boolean), fallbackSource: 'defaults' };
  return { fallbacks: [], fallbackSource: 'none' };
}

function projectSession(s) {
  const key = str(s.key, 512);
  const provider = str(s.modelProvider, 100);
  const rawModel = str(s.model);
  return {
    key, id: str(s.sessionId || s.id), agentId: str(s.agentId || key?.split(':')[1], 100),
    label: str(s.label || s.displayName, 200), kind: str(s.classification || s.kind, 50),
    channel: str(s.channel, 50), updatedAt: stamp(s.updatedAt), lastInteractionAt: stamp(s.lastInteractionAt),
    totalTokens: num(s.totalTokens), totalTokensFresh: bool(s.totalTokensFresh),
    inputTokens: num(s.inputTokens), outputTokens: num(s.outputTokens), contextTokens: num(s.contextTokens),
    model: rawModel && provider && !rawModel.includes('/') ? `${provider}/${rawModel}` : rawModel,
    modelProvider: provider, status: str(s.status, 50), active: s.hasActiveRun === true,
    archived: s.archived === true, abortedLastRun: bool(s.abortedLastRun),
    startedAt: stamp(s.startedAt), endedAt: stamp(s.endedAt), runtimeMs: num(s.runtimeMs),
  };
}

function projectSchedule(value) {
  const s = record(value);
  if (s.kind === 'cron') return { kind: 'cron', expr: str(s.expr, 200), tz: str(s.tz, 100), staggerMs: num(s.staggerMs) };
  if (s.kind === 'every') return { kind: 'every', everyMs: num(s.everyMs), anchorMs: num(s.anchorMs) };
  if (s.kind === 'at') return { kind: 'at', at: str(s.at, 100) };
  return { kind: str(s.kind, 50) || 'unknown' }; // never leak command/script payloads
}

function projectRoutine(j) {
  const state = record(j.state);
  return {
    id: str(j.id, 200), name: str(j.displayName || j.name, 200), agentId: str(j.effectiveAgentId || j.agentId, 100),
    enabled: bool(j.enabled), schedule: projectSchedule(j.schedule),
    lastRunAt: stamp(j.lastRunAtMs ?? state.lastRunAtMs ?? j.lastRunAt),
    nextRunAt: stamp(j.nextRunAtMs ?? state.nextRunAtMs ?? j.nextRunAt),
    lastStatus: str(j.lastRunStatus ?? state.lastRunStatus ?? state.lastStatus, 50),
    lastDurationMs: num(state.lastDurationMs), consecutiveErrors: num(state.consecutiveErrors),
    deliveryStatus: str(j.lastDeliveryStatus ?? state.lastDeliveryStatus, 50),
    hasError: Boolean(j.lastRunError || state.lastError),
    configRevision: str(j.configRevision, 200),
  };
}

function projectRun(r, id) {
  return {
    id: str(r.runId || r.id, 200), routineId: str(r.jobId || id, 200),
    at: stamp(r.runAtMs ?? r.ts), finishedAt: stamp(r.ts), durationMs: num(r.durationMs),
    status: str(r.status || r.completionStatus, 50), deliveryStatus: str(r.deliveryStatus, 50),
    hasError: Boolean(r.error), error: r.error ? 'The run recorded a failure. The dashboard does not expose the raw text.' : null,
    sessionKey: str(r.sessionKey, 512), sessionId: str(r.sessionId),
    model: str(r.model), provider: str(r.provider, 100),
    usage: { inputTokens: num(r.usage?.input_tokens ?? r.usage?.inputTokens), outputTokens: num(r.usage?.output_tokens ?? r.usage?.outputTokens), totalTokens: num(r.usage?.total_tokens ?? r.usage?.totalTokens) },
  };
}

function projectChannels(response) {
  return Object.entries(record(response.channelAccounts)).flatMap(([channel, accounts]) => list(accounts).map(a => ({
    id: `${channel}:${str(a.accountId, 100) || 'unknown'}`, channel: str(channel, 100), accountId: str(a.accountId, 100),
    name: str(a.name || a.accountId, 200), configured: bool(a.configured), enabled: bool(a.enabled),
    running: bool(a.running), connected: bool(a.connected), reconnectAttempts: num(a.reconnectAttempts),
    lastConnectedAt: stamp(a.lastConnectedAt), lastStartAt: stamp(a.lastStartAt), lastStopAt: stamp(a.lastStopAt),
    lastInboundAt: stamp(a.lastInboundAt), lastOutboundAt: stamp(a.lastOutboundAt),
    activeRuns: num(a.activeRuns), hasError: Boolean(a.lastError), lifecycle: str(a.lifecycle, 50),
    lastError: a.lastError ? 'The channel reported a failure; raw details were omitted.' : null,
  })));
}

function projectQueues(queue) {
  return list(queue).filter(isRecord).map(q => ({
    queue: str(q.queueName, 100), channel: str(q.channelId, 100), accountId: str(q.accountId, 100),
    count: num(q.count), oldestFailedAt: stamp(q.oldestFailedAt),
  })).filter(q => q.count !== null);
}

function projectHealth(response) {
  const e = record(response.eventLoop);
  const countQueues = queue => Array.isArray(queue) ? queue.reduce((n, q) => n + (num(q.count) || 0), 0) : null;
  return {
    ok: bool(response.ok), checkedAt: stamp(response.ts), durationMs: num(response.durationMs),
    heartbeatSeconds: num(response.heartbeatSeconds),
    eventLoop: {
      degraded: bool(e.degraded), delayP99Ms: num(e.delayP99Ms), delayMaxMs: num(e.delayMaxMs),
      utilization: num(e.utilization), cpuCoreRatio: num(e.cpuCoreRatio), intervalMs: num(e.intervalMs),
    },
    failedDeliveries: countQueues(response.deliveryQueues?.failed),
    failedIngress: countQueues(response.deliveryQueues?.ingressFailed),
    // Per-queue detail: which queue/channel/account failed and since when. No message content.
    deliveryQueues: {
      failed: projectQueues(response.deliveryQueues?.failed),
      ingressFailed: projectQueues(response.deliveryQueues?.ingressFailed),
    },
    pluginsLoaded: Array.isArray(response.plugins?.loaded) ? response.plugins.loaded.length : null,
    pluginErrors: Array.isArray(response.plugins?.errors) ? response.plugins.errors.length : null,
  };
}

function validateSchedule(value) {
  const s = record(value);
  if (s.kind === 'cron') {
    if (typeof s.expr !== 'string' || !s.expr.trim() || s.expr.length > 200 || /[\r\n\u0000]/.test(s.expr)) badInput('Invalid cron expression.');
    const out = { kind: 'cron', expr: s.expr.trim() };
    if (s.tz !== undefined) {
      if (typeof s.tz !== 'string' || s.tz.length > 100) badInput('Invalid time zone.');
      try { new Intl.DateTimeFormat('en-US', { timeZone: s.tz }); } catch { badInput('Invalid time zone.'); }
      out.tz = s.tz;
    }
    if (s.staggerMs !== undefined && s.staggerMs !== null) {
      if (!Number.isSafeInteger(s.staggerMs) || s.staggerMs < 0) badInput('Invalid schedule stagger.');
      out.staggerMs = s.staggerMs;
    }
    return out;
  }
  if (s.kind === 'every') {
    if (!Number.isSafeInteger(s.everyMs) || s.everyMs < 1000) badInput('The interval must be at least one second.');
    const out = { kind: 'every', everyMs: s.everyMs };
    if (s.anchorMs !== undefined && s.anchorMs !== null) {
      if (!Number.isSafeInteger(s.anchorMs) || s.anchorMs < 0) badInput('Invalid interval anchor.');
      out.anchorMs = s.anchorMs;
    }
    return out;
  }
  if (s.kind === 'at' && stamp(s.at)) return { kind: 'at', at: new Date(stamp(s.at)).toISOString() };
  throw new GatewayError('UNSUPPORTED_SCHEDULE', 'This kind of schedule cannot be edited on this screen.', 501);
}

/**
 * OpenClaw 2026.9.4 adapter. Transports:
 * - 'ws': persistent WebSocket to MC_GATEWAY_URL from anywhere (another
 *   container, another machine over Tailscale or an SSH tunnel);
 * - 'runtime': inside the OpenClaw image, loads the installed gateway SDK once;
 * - 'cli': execFile-compatible runner (fixtures/diagnostics), never a shell.
 * Snapshot values are projections, never gateway config, transcript, or cron payload.
 */
export function createGateway({
  command = 'node', argsPrefix = ['/app/openclaw.mjs'], runner = execute,
  url = null, token = null, identity = null, client = null, WebSocketImpl, allowPrivateNames = false,
  autoStart = !client, log = defaultLog,
  transport = url || client ? 'ws' : runner === execute && command === 'node' && argsPrefix.length === 1 && argsPrefix[0] === '/app/openclaw.mjs' ? 'runtime' : 'cli',
  runtimeLoader = () => import(process.env.MC_GATEWAY_SDK || '/app/dist/plugin-sdk/gateway-runtime.js'),
  identityLoader = getGatewayIdentity,
  cacheTtlMs = 60_000, now = Date.now,
} = {}) {
  if (!['runtime', 'cli', 'ws'].includes(transport)) throw new GatewayError('INVALID_TRANSPORT', 'Invalid OpenClaw transport.', 500);
  let cached = null;
  let inFlight = null;
  let cacheExpires = 0;
  let generation = 0;
  let runtimePromise;
  let wsClient = null;
  if (transport === 'ws') {
    // Logged once per change: no token, no Gateway text, only fixed messages,
    // the URL origin and the public device/request identifiers.
    let lastLogged = null;
    const onStateChange = s => {
      const key = s.connected ? 'ready' : s.pairing ? `pairing:${s.pairing.requestId}` : s.error ? `error:${s.error.code}` : null;
      if (!key || key === lastLogged) return;
      lastLogged = key;
      if (s.connected) log(`OpenClaw Gateway connected (${s.url}).`);
      else if (s.pairing) log(`OpenClaw Gateway pairing required for device ${s.deviceId}. ${s.pairing.hint}`);
      else log(`OpenClaw Gateway connection problem (${s.url}): ${s.error.message}`);
    };
    wsClient = client || createGatewayClient({
      url, token: typeof token === 'function' ? token() : token, identity: identity || identityLoader(),
      WebSocketImpl, allowPrivateNames, onStateChange,
    });
    if (autoStart) wsClient.start();
  }
  const connection = () => wsClient ? wsClient.status() : null;

  async function cli(args, { timeoutMs = 25_000, mutation = false } = {}) {
    try {
      const result = await runner(command, [...argsPrefix, ...args], {
        encoding: 'utf8', timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024,
        windowsHide: true, shell: false,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', OPENCLAW_NO_BANNER: '1' },
      });
      return parseJsonOutput(typeof result === 'string' ? result : result.stdout);
    } catch (error) { throw safeFailure(error, mutation); }
  }
  async function rpc(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs || 20_000;
    if (transport === 'ws') {
      try { return await wsClient.request(method, params, { timeoutMs }); }
      catch (error) { throw safeFailure(error, options.mutation); }
    }
    if (transport === 'runtime') {
      try {
        // A missing installation must remain an explicit deployment error,
        // never silently fall back to six fresh CLI processes per collection.
        runtimePromise ||= runtimeLoader();
        const runtime = await runtimePromise;
        if (typeof runtime.callGatewayFromCli !== 'function') throw new GatewayError('UNSUPPORTED_RUNTIME', 'The installed version does not export the expected RPC client.', 501);
        return await runtime.callGatewayFromCli(method, { json: true, timeout: String(timeoutMs) }, params, {
          sharedStateMode: 'read-only', progress: false,
          deviceIdentity: identityLoader(), useStoredDeviceAuth: false,
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          clientName: 'gateway-client', mode: 'backend',
        });
      } catch (error) { throw safeFailure(error, options.mutation); }
    }
    return cli(['gateway', 'call', method, '--json', '--timeout', String(timeoutMs), '--params', JSON.stringify(params)], { ...options, timeoutMs: timeoutMs + 2_000 });
  }
  async function modelsCatalog() { return rpc('models.list', { view: 'default', includeDetails: true }); }
  async function paged(method, property, params) {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await rpc(method, { ...params, limit: PAGE_SIZE, offset });
      rows.push(...list(response[property]));
      if (!response.hasMore) return rows;
      if (!Number.isInteger(response.nextOffset) || response.nextOffset <= offset) throw new GatewayError('INVALID_PAGINATION', 'OpenClaw returned inconsistent pagination.');
      offset = response.nextOffset;
    }
    throw new GatewayError('TOO_MANY_RECORDS', 'There are more records than this collection can read. No partial total is presented as complete.');
  }
  async function sessions() {
    return (await paged('sessions.list', 'sessions', {
      includeDerivedTitles: false, includeLastMessage: false,
      configuredAgentsOnly: true, archived: 'all',
    })).map(projectSession);
  }
  function invalidate() { cached = null; cacheExpires = 0; generation++; }
  // Connection state is always current, even when the data comes from cache.
  const fresh = result => ({ ...structuredClone(result), connection: connection() });
  async function snapshot({ force = false } = {}) {
    if (!force && cached && now() < cacheExpires) return fresh(cached);
    if (inFlight) return fresh(await inFlight);
    inFlight = (async () => {
      const collectedGeneration = generation;
      const sources = [
        ['agents', () => rpc('agents.list')],
        ['models', modelsCatalog],
        ['sessions', sessions],
        ['routines', () => paged('cron.list', 'jobs', { includeDisabled: true, compact: true, includeDeliveryPreviews: false })],
        ['channels', () => rpc('channels.status', { probe: false })],
        ['health', () => rpc('health')],
      ];
      const values = await Promise.allSettled(sources.map(([, run]) => run()));
      const data = {}, errors = [];
      values.forEach((result, index) => {
        const source = sources[index][0];
        if (result.status === 'fulfilled') data[source] = result.value;
        else { const e = safeFailure(result.reason); errors.push({ source, code: e.code, message: e.message }); }
      });
      // agents.list normally returns effective alternatives. Resolve omitted
      // alternatives only when needed; never assume null means disabled.
      const fallbackResolution = new Map();
      const unresolved = list(data.agents?.agents).filter(a => effectiveModel(a.model).fallbacks === null);
      if (unresolved.length) {
        try {
          const response = await rpc('config.get');
          if (response.valid === false) throw new GatewayError('INVALID_CONFIG', 'The OpenClaw configuration needs review before the fallbacks can be confirmed.');
          for (const a of unresolved) fallbackResolution.set(a.id, configuredFallbacks(record(response.config), a.id));
        } catch (failure) {
          const e = safeFailure(failure);
          errors.push({ source: 'agentFallbacks', code: e.code, message: e.message });
        }
      }
      const projectedSessions = data.sessions || [];
      const models = list(data.models?.models).map(m => ({
        id: modelKey(m), name: str(m.name || m.key || m.id, 200),
        provider: str(m.provider || (m.key || m.id || '').split('/')[0], 100),
        contextWindow: num(m.contextWindow), available: bool(m.available), local: bool(m.local),
        configured: list(m.tags).some(tag => tag === 'configured' || tag === 'default' || String(tag).startsWith('fallback#')),
      })).filter(m => m.id);
      const health = data.health ? projectHealth(data.health) : null;
      const agents = list(data.agents?.agents).map(a => {
        const agentSessions = projectedSessions.filter(s => s.agentId === a.id).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
        const latest = agentSessions[0];
        const configured = effectiveModel(a.model);
        const fallback = fallbackResolution.get(a.id) || { fallbacks: configured.fallbacks, fallbackSource: configured.fallbacks === null ? 'unknown' : 'gateway' };
        const model = models.find(m => m.id === configured.primary);
        return {
          id: str(a.id, 100), name: str(a.identity?.name || a.name || a.id, 200), emoji: str(a.identity?.emoji, 20),
          model: configured.primary, ...fallback, fallbacksKnown: fallback.fallbacks !== null, workspace: str(a.workspace, 1000),
          status: !data.sessions ? 'unknown' : agentSessions.some(s => s.active) ? 'active' : 'idle',
          lastActiveAt: latest?.updatedAt || null, sessionCount: data.sessions ? agentSessions.length : null,
          activeSessionCount: data.sessions ? agentSessions.filter(s => s.active).length : null,
          contextWindow: model?.contextWindow ?? null, latestSession: latest ? { ...latest } : null,
        };
      }).filter(a => a.id);
      const result = {
        agents, models, sessions: projectedSessions,
        channels: data.channels ? projectChannels(data.channels) : [],
        routines: list(data.routines).map(projectRoutine), health, errors,
        collectedAt: new Date(now()).toISOString(),
        source: 'openclaw', transport, cacheTtlMs,
      };
      // Waiting for approval or for the Gateway to come back: keep retrying
      // soon instead of serving the failure for a whole cache period.
      const ttl = wsClient && !wsClient.status().connected && errors.length ? Math.min(cacheTtlMs, 5_000) : cacheTtlMs;
      if (generation === collectedGeneration) { cached = result; cacheExpires = now() + ttl; }
      return result;
    })();
    try { return fresh(await inFlight); } finally { inFlight = null; }
  }

  async function requireAgent(agentId) {
    requireId(agentId);
    const response = await rpc('agents.list');
    const agent = list(response.agents).find(a => a.id === agentId);
    if (!agent) throw new GatewayError('NOT_FOUND', 'The agent is not configured in OpenClaw.', 404);
    return agent;
  }

  async function cronRuns(id, { limit = 40, offset = 0 } = {}) {
    requireCron(id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0) badInput('Invalid history pagination.');
    const response = await rpc('cron.runs', { id, limit, offset, sortDir: 'desc' });
    return {
      id, entries: list(response.entries).map(r => projectRun(r, id)),
      total: num(response.total), hasMore: response.hasMore === true, nextOffset: num(response.nextOffset),
    };
  }

  async function getCron(id) {
    requireCron(id);
    const response = await rpc('cron.get', { id });
    const current = response.job || response;
    if (current.id !== id) throw new GatewayError('NOT_FOUND', 'Routine not found.', 404);
    return projectRoutine(current);
  }

  async function updateCron(id, patch) {
    requireCron(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) badInput('Invalid routine change.');
    const allowed = ['name', 'enabled', 'schedule', 'expectedConfigRevision'];
    if (Object.keys(patch).some(k => !allowed.includes(k))) badInput('Only the name, schedule and enabled state can be changed on this screen.');
    const safePatch = {};
    if (own(patch, 'name')) {
      if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 200) badInput('Invalid routine name.');
      safePatch.name = patch.name.trim();
    }
    if (own(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') badInput('Invalid routine state.');
      safePatch.enabled = patch.enabled;
    }
    if (own(patch, 'schedule')) safePatch.schedule = validateSchedule(patch.schedule);
    if (!Object.keys(safePatch).length) badInput('No change was provided.');
    // Fetch only on edit: compact list deliberately omits revision and payload.
    const currentResponse = await rpc('cron.get', { id });
    const current = currentResponse.job || currentResponse;
    if (current.id !== id) throw new GatewayError('NOT_FOUND', 'Routine not found.', 404);
    const revision = str(current.configRevision, 200);
    if (!revision) throw new GatewayError('UNSUPPORTED', 'OpenClaw did not provide a safe revision for editing this routine.', 501);
    if (patch.expectedConfigRevision && patch.expectedConfigRevision !== revision) throw new GatewayError('CONFLICT', 'The routine changed while it was open. Refresh before saving.', 409);
    const result = await rpc('cron.update', { id, patch: safePatch, expectedConfigRevision: revision }, { mutation: true });
    invalidate();
    const updated = result.job || result;
    if (updated.id !== id) throw new GatewayError('UNCONFIRMED', 'OpenClaw did not return the updated routine. Check the state before repeating.');
    return { ok: true, routine: projectRoutine(updated) };
  }

  async function setModels(agentId, { primary, fallbacks } = {}) {
    requireId(agentId);
    if (typeof primary !== 'string' || !primary.includes('/') || primary.length > 250 || !Array.isArray(fallbacks) || fallbacks.length > 10 || fallbacks.some(m => typeof m !== 'string' || !m.includes('/') || m.length > 250)) badInput('Provide the primary model and a list of fallbacks.');
    if (fallbacks.includes(primary) || new Set(fallbacks).size !== fallbacks.length) badInput('The primary model and the fallbacks must all be different.');
    const [configResponse, catalogResponse] = await Promise.all([rpc('config.get'), modelsCatalog()]);
    const cfg = record(configResponse.config);
    const entries = record(cfg.agents?.entries);
    const roster = list(cfg.agents?.list);
    if (!own(entries, agentId) && !roster.some(a => a.id === agentId)) throw new GatewayError('NOT_FOUND', 'The agent is not configured in OpenClaw.', 404);
    const catalog = list(catalogResponse.models);
    if ([primary, ...fallbacks].some(id => !catalog.some(m => modelKey(m) === id && m.available === true))) badInput('Choose only models available in the configured OpenClaw catalog.');
    if (!str(configResponse.hash)) throw new GatewayError('UNSUPPORTED', 'OpenClaw did not provide a safe configuration revision.', 501);
    const model = { primary, fallbacks: [...fallbacks] };
    // The installed RPC merges entries by key (and legacy lists by id). No other
    // agent fields, credentials, defaults, or configuration sections are sent back.
    const patch = own(entries, agentId) ? { agents: { entries: { [agentId]: { model } } } } : { agents: { list: [{ id: agentId, model }] } };
    const result = await rpc('config.patch', { baseHash: configResponse.hash, raw: JSON.stringify(patch), note: 'Mission Control: agent primary model and fallbacks' }, { timeoutMs: 30_000, mutation: true });
    if (result.ok !== true) throw new GatewayError('UNCONFIRMED', 'OpenClaw did not confirm the model change.');
    invalidate();
    return { ok: true, agentId, primary, fallbacks: [...fallbacks], restartScheduled: Boolean(result.restart?.scheduled), changedPaths: list(result.changedPaths).map(p => str(p, 250)).filter(Boolean) };
  }

  async function chat({ agentId, message, sessionKey, idempotencyKey, waitTimeoutMs = 180_000 } = {}) {
    requireId(agentId);
    if (typeof message !== 'string' || !message.trim() || message.length > 40_000 || message.includes('\u0000')) badInput('Write a message of up to 40,000 characters.');
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 300_000) badInput('Invalid wait time.');
    await requireAgent(agentId);
    const key = requireSession(sessionKey || `agent:${agentId}:mission-control`);
    if (key.split(':')[1] !== agentId) badInput('The session belongs to another agent.');
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(idempotencyKey))) badInput('Invalid send identifier.');
    const requestId = idempotencyKey || randomUUID();
    const result = await rpc('chat.send', { agentId, sessionKey: key, message, idempotencyKey: requestId, deliver: false, suppressCommandInterpretation: true }, { timeoutMs: 30_000, mutation: true });
    invalidate();
    const runId = str(result.runId);
    if (!runId) throw new GatewayError('UNCONFIRMED', 'OpenClaw did not return the run identifier. Check the conversation before resending.');
    const receipt = { ok: true, agentId, sessionKey: key, idempotencyKey: requestId, runId };
    if (!waitTimeoutMs) return { ...receipt, status: str(result.status, 50) || 'accepted', text: null };
    return { ...receipt, ...await waitChat({ runId, sessionKey: key, waitTimeoutMs }) };
  }

  async function waitChat({ runId, sessionKey, waitTimeoutMs = 180_000 } = {}) {
    const key = requireSession(sessionKey);
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(runId)) badInput('Invalid run identifier.');
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 300_000) badInput('Invalid wait time.');
    const completion = await rpc('agent.wait', { runId, timeoutMs: waitTimeoutMs }, { timeoutMs: waitTimeoutMs + 5_000 });
    invalidate();
    if (completion.status === 'error') throw new GatewayError('AGENT_FAILED', 'The agent recorded a failure in this run. The message was already sent; review the conversation before repeating it.');
    const terminal = record(completion.terminalReply);
    return {
      ok: true, sessionKey: key, runId, status: ['timeout', 'pending'].includes(completion.status) ? 'pending' : 'complete',
      text: terminal.disposition === 'visible' ? str(terminal.text, 100_000) : null,
      silent: terminal.disposition === 'silent',
    };
  }

  async function chatHistory(sessionKey, { limit = 60, offset = 0 } = {}) {
    const key = requireSession(sessionKey);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) badInput('Invalid conversation pagination.');
    const result = await rpc('chat.history', { sessionKey: key, agentId: key.split(':')[1], limit, offset, maxBytes: 300_000 });
    // Only user/assistant visible text; no tool calls/results, system prompts,
    // reasoning, tokens, attachments, or full internal message objects.
    const messages = list(result.messages).flatMap((entry, index) => {
      const m = record(entry.message || entry);
      if (!['user', 'assistant'].includes(m.role)) return [];
      const text = typeof m.content === 'string' ? m.content : list(m.content).filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
      if (!text) return [];
      return [{ id: str(entry.id || m.id || `message-${offset + index}`), role: m.role, content: str(text, 80_000), text: str(text, 80_000), at: stamp(entry.timestamp ?? m.timestamp) }];
    });
    return { sessionKey: key, messages, sessionId: str(result.sessionId), hasMore: result.hasMore === true, nextOffset: num(result.nextOffset), inFlight: Boolean(result.inFlightRun) };
  }

  async function renewSession(sessionKey, { confirm = false, expectedSessionId } = {}) {
    const key = requireSession(sessionKey);
    if (confirm !== true) badInput('Confirm the renewal after reviewing what needs to be preserved in files.');
    if (typeof expectedSessionId !== 'string' || !expectedSessionId) badInput('Renewal requires the identifier of the session you reviewed.');
    const current = (await sessions()).find(s => s.key === key);
    if (!current) throw new GatewayError('NOT_FOUND', 'Session not found.', 404);
    if (current.id !== expectedSessionId) throw new GatewayError('CONFLICT', 'This session was already replaced. Refresh before renewing.', 409);
    if (current.active) throw new GatewayError('CONFLICT', 'The session is running work. Wait for it to finish before renewing.', 409);
    if (current.archived) throw new GatewayError('CONFLICT', 'This session is already archived.', 409);
    const result = await rpc('sessions.reset', { key, agentId: current.agentId, reason: 'new' }, { timeoutMs: 30_000, mutation: true });
    if (result.ok !== true) throw new GatewayError('UNCONFIRMED', 'OpenClaw did not confirm the renewal.');
    invalidate();
    return { ok: true, key: str(result.key, 512) || key, previousSessionId: current.id, sessionId: str(result.entry?.sessionId), memoryPreservedAutomatically: false };
  }

  function close() { wsClient?.close(); }

  return { snapshot, invalidate, getCron, cronRuns, updateCron, setModels, chat, waitChat, chatHistory, renewSession, connection, close };
}
