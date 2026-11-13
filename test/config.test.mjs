import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configFromEnv, isLoopback, originAliases, ConfigError } from '../server/config.mjs';

const TOKEN = 'f'.repeat(64);
const refuses = (env, pattern) => assert.throws(() => configFromEnv(env), error => error instanceof ConfigError && pattern.test(error.message));

test('defaults: loopback, port 4318, no login, no workspace', () => {
  const c = configFromEnv({});
  assert.equal(c.host, '127.0.0.1'); assert.equal(c.port, 4318);
  assert.equal(c.origin, 'http://127.0.0.1:4318');
  assert.deepEqual(c.auth, { mode: 'none' });
  assert.equal(c.workspace, null);
  assert.ok(path.isAbsolute(c.stateDir));
  assert.deepEqual(c.warnings, []);
  assert.equal(configFromEnv({ MC_PORT: '5000' }).origin, 'http://127.0.0.1:5000');
});

test('loopback detection and aliases', () => {
  for (const host of ['127.0.0.1', '127.8.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) assert.ok(isLoopback(host), host);
  for (const host of ['0.0.0.0', '192.168.1.5', 'dashboard.example.test', '::', '']) assert.ok(!isLoopback(host), host);
  assert.deepEqual(originAliases('http://127.0.0.1:4318'), ['http://127.0.0.1:4318', 'http://localhost:4318', 'http://[::1]:4318']);
  assert.deepEqual(originAliases('https://dashboard.example.test'), ['https://dashboard.example.test']);
});

test('none is only for a dashboard opened on this computer', () => {
  refuses({ MC_HOST: '0.0.0.0' }, /MC_AUTH is required/);
  refuses({ MC_ORIGIN: 'https://dashboard.example.test' }, /MC_AUTH is required/);
  refuses({ MC_AUTH: 'none', MC_HOST: '0.0.0.0' }, /refuses to listen on 0\.0\.0\.0/);
  refuses({ MC_AUTH: 'none', MC_ORIGIN: 'http://192.168.1.5:4318' }, /MC_ORIGIN must use 127\.0\.0\.1 or localhost/);
  refuses({ MC_AUTH: 'none', MC_HOST: '0.0.0.0', MC_ALLOW_UNAUTHENTICATED_BIND: '1', MC_ORIGIN: 'http://192.168.1.5:4318' }, /MC_ORIGIN must use/);
  // Inside a container whose port is published on the host loopback only.
  const docker = configFromEnv({ MC_AUTH: 'none', MC_HOST: '0.0.0.0', MC_ALLOW_UNAUTHENTICATED_BIND: '1' });
  assert.equal(docker.auth.mode, 'none'); assert.match(docker.warnings[0], /Publish this port only on the host loopback/);
  refuses({ MC_AUTH: 'nobody' }, /MC_AUTH must be one of/);
});

test('token mode: length, file form, https outside loopback', async t => {
  refuses({ MC_AUTH: 'token' }, /needs MC_ACCESS_TOKEN.*openssl rand -hex 32/);
  refuses({ MC_AUTH: 'token', MC_ACCESS_TOKEN: 'short' }, /32 to 4096 characters/);
  refuses({ MC_AUTH: 'token', MC_ACCESS_TOKEN: 'a b'.repeat(20) }, /no spaces/);
  refuses({ MC_AUTH: 'token', MC_ACCESS_TOKEN: TOKEN, MC_HOST: '0.0.0.0', MC_ORIGIN: 'http://192.168.1.5:4318' }, /must not travel over plain HTTP/);
  const docker = configFromEnv({ MC_AUTH: 'token', MC_ACCESS_TOKEN: TOKEN, MC_HOST: '0.0.0.0' });
  assert.deepEqual(docker.auth, { mode: 'token', token: TOKEN, name: 'token' });
  assert.equal(docker.origin, 'http://127.0.0.1:4318', 'plain http is fine when the browser is on this computer');
  assert.equal(configFromEnv({ MC_AUTH: 'token', MC_ACCESS_TOKEN: TOKEN, MC_ACCESS_NAME: 'Ana', MC_ORIGIN: 'https://dashboard.example.test' }).auth.name, 'Ana');
  const directory = await mkdtemp(path.join(tmpdir(), 'mc-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'token'), TOKEN + '\n');
  assert.equal(configFromEnv({ MC_AUTH: 'token', MC_ACCESS_TOKEN_FILE: path.join(directory, 'token') }).auth.token, TOKEN);
  refuses({ MC_AUTH: 'token', MC_ACCESS_TOKEN_FILE: path.join(directory, 'missing') }, /cannot read/);
  refuses({ MC_AUTH: 'token', MC_ACCESS_TOKEN: TOKEN, MC_ACCESS_TOKEN_FILE: path.join(directory, 'token') }, /not both/);
});

test('proxy mode: header required and not a reserved one, allowlist, logout address, loud warning', () => {
  refuses({ MC_AUTH: 'proxy' }, /needs MC_PROXY_AUTH_HEADER/);
  refuses({ MC_AUTH: 'proxy', MC_PROXY_AUTH_HEADER: 'Cookie' }, /identity header/);
  refuses({ MC_AUTH: 'proxy', MC_PROXY_AUTH_HEADER: 'X Bad' }, /identity header/);
  refuses({ MC_AUTH: 'proxy', MC_PROXY_AUTH_HEADER: 'X-Forwarded-Email', MC_PROXY_LOGOUT_URL: 'javascript:alert(1)' }, /MC_PROXY_LOGOUT_URL/);
  const c = configFromEnv({ MC_AUTH: 'proxy', MC_HOST: '0.0.0.0', MC_ORIGIN: 'http://dashboard.tailnet.test', MC_PROXY_AUTH_HEADER: 'Tailscale-User-Login', MC_PROXY_ALLOWED_USERS: 'Ana@Example.test, bob@example.test' });
  assert.deepEqual(c.auth, { mode: 'proxy', header: 'tailscale-user-login', allowedUsers: ['ana@example.test', 'bob@example.test'], logoutUrl: null });
  assert.match(c.warnings[0], /reachable ONLY through your reverse proxy/);
  assert.equal(configFromEnv({ MC_AUTH: 'proxy', MC_PROXY_AUTH_HEADER: 'X-Forwarded-User' }).warnings.length, 2, 'an empty allowlist is also called out');
});

test('cloudflare-access mode keeps its required settings and an https origin', () => {
  const base = { MC_AUTH: 'cloudflare-access', MC_ACCESS_TEAM: 'example-team', MC_ACCESS_AUD: 'a'.repeat(64), MC_ORIGIN: 'https://dashboard.example.test' };
  refuses({ ...base }, /needs MC_ACCESS_TEAM, MC_ACCESS_AUD and MC_ACCESS_EMAILS/);
  refuses({ ...base, MC_ACCESS_EMAILS: ', ,' }, /at least one valid email/);
  refuses({ ...base, MC_ACCESS_EMAILS: 'you@example.test', MC_ORIGIN: 'http://127.0.0.1:4318' }, /https:\/\//);
  assert.deepEqual(configFromEnv({ ...base, MC_ACCESS_EMAILS: 'You@Example.test' }).auth, { mode: 'cloudflare-access', team: 'example-team', aud: 'a'.repeat(64), emails: ['you@example.test'] });
});

test('origin, port, workspace and state folder are validated', async t => {
  refuses({ MC_PORT: '99999' }, /MC_PORT/);
  refuses({ MC_ORIGIN: 'https://dashboard.example.test/', MC_AUTH: 'token', MC_ACCESS_TOKEN: TOKEN }, /no path or trailing slash/);
  refuses({ MC_ORIGIN: 'not a url' }, /MC_ORIGIN must be an address/);
  refuses({ MC_WORKSPACE: '/does-not-exist-mission-control' }, /not a folder/);
  const directory = await mkdtemp(path.join(tmpdir(), 'mc-config-ws-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  refuses({ MC_WORKSPACE: directory, MC_STATE_DIR: path.join(directory, 'state') }, /outside MC_WORKSPACE/);
  const c = configFromEnv({ MC_WORKSPACE: directory, MC_STATE_DIR: directory + '-state' });
  assert.equal(c.workspace, directory); assert.equal(c.stateDir, directory + '-state');
});
