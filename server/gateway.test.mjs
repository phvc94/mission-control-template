import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, gatewayConfigFromEnv, parseJsonOutput, GatewayError } from './gateway.mjs';
import { GatewayClientError } from './gateway-client.mjs';
import { generateGatewayIdentity, loadOrCreateGatewayIdentity } from './gateway-identity.mjs';

// All fixtures in this file are invented. No real content or credentials copied.
const session = { key: 'agent:atlas:mission-control', sessionId: 's-one', agentId: 'atlas', updatedAt: 1700000000000, totalTokens: 45000, contextTokens: 1000000, model: 'model-a', modelProvider: 'vendor', hasActiveRun: false, systemPrompt: 'PRIVATE-MARKER', messages: ['PRIVATE-MARKER'] };
const routine = { id: 'cron-one', name: 'Example review', agentId: 'atlas', enabled: true, schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'America/New_York' }, configRevision: 'rev-one', state: { lastRunAtMs: 1700000000000, nextRunAtMs: 1700003600000, lastRunStatus: 'error', lastError: 'PRIVATE-MARKER', lastDurationMs: 2200 }, payload: { message: 'PRIVATE-MARKER' } };
function harness(overrides = {}, options = {}) {
  const calls = [];
  const fixtures = {
    'agents.list': { agents: [{ id: 'atlas', name: 'Atlas', model: { primary: 'vendor/model-a', fallbacks: ['vendor/model-b'] }, workspace: '/workspace/agentes/atlas', token: 'PRIVATE-MARKER' }] },
    'models.list': { models: [{ id: 'model-a', provider: 'vendor', name: 'Modelo A', available: true, contextWindow: 1000000, tags: ['configured'] }, { id: 'model-b', provider: 'vendor', name: 'Modelo B', available: true, contextWindow: null, tags: ['configured'] }] },
    'sessions.list': { sessions: [session], hasMore: false },
    'cron.list': { jobs: [routine], hasMore: false },
    'channels.status': { channelAccounts: { chat: [{ accountId: 'atlas', configured: true, connected: true, running: true, reconnectAttempts: 0, lastError: 'PRIVATE-MARKER', token: 'PRIVATE-MARKER' }] } },
    health: { ok: true, ts: 1700000000000, eventLoop: { delayP99Ms: 12.3, degraded: false }, deliveryQueues: { failed: [{ count: 3 }], ingressFailed: [{ count: 2 }] }, plugins: { loaded: ['one'], errors: [] } },
    'cron.get': { job: routine },
    'cron.update': (_params) => ({ ...routine, ..._params.patch, configRevision: 'rev-two' }),
    'cron.runs': { entries: [{ runId: 'run-one', jobId: 'cron-one', ts: 1700000002000, runAtMs: 1700000000000, status: 'error', durationMs: 2000, error: 'PRIVATE-MARKER', summary: 'PRIVATE-MARKER', diagnostics: 'PRIVATE-MARKER' }], total: 1, hasMore: false },
    'config.get': { hash: 'base-one', valid: true, config: { secret: 'PRIVATE-MARKER', agents: { defaults: { model: 'vendor/model-b' }, entries: { atlas: { workspace: '/workspace/agentes/atlas', model: { primary: 'vendor/model-a', fallbacks: ['vendor/model-b'] } }, boreal: { model: 'vendor/model-b' } } } } },
    'config.patch': { ok: true, config: { secret: 'PRIVATE-MARKER' }, changedPaths: ['agents.entries.atlas.model'] },
    'chat.send': { runId: 'run-new', status: 'accepted' },
    'agent.wait': { status: 'ok', terminalReply: { disposition: 'visible', text: 'Fixture reply.' } },
    'chat.history': { messages: [{ role: 'user', content: 'Hello', timestamp: 1700000000000 }, { role: 'assistant', content: [{ type: 'text', text: 'Reply' }, { type: 'thinking', thinking: 'PRIVATE-MARKER' }, { type: 'tool_use', input: 'PRIVATE-MARKER' }] }, { role: 'toolResult', content: 'PRIVATE-MARKER' }, { role: 'system', content: 'PRIVATE-MARKER' }], sessionId: 's-one', hasMore: false },
    'sessions.reset': { ok: true, key: session.key, entry: { sessionId: 's-two', privateField: 'PRIVATE-MARKER' } },
    ...overrides,
  };
  const runner = async (command, args, execOptions) => {
    const prefixIndex = args.indexOf('gateway');
    const name = prefixIndex < 0 ? 'models' : args[prefixIndex + 2];
    const paramsIndex = args.indexOf('--params');
    const params = paramsIndex < 0 ? {} : JSON.parse(args[paramsIndex + 1]);
    calls.push({ command, args, execOptions, name, params });
    let result = fixtures[name];
    if (result instanceof Error) throw result;
    if (typeof result === 'function') result = await result(params);
    assert.notEqual(result, undefined, `unmocked call ${name}`);
    return { stdout: JSON.stringify(result), stderr: '' };
  };
  return { api: createGateway({ runner, ...options }), calls, fixtures };
}
const noPrivate = result => assert.ok(!JSON.stringify(result).includes('PRIVATE-MARKER'));

test('JSON parser accepts banner but refuses partial/malformed output without exposing it', () => {
  assert.deepEqual(parseJsonOutput('banner\n{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonOutput('\u001b[32m[1,2]\u001b[0m'), [1, 2]);
  assert.throws(() => parseJsonOutput('PRIVATE-MARKER {broken'), e => e.code === 'INVALID_RESPONSE' && !e.message.includes('PRIVATE'));
});

test('snapshot allowlists metadata, calculates only known values and avoids transcript previews', async () => {
  const { api, calls } = harness();
  const s = await api.snapshot();
  noPrivate(s);
  assert.equal(s.agents[0].name, 'Atlas');
  assert.deepEqual(s.agents[0].fallbacks, ['vendor/model-b']);
  assert.equal(s.agents[0].contextWindow, 1000000);
  assert.equal(s.agents[0].latestSession.totalTokens, 45000);
  assert.equal(s.sessions[0].model, 'vendor/model-a');
  assert.equal(s.models[1].contextWindow, null);
  assert.equal(s.health.failedDeliveries, 3);
  assert.equal(s.health.failedIngress, 2);
  assert.equal(s.routines[0].lastStatus, 'error');
  const p = calls.find(c => c.name === 'sessions.list').params;
  assert.equal(p.includeDerivedTitles, false);
  assert.equal(p.includeLastMessage, false);
  assert.equal(p.archived, 'all');
  assert.ok(calls.every(c => c.execOptions.shell === false));
  assert.equal(calls.length, 6);
  assert.ok(calls.every(c => c.args.includes('gateway')), 'All access uses the CLI read-only shared-state RPC path');
});

test('missing fallbacks resolve inherited defaults without exporting configuration', async () => {
  const { api } = harness({
    'agents.list': { agents: [{ id: 'atlas', model: 'vendor/model-a' }] },
    'config.get': { config: { secret: 'PRIVATE-MARKER', agents: { entries: { atlas: { model: 'vendor/model-a' } }, defaults: { model: { primary: 'vendor/model-a', fallbacks: ['vendor/model-b'] } } } } },
  });
  const result = await api.snapshot();
  noPrivate(result);
  assert.deepEqual(result.agents[0].fallbacks, ['vendor/model-b']);
  assert.equal(result.agents[0].fallbackSource, 'defaults');
  assert.equal(result.agents[0].fallbacksKnown, true);
});

test('unavailable fallback config stays unknown, not an empty disabled list', async () => {
  const { api } = harness({ 'agents.list': { agents: [{ id: 'atlas', model: 'vendor/model-a' }] }, 'config.get': new Error('unavailable PRIVATE-MARKER') });
  const result = await api.snapshot();
  noPrivate(result);
  assert.equal(result.agents[0].fallbacks, null);
  assert.equal(result.agents[0].fallbacksKnown, false);
  assert.equal(result.agents[0].fallbackSource, 'unknown');
  assert.equal(result.errors[0].source, 'agentFallbacks');
});

test('snapshot TTL shares concurrent work and returns copies, not mutable cache', async () => {
  let at = 1700000000000;
  const { api, calls } = harness({}, { now: () => at });
  const [a, b] = await Promise.all([api.snapshot(), api.snapshot()]);
  assert.equal(calls.length, 6);
  a.agents[0].name = 'changed';
  assert.equal(b.agents[0].name, 'Atlas');
  at += 59000;
  assert.equal((await api.snapshot()).agents[0].name, 'Atlas');
  assert.equal(calls.length, 6);
  at += 1001;
  await api.snapshot();
  assert.equal(calls.length, 12);
});

test('failed source is explicit, not stale success, and stderr cannot escape', async () => {
  const failure = Object.assign(new Error('PRIVATE-MARKER'), { stderr: 'provider token=PRIVATE-MARKER timeout' });
  const { api } = harness({ 'sessions.list': failure });
  const result = await api.snapshot();
  noPrivate(result);
  assert.equal(result.agents[0].sessionCount, null);
  assert.equal(result.agents[0].status, 'unknown');
  assert.equal(result.errors[0].source, 'sessions');
  assert.equal(result.errors[0].code, 'GATEWAY_TIMEOUT');
});

test('pagination collects all pages and malformed continuations fail visibly', async () => {
  const { api, calls } = harness({ 'sessions.list': p => p.offset === 0 ? { sessions: [session], hasMore: true, nextOffset: 200 } : { sessions: [{ ...session, key: 'agent:atlas:another', sessionId: 's-other' }], hasMore: false } });
  assert.equal((await api.snapshot()).sessions.length, 2);
  assert.deepEqual(calls.filter(c => c.name === 'sessions.list').map(c => c.params.offset), [0, 200]);
  const other = harness({ 'sessions.list': { sessions: [session], hasMore: true, nextOffset: 0 } });
  assert.equal((await other.api.snapshot()).errors[0].code, 'INVALID_PAGINATION');
});

test('model updates only one keyed agent model and includes optimistic revision', async () => {
  const { api, calls } = harness();
  const result = await api.setModels('atlas', { primary: 'vendor/model-b', fallbacks: [] });
  noPrivate(result);
  const p = calls.find(c => c.name === 'config.patch').params;
  assert.equal(p.baseHash, 'base-one');
  assert.deepEqual(JSON.parse(p.raw), { agents: { entries: { atlas: { model: { primary: 'vendor/model-b', fallbacks: [] } } } } });
  assert.equal(result.ok, true);
});

test('legacy agent list patch stays targeted and rejects unknown/self fallback', async () => {
  const { api, calls } = harness({ 'config.get': { hash: 'base', config: { agents: { list: [{ id: 'atlas', model: 'vendor/model-a' }, { id: 'boreal', model: 'vendor/model-b' }] } } } });
  await api.setModels('atlas', { primary: 'vendor/model-b', fallbacks: ['vendor/model-a'] });
  assert.deepEqual(JSON.parse(calls.find(c => c.name === 'config.patch').params.raw).agents.list, [{ id: 'atlas', model: { primary: 'vendor/model-b', fallbacks: ['vendor/model-a'] } }]);
  const original = calls.length;
  await assert.rejects(api.setModels('atlas', { primary: 'vendor/model-a', fallbacks: ['vendor/model-a'] }), { status: 400 });
  assert.equal(calls.length, original);
  await assert.rejects(api.setModels('atlas', { primary: 'vendor/not-installed', fallbacks: [] }), { status: 400 });
  assert.equal(calls.filter(c => c.name === 'config.patch').length, 1);
  await assert.rejects(api.setModels('__proto__', { primary: 'vendor/model-a', fallbacks: [] }), { status: 400 });
});

test('model conflict is safely returned without retrying the mutation', async () => {
  const { api, calls } = harness({ 'config.patch': Object.assign(new Error('PRIVATE-MARKER'), { stderr: 'config base hash changed PRIVATE-MARKER' }) });
  await assert.rejects(api.setModels('atlas', { primary: 'vendor/model-b', fallbacks: [] }), e => e.status === 409 && !e.message.includes('PRIVATE'));
  assert.equal(calls.filter(c => c.name === 'config.patch').length, 1);
});

test('cron reads omit payload and diagnostics; update preserves revision and never runs job', async () => {
  const { api, calls } = harness();
  noPrivate(await api.getCron('cron-one'));
  noPrivate(await api.cronRuns('cron-one'));
  const result = await api.updateCron('cron-one', { enabled: false, expectedConfigRevision: 'rev-one' });
  noPrivate(result);
  assert.equal(result.routine.enabled, false);
  const update = calls.find(c => c.name === 'cron.update').params;
  assert.deepEqual(update, { id: 'cron-one', patch: { enabled: false }, expectedConfigRevision: 'rev-one' });
  assert.ok(!calls.some(c => c.name === 'cron.run'));
});

test('cron editor rejects payload injection, stale revision, unknown schedule', async () => {
  const { api, calls } = harness();
  await assert.rejects(api.updateCron('cron-one', { payload: { argv: ['sh'] } }), { status: 400 });
  await assert.rejects(api.updateCron('cron-one', { enabled: false, expectedConfigRevision: 'stale' }), { status: 409 });
  await assert.rejects(api.updateCron('cron-one', { schedule: { kind: 'stream', command: ['sh'] } }), { status: 501 });
  await assert.rejects(api.updateCron('cron-one', { schedule: { kind: 'cron', expr: '* * * * *', tz: 'Wrong/Zone' } }), { status: 400 });
  await assert.rejects(api.cronRuns('../../credentials'), { status: 400 });
  assert.ok(!calls.some(c => c.name === 'cron.update'));
});

test('chat uses dedicated session, no external delivery, idempotency, and native final reply', async () => {
  const { api, calls } = harness();
  const message = 'A literal message $(touch /tmp/never) `echo nothing`';
  const result = await api.chat({ agentId: 'atlas', message, idempotencyKey: 'request-one' });
  assert.equal(result.sessionKey, 'agent:atlas:mission-control');
  assert.equal(result.text, 'Fixture reply.');
  assert.equal(result.status, 'complete');
  const send = calls.find(c => c.name === 'chat.send');
  assert.equal(send.params.message, message);
  assert.equal(send.params.deliver, false);
  assert.equal(send.params.suppressCommandInterpretation, true);
  assert.equal(send.params.idempotencyKey, 'request-one');
  const wait = calls.find(c => c.name === 'agent.wait');
  assert.equal(wait.params.runId, 'run-new');
  assert.equal(wait.params.timeoutMs, 180000);
  assert.ok(wait.execOptions.timeout > 180000);
});

test('chat validates before sending and rejects agent/session mismatch', async () => {
  const { api, calls } = harness();
  await assert.rejects(api.chat({ agentId: 'atlas', message: 'x', waitTimeoutMs: -1 }), { status: 400 });
  await assert.rejects(api.chat({ agentId: 'atlas', message: 'x', sessionKey: 'agent:boreal:main' }), { status: 400 });
  await assert.rejects(api.chat({ agentId: 'atlas', message: '' }), { status: 400 });
  assert.ok(!calls.some(c => c.name === 'chat.send'));
});

test('chat reports still pending without pretending a response exists', async () => {
  const { api } = harness({ 'agent.wait': { status: 'timeout' } });
  const result = await api.chat({ agentId: 'atlas', message: 'Hello' });
  assert.equal(result.status, 'pending');
  assert.equal(result.text, null);
});

test('waiting again follows the same run without another chat.send', async () => {
  const { api, calls } = harness();
  const result = await api.waitChat({ runId: 'run-existing', sessionKey: session.key, waitTimeoutMs: 60000 });
  assert.equal(result.status, 'complete');
  assert.equal(result.text, 'Fixture reply.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'agent.wait');
  assert.equal(calls[0].params.runId, 'run-existing');
  assert.equal(calls[0].params.timeoutMs, 60000);
});

test('chat history returns only visible user/assistant text', async () => {
  const { api } = harness();
  const result = await api.chatHistory(session.key);
  noPrivate(result);
  assert.deepEqual(result.messages.map(m => [m.role, m.content]), [['user', 'Hello'], ['assistant', 'Reply']]);
});

test('renew requires reviewed session ID and explicit confirmation, rejects active work', async () => {
  const { api, calls, fixtures } = harness();
  await assert.rejects(api.renewSession(session.key, { expectedSessionId: 's-one' }), { status: 400 });
  await assert.rejects(api.renewSession(session.key, { confirm: true, expectedSessionId: 'stale' }), { status: 409 });
  fixtures['sessions.list'] = { sessions: [{ ...session, hasActiveRun: true }] };
  await assert.rejects(api.renewSession(session.key, { confirm: true, expectedSessionId: 's-one' }), { status: 409 });
  assert.ok(!calls.some(c => c.name === 'sessions.reset'));
  fixtures['sessions.list'] = { sessions: [session] };
  const result = await api.renewSession(session.key, { confirm: true, expectedSessionId: 's-one' });
  noPrivate(result);
  assert.equal(result.sessionId, 's-two');
  assert.equal(result.memoryPreservedAutomatically, false);
  assert.deepEqual(calls.find(c => c.name === 'sessions.reset').params, { key: session.key, agentId: 'atlas', reason: 'new' });
});

test('unsupported RPC returns honest 501 and never raw diagnostic', async () => {
  const { api } = harness({ 'cron.runs': new Error('unknown method PRIVATE-MARKER') });
  await assert.rejects(api.cronRuns('cron-one'), e => e instanceof GatewayError && e.status === 501 && !e.message.includes('PRIVATE'));
});

test('persistent runtime imports once, projects same snapshot and never launches CLI', async () => {
  const { fixtures } = harness();
  let imports = 0;
  const calls = [];
  const identity = { deviceId: 'fixture-device', privateKeyPem: 'synthetic-key' };
  const api = createGateway({ identityLoader: () => identity, runtimeLoader: async () => {
    imports++;
    return { callGatewayFromCli: async (method, opts, params, policy) => {
      calls.push({ method, opts, params, policy });
      return structuredClone(fixtures[method]);
    } };
  } });
  const snapshot = await api.snapshot();
  assert.equal(snapshot.transport, 'runtime');
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.models[0].id, 'vendor/model-a');
  assert.equal(imports, 1);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(c => c.policy.sharedStateMode === 'read-only' && c.policy.progress === false));
  assert.ok(calls.every(c => c.policy.deviceIdentity === identity && c.policy.useStoredDeviceAuth === false));
  assert.ok(calls.every(c => c.policy.clientName === 'gateway-client' && c.policy.mode === 'backend'));
  assert.deepEqual(calls[0].policy.scopes, ['operator.read', 'operator.write', 'operator.admin']);
  await api.snapshot({ force: true });
  assert.equal(imports, 1);
  assert.equal(calls.length, 12);
});

test('missing runtime export reports unsupported instead of creating CLI storm', async () => {
  let imports = 0;
  const api = createGateway({ runtimeLoader: async () => { imports++; return {}; } });
  const result = await api.snapshot();
  assert.equal(imports, 1);
  assert.equal(result.errors.length, 6);
  assert.ok(result.errors.every(e => e.code === 'UNSUPPORTED_RUNTIME'));
});

test('missing service identity does not call the SDK without a device or borrow stored identity', async () => {
  let requests = 0;
  const api = createGateway({
    identityLoader: () => { const error = new Error('synthetic unavailable'); error.code = 'GATEWAY_DEVICE_UNAVAILABLE'; throw error; },
    runtimeLoader: async () => ({ callGatewayFromCli: async () => { requests++; throw new Error('must not connect'); } }),
  });
  const result = await api.snapshot();
  assert.equal(requests, 0);
  assert.equal(result.errors.length, 6);
  assert.ok(result.errors.every(error => error.code === 'GATEWAY_AUTH' && !error.message.includes('synthetic')));
});

test('health projects per-queue failure detail with age, never message content', async () => {
  const { api } = harness({ health: { ok: true, ts: 1700000000000, deliveryQueues: {
    failed: [{ queueName: 'outbound', count: 5, oldestFailedAt: 1690000000000, entries: ['PRIVATE-MARKER'] }],
    ingressFailed: [{ channelId: 'chat', accountId: 'atlas', count: 2, oldestFailedAt: 1695000000000, lastError: 'PRIVATE-MARKER' }, { channelId: 'chat', accountId: 'boreal', count: 'x' }],
  } } });
  const s = await api.snapshot();
  noPrivate(s);
  assert.equal(s.health.failedDeliveries, 5);
  assert.deepEqual(s.health.deliveryQueues.failed, [{ queue: 'outbound', channel: null, accountId: null, count: 5, oldestFailedAt: 1690000000000 }]);
  assert.deepEqual(s.health.deliveryQueues.ingressFailed, [{ queue: null, channel: 'chat', accountId: 'atlas', count: 2, oldestFailedAt: 1695000000000 }]);
  assert.equal(s.channels[0].lifecycle, null);
});

// ---- 'ws' transport: environment, identity storage, and error mapping ----

function tempDir(t) { const dir = mkdtempSync(join(tmpdir(), 'mc-gateway-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('without MC_GATEWAY_URL the configuration stays on the runtime transport', () => {
  assert.deepEqual(gatewayConfigFromEnv({ MC_STATE_DIR: '/nonexistent', MC_GATEWAY_TOKEN: 'x' }), {});
  assert.deepEqual(gatewayConfigFromEnv({ MC_GATEWAY_URL: '  ' }), {});
});

test('MC_GATEWAY_URL creates a private, stable device identity and hides the token', t => {
  const stateDir = tempDir(t);
  const env = { MC_GATEWAY_URL: 'ws://127.0.0.1:18789', MC_GATEWAY_TOKEN: 'PRIVATE-MARKER-token', MC_STATE_DIR: stateDir };
  const first = gatewayConfigFromEnv(env);
  assert.equal(first.transport, 'ws');
  assert.equal(first.url, 'ws://127.0.0.1:18789/');
  assert.equal(first.token(), 'PRIVATE-MARKER-token');
  noPrivate(first);
  noPrivate({ ...first });
  const file = join(stateDir, 'gateway-device.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(first.identity.deviceId, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(first.identity).includes('PRIVATE KEY'), 'the private key is not enumerable');
  assert.equal(gatewayConfigFromEnv(env).identity.deviceId, first.identity.deviceId, 'restarts keep the approved device');
  chmodSync(file, 0o644);
  assert.throws(() => gatewayConfigFromEnv(env), e => e.code === 'GATEWAY_DEVICE_UNSAFE');
});

test('token file (Docker secret) and explicit device file are honored; bad values fail at startup', t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'token'), 'PRIVATE-MARKER-file\n', { mode: 0o600 });
  const device = generateGatewayIdentity();
  writeFileSync(join(dir, 'device.json'), JSON.stringify(device), { mode: 0o400 });
  const config = gatewayConfigFromEnv({ MC_GATEWAY_URL: 'wss://gateway.example.com', MC_GATEWAY_TOKEN_FILE: join(dir, 'token'), MC_GATEWAY_DEVICE_FILE: join(dir, 'device.json') });
  assert.equal(config.token(), 'PRIVATE-MARKER-file');
  assert.equal(config.identity.deviceId, device.deviceId);
  // When the token file is not readable, OPENCLAW_GATEWAY_TOKEN is used instead.
  assert.equal(gatewayConfigFromEnv({ MC_GATEWAY_URL: 'ws://127.0.0.1:1', MC_GATEWAY_TOKEN_FILE: join(dir, 'missing'), OPENCLAW_GATEWAY_TOKEN: 'from-start-server', MC_STATE_DIR: dir }).token(), 'from-start-server');
  assert.throws(() => gatewayConfigFromEnv({ MC_GATEWAY_URL: 'ws://127.0.0.1:1', MC_GATEWAY_TOKEN_FILE: join(dir, 'missing'), MC_STATE_DIR: dir }), e => e.code === 'GATEWAY_CREDENTIAL_UNREADABLE');
  assert.throws(() => gatewayConfigFromEnv({ MC_GATEWAY_URL: 'ws://127.0.0.1:1', MC_GATEWAY_TOKEN: 'a\nb', MC_STATE_DIR: dir }), e => e.code === 'GATEWAY_CREDENTIAL_INVALID');
  assert.throws(() => gatewayConfigFromEnv({ MC_GATEWAY_URL: 'ws://203.0.113.9:18789', MC_GATEWAY_TOKEN: 'x', MC_STATE_DIR: dir }), e => e.code === 'GATEWAY_URL_INSECURE');
  assert.throws(() => gatewayConfigFromEnv({ MC_GATEWAY_URL: 'ws://u:PRIVATE-MARKER@127.0.0.1', MC_STATE_DIR: dir }), e => e.code === 'GATEWAY_URL_INVALID' && !e.message.includes('PRIVATE'));
  assert.throws(() => gatewayConfigFromEnv({ MC_GATEWAY_URL: 'ws://127.0.0.1:1', MC_GATEWAY_DEVICE_FILE: join(dir, 'absent.json') }), e => e.code === 'GATEWAY_DEVICE_UNREADABLE');
  writeFileSync(join(dir, 'broken.json'), '{"deviceId":"PRIVATE-MARKER"}', { mode: 0o600 });
  assert.throws(() => loadOrCreateGatewayIdentity({ file: join(dir, 'broken.json') }), e => e.code === 'GATEWAY_DEVICE_INVALID' && !e.message.includes('PRIVATE'));
  assert.ok(!readFileSync(join(dir, 'device.json'), 'utf8').includes('PRIVATE-MARKER'));
});

function fakeClient(fixtures, statusValue = { transport: 'ws', state: 'ready', connected: true, pairing: null, error: null }) {
  const calls = [];
  const fake = {
    calls, statusValue, closed: false,
    async request(method, params, options) {
      calls.push({ method, params, options });
      const value = typeof fixtures === 'function' ? fixtures(method, params) : fixtures[method];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new GatewayClientError('GATEWAY_REQUEST_FAILED', `unknown method: ${method}`, { gatewayCode: 'INVALID_REQUEST' });
      return structuredClone(value);
    },
    status() { return structuredClone(fake.statusValue); },
    start() {}, close() { fake.closed = true; },
  };
  return fake;
}

test('ws transport projects the same snapshot and reports the live connection state', async () => {
  const { fixtures } = harness();
  const client = fakeClient(fixtures);
  const api = createGateway({ client });
  const s = await api.snapshot();
  noPrivate(s);
  assert.equal(s.transport, 'ws');
  assert.equal(s.agents[0].name, 'Atlas');
  assert.equal(s.connection.connected, true);
  assert.equal(client.calls.length, 6);
  assert.equal(client.calls.find(c => c.method === 'sessions.list').options.timeoutMs, 20000);
  client.statusValue = { ...client.statusValue, connected: false, state: 'backoff' };
  assert.equal((await api.snapshot()).connection.connected, false, 'cached data still carries the current connection state');
  api.close();
  assert.equal(client.closed, true);
});

test('pairing required becomes a clear, specific state with the approval command', async () => {
  let at = 1700000000000;
  const pairing = { deviceId: 'a'.repeat(64), requestId: 'req-0001', reason: 'not-paired', command: 'openclaw devices approve req-0001', hint: 'Approve this device on the OpenClaw Gateway host: openclaw devices approve req-0001' };
  const failure = new GatewayClientError('GATEWAY_PAIRING_REQUIRED', 'This dashboard is waiting for device approval in OpenClaw.', { pairing });
  const client = fakeClient(() => failure, { transport: 'ws', state: 'backoff', connected: false, pairing, error: { code: 'GATEWAY_PAIRING_REQUIRED' } });
  const api = createGateway({ client, now: () => at });
  const s = await api.snapshot();
  assert.equal(s.connection.connected, false);
  assert.equal(s.connection.pairing.command, 'openclaw devices approve req-0001');
  assert.equal(s.errors.length, 6);
  assert.ok(s.errors.every(e => e.code === 'GATEWAY_PAIRING' && e.message === 'This dashboard is waiting for approval in OpenClaw. Approve its device on the Gateway host.'));
  const before = client.calls.length;
  at += 6000; // a failed connection is not served from cache for the full minute
  await api.snapshot();
  assert.ok(client.calls.length > before);
});

test('ws failures map to fixed messages; mutations never claim success after a lost connection', async () => {
  const lost = new GatewayClientError('GATEWAY_CONNECTION_LOST', 'The connection to the OpenClaw Gateway was lost.');
  const { fixtures } = harness({ 'cron.update': lost });
  const api = createGateway({ client: fakeClient(fixtures) });
  await assert.rejects(api.updateCron('cron-one', { enabled: false }), e => e.code === 'GATEWAY_UNAVAILABLE' && e.message === 'Could not confirm the operation in OpenClaw. Check the state before repeating it.');
  const cases = [
    [new GatewayClientError('GATEWAY_REQUEST_FAILED', 'missing scope: operator.admin', { gatewayCode: 'FORBIDDEN', detailCode: 'MISSING_SCOPE' }), 'GATEWAY_SCOPE'],
    [new GatewayClientError('GATEWAY_REQUEST_FAILED', 'unknown method: cron.runs', { gatewayCode: 'INVALID_REQUEST' }), 'UNSUPPORTED'],
    [new GatewayClientError('GATEWAY_REQUEST_FAILED', 'invalid cron.runs params: PRIVATE-MARKER', { gatewayCode: 'INVALID_REQUEST' }), 'INCOMPATIBLE'],
    [new GatewayClientError('GATEWAY_TIMEOUT', 'The OpenClaw Gateway did not answer in time.'), 'GATEWAY_TIMEOUT'],
    [new GatewayClientError('GATEWAY_UNREACHABLE', 'Could not connect to the OpenClaw Gateway at the configured address.'), 'GATEWAY_UNREACHABLE'],
    [new GatewayClientError('GATEWAY_AUTH_REJECTED', 'The OpenClaw Gateway rejected the dashboard credentials.', { detailCode: 'AUTH_TOKEN_MISMATCH' }), 'GATEWAY_AUTH'],
  ];
  for (const [error, code] of cases) {
    const other = createGateway({ client: fakeClient({ 'cron.runs': error }) });
    await assert.rejects(other.cronRuns('cron-one'), e => e instanceof GatewayError && e.code === code && !e.message.includes('PRIVATE'), code);
  }
});
