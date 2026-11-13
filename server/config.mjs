// Startup configuration, read once from the environment and validated before anything listens.
// Errors are written for the person installing the dashboard: what is wrong and how to fix it.
import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const AUTH_MODES = Object.freeze(['none', 'token', 'proxy', 'cloudflare-access']);
export const MIN_TOKEN_LENGTH = 32;
const DEFAULT_STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));
// Headers a reverse proxy cannot meaningfully use to carry the user's identity.
const RESERVED_HEADERS = new Set(['host', 'cookie', 'authorization', 'origin', 'referer', 'content-type', 'content-length', 'x-mission-control', 'x-mc-lang', 'cf-access-jwt-assertion']);

export class ConfigError extends Error {}
const fail = message => { throw new ConfigError(message); };

/** True for 127.0.0.0/8, ::1 and localhost: addresses only this computer can reach. */
export function isLoopback(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(value);
}

/** Other spellings of a loopback origin (127.0.0.1, localhost, [::1]) with the same scheme and port. */
export function originAliases(origin) {
  const url = new URL(origin);
  if (!isLoopback(url.hostname)) return [origin];
  const port = url.port ? ':' + url.port : '';
  return [...new Set([origin, ...['127.0.0.1', 'localhost', '[::1]'].map(host => `${url.protocol}//${host}${port}`)])];
}

const list = value => String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const flag = value => ['1', 'true', 'yes'].includes(String(value || '').trim().toLowerCase());

function readSecret(env, name) {
  const direct = env[name];
  const file = env[name + '_FILE'];
  if (direct && file) fail(`Set ${name} or ${name}_FILE, not both.`);
  if (!file) return direct ? String(direct).trim() : '';
  try { return readFileSync(file, 'utf8').trim(); }
  catch { return fail(`${name}_FILE points to a file the dashboard cannot read.`); }
}

function tokenAuth(env, origin) {
  const token = readSecret(env, 'MC_ACCESS_TOKEN');
  if (!token) fail(`MC_AUTH=token needs MC_ACCESS_TOKEN (or MC_ACCESS_TOKEN_FILE). Generate one with: openssl rand -hex 32`);
  if (token.length < MIN_TOKEN_LENGTH || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token)) fail(`MC_ACCESS_TOKEN must be ${MIN_TOKEN_LENGTH} to 4096 characters with no spaces. Generate one with: openssl rand -hex 32`);
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) fail('MC_AUTH=token sends a session cookie, which must not travel over plain HTTP on a network. Put an HTTPS reverse proxy in front of the dashboard and set MC_ORIGIN to its https:// address, or open it on 127.0.0.1.');
  const name = String(env.MC_ACCESS_NAME || 'token').trim();
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) fail('MC_ACCESS_NAME must be a short name (up to 100 characters) with no control characters.');
  return { mode: 'token', token, name };
}

function proxyAuth(env) {
  const header = String(env.MC_PROXY_AUTH_HEADER || '').trim().toLowerCase();
  if (!header) fail('MC_AUTH=proxy needs MC_PROXY_AUTH_HEADER: the header your reverse proxy sets with the signed-in user, e.g. Tailscale-User-Login, X-Forwarded-Email or Cf-Access-Authenticated-User-Email.');
  if (!/^[a-z0-9-]{1,100}$/.test(header) || RESERVED_HEADERS.has(header)) fail('MC_PROXY_AUTH_HEADER must be the name of an identity header, e.g. X-Forwarded-Email.');
  const logoutUrl = String(env.MC_PROXY_LOGOUT_URL || '').trim() || null;
  if (logoutUrl && !/^\/(?!\/)\S*$/.test(logoutUrl) && !/^https:\/\/\S+$/.test(logoutUrl)) fail('MC_PROXY_LOGOUT_URL must be a path such as /oauth2/sign_out or an https:// address.');
  return { mode: 'proxy', header, allowedUsers: list(env.MC_PROXY_ALLOWED_USERS), logoutUrl };
}

function cloudflareAuth(env, origin) {
  const team = String(env.MC_ACCESS_TEAM || '').trim(), aud = String(env.MC_ACCESS_AUD || '').trim();
  const emails = list(env.MC_ACCESS_EMAILS);
  if (!team || !aud || !env.MC_ACCESS_EMAILS) fail('MC_AUTH=cloudflare-access needs MC_ACCESS_TEAM, MC_ACCESS_AUD and MC_ACCESS_EMAILS.');
  if (!emails.length || emails.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail('MC_ACCESS_EMAILS must list at least one valid email, separated by commas.');
  if (!origin.startsWith('https://')) fail('MC_AUTH=cloudflare-access needs MC_ORIGIN to be the https:// address served by Cloudflare.');
  return { mode: 'cloudflare-access', team, aud, emails };
}

/**
 * Reads MC_* variables. Defaults: listen on 127.0.0.1:4318, open at http://127.0.0.1:4318, no login.
 * Any other bind address needs an explicit MC_AUTH; `none` never accepts a network origin.
 */
export function configFromEnv(env = process.env) {
  const warnings = [];
  const host = String(env.MC_HOST || '127.0.0.1').trim();
  const port = Number(env.MC_PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('MC_PORT must be a port number between 1 and 65535.');
  const origin = String(env.MC_ORIGIN || '').trim() || `http://127.0.0.1:${port}`;
  let url;
  try { url = new URL(origin); } catch { fail('MC_ORIGIN must be an address such as https://dashboard.example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) fail('MC_ORIGIN must be only a scheme, host and optional port, with no path or trailing slash, e.g. https://dashboard.example.com.');
  const loopbackBind = isLoopback(host), loopbackOrigin = isLoopback(url.hostname);
  const requested = String(env.MC_AUTH || '').trim().toLowerCase();
  if (requested && !AUTH_MODES.includes(requested)) fail(`MC_AUTH must be one of: ${AUTH_MODES.join(', ')}.`);
  const unauthenticatedBind = flag(env.MC_ALLOW_UNAUTHENTICATED_BIND);
  const mode = requested || (loopbackBind && loopbackOrigin ? 'none'
    : fail(`MC_AUTH is required when the dashboard listens on ${host} or is opened at ${origin}. Use MC_AUTH=token with MC_ACCESS_TOKEN (openssl rand -hex 32), or proxy / cloudflare-access.`));
  let auth;
  if (mode === 'none') {
    if (!loopbackOrigin) fail('MC_AUTH=none works only when the dashboard is opened on this computer: MC_ORIGIN must use 127.0.0.1 or localhost. To reach it from other devices, use MC_AUTH=token, proxy or cloudflare-access.');
    if (!loopbackBind && !unauthenticatedBind) fail(`MC_AUTH=none refuses to listen on ${host}, which other machines may reach. Listen on 127.0.0.1, or, inside a container whose port is published only on the host loopback (127.0.0.1:PORT:PORT), set MC_ALLOW_UNAUTHENTICATED_BIND=1.`);
    if (!loopbackBind) warnings.push(`No login, listening on ${host} because MC_ALLOW_UNAUTHENTICATED_BIND=1. Publish this port only on the host loopback (127.0.0.1); anyone who reaches it controls your agents.`);
    auth = { mode: 'none' };
  } else if (mode === 'token') auth = tokenAuth(env, origin);
  else if (mode === 'proxy') {
    auth = proxyAuth(env);
    warnings.push(`MC_AUTH=proxy trusts the ${auth.header} header on every request. This port must be reachable ONLY through your reverse proxy, and the proxy must overwrite that header; anyone who reaches the port directly can claim any identity.`);
    if (!auth.allowedUsers.length) warnings.push('MC_PROXY_ALLOWED_USERS is empty: every identity the proxy lets through can use the dashboard.');
  } else auth = cloudflareAuth(env, origin);
  const workspace = String(env.MC_WORKSPACE || '').trim();
  const stateDir = path.resolve(String(env.MC_STATE_DIR || '').trim() || DEFAULT_STATE_DIR);
  if (workspace) {
    const root = path.resolve(workspace);
    let folder = false;
    try { folder = statSync(root).isDirectory(); } catch { /* reported below */ }
    if (!folder) fail(`MC_WORKSPACE points to ${root}, which is not a folder the dashboard can read. Leave MC_WORKSPACE empty to run without a workspace.`);
    if (stateDir === root || stateDir.startsWith(root + path.sep)) fail('MC_STATE_DIR must be outside MC_WORKSPACE: dashboard state never goes into your versioned files.');
  }
  return { host, port, origin, auth, workspace: workspace ? path.resolve(workspace) : null, stateDir, warnings };
}
