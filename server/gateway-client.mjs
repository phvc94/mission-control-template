import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Minimal OpenClaw Gateway WebSocket client (protocol v4, OpenClaw 2026.9.4).
 *
 * Wire facts, from the installed package (node_modules/openclaw):
 * - frames: {type:'req',id,method,params} / {type:'res',id,ok,payload|error} /
 *   {type:'event',event,payload,seq?}; error = {code,message,details?,retryable?,retryAfterMs?}
 *   (docs/gateway/protocol/transport.md, dist/client-*.mjs GatewayProtocolClient).
 * - the server speaks first with event 'connect.challenge' {nonce, ts}; the first
 *   client frame must be the 'connect' request (docs/gateway/protocol/handshake.md).
 * - device proof: Ed25519 signature (base64url) over the v3 payload
 *   v3|deviceId|clientId|clientMode|role|scopes(csv)|signedAt|token|nonce|platform|deviceFamily,
 *   signedAt = challenge ts, publicKey = raw 32 bytes base64url
 *   (dist/device-auth-*.mjs buildDeviceAuthPayloadV3, dist/ed25519-signature-*.mjs).
 * - an unapproved device gets error code NOT_PAIRED with details.code
 *   'PAIRING_REQUIRED', details.requestId, details.reason, then close 1008
 *   (dist/message-handler-*.mjs authorizeGatewayConnectDevice,
 *   dist/connect-error-details-*.mjs).
 *
 * Secrets: the token and private key live only in this closure. Nothing here
 * logs, and no error message contains the token, the URL credentials, or a
 * raw socket diagnostic.
 */

export const PROTOCOL_VERSION = 4;
export const DEFAULT_SCOPES = Object.freeze(['operator.read', 'operator.write', 'operator.admin']);
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const DEFAULT_MAX_PAYLOAD = 25 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Failures an operator must fix on the Gateway or in configuration. Retrying
// quickly only adds failed-auth noise (and can trip the Gateway rate limiter).
const OPERATOR_ACTION_CODES = new Set([
  'AUTH_REQUIRED', 'AUTH_UNAUTHORIZED', 'AUTH_TOKEN_MISSING', 'AUTH_TOKEN_MISMATCH', 'AUTH_TOKEN_NOT_CONFIGURED',
  'AUTH_PASSWORD_MISSING', 'AUTH_PASSWORD_MISMATCH', 'AUTH_PASSWORD_NOT_CONFIGURED', 'AUTH_DEVICE_TOKEN_MISMATCH',
  'AUTH_SCOPE_MISMATCH', 'AUTH_IDENTITY_HEADER_REQUIRED', 'AUTH_VERIFIED_USER_REQUIRED', 'PROTOCOL_MISMATCH',
  'CLIENT_VERSION_MISMATCH', 'DEVICE_IDENTITY_REQUIRED', 'DEVICE_AUTH_INVALID', 'DEVICE_AUTH_DEVICE_ID_MISMATCH',
  'DEVICE_AUTH_SIGNATURE_EXPIRED', 'DEVICE_AUTH_NONCE_REQUIRED', 'DEVICE_AUTH_NONCE_MISMATCH',
  'DEVICE_AUTH_SIGNATURE_INVALID', 'DEVICE_AUTH_PUBLIC_KEY_INVALID',
]);

export class GatewayClientError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GatewayClientError';
    this.code = code;
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) this[key] = value;
  }
}

/** Same platform identity OpenClaw's own Node client sends; paired devices pin it. */
export function platformIdentity(platform = process.platform) {
  if (platform === 'darwin') return { platform: 'macos', deviceFamily: 'Mac' };
  if (platform === 'win32') return { platform: 'windows', deviceFamily: 'Windows' };
  if (platform === 'linux') return { platform: 'linux', deviceFamily: 'Linux' };
  return { platform: String(platform || 'unknown') };
}

function lowerAscii(value) { return typeof value === 'string' ? value.trim().replace(/[A-Z]/g, c => c.toLowerCase()) : ''; }

export function buildDeviceAuthPayloadV3({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, platform, deviceFamily }) {
  return ['v3', deviceId, clientId, clientMode, role, scopes.join(','), String(signedAtMs), token ?? '', nonce, lowerAscii(platform), lowerAscii(deviceFamily)].join('|');
}

function ipv4Private(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
function ipv6Private(address) {
  const value = address.toLowerCase();
  if (value === '::1') return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Private(mapped[1]);
  return /^fe[89ab]/.test(value) || /^f[cd]/.test(value) || /^fe[c-f]/.test(value);
}
/**
 * Mirrors OpenClaw's own client policy (dist/websocket-transport-*.mjs): plaintext
 * ws:// only to loopback, private, link-local, Tailscale CGNAT, *.local and
 * *.ts.net. allowPrivateNames additionally admits bare names such as a Docker
 * service ("openclaw-gateway"), never a public IP literal.
 */
export function isTrustedPlaintextHost(hostname, { allowPrivateNames = false } = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.ts.net')) return true;
  const kind = isIP(host);
  if (kind === 4) return ipv4Private(host);
  if (kind === 6) return ipv6Private(host);
  // Docker service names (no dot) and Docker Desktop's host alias; never a public DNS name.
  return allowPrivateNames && (!host.includes('.') || host === 'host.docker.internal');
}

/** Throws GatewayClientError('GATEWAY_URL_INVALID' | 'GATEWAY_URL_INSECURE'); returns the normalized URL. */
export function validateGatewayUrl(raw, { allowPrivateNames = false } = {}) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { url = null; }
  if (!url || !['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new GatewayClientError('GATEWAY_URL_INVALID', 'MC_GATEWAY_URL must be a ws:// or wss:// address without credentials, query or fragment.');
  }
  if (url.protocol === 'ws:' && !isTrustedPlaintextHost(url.hostname, { allowPrivateNames })) {
    throw new GatewayClientError('GATEWAY_URL_INSECURE', 'MC_GATEWAY_URL must use wss:// for hosts outside loopback, private networks and Tailscale.');
  }
  return url.href;
}

/** Origin-only form for status output: no path, never credentials. */
export function displayGatewayUrl(raw) {
  try { const u = new URL(raw); return `${u.protocol}//${u.host}`; } catch { return null; }
}

function cleanText(value, max = 300) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
}

export function pairingCommand(requestId) {
  return requestId ? `openclaw devices approve ${requestId}` : 'openclaw devices list';
}

function pairingFromDetails(details, ownDeviceId) {
  const requestId = typeof details?.requestId === 'string' && REQUEST_ID_PATTERN.test(details.requestId) ? details.requestId : null;
  const reason = ['not-paired', 'role-upgrade', 'scope-upgrade', 'metadata-upgrade'].includes(details?.reason) ? details.reason : null;
  const command = pairingCommand(requestId);
  return {
    deviceId: ownDeviceId, requestId, reason, command,
    requestedScopes: Array.isArray(details?.requestedScopes) ? details.requestedScopes.filter(s => typeof s === 'string').slice(0, 20).map(s => cleanText(s, 100)) : null,
    hint: requestId ? `Approve this device on the OpenClaw Gateway host: ${command}` : `Approve this device on the OpenClaw Gateway host: run ${command}, then openclaw devices approve <requestId> for device ${ownDeviceId}`,
  };
}

/**
 * createGatewayClient({url, token, identity}) -> {request, start, close, status}
 * One persistent socket shared by all calls; reconnect with exponential backoff.
 * A call made while disconnected starts (or joins) a connect attempt; if the
 * last attempt failed less than demandRetryMs ago, it fails fast with that
 * failure instead of piling up waits.
 */
export function createGatewayClient({
  url, token = null, identity, scopes = DEFAULT_SCOPES,
  clientVersion = '0.0.0', displayName = 'Mission Control', platform = process.platform,
  requestTimeoutMs = 30_000, handshakeTimeoutMs = 15_000,
  backoff = { initialMs: 1_000, maxMs: 30_000 }, operatorActionRetryMs = 60_000, demandRetryMs = 5_000,
  WebSocketImpl = globalThis.WebSocket, now = Date.now, onStateChange = null,
  allowPrivateNames = false,
} = {}) {
  const target = validateGatewayUrl(url, { allowPrivateNames });
  if (typeof WebSocketImpl !== 'function') throw new GatewayClientError('GATEWAY_UNSUPPORTED_RUNTIME', 'This Node.js runtime has no WebSocket client. Use Node.js 22 or newer.');
  if (!identity || typeof identity.deviceId !== 'string' || typeof identity.publicKeyPem !== 'string' || typeof identity.privateKeyPem !== 'string') {
    throw new GatewayClientError('GATEWAY_DEVICE_UNAVAILABLE', 'The dashboard\'s own connection identity was not loaded.');
  }
  const secret = typeof token === 'string' && token ? token : null;
  const deviceId = identity.deviceId;
  const privateKey = createPrivateKey(identity.privateKeyPem);
  const publicKeyRaw = createPublicKey(identity.publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
  const platformInfo = platformIdentity(platform);
  const requestedScopes = [...scopes];

  let state = 'idle';           // idle | connecting | ready | backoff | closed
  let socket = null;
  let generation = 0;
  let attempt = null;           // {generation, waiters: Set, challengeTimer, connectId}
  let pending = new Map();      // id -> {resolve, reject, timer, method}
  let sequence = 0;
  let retryTimer = null, tickTimer = null;
  let failures = 0;
  let lastAttemptAt = 0, lastActivityAt = 0, nextRetryAt = null;
  let lastError = null, pairing = null, hello = null;
  let exitHook = null;

  const redact = text => secret ? cleanText(text).split(secret).join('***') : cleanText(text);
  function emit() { try { onStateChange?.(status()); } catch {} }
  function setState(next) { if (state !== next) { state = next; emit(); } }

  function status() {
    return {
      transport: 'ws', state, connected: state === 'ready', url: displayGatewayUrl(target), deviceId,
      server: hello ? { version: hello.version, protocol: hello.protocol } : null,
      scopes: hello ? [...hello.scopes] : null,
      pairing: pairing ? { ...pairing, requestedScopes: pairing.requestedScopes ? [...pairing.requestedScopes] : null } : null,
      error: lastError ? { code: lastError.code, detailCode: lastError.detailCode ?? null, message: lastError.message } : null,
      nextRetryAt: state === 'backoff' && nextRetryAt ? new Date(nextRetryAt).toISOString() : null,
    };
  }

  function clearTimers() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function rejectPending(error) {
    const current = pending;
    pending = new Map();
    for (const entry of current.values()) { clearTimeout(entry.timer); entry.reject(error); }
  }

  function settleAttempt(error) {
    const current = attempt;
    attempt = null;
    if (!current) return;
    clearTimeout(current.challengeTimer);
    for (const waiter of current.waiters) error ? waiter.reject(error) : waiter.resolve();
  }

  function scheduleRetry(error) {
    if (state === 'closed') return;
    let delay;
    if (error?.code === 'GATEWAY_PAIRING_REQUIRED') delay = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(failures, 10));
    else if (error?.operatorAction) delay = Math.max(operatorActionRetryMs, error.retryAfterMs || 0);
    else if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) delay = Math.min(error.retryAfterMs, 5 * 60_000);
    else delay = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.min(failures, 10));
    failures++;
    nextRetryAt = now() + delay;
    setState('backoff');
    retryTimer = setTimeout(() => { retryTimer = null; if (state === 'backoff') connect(); }, delay);
    retryTimer.unref?.();
  }

  function failConnection(sock, error) {
    if (sock !== socket) return;
    socket = null;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    try { sock.close(); } catch {}
    const wasReady = state === 'ready';
    lastError = error;
    hello = null;
    rejectPending(wasReady ? new GatewayClientError('GATEWAY_CONNECTION_LOST', 'The connection to the OpenClaw Gateway was lost.') : error);
    settleAttempt(error);
    scheduleRetry(error);
  }

  function sendFrame(sock, frame) {
    const text = JSON.stringify(frame);
    const limit = hello?.maxPayload || DEFAULT_MAX_PAYLOAD;
    if (Buffer.byteLength(text) > limit) throw new GatewayClientError('GATEWAY_PAYLOAD_TOO_LARGE', 'The request is larger than the OpenClaw Gateway accepts.');
    sock.send(text);
  }

  function sendConnect(sock, challenge) {
    const signedAtMs = challenge.ts;
    const payload = buildDeviceAuthPayloadV3({
      deviceId, clientId: CLIENT_ID, clientMode: CLIENT_MODE, role: 'operator', scopes: requestedScopes,
      signedAtMs, token: secret, nonce: challenge.nonce, platform: platformInfo.platform, deviceFamily: platformInfo.deviceFamily,
    });
    const params = {
      minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
      client: { id: CLIENT_ID, displayName, version: clientVersion, platform: platformInfo.platform, ...(platformInfo.deviceFamily ? { deviceFamily: platformInfo.deviceFamily } : {}), mode: CLIENT_MODE },
      caps: [], role: 'operator', scopes: requestedScopes,
      ...(secret ? { auth: { token: secret } } : {}),
      device: { id: deviceId, publicKey: publicKeyRaw, signature: sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64url'), signedAt: signedAtMs, nonce: challenge.nonce },
    };
    attempt.connectId = `connect:${randomUUID()}`;
    sendFrame(sock, { type: 'req', id: attempt.connectId, method: 'connect', params });
  }

  function connectFailure(error) {
    const details = error && typeof error.details === 'object' && error.details ? error.details : {};
    const detailCode = typeof details.code === 'string' ? cleanText(details.code, 64) : null;
    const gatewayCode = typeof error?.code === 'string' ? cleanText(error.code, 64) : null;
    const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : undefined;
    if (detailCode === 'PAIRING_REQUIRED' || gatewayCode === 'NOT_PAIRED') {
      pairing = pairingFromDetails(details, deviceId);
      return new GatewayClientError('GATEWAY_PAIRING_REQUIRED', 'This dashboard is waiting for device approval in OpenClaw.', { gatewayCode, detailCode: 'PAIRING_REQUIRED', pairing: { ...pairing } });
    }
    if (detailCode === 'AUTH_RATE_LIMITED') return new GatewayClientError('GATEWAY_AUTH_RATE_LIMITED', 'The OpenClaw Gateway is temporarily refusing connection attempts after failed logins.', { gatewayCode, detailCode, retryAfterMs, operatorAction: true });
    if (detailCode && detailCode.startsWith('DEVICE_')) return new GatewayClientError('GATEWAY_DEVICE_REJECTED', 'The OpenClaw Gateway rejected the dashboard device signature.', { gatewayCode, detailCode, operatorAction: true });
    if (detailCode === 'PROTOCOL_MISMATCH' || detailCode === 'CLIENT_VERSION_MISMATCH') return new GatewayClientError('GATEWAY_PROTOCOL_MISMATCH', 'The OpenClaw Gateway uses a protocol version this dashboard does not support.', { gatewayCode, detailCode, operatorAction: true });
    if (detailCode === 'AUTH_SCOPE_MISMATCH') return new GatewayClientError('GATEWAY_SCOPE_REJECTED', 'The OpenClaw Gateway did not grant the permissions this dashboard requests.', { gatewayCode, detailCode, operatorAction: true });
    if (detailCode && (OPERATOR_ACTION_CODES.has(detailCode) || detailCode.startsWith('AUTH_'))) return new GatewayClientError('GATEWAY_AUTH_REJECTED', 'The OpenClaw Gateway rejected the dashboard credentials.', { gatewayCode, detailCode, operatorAction: true });
    if (gatewayCode === 'UNAVAILABLE') return new GatewayClientError('GATEWAY_STARTING', 'The OpenClaw Gateway is not ready to accept connections yet.', { gatewayCode, detailCode, retryAfterMs });
    return new GatewayClientError('GATEWAY_HANDSHAKE_FAILED', 'The OpenClaw Gateway refused the dashboard connection.', { gatewayCode, detailCode, operatorAction: true });
  }

  function handleHello(sock, payload) {
    if (!payload || payload.type !== 'hello-ok' || payload.protocol !== PROTOCOL_VERSION) {
      failConnection(sock, new GatewayClientError('GATEWAY_PROTOCOL_MISMATCH', 'The OpenClaw Gateway uses a protocol version this dashboard does not support.', { operatorAction: true }));
      return;
    }
    const policy = payload.policy && typeof payload.policy === 'object' ? payload.policy : {};
    const tickIntervalMs = Number.isSafeInteger(policy.tickIntervalMs) && policy.tickIntervalMs > 0 ? policy.tickIntervalMs : 30_000;
    hello = {
      protocol: payload.protocol, version: cleanText(payload.server?.version, 100) || null,
      scopes: Array.isArray(payload.auth?.scopes) ? payload.auth.scopes.filter(s => typeof s === 'string').map(s => cleanText(s, 100)) : [],
      maxPayload: Number.isSafeInteger(policy.maxPayload) && policy.maxPayload > 0 ? policy.maxPayload : DEFAULT_MAX_PAYLOAD,
      tickIntervalMs,
    };
    // auth.deviceToken (issued after pairing) is deliberately not kept: this
    // client always authenticates with the shared token plus its signed identity.
    failures = 0; lastError = null; pairing = null; nextRetryAt = null;
    lastActivityAt = now();
    tickTimer = setInterval(() => {
      if (socket !== sock) return;
      if (now() - lastActivityAt > tickIntervalMs * 2 + 5_000) failConnection(sock, new GatewayClientError('GATEWAY_CONNECTION_LOST', 'The connection to the OpenClaw Gateway was lost.'));
    }, Math.max(1_000, Math.min(tickIntervalMs, 30_000)));
    tickTimer.unref?.();
    setState('ready');
    settleAttempt(null);
  }

  function handleMessage(sock, data) {
    if (sock !== socket || typeof data !== 'string') return;
    let frame;
    try { frame = JSON.parse(data); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    lastActivityAt = now();
    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge' && attempt && !attempt.connectId) {
        const nonce = typeof frame.payload?.nonce === 'string' ? frame.payload.nonce.trim() : '';
        const ts = frame.payload?.ts;
        if (!nonce || nonce.length > 512 || !Number.isSafeInteger(ts) || ts < 0) {
          failConnection(sock, new GatewayClientError('GATEWAY_HANDSHAKE_FAILED', 'The OpenClaw Gateway sent an invalid connection challenge.', { operatorAction: true }));
          return;
        }
        try { sendConnect(sock, { nonce, ts }); }
        catch (error) { failConnection(sock, error instanceof GatewayClientError ? error : new GatewayClientError('GATEWAY_UNREACHABLE', 'Could not connect to the OpenClaw Gateway at the configured address.')); }
      }
      return; // tick, presence, health and other broadcasts only refresh liveness
    }
    if (frame.type !== 'res' || typeof frame.id !== 'string' || typeof frame.ok !== 'boolean') return;
    if (attempt?.connectId && frame.id === attempt.connectId) {
      if (frame.ok) handleHello(sock, frame.payload);
      else failConnection(sock, connectFailure(frame.error));
      return;
    }
    const entry = pending.get(frame.id);
    if (!entry) return;
    pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok) { entry.resolve(frame.payload === undefined ? {} : frame.payload); return; }
    const error = frame.error && typeof frame.error === 'object' ? frame.error : {};
    const details = error.details && typeof error.details === 'object' ? error.details : {};
    entry.reject(new GatewayClientError('GATEWAY_REQUEST_FAILED', redact(error.message) || 'OpenClaw rejected the request.', {
      gatewayCode: typeof error.code === 'string' ? cleanText(error.code, 64) : null,
      detailCode: typeof details.code === 'string' ? cleanText(details.code, 64) : null,
      missingScope: typeof details.missingScope === 'string' ? cleanText(details.missingScope, 64) : undefined,
      retryable: error.retryable === true,
      retryAfterMs: Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : undefined,
    }));
  }

  function connect() {
    if (state === 'closed' || state === 'connecting' || state === 'ready') return attempt;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const gen = ++generation;
    lastAttemptAt = now();
    nextRetryAt = null;
    attempt = { generation: gen, waiters: new Set(), connectId: null, challengeTimer: null };
    setState('connecting');
    let sock;
    try { sock = new WebSocketImpl(target); }
    catch {
      const error = new GatewayClientError('GATEWAY_UNREACHABLE', 'Could not connect to the OpenClaw Gateway at the configured address.');
      lastError = error; settleAttempt(error); scheduleRetry(error);
      return null;
    }
    socket = sock;
    const current = attempt;
    // The whole pre-hello phase is bounded, whether the socket stalls or the challenge never arrives.
    current.challengeTimer = setTimeout(() => {
      if (attempt === current) failConnection(sock, new GatewayClientError('GATEWAY_HANDSHAKE_TIMEOUT', 'The OpenClaw Gateway did not complete the connection in time.'));
    }, handshakeTimeoutMs);
    current.challengeTimer.unref?.();
    sock.addEventListener('message', event => handleMessage(sock, event.data));
    sock.addEventListener('error', () => {
      if (sock === socket && state === 'connecting') failConnection(sock, new GatewayClientError('GATEWAY_UNREACHABLE', 'Could not connect to the OpenClaw Gateway at the configured address.'));
    });
    sock.addEventListener('close', event => {
      if (sock !== socket) return;
      const lost = state === 'ready'
        ? new GatewayClientError('GATEWAY_CONNECTION_LOST', 'The connection to the OpenClaw Gateway was lost.', event?.code === 1012 ? { retryAfterMs: 250 } : {})
        : new GatewayClientError('GATEWAY_UNREACHABLE', 'Could not connect to the OpenClaw Gateway at the configured address.');
      failConnection(sock, lost);
    });
    if (!exitHook) {
      exitHook = () => { try { socket?.close(1000, 'process exit'); } catch {} };
      process.once('exit', exitHook);
    }
    return current;
  }

  function waitForReady(deadline) {
    if (state === 'ready') return Promise.resolve();
    if (state === 'closed') return Promise.reject(new GatewayClientError('GATEWAY_CLOSED', 'The OpenClaw Gateway connection was closed by the dashboard.'));
    if (state !== 'connecting') {
      // Pairing is waiting for a human: retry soon on demand. Credential and
      // protocol failures need configuration work: do not hammer the Gateway.
      const quiet = !lastError ? 0 : lastError.operatorAction ? Math.max(demandRetryMs, operatorActionRetryMs / 2, lastError.retryAfterMs || 0) : demandRetryMs;
      if (lastError && now() - lastAttemptAt < quiet) return Promise.reject(lastError);
      connect();
      if (state === 'ready') return Promise.resolve();
      if (!attempt) return Promise.reject(lastError);
    }
    const current = attempt;
    return new Promise((resolve, reject) => {
      const waiter = { resolve: () => { clearTimeout(timer); resolve(); }, reject: e => { clearTimeout(timer); reject(e); } };
      const timer = setTimeout(() => {
        current.waiters.delete(waiter);
        reject(new GatewayClientError('GATEWAY_TIMEOUT', 'The OpenClaw Gateway did not answer in time.'));
      }, Math.max(0, deadline - now()));
      timer.unref?.();
      current.waiters.add(waiter);
    });
  }

  async function request(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
    if (typeof method !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(method)) throw new GatewayClientError('GATEWAY_REQUEST_INVALID', 'Invalid OpenClaw method.');
    const deadline = now() + timeoutMs;
    await waitForReady(deadline);
    const sock = socket;
    return new Promise((resolve, reject) => {
      const id = `${++sequence}:${randomUUID()}`;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new GatewayClientError('GATEWAY_TIMEOUT', 'The OpenClaw Gateway did not answer in time.'));
      }, Math.max(1, deadline - now()));
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, method });
      try { sendFrame(sock, { type: 'req', id, method, params }); }
      catch (error) {
        pending.delete(id); clearTimeout(timer);
        reject(error instanceof GatewayClientError ? error : new GatewayClientError('GATEWAY_CONNECTION_LOST', 'The connection to the OpenClaw Gateway was lost.'));
      }
    });
  }

  function start() { if (state === 'idle' || state === 'backoff') connect(); }

  function close() {
    if (state === 'closed') return;
    const sock = socket;
    socket = null;
    clearTimers();
    state = 'closed';
    const error = new GatewayClientError('GATEWAY_CLOSED', 'The OpenClaw Gateway connection was closed by the dashboard.');
    rejectPending(error);
    settleAttempt(error);
    if (exitHook) { process.removeListener('exit', exitHook); exitHook = null; }
    try { sock?.close(1000, 'client closing'); } catch {}
    emit();
  }

  return { request, start, close, status };
}
