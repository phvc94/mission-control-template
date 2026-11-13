import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { AppError } from './errors.mjs';
// Cloudflare Access authenticates at the edge, but the origin must not take that on faith: a request
// that arrives here without a valid, current token is refused again. Cloudflare documents this second
// check as the defence for anything that reaches the origin without passing the edge.
// Where the token comes from (header or CF_Authorization cookie) is decided in server/auth.mjs.
const skew = 60;
interface Payload { iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; iat?: unknown; email?: unknown }
interface Options { certsUrl?: string; ttlMs?: number; cooldownMs?: number }
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
export class AccessGate {
  readonly issuer: string;
  readonly certsUrl: string;
  private readonly audience: string;
  private readonly emails: string[];
  private readonly ttlMs: number;
  private readonly cooldownMs: number;
  private keys = new Map<string, KeyObject>();
  private refreshedAt = 0;
  private refreshing?: Promise<void>;
  // certsUrl, ttlMs and cooldownMs exist for the tests and are never read from the environment, so no
  // deployment can be pointed at a foreign key set or talked into fetching on every request.
  constructor(team: string, audience: string, emails: string[] = [], options: Options = {}) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(team)) throw new Error('Invalid Zero Trust team name');
    if (!/^[a-f0-9]{64}$/.test(audience)) throw new Error('Invalid Access application AUD');
    this.audience = audience;
    this.emails = emails;
    this.issuer = `https://${team}.cloudflareaccess.com`;
    this.certsUrl = options.certsUrl ?? `${this.issuer}/cdn-cgi/access/certs`;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }
  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await fetch(this.certsUrl, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new AppError('Could not fetch the Cloudflare Access keys', 503);
      const body = await response.json() as { keys?: { kid?: unknown; kty?: unknown; alg?: unknown }[] };
      const keys = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256')) continue;
        try { keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' })); } catch { /* an unreadable key is skipped */ }
      }
      if (!keys.size) throw new AppError('Cloudflare Access returned no usable key', 503);
      this.keys = keys;
      this.refreshedAt = Date.now();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async keyFor(kid: string): Promise<KeyObject> {
    // Cloudflare publishes the next signing key before using it, so the periodic reread covers rotation.
    if (!this.keys.size || Date.now() - this.refreshedAt > this.ttlMs) await this.refresh();
    const known = this.keys.get(kid);
    if (known) return known;
    // An unknown kid is the safety net, never a fetch per request: at most one reread per cooldown.
    if (Date.now() - this.refreshedAt <= this.cooldownMs) throw new AppError('Unknown signing key', 403);
    await this.refresh();
    const key = this.keys.get(kid);
    if (!key) throw new AppError('Unknown signing key', 403);
    return key;
  }
  async verify(token: string): Promise<{ email?: string }> {
    if (token.length > 8192) throw new AppError('Token too large', 403);
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new AppError('Malformed token', 403);
    let header: { alg?: unknown; kid?: unknown };
    let payload: Payload;
    try { header = decode(parts[0]) as typeof header; payload = decode(parts[1]) as Payload; }
    catch { throw new AppError('Unreadable token', 403); }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AppError('Algorithm not accepted', 403);
    const key = await this.keyFor(header.kid);
    const verifier = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    if (!verifier.verify(key, Buffer.from(parts[2], 'base64url'))) throw new AppError('Invalid signature', 403);
    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== this.issuer) throw new AppError('Unexpected issuer', 403);
    if (!audience.includes(this.audience)) throw new AppError('Token for another application', 403);
    if (typeof payload.exp !== 'number' || payload.exp <= now - skew) throw new AppError('Session expired', 403);
    if (typeof payload.nbf === 'number' && payload.nbf > now + skew) throw new AppError('Token not valid yet', 403);
    if (typeof payload.iat === 'number' && payload.iat > now + skew) throw new AppError('Token issued in the future', 403);
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
    if (this.emails.length && (!email || !this.emails.includes(email))) throw new AppError('Identity not on the allow list', 403);
    return { email };
  }
}
