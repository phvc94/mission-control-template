import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessGate } from './access.ts';
import { createApp } from './http.mjs';
import { createAuth } from './auth.mjs';

// This suite creates its own RSA key pair, JWTs, cert server, and workspace.
// It never reads real Access tokens, credentials, files, agents, or accounts.
const team = 'mission-fixture';
const aud = 'a'.repeat(64);
const email = 'owner@example.test';
const origin = 'https://dashboard.example.test';
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
let certs, certsUrl, certRequests = 0;
const issuer = `https://${team}.cloudflareaccess.com`;
const publicJwk = { ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'fixture-rsa-one', alg: 'RS256' };
function jwt(overrides = {}, header = { alg: 'RS256', kid: 'fixture-rsa-one' }, privateKey = keyPair.privateKey) {
  const at = Math.floor(Date.now() / 1000);
  const payload = { iss: issuer, aud: [aud], email, iat: at - 2, nbf: at - 2, exp: at + 600, ...overrides };
  const pieces = [header, payload].map(v => Buffer.from(JSON.stringify(v)).toString('base64url'));
  const input = pieces.join('.');
  const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url');
  return `${input}.${signature}`;
}
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
before(async () => {
  certs = createServer((_req, res) => { certRequests++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ keys: [publicJwk] })); });
  await new Promise(resolve => certs.listen(0, '127.0.0.1', resolve));
  certsUrl = `http://127.0.0.1:${certs.address().port}/certs`;
});
after(async () => { await close(certs); });
function makeGate(emails = [email]) { return new AccessGate(team, aud, emails, { certsUrl }); }

test('AccessGate validates real RS256 fixture and caches public keys', async () => {
  const gate = makeGate();
  const beforeCount = certRequests;
  assert.deepEqual(await gate.verify(jwt()), { email });
  assert.deepEqual(await gate.verify(jwt({ email: email.toUpperCase() })), { email });
  assert.equal(certRequests - beforeCount, 1);
});

test('AccessGate refuses tampering, wrong email/issuer/audience, expired or future tokens', async () => {
  const gate = makeGate();
  const at = Math.floor(Date.now() / 1000);
  const invalid = [
    jwt({ email: 'other@example.test' }), jwt({ iss: 'https://untrusted.example.test' }),
    jwt({ aud: ['b'.repeat(64)] }), jwt({ exp: at - 120 }),
    jwt({ nbf: at + 120 }), jwt({ iat: at + 120 }),
    jwt({}, { alg: 'HS256', kid: 'fixture-rsa-one' }),
    jwt({}, { alg: 'none', kid: 'fixture-rsa-one' }),
    jwt({}, undefined, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey),
    'broken-token', `${jwt()}.extra`,
  ];
  for (const token of invalid) await assert.rejects(gate.verify(token), e => e.status === 403);
});

test('unknown signing key cannot force certificate fetch per request', async () => {
  const gate = makeGate();
  await gate.verify(jwt());
  const count = certRequests;
  for (let i = 0; i < 4; i++) await assert.rejects(gate.verify(jwt({}, { alg: 'RS256', kid: `unknown-${i}` })), e => e.status === 403);
  assert.equal(certRequests, count);
});

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mc-http-fixture-'));
  const publicDir = join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>Fixture</title>');
  const calls = [];
  const gateway = {
    snapshot: async () => ({ agents: [], sessions: [], routines: [], models: [], channels: [], errors: [], collectedAt: new Date().toISOString() }),
    updateCron: async (id, patch) => { calls.push(['cron', id, patch]); return { ok: true }; },
    setModels: async (id, patch) => { calls.push(['models', id, patch]); return { ok: true }; },
    renewSession: async (key, patch) => { calls.push(['renew', key, patch]); return { ok: true }; },
    getCron: async id => ({ id, configRevision: 'fixture-revision' }),
    cronRuns: async id => ({ id, entries: [] }),
    chatHistory: async key => ({ sessionKey: key, messages: [] }),
    chat: async input => { calls.push(['chat', input]); return { status: 'complete', sessionKey: 'agent:atlas:mission-control', runId: 'run-one', text: 'Fixture answer' }; },
    waitChat: async input => { calls.push(['wait', input]); return { status: 'complete', text: 'Fixture answer' }; },
    ...overrides.gateway,
  };
  const workspace = {
    snapshot: async () => ({ items: [], projects: [] }),
    listFiles: async () => ({ files: [] }),
    readDocument: async path => ({ path, content: 'fixture document', name: 'fixture.md' }),
    saveDocument: async () => { calls.push(['document']); return { ok: true }; },
    mutate: async () => { calls.push(['task']); return { ok: true }; },
  };
  Object.assign(workspace, {
    recentCommits: async () => [{ hash: 'abc123', author: 'Fixture', at: new Date().toISOString(), subject: 'fixture commit', routine: false }],
    storeUpload: async ({ agentId, destination, name, mimeType, stream }, actor) => { let bytes = 0; for await (const chunk of stream) bytes += chunk.length; calls.push(['upload', agentId, destination, name, mimeType, bytes, actor]); return { id: '11111111-2222-4333-8444-555555555555', path: `agentes/${agentId}/anexos/${name}`, gatewayPath: `/home/node/.openclaw/workspace/agentes/${agentId}/anexos/${name}`, name, size: bytes, mimeType, agentId, destination, temporary: destination === 'temporario' }; },
  }, overrides.workspace);
  const monitor = { snapshot: async () => ({ vm: {}, sources: {}, warnings: [], acks: [] }), acknowledge: async (input, actor) => { calls.push(['ack', input, actor]); return { ok: true }; }, unacknowledge: async (input, actor) => { calls.push(['unack', input, actor]); return { ok: true }; } };
  const stateDir = overrides.stateDir || join(directory, 'state');
  const auth = createAuth({ mode: 'cloudflare-access', team, aud, emails: [email] }, { gate: overrides.gate || makeGate() });
  const server = createApp({ gateway, workspace, monitor, auth, origin, publicDir, stateDir, auditWriter: overrides.auditWriter, chatLifetimeMs: overrides.chatLifetimeMs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Job persistence writes in the background; cleanup tolerates a file that is still being written.
  t.after(async () => { await close(server); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  function send(path, { method = 'GET', headers = {}, body, authenticated = true } = {}) {
    const defaultHeaders = { host: new URL(origin).host, 'x-forwarded-proto': 'https', ...(authenticated ? { 'cf-access-jwt-assertion': jwt() } : {}) };
    if (method !== 'GET') Object.assign(defaultHeaders, { origin, 'content-type': 'application/json', 'x-mission-control': '1' });
    const finalHeaders = { ...defaultHeaders, ...headers };
    for (const key of Object.keys(finalHeaders)) if (finalHeaders[key] === undefined) delete finalHeaders[key];
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: finalHeaders }, res => {
        const parts = []; res.on('data', b => parts.push(b)); res.on('end', () => { const text = Buffer.concat(parts).toString(); let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, data }); });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
  }
  function raw(path, { headers = {}, body = Buffer.alloc(0) } = {}) {
    const finalHeaders = { host: new URL(origin).host, 'x-forwarded-proto': 'https', 'cf-access-jwt-assertion': jwt(), origin, 'x-mission-control': '1', 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...headers };
    for (const key of Object.keys(finalHeaders)) if (finalHeaders[key] === undefined) delete finalHeaders[key];
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: finalHeaders }, res => {
        const parts = []; res.on('data', b => parts.push(b)); res.on('end', () => { const text = Buffer.concat(parts).toString(); let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, data }); });
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { server, send, raw, calls, gateway, directory, stateDir };
}
async function jobResult(send, id) {
  for (let i = 0; i < 100; i++) {
    const response = await send(`/api/chat/jobs/${id}`);
    if (response.data.status !== 'running') return response;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('fixture job did not settle');
}

test('every public and API route requires valid Access token, host and HTTPS', async t => {
  const { send } = await fixture(t);
  for (const path of ['/', '/api/status', '/api/document?path=sistema/ESTADO.md', '/app.js']) assert.equal((await send(path, { authenticated: false })).status, 403);
  const logout = await send('/logout', { authenticated: false });
  assert.equal(logout.status, 303); assert.equal(logout.headers.location, '/cdn-cgi/access/logout');
  assert.equal((await send('/healthz', { authenticated: false, headers: { host: 'anything.example.test', 'x-forwarded-proto': undefined } })).text, 'ok\n');
  assert.equal((await send('/', { headers: { host: 'wrong.example.test' } })).status, 403);
  assert.equal((await send('/', { headers: { 'x-forwarded-proto': 'http' } })).status, 403);
  assert.equal((await send('/', { headers: { 'cf-access-jwt-assertion': jwt({ email: 'other@example.test' }) } })).status, 403);
  const page = await send('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  const status = await send('/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.data.access, { mode: 'cloudflare-access', signOut: '/logout', actor: email });
  assert.equal(status.data.demo, false);
  assert.equal((await send('/', { authenticated: false, headers: { cookie: `CF_Authorization=${jwt()}` } })).status, 200);
});

test('writes require same origin, JSON, custom header, and object body before any action', async t => {
  const { send, calls } = await fixture(t);
  const path = '/api/agents/atlas/models';
  const payload = { primary: 'fixture/model', fallbacks: [] };
  for (const headers of [{ origin: undefined }, { origin: 'https://other.example.test' }, { 'sec-fetch-site': 'cross-site' }, { 'x-mission-control': undefined }, { 'content-type': 'text/plain' }]) assert.equal((await send(path, { method: 'POST', body: payload, headers })).status, 403);
  for (const body of ['null', '[]', '{broken']) assert.equal((await send(path, { method: 'POST', body })).status, 400);
  assert.equal(calls.length, 0);
});

test('successful gateway mutations remain successful if final audit fails', async t => {
  const { send, calls } = await fixture(t, { auditWriter: async event => { if (event.result === 'confirmed') throw new Error('fixture audit disk failure'); } });
  const actions = [
    ['/api/agents/atlas/models', 'POST', { primary: 'fixture/model', fallbacks: [] }],
    ['/api/routines/routine-one', 'PATCH', { enabled: false }],
    ['/api/sessions/renew', 'POST', { sessionKey: 'agent:atlas:mission-control', confirm: true, expectedSessionId: 'one' }],
  ];
  for (const [path, method, body] of actions) {
    const response = await send(path, { method, body });
    assert.equal(response.status, 200);
    assert.equal(response.data.ok, true);
    assert.match(response.data.auditWarning, /Do not repeat/);
  }
  assert.equal(calls.length, 3);
});

test('failed requested audit never executes chat or leaves orphaned running jobs', async t => {
  const { send, calls } = await fixture(t, { auditWriter: async () => { throw new Error('fixture only'); } });
  for (let i = 0; i < 4; i++) assert.equal((await send('/api/chat', { method: 'POST', body: { agentId: 'atlas', message: 'hello fixture' } })).status, 500);
  assert.equal(calls.length, 0);
});

test('chat jobs continue same run and audit failure does not lose the answer', async t => {
  let sends = 0, waits = 0;
  const { send } = await fixture(t, {
    gateway: {
      chat: async input => { sends++; assert.ok(input.idempotencyKey); assert.equal(input.waitTimeoutMs, undefined); return { runId: 'run-one', sessionKey: 'agent:atlas:mission-control', status: 'pending' }; },
      waitChat: async input => { waits++; assert.equal(input.runId, 'run-one'); return { status: 'complete', text: 'Final fixture answer' }; },
    },
    auditWriter: async event => { if (event.result !== 'requested') throw new Error('fixture audit failure'); },
  });
  const queued = await send('/api/chat', { method: 'POST', body: { agentId: 'atlas', message: 'hello fixture', waitTimeoutMs: 0 } });
  assert.equal(queued.status, 202);
  const finished = await jobResult(send, queued.data.jobId);
  assert.equal(finished.data.status, 'completed');
  assert.equal(finished.data.result.text, 'Final fixture answer');
  assert.ok(finished.data.auditWarning);
  assert.equal(sends, 1);
  assert.equal(waits, 1);
});

test('pending chat after job deadline stays pending and never reports complete', async t => {
  const { send } = await fixture(t, { chatLifetimeMs: 0, gateway: { chat: async () => ({ status: 'pending', runId: 'run-long', sessionKey: 'agent:atlas:mission-control' }), waitChat: async () => assert.fail('deadline elapsed') } });
  const queued = await send('/api/chat', { method: 'POST', body: { agentId: 'atlas', message: 'hello fixture' } });
  const finished = await jobResult(send, queued.data.jobId);
  assert.equal(finished.data.status, 'pending');
  assert.equal(finished.data.result.status, 'pending');
});

test('idempotent retry returns same job, changed payload conflicts, other actor cannot read job', async t => {
  let sends = 0;
  const { send } = await fixture(t, { gate: makeGate([email, 'second@example.test']), gateway: { chat: async () => { sends++; return { status: 'complete', text: 'fixture' }; } } });
  const input = { agentId: 'atlas', message: 'hello fixture', idempotencyKey: 'fixture-request-one' };
  const first = await send('/api/chat', { method: 'POST', body: input });
  const duplicate = await send('/api/chat', { method: 'POST', body: input });
  assert.equal(duplicate.data.jobId, first.data.jobId);
  assert.equal(sends, 1);
  assert.equal((await send('/api/chat', { method: 'POST', body: { ...input, message: 'another' } })).status, 409);
  assert.equal((await send(`/api/chat/jobs/${first.data.jobId}`, { headers: { 'cf-access-jwt-assertion': jwt({ email: 'second@example.test' }) } })).status, 404);
});

test('malformed route and malformed verified token fail safely without raw details', async t => {
  const { send } = await fixture(t);
  assert.equal((await send('/api/routines/%ZZ')).status, 400);
  const nullHeader = jwt({}, null);
  const response = await send('/api/status', { headers: { 'cf-access-jwt-assertion': nullHeader } });
  assert.equal(response.status, 403);
  assert.ok(!response.text.includes('TypeError'));
});

test('acknowledging an alert is audited, needs JSON body and reaches the monitor with the verified actor', async t => {
  const { send, calls } = await fixture(t);
  const ok = await send('/api/alerts/ack', { method: 'POST', body: { key: 'check:reboot', fingerprint: 'warn|x', reason: 'fixture' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.at(-1), ['ack', { key: 'check:reboot', fingerprint: 'warn|x', reason: 'fixture' }, email]);
  assert.equal((await send('/api/alerts/unack', { method: 'POST', body: { key: 'check:reboot' } })).status, 200);
  assert.equal(calls.at(-1)[0], 'unack');
  assert.equal((await send('/api/alerts/ack', { method: 'POST', body: '{broken' })).status, 400);
});

test('activity timeline merges commits, routines, sessions and audit events, newest first', async t => {
  const { send } = await fixture(t, { gateway: { snapshot: async () => ({ agents: [], sessions: [{ key: 'agent:atlas:main', agentId: 'atlas', updatedAt: Date.now() - 5000 }], routines: [{ id: 'cron-one', name: 'Review', agentId: 'atlas', lastRunAt: Date.now() - 1000, lastStatus: 'ok' }], models: [], channels: [], errors: [], collectedAt: new Date().toISOString() }) } });
  const response = await send('/api/activity');
  assert.equal(response.status, 200);
  const kinds = response.data.events.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 3).sort(), ['commit', 'routine', 'session']);
  for (let i = 1; i < response.data.events.length; i++) assert.ok(response.data.events[i - 1].at >= response.data.events[i].at);
});

test('upload stores the raw body through the workspace and attachments reach the agent as paths, never as JSON content', async t => {
  const { send, raw, calls } = await fixture(t);
  const content = Buffer.from('%PDF-1.4 fixture');
  const up = await raw('/api/upload', { headers: { 'x-file-name': encodeURIComponent('Test book.pdf'), 'x-agent-id': 'atlas', 'content-type': 'application/pdf' }, body: content });
  assert.equal(up.status, 201);
  assert.deepEqual(calls.find(c => c[0] === 'upload').slice(1), ['atlas', 'temporario', 'Test book.pdf', 'application/pdf', content.length, email]);
  assert.equal((await raw('/api/upload', { headers: { 'x-file-name': 'x.pdf', 'x-agent-id': 'atlas', 'x-mission-control': undefined }, body: content })).status, 403);
  const wrongAgent = await send('/api/chat', { method: 'POST', body: { agentId: 'boreal', message: 'look', attachments: [up.data.id] } });
  assert.equal(wrongAgent.status, 400);
  const queued = await send('/api/chat', { method: 'POST', body: { agentId: 'atlas', message: '', attachments: [up.data.id] } });
  assert.equal(queued.status, 202);
  const finished = await jobResult(send, queued.data.jobId);
  assert.equal(finished.data.status, 'completed');
  assert.equal(finished.data.attachments[0].name, 'Test book.pdf');
  const chat = calls.find(c => c[0] === 'chat')[1];
  assert.match(chat.message, /^Here is the attached file\.\n\n\[media attached: \/home\/node\/\.openclaw\/workspace\/agentes\/atlas\/anexos\/Test book\.pdf\]/);
  assert.ok(!chat.message.includes('%PDF'));
  assert.match(chat.message, /\(Files sent by the user from Mission Control: Test book\.pdf, application\/pdf, 1 KB, TEMPORARY: will be deleted automatically in 3 days/);
  assert.equal((await send('/api/chat', { method: 'POST', body: { agentId: 'atlas', message: 'again', attachments: [up.data.id] } })).status, 410, 'an attachment is consumed by one message');
  assert.equal((await send('/api/chat', { method: 'POST', body: { agentId: 'atlas', message: '' } })).status, 400);
});

test('running chat jobs survive a restart: the new process follows the same run without a second send', async t => {
  const first = await fixture(t, { gateway: { chat: async () => ({ runId: 'run-persist', sessionKey: 'agent:atlas:mission-control', status: 'pending' }), waitChat: () => new Promise(() => {}) } });
  const queued = await first.send('/api/chat', { method: 'POST', body: { agentId: 'atlas', message: 'persistent' } });
  assert.equal(queued.status, 202);
  for (let i = 0; i < 50 && !JSON.parse(await readFile(join(first.stateDir, 'chat-jobs.json'), 'utf8').catch(() => '[]')).some(j => j.result?.runId === 'run-persist'); i++) await new Promise(r => setTimeout(r, 10));
  const saved = JSON.parse(await readFile(join(first.stateDir, 'chat-jobs.json'), 'utf8'));
  assert.equal(saved[0].status, 'running');
  assert.equal(saved[0].input.message, undefined, 'message text is not persisted');
  await close(first.server);
  let sends = 0, waits = 0;
  const second = await fixture(t, { stateDir: first.stateDir, gateway: { chat: async () => { sends++; throw new Error('must not resend'); }, waitChat: async input => { waits++; assert.equal(input.runId, 'run-persist'); return { status: 'complete', text: 'Answer after restart' }; } } });
  const finished = await jobResult(second.send, queued.data.jobId);
  assert.equal(finished.data.status, 'completed');
  assert.equal(finished.data.result.text, 'Answer after restart');
  assert.equal(sends, 0); assert.equal(waits, 1);
});

test('error messages and the note sent with attachments follow the language the interface asks for', async t => {
  const { send, raw, calls } = await fixture(t);
  const empty = { agentId: 'atlas', message: '' };
  assert.equal((await send('/api/chat', { method: 'POST', body: empty })).data.error, 'Write a message or attach a file.');
  assert.equal((await send('/api/chat', { method: 'POST', headers: { 'x-mc-lang': 'pt-BR' }, body: empty })).data.error, 'Escreva uma mensagem ou anexe um arquivo.');
  assert.equal((await send('/api/missing', { headers: { 'x-mc-lang': 'pt' } })).data.error, 'Não encontrado.');
  assert.equal((await send('/api/missing', { headers: { 'x-mc-lang': 'fr' } })).data.error, 'Not found.');
  const up = await raw('/api/upload', { headers: { 'x-file-name': 'notes.txt', 'x-agent-id': 'atlas', 'content-type': 'text/plain' }, body: Buffer.from('fixture') });
  const queued = await send('/api/chat', { method: 'POST', headers: { 'x-mc-lang': 'pt' }, body: { ...empty, attachments: [up.data.id] } });
  assert.equal(queued.status, 202);
  await jobResult(send, queued.data.jobId);
  const chat = calls.find(c => c[0] === 'chat')[1];
  assert.match(chat.message, /^Segue o arquivo em anexo\.\n\n\[media attached: \/home\/node\/\.openclaw\/workspace\/agentes\/atlas\/anexos\/notes\.txt\]/);
  assert.match(chat.message, /\(Arquivos enviados pelo usuário no Mission Control: notes\.txt, text\/plain, 1 KB, TEMPORÁRIO: será apagado automaticamente em 3 dias/);
});
