import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/http.mjs';
import { createAuth, MAX_FAILURES, SESSION_TTL_MS } from '../server/auth.mjs';
import { createMissingWorkspace } from '../server/workspace.mjs';

// Fictional tokens and identities only. Every server listens on an ephemeral loopback port.
const TOKEN = 'a'.repeat(24) + 'fixture-token-0123456789';
async function serve(t, auth, { origin, workspace } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mc-auth-fixture-'));
  const publicDir = path.join(directory, 'public');
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Fixture</title>');
  const calls = [];
  const app = createApp({
    auth, origin: origin || 'http://127.0.0.1:4318', publicDir, stateDir: path.join(directory, 'state'), persistJobs: false,
    gateway: { snapshot: async () => ({ agents: [], sessions: [], routines: [], models: [], channels: [], errors: [] }) },
    monitor: { snapshot: async () => ({ vm: null, incidents: [], warnings: [], acks: [], sources: {} }), acknowledge: async (input, actor) => { calls.push(['ack', actor]); return { ok: true }; } },
    workspace: workspace || { snapshot: async () => ({ items: [], projects: [] }), recentCommits: async () => [], mutate: async (input, actor) => { calls.push(['mutate', actor]); return { ok: true }; } },
    auditWriter: async () => {},
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const host = new URL(origin || 'http://127.0.0.1:4318').host;
  const send = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const final = { host, ...(method !== 'GET' ? { origin: origin || 'http://127.0.0.1:4318' } : {}), ...headers };
    for (const key of Object.keys(final)) if (final[key] === undefined) delete final[key];
    const req = request({ hostname: '127.0.0.1', port: app.address().port, path: route, method, headers: final }, res => {
      const parts = []; res.on('data', b => parts.push(b));
      res.on('end', () => { const text = Buffer.concat(parts).toString(); let data; try { data = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, data }); });
    });
    req.on('error', reject); req.end(body);
  });
  const login = (token, headers = {}) => send('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ token }).toString() });
  const json = (route, body, headers = {}) => send(route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mission-control': '1', ...headers }, body: JSON.stringify(body) });
  return { send, login, json, calls };
}
const cookieOf = response => String(response.headers['set-cookie']?.[0] || '').split(';')[0];

test('none: every route opens as "local" on the loopback origin and its aliases, foreign hosts are refused', async t => {
  const { send, json, calls } = await serve(t, createAuth({ mode: 'none' }));
  const status = await send('/api/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.data.access, { mode: 'none', signOut: null, actor: 'local' });
  assert.equal((await send('/', { headers: { host: 'localhost:4318' } })).status, 200);
  assert.equal((await send('/', { headers: { host: 'evil.example.test' } })).status, 403, 'DNS rebinding: a foreign Host is refused');
  assert.equal((await json('/api/tasks/mutate', {}, { origin: 'http://evil.example.test' })).status, 403);
  assert.equal((await json('/api/tasks/mutate', {}, { origin: 'http://localhost:4318', host: 'localhost:4318' })).status, 200);
  assert.deepEqual(calls.at(-1), ['mutate', 'local']);
  const out = await send('/logout');
  assert.equal(out.status, 303); assert.equal(out.headers.location, '/');
});

test('token: login page, wrong and right token, session cookie, Bearer header and logout', async t => {
  const { send, login, json, calls } = await serve(t, createAuth({ mode: 'token', token: TOKEN, name: 'owner' }, { origin: 'http://127.0.0.1:4318' }));
  const home = await send('/');
  assert.equal(home.status, 303); assert.equal(home.headers.location, '/login');
  assert.equal((await send('/api/status')).status, 401);
  assert.equal((await send('/app.js')).status, 401);
  const page = await send('/login', { headers: { 'accept-language': 'pt-BR,pt;q=0.9' } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /<html lang="pt-BR">/); assert.match(page.text, /Token de acesso/);
  assert.doesNotMatch(page.text, /<script/i, 'the login page works under the script-free CSP');
  assert.match((await send('/login?lang=en')).text, /Access token/);
  const wrong = await login('b'.repeat(64));
  assert.equal(wrong.status, 401); assert.match(wrong.text, /Invalid access token/); assert.equal(wrong.headers['set-cookie'], undefined);
  assert.equal((await login(TOKEN, { origin: 'http://evil.example.test' })).status, 403, 'a login form posted from another origin is refused');
  const ok = await login(TOKEN);
  assert.equal(ok.status, 303); assert.equal(ok.headers.location, '/');
  const setCookie = ok.headers['set-cookie'][0];
  assert.match(setCookie, /^mc_session=v1\./); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
  assert.doesNotMatch(setCookie, /Secure/, 'no Secure flag on a plain-http loopback origin');
  assert.ok(!setCookie.includes(TOKEN), 'the cookie never carries the token');
  const cookie = cookieOf(ok);
  const status = await send('/api/status', { headers: { cookie } });
  assert.equal(status.status, 200); assert.deepEqual(status.data.access, { mode: 'token', signOut: '/logout', actor: 'owner' });
  assert.equal((await send('/login', { headers: { cookie } })).headers.location, '/', 'signed in: the login page sends you home');
  const [name, value] = cookie.split('=');
  const tampered = value.slice(0, -2) + (value.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await send('/api/status', { headers: { cookie: `${name}=${tampered}` } })).status, 401);
  assert.equal((await send('/api/status', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await send('/api/status', { headers: { authorization: 'Bearer ' + 'c'.repeat(64) } })).status, 401);
  assert.equal((await json('/api/tasks/mutate', {}, { cookie })).status, 200);
  assert.deepEqual(calls.at(-1), ['mutate', 'owner'], 'audits record the token name as the actor');
  const out = await send('/logout', { headers: { cookie } });
  assert.equal(out.status, 303); assert.equal(out.headers.location, '/login');
  assert.match(out.headers['set-cookie'][0], /^mc_session=; Max-Age=0/);
  assert.equal((await send('/api/status', { headers: { cookie } })).status, 401, 'a signed-out session stays invalid even if the cookie was kept');
});

test('token: an https origin sets a Secure __Host- cookie and requires the forwarded HTTPS scheme', async t => {
  const origin = 'https://dashboard.example.test';
  const { send, login } = await serve(t, createAuth({ mode: 'token', token: TOKEN, name: 'token' }, { origin }), { origin });
  assert.equal((await send('/login')).status, 403, 'plain http behind an https origin is refused');
  const ok = await login(TOKEN, { 'x-forwarded-proto': 'https' });
  assert.equal(ok.status, 303);
  assert.match(ok.headers['set-cookie'][0], /^__Host-mc_session=.*; Secure$/);
  assert.equal(ok.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal((await send('/api/status', { headers: { cookie: cookieOf(ok), 'x-forwarded-proto': 'https' } })).status, 200);
});

test('token: failed attempts are rate limited, also for Bearer, and a later success is refused while limited', async t => {
  let clock = Date.now();
  const { send, login } = await serve(t, createAuth({ mode: 'token', token: TOKEN, name: 'token' }, { origin: 'http://127.0.0.1:4318', now: () => clock }));
  for (let i = 0; i < MAX_FAILURES; i++) assert.equal((await login('wrong-' + 'x'.repeat(40))).status, 401);
  const limited = await login(TOKEN);
  assert.equal(limited.status, 429); assert.match(limited.text, /Too many failed sign-in attempts/);
  assert.equal((await send('/api/status', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 429);
  clock += 16 * 60 * 1000;
  assert.equal((await login(TOKEN)).status, 303, 'the window expires');
});

test('token: changing the token invalidates every session', async t => {
  const first = await serve(t, createAuth({ mode: 'token', token: TOKEN, name: 'token' }, { origin: 'http://127.0.0.1:4318' }));
  const cookie = cookieOf(await first.login(TOKEN));
  assert.equal((await first.send('/api/status', { headers: { cookie } })).status, 200);
  const rotated = await serve(t, createAuth({ mode: 'token', token: 'z'.repeat(48), name: 'token' }, { origin: 'http://127.0.0.1:4318' }));
  assert.equal((await rotated.send('/api/status', { headers: { cookie } })).status, 401);
  const same = await serve(t, createAuth({ mode: 'token', token: TOKEN, name: 'token' }, { origin: 'http://127.0.0.1:4318' }));
  assert.equal((await same.send('/api/status', { headers: { cookie } })).status, 200, 'a restart with the same token keeps sessions');
});

test('token: expired sessions are refused', async t => {
  let clock = Date.now();
  const { send, login } = await serve(t, createAuth({ mode: 'token', token: TOKEN, name: 'token' }, { origin: 'http://127.0.0.1:4318', now: () => clock }));
  const cookie = cookieOf(await login(TOKEN));
  clock += SESSION_TTL_MS + 1000;
  assert.equal((await send('/api/status', { headers: { cookie } })).status, 401);
});

test('proxy: the trusted header is the actor, the allowlist applies, and a missing or repeated header is refused', async t => {
  const auth = createAuth({ mode: 'proxy', header: 'tailscale-user-login', allowedUsers: ['ana@example.test'], logoutUrl: null });
  const { send, json, calls } = await serve(t, auth);
  assert.equal((await send('/api/status')).status, 403);
  assert.equal((await send('/api/status', { headers: { 'tailscale-user-login': 'bob@example.test' } })).status, 403);
  const ok = await send('/api/status', { headers: { 'tailscale-user-login': 'Ana@example.test' } });
  assert.equal(ok.status, 200); assert.deepEqual(ok.data.access, { mode: 'proxy', signOut: null, actor: 'Ana@example.test' });
  assert.equal((await json('/api/tasks/mutate', {}, { 'tailscale-user-login': 'Ana@example.test' })).status, 200);
  assert.deepEqual(calls.at(-1), ['mutate', 'Ana@example.test']);
  assert.equal((await send('/api/status', { headers: { 'tailscale-user-login': 'ana\t@example.test' } })).status, 403, 'control characters never reach an audit record');
  assert.equal((await send('/api/status', { headers: { 'tailscale-user-login': 'ana@example.test, bob@example.test' } })).status, 403, 'a repeated header (joined with a comma) is refused');
  const open = await serve(t, createAuth({ mode: 'proxy', header: 'x-forwarded-user', allowedUsers: [], logoutUrl: '/oauth2/sign_out' }));
  const anyone = await open.send('/api/status', { headers: { 'x-forwarded-user': 'carla' } });
  assert.equal(anyone.status, 200, 'without an allowlist any proxy identity (not only emails) is accepted');
  assert.equal(anyone.data.access.signOut, '/logout');
  assert.equal((await open.send('/logout')).headers.location, '/oauth2/sign_out');
});

test('without a workspace the server runs, reports "not configured" and refuses writes politely', async t => {
  const { send, json } = await serve(t, createAuth({ mode: 'none' }), { workspace: createMissingWorkspace() });
  const status = await send('/api/status');
  assert.equal(status.status, 200);
  assert.equal(status.data.sources.workspace.configured, false);
  assert.equal(status.data.sources.workspace.connected, false);
  assert.match(status.data.sources.workspace.description, /No workspace connected\. Set MC_WORKSPACE/);
  assert.deepEqual(status.data.workspace.items, []);
  const files = await send('/api/files');
  assert.equal(files.status, 200); assert.deepEqual(files.data.files, []);
  const write = await json('/api/tasks/mutate', { action: 'create' });
  assert.equal(write.status, 409); assert.match(write.data.error, /No workspace connected/);
  const pt = await json('/api/document', { path: 'tasks/x.md', content: '' }, { 'x-mc-lang': 'pt' });
  assert.equal(pt.status, 409); assert.match(pt.data.error, /Nenhum workspace conectado/);
  assert.equal((await send('/api/document?path=tasks/x.md')).status, 409);
});
