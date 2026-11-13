import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { createGatewayClient, validateGatewayUrl, isTrustedPlaintextHost, GatewayClientError } from '../server/gateway-client.mjs';
import { generateGatewayIdentity, validateGatewayIdentity } from '../server/gateway-identity.mjs';

// A real WebSocket server (RFC 6455 framing over node:http upgrade) speaking a
// fake of the OpenClaw Gateway protocol, so the client runs through Node's own
// WebSocket implementation. All values are invented; no real Gateway involved.
const TOKEN = 'synthetic-token-PRIVATE-MARKER';
const identity = validateGatewayIdentity(generateGatewayIdentity());

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = body.length < 126 ? Buffer.from([0x80 | opcode, body.length])
    : body.length < 65536 ? Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(body.length), 2); return h; })();
  return Buffer.concat([header, body]);
}

function attach(socket, onText) {
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = (buffer[1] & 0x80) !== 0;
      const total = offset + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const data = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buffer = buffer.subarray(total);
      if (opcode === 1) onText(data.toString('utf8'));
      else if (opcode === 8) { try { socket.end(encodeFrame(8, data.subarray(0, 2))); } catch {} }
      else if (opcode === 9) socket.write(encodeFrame(10, data));
    }
  });
}

async function fakeGateway(options = {}) {
  const server = http.createServer();
  const state = { connections: 0, connects: [], requests: [], sockets: new Set(), mode: options.mode || 'ok', sendChallenge: options.sendChallenge !== false, handlers: options.handlers || {}, tickIntervalMs: options.tickIntervalMs || 30_000 };
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    state.connections++;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => {});
    const send = obj => { if (!socket.destroyed) socket.write(encodeFrame(1, JSON.stringify(obj))); };
    const close = (code, reason = '') => { const b = Buffer.alloc(2 + Buffer.byteLength(reason)); b.writeUInt16BE(code, 0); b.write(reason, 2); socket.write(encodeFrame(8, b)); socket.end(); };
    const challenge = { nonce: randomUUID(), ts: 1_700_000_000_123 };
    if (state.sendChallenge) send({ type: 'event', event: 'connect.challenge', payload: challenge });
    attach(socket, text => {
      const frame = JSON.parse(text);
      if (frame.method === 'connect') {
        state.connects.push({ params: frame.params, challenge });
        if (state.mode === 'pairing') {
          send({ type: 'res', id: frame.id, ok: false, error: { code: 'NOT_PAIRED', message: 'pairing required: device is not approved yet', details: { code: 'PAIRING_REQUIRED', reason: 'not-paired', requestId: 'req-0001', deviceId: frame.params.device?.id, requestedRole: 'operator', requestedScopes: frame.params.scopes } } });
          close(1008, 'pairing required (requestId: req-0001)');
          return;
        }
        if (state.mode === 'bad-token') {
          send({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', message: `unauthorized: gateway token mismatch ${TOKEN}`, details: { code: 'AUTH_TOKEN_MISMATCH', recommendedNextStep: 'update_auth_credentials' } } });
          close(1008, 'unauthorized');
          return;
        }
        send({ type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4, server: { version: '2026.9.4', connId: 'c1' }, features: { methods: [], events: [] }, snapshot: {}, auth: { role: 'operator', scopes: frame.params.scopes, deviceToken: 'PRIVATE-MARKER-device-token' }, policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 2 * 1024 * 1024, tickIntervalMs: state.tickIntervalMs } } });
        return;
      }
      state.requests.push(frame);
      const handler = state.handlers[frame.method];
      if (handler) handler(frame, { send, close, socket });
      else send({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', message: `unknown method: ${frame.method}` } });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const stop = () => new Promise(resolve => { for (const s of state.sockets) s.destroy(); server.close(() => resolve()); });
  return { url, state, stop, dropAll: () => { for (const s of state.sockets) s.destroy(); } };
}

const reply = payload => (frame, { send }) => send({ type: 'res', id: frame.id, ok: true, payload });
const client = (url, extra = {}) => createGatewayClient({ url, token: TOKEN, identity, requestTimeoutMs: 2_000, handshakeTimeoutMs: 1_000, backoff: { initialMs: 20, maxMs: 100 }, demandRetryMs: 50, operatorActionRetryMs: 200, ...extra });
const until = async (check, ms = 2_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 10)); } };

test('handshake signs the challenge with the device identity and requests correlate by id', async t => {
  const gw = await fakeGateway({ handlers: {
    'agents.list': reply({ agents: [{ id: 'atlas' }] }),
    'slow.first': (frame, io) => setTimeout(() => reply({ order: 'first' })(frame, io), 60),
    'fast.second': reply({ order: 'second' }),
  } });
  const c = client(gw.url);
  t.after(async () => { c.close(); await gw.stop(); });
  assert.deepEqual(await c.request('agents.list', {}), { agents: [{ id: 'atlas' }] });
  const [{ params, challenge }] = gw.state.connects;
  assert.equal(params.minProtocol, 4);
  assert.equal(params.maxProtocol, 4);
  assert.equal(params.client.id, 'gateway-client');
  assert.equal(params.client.mode, 'backend');
  assert.equal(params.role, 'operator');
  assert.deepEqual(params.scopes, ['operator.read', 'operator.write', 'operator.admin']);
  assert.deepEqual(params.auth, { token: TOKEN });
  assert.equal(params.device.id, identity.deviceId);
  assert.equal(params.device.nonce, challenge.nonce);
  assert.equal(params.device.signedAt, challenge.ts);
  // Independent reconstruction of OpenClaw's v3 device-auth payload.
  const payload = ['v3', identity.deviceId, 'gateway-client', 'backend', 'operator', 'operator.read,operator.write,operator.admin', String(challenge.ts), TOKEN, challenge.nonce, params.client.platform.toLowerCase(), (params.client.deviceFamily || '').toLowerCase()].join('|');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(params.device.publicKey, 'base64url')]);
  assert.ok(verify(null, Buffer.from(payload), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(params.device.signature, 'base64url')));
  const [first, second] = await Promise.all([c.request('slow.first'), c.request('fast.second')]);
  assert.deepEqual([first.order, second.order], ['first', 'second']);
  assert.equal(gw.state.connections, 1, 'one persistent connection is reused');
  const status = c.status();
  assert.equal(status.connected, true);
  assert.equal(status.server.version, '2026.9.4');
  assert.ok(!JSON.stringify(status).includes('PRIVATE-MARKER'), 'neither token nor issued device token is exposed');
});

test('request timeout rejects only that call; late replies are ignored and the socket stays usable', async t => {
  let late;
  const gw = await fakeGateway({ handlers: { 'never.answers': frame => { late = frame; }, 'agents.list': reply({ agents: [] }) } });
  const c = client(gw.url);
  t.after(async () => { c.close(); await gw.stop(); });
  await assert.rejects(c.request('never.answers', {}, { timeoutMs: 80 }), e => e.code === 'GATEWAY_TIMEOUT');
  gw.state.sockets.forEach(s => s.write(encodeFrame(1, JSON.stringify({ type: 'res', id: late.id, ok: true, payload: { stale: true } }))));
  assert.deepEqual(await c.request('agents.list'), { agents: [] });
  assert.equal(gw.state.connections, 1);
});

test('a dropped connection rejects pending calls and reconnects with backoff', async t => {
  const gw = await fakeGateway({ handlers: { 'hang': () => {}, 'agents.list': reply({ agents: [] }) } });
  const c = client(gw.url);
  t.after(async () => { c.close(); await gw.stop(); });
  await c.request('agents.list');
  const pending = c.request('hang', {}, { timeoutMs: 1_500 });
  await until(() => gw.state.requests.some(r => r.method === 'hang'));
  gw.dropAll();
  await assert.rejects(pending, e => e.code === 'GATEWAY_CONNECTION_LOST');
  await until(() => gw.state.connections === 2 && c.status().connected, 2_000);
  assert.deepEqual(await c.request('agents.list'), { agents: [] });
});

test('pairing required exposes the exact approval command, fails fast, and recovers after approval', async t => {
  const gw = await fakeGateway({ mode: 'pairing', handlers: { 'agents.list': reply({ agents: [] }) } });
  const c = client(gw.url, { backoff: { initialMs: 5_000, maxMs: 5_000 }, demandRetryMs: 150 });
  t.after(async () => { c.close(); await gw.stop(); });
  await assert.rejects(c.request('agents.list'), e => e instanceof GatewayClientError && e.code === 'GATEWAY_PAIRING_REQUIRED' && e.pairing.requestId === 'req-0001');
  const status = c.status();
  assert.equal(status.connected, false);
  assert.deepEqual({ deviceId: status.pairing.deviceId, requestId: status.pairing.requestId, reason: status.pairing.reason, command: status.pairing.command }, { deviceId: identity.deviceId, requestId: 'req-0001', reason: 'not-paired', command: 'openclaw devices approve req-0001' });
  assert.match(status.pairing.hint, /openclaw devices approve req-0001/);
  const attempts = gw.state.connections;
  await assert.rejects(c.request('agents.list'), e => e.code === 'GATEWAY_PAIRING_REQUIRED');
  assert.equal(gw.state.connections, attempts, 'no reconnect storm while waiting for a human');
  gw.state.mode = 'ok'; // the operator approved the device
  await new Promise(r => setTimeout(r, 170));
  assert.deepEqual(await c.request('agents.list'), { agents: [] });
  assert.equal(c.status().pairing, null);
});

test('rejected credentials are reported without the token or the Gateway text', async t => {
  const gw = await fakeGateway({ mode: 'bad-token' });
  const c = client(gw.url);
  t.after(async () => { c.close(); await gw.stop(); });
  await assert.rejects(c.request('agents.list'), e => e.code === 'GATEWAY_AUTH_REJECTED' && e.detailCode === 'AUTH_TOKEN_MISMATCH' && !e.message.includes('PRIVATE'));
  assert.ok(!JSON.stringify(c.status()).includes('PRIVATE'));
  const attempts = gw.state.connections;
  await assert.rejects(c.request('agents.list'), e => e.code === 'GATEWAY_AUTH_REJECTED');
  assert.equal(gw.state.connections, attempts, 'credential failures are not retried on every call');
});

test('Gateway error text is redacted if it ever echoes the token', async t => {
  const gw = await fakeGateway({ handlers: { 'echo.fail': (frame, { send }) => send({ type: 'res', id: frame.id, ok: false, error: { code: 'INVALID_REQUEST', message: `invalid params ${TOKEN}` } }) } });
  const c = client(gw.url);
  t.after(async () => { c.close(); await gw.stop(); });
  await assert.rejects(c.request('echo.fail'), e => e.code === 'GATEWAY_REQUEST_FAILED' && e.gatewayCode === 'INVALID_REQUEST' && !e.message.includes(TOKEN) && e.message.includes('***'));
});

test('missing challenge and unreachable address fail within bounded time', async t => {
  const silent = await fakeGateway({ sendChallenge: false });
  const c1 = client(silent.url, { handshakeTimeoutMs: 100 });
  const c2 = client('ws://127.0.0.1:9');
  t.after(async () => { c1.close(); c2.close(); await silent.stop(); });
  await assert.rejects(c1.request('agents.list'), e => e.code === 'GATEWAY_HANDSHAKE_TIMEOUT');
  await assert.rejects(c2.request('agents.list'), e => e.code === 'GATEWAY_UNREACHABLE' && !e.message.includes('127.0.0.1'));
  assert.equal(c2.status().state, 'backoff');
});

test('silent connection is detected by the tick watchdog and replaced', async t => {
  let clock = Date.now();
  const gw = await fakeGateway({ tickIntervalMs: 50, handlers: { 'agents.list': reply({ agents: [] }) } });
  const c = client(gw.url, { now: () => clock });
  t.after(async () => { c.close(); await gw.stop(); });
  await c.request('agents.list');
  clock += 60_000; // no frame for a minute
  await until(() => gw.state.connections >= 2, 3_000);
});

test('close rejects pending work, stops reconnecting and is idempotent', async t => {
  const gw = await fakeGateway({ handlers: { 'hang': () => {} } });
  const c = client(gw.url);
  t.after(() => gw.stop());
  const pending = c.request('hang', {}, { timeoutMs: 1_000 });
  await until(() => gw.state.requests.length === 1);
  c.close();
  c.close();
  await assert.rejects(pending, e => e.code === 'GATEWAY_CLOSED');
  await assert.rejects(c.request('agents.list'), e => e.code === 'GATEWAY_CLOSED');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(gw.state.connections, 1);
  assert.equal(c.status().state, 'closed');
});

test('URL policy mirrors OpenClaw: plaintext only on trusted networks, never credentials in the URL', () => {
  for (const ok of ['ws://127.0.0.1:18789', 'ws://localhost:18789', 'ws://[::1]:18789', 'ws://10.0.0.5:18789', 'ws://192.168.1.2:1', 'ws://100.101.102.103:18789', 'ws://gateway.tailnet-name.ts.net', 'ws://host.local:18789', 'wss://gateway.example.com', 'wss://203.0.113.9:443/gateway']) assert.ok(validateGatewayUrl(ok), ok);
  for (const insecure of ['ws://203.0.113.9:18789', 'ws://gateway.example.com', 'ws://openclaw-gateway:18789']) assert.throws(() => validateGatewayUrl(insecure), e => e.code === 'GATEWAY_URL_INSECURE', insecure);
  for (const bad of ['http://127.0.0.1:18789', 'ws://user:secret@127.0.0.1', 'ws://127.0.0.1/?token=secret', 'ws://127.0.0.1/#x', 'not a url', '']) assert.throws(() => validateGatewayUrl(bad), e => e.code === 'GATEWAY_URL_INVALID' && !e.message.includes('secret'), bad);
  assert.ok(validateGatewayUrl('ws://openclaw-gateway:18789', { allowPrivateNames: true }));
  assert.equal(isTrustedPlaintextHost('203.0.113.9', { allowPrivateNames: true }), false, 'a public IP literal is never trusted for plaintext');
  assert.equal(isTrustedPlaintextHost('gw.example.com', { allowPrivateNames: true }), false, 'a public DNS name is never trusted for plaintext');
  assert.equal(isTrustedPlaintextHost('host.docker.internal', { allowPrivateNames: true }), true);
  assert.equal(isTrustedPlaintextHost('host.docker.internal'), false);
});

test('constructor refuses missing identity and never stores the token on the object', () => {
  assert.throws(() => createGatewayClient({ url: 'ws://127.0.0.1:1', token: TOKEN }), e => e.code === 'GATEWAY_DEVICE_UNAVAILABLE');
  const c = createGatewayClient({ url: 'ws://127.0.0.1:1', token: TOKEN, identity });
  assert.ok(!JSON.stringify(c).includes(TOKEN));
  assert.ok(!JSON.stringify(c.status()).includes(TOKEN));
  c.close();
});
