// Who is making this request. One authenticator per installation, chosen by MC_AUTH (see server/config.mjs):
//   none               no login; only ever configured for a dashboard opened on this computer
//   token              a shared access token (MC_ACCESS_TOKEN): login page + signed session cookie, or a Bearer header
//   proxy              a trusted reverse proxy sends the signed-in user in a header (Tailscale, oauth2-proxy, ...)
//   cloudflare-access  Cloudflare Access JWT, verified again here (server/access.ts)
// identify(req) returns {actor} or throws an AppError; route() serves /login and /logout.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';
import { AccessGate } from './access.ts';
import { i18n, t } from './i18n.mjs';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES = 10;
const FORM_LIMIT = 8 * 1024;

const digest = value => createHash('sha256').update(String(value)).digest();
const sameSecret = (given, expected) => timingSafeEqual(digest(given), digest(expected));
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const single = value => Array.isArray(value) ? undefined : value;

export function cookies(req) {
  const out = new Map();
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return out;
}

/** Language of a page the server renders itself: ?lang=, then the interface header, then the browser's Accept-Language. */
export function pageLanguage(req, url) {
  const asked = url?.searchParams.get('lang') || req.headers['x-mc-lang'] || String(req.headers['accept-language'] || '').split(',')[0];
  return i18n.normalize(asked);
}

function validIdentity(value) {
  return typeof value === 'string' && value.trim() && value.length <= 254 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
}

async function readForm(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/x-www-form-urlencoded') throw new AppError('Invalid request format or origin.', 403);
  const chunks = []; let bytes = 0;
  for await (const part of req) { bytes += part.length; if (bytes > FORM_LIMIT) throw new AppError('The document exceeds the request size limit.', 413); chunks.push(part); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function loginPage({ lang, error = '' }) {
  const field = (key, params) => escapeHTML(t(lang, key, params));
  return `<!doctype html><html lang="${i18n.locale(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="color-scheme" content="light dark"><title>${field('Sign in')} · Mission Control</title><style>
:root{--paper:#f6f3eb;--white:#fbf9f3;--ink:#393c36;--muted:#6f7066;--line:#d9d8cd;--sage:#6e806a;--clay:#aa735c;--clay-soft:#efe2d8}
@media (prefers-color-scheme:dark){:root{--paper:#242621;--white:#2d3029;--ink:#e8e4d8;--muted:#b8b8aa;--line:#494d42;--sage:#a5b997;--clay:#e1aa91;--clay-soft:#48372e}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--paper);color:var(--ink);font:400 15px/1.5 "Avenir Next",Avenir,"Segoe UI",sans-serif}
main{width:100%;max-width:380px;background:var(--white);border:1px solid var(--line);border-radius:8px;padding:32px 28px}
.brand{margin:0 0 18px;font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:var(--muted)}h1{margin:0 0 8px;font:400 30px/1.15 "Iowan Old Style",Palatino,Georgia,serif;letter-spacing:-.6px}
p{margin:0 0 18px;color:var(--muted);font-size:13px}label{display:block;font-size:13px;margin-bottom:6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:5px;background:var(--paper);color:var(--ink);font:inherit}input:focus{outline:2px solid var(--sage);outline-offset:1px}
button{margin-top:16px;width:100%;padding:10px 12px;border:0;border-radius:5px;background:var(--ink);color:var(--paper);font:inherit;cursor:pointer}
.error{color:var(--clay);background:var(--clay-soft);border-radius:5px;padding:8px 10px}nav{margin-top:22px;font-size:12px;color:var(--muted)}nav a{color:inherit}
</style></head><body><main><p class="brand">Mission Control</p><h1>${field('Sign in')}</h1><p>${field('Enter the access token configured on the server (MC_ACCESS_TOKEN).')}</p>${error ? `<p class="error" role="alert">${escapeHTML(error)}</p>` : ''}<form method="post" action="/login"><input type="hidden" name="lang" value="${lang}"><input type="text" name="username" value="Mission Control" autocomplete="username" hidden><label for="token">${field('Access token')}</label><input id="token" name="token" type="password" autocomplete="current-password" required autofocus spellcheck="false" maxlength="4096"><button type="submit">${field('Sign in')}</button></form><nav><a href="/login?lang=en" lang="en">English</a> · <a href="/login?lang=pt" lang="pt">Portugu&ecirc;s</a></nav></main></body></html>`;
}

function redirect(res, location, headers = {}) { res.writeHead(303, { Location: location, ...headers }); res.end(); return true; }

function noneAuth() {
  return {
    mode: 'none',
    describe: () => ({ mode: 'none', signOut: null }),
    identify: async () => ({ actor: 'local' }),
    route: async (req, res, url) => (url.pathname === '/login' || url.pathname === '/logout') && redirect(res, '/'),
  };
}

function tokenAuth({ token, name }, { origin, now }) {
  // The signing key comes from the token itself: changing MC_ACCESS_TOKEN invalidates every session at once.
  const key = Buffer.from(hkdfSync('sha256', token, 'mission-control', 'session cookie v1', 32));
  const secure = origin.startsWith('https://');
  const cookieName = secure ? '__Host-mc_session' : 'mc_session';
  const attributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const failures = new Map(); // remote address -> {count, first}
  const revoked = new Map(); // session id -> expiry, for sessions ended with "Sign out" before they expire
  const sign = body => createHmac('sha256', key).update(body).digest('base64url');
  function issue() {
    const exp = now() + SESSION_TTL_MS, sid = randomBytes(16).toString('base64url');
    const body = `v1.${exp.toString(36)}.${sid}`;
    return `${body}.${sign(body)}`;
  }
  function session(req) {
    const value = cookies(req).get(cookieName);
    if (!value || value.length > 200) return null;
    const [version, exp36, sid, signature, extra] = value.split('.');
    if (version !== 'v1' || !exp36 || !sid || !signature || extra !== undefined) return null;
    const expected = sign(`${version}.${exp36}.${sid}`);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const exp = parseInt(exp36, 36);
    if (!Number.isFinite(exp) || exp <= now() || revoked.has(sid)) return null;
    return { sid, exp };
  }
  const client = req => req.socket?.remoteAddress || 'unknown';
  function limited(req) {
    const entry = failures.get(client(req));
    if (!entry) return 0;
    if (now() - entry.first > FAILURE_WINDOW_MS) { failures.delete(client(req)); return 0; }
    return entry.count >= MAX_FAILURES ? Math.max(1, Math.ceil((entry.first + FAILURE_WINDOW_MS - now()) / 60000)) : 0;
  }
  function fail(req) {
    const address = client(req), entry = failures.get(address);
    if (!entry || now() - entry.first > FAILURE_WINDOW_MS) failures.set(address, { count: 1, first: now() });
    else entry.count++;
    if (failures.size > 10_000) for (const [k, v] of failures) if (now() - v.first > FAILURE_WINDOW_MS) failures.delete(k);
  }
  const tooMany = minutes => new AppError(`Too many failed sign-in attempts. Try again in ${minutes} minutes.`, 429);
  const page = (res, status, lang, error) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(loginPage({ lang, error })); return true; };
  return {
    mode: 'token',
    describe: () => ({ mode: 'token', signOut: '/logout' }),
    async identify(req) {
      const authorization = single(req.headers.authorization);
      if (authorization !== undefined) {
        const match = /^Bearer ([^\s]{1,4096})$/.exec(authorization);
        const wait = limited(req);
        if (wait) throw tooMany(wait);
        if (!match || !sameSecret(match[1], token)) { fail(req); throw new AppError('Invalid access token.', 401); }
        return { actor: name };
      }
      if (session(req)) return { actor: name };
      throw new AppError('Sign in to open the dashboard.', 401);
    },
    async route(req, res, url) {
      if (url.pathname === '/logout' && ['GET', 'POST'].includes(req.method)) {
        const current = session(req);
        if (current) { revoked.set(current.sid, current.exp); for (const [sid, exp] of revoked) if (exp <= now()) revoked.delete(sid); }
        return redirect(res, '/login', { 'Set-Cookie': `${cookieName}=; Max-Age=0; ${attributes}` });
      }
      if (url.pathname !== '/login') return false;
      if (req.method === 'GET') return session(req) ? redirect(res, '/') : page(res, 200, pageLanguage(req, url));
      if (req.method !== 'POST') throw new AppError('Not found.', 404);
      const form = await readForm(req);
      const lang = i18n.normalize(form.get('lang') || pageLanguage(req, url));
      const wait = limited(req);
      if (wait) return page(res, 429, lang, t(lang, 'Too many failed sign-in attempts. Try again in {minutes} minutes.', { minutes: wait }));
      const given = form.get('token') || '';
      if (!given || given.length > 4096 || !sameSecret(given.trim(), token)) { fail(req); return page(res, 401, lang, t(lang, 'Invalid access token.')); }
      failures.delete(client(req));
      return redirect(res, '/', { 'Set-Cookie': `${cookieName}=${issue()}; Max-Age=${SESSION_TTL_MS / 1000}; ${attributes}` });
    },
  };
}

function proxyAuth({ header, allowedUsers, logoutUrl }) {
  return {
    mode: 'proxy',
    describe: () => ({ mode: 'proxy', signOut: logoutUrl ? '/logout' : null }),
    async identify(req) {
      const raw = req.headers[header];
      // Node joins a repeated header with ", ": a login or email never contains a comma, so that means two identities.
      if (Array.isArray(raw) || String(raw ?? '').includes(',')) throw new AppError('Your reverse proxy sent more than one identity. Sign in again through it.', 403);
      const actor = validIdentity(raw);
      if (!actor) throw new AppError('Sign in through your reverse proxy to open the dashboard.', 403);
      if (allowedUsers.length && !allowedUsers.includes(actor.toLowerCase())) throw new AppError('Identity not on the allow list', 403);
      return { actor };
    },
    route: async (req, res, url) => url.pathname === '/logout' ? redirect(res, logoutUrl || '/') : url.pathname === '/login' && redirect(res, '/'),
  };
}

function cloudflareAuth({ team, aud, emails }, { gate }) {
  const verifier = gate || new AccessGate(team, aud, emails);
  return {
    mode: 'cloudflare-access',
    describe: () => ({ mode: 'cloudflare-access', signOut: '/logout' }),
    async identify(req) {
      const token = single(req.headers['cf-access-jwt-assertion']) ?? cookies(req).get('CF_Authorization');
      if (!token) throw new AppError('Sign in through Cloudflare Access to open the dashboard.', 403);
      let identity;
      try { identity = await verifier.verify(token); }
      catch (error) { if (error?.status === 503) throw error; throw new AppError('Invalid or expired session. Sign in again through Cloudflare Access.', 403); }
      return { actor: identity?.email };
    },
    // Cloudflare answers /cdn-cgi/access/* at the edge; sending the button there ends the session there.
    route: async (req, res, url) => url.pathname === '/logout' ? redirect(res, '/cdn-cgi/access/logout') : url.pathname === '/login' && redirect(res, '/'),
  };
}

/** config: the `auth` object from configFromEnv. options.gate replaces the Cloudflare verifier (tests). */
export function createAuth(config, { origin, gate, now = Date.now } = {}) {
  if (config?.mode === 'none') return noneAuth();
  if (config?.mode === 'token') return tokenAuth(config, { origin: origin || '', now });
  if (config?.mode === 'proxy') return proxyAuth(config);
  if (config?.mode === 'cloudflare-access') return cloudflareAuth(config, { gate });
  throw new Error('Unknown authentication mode.');
}
