import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';

let serviceIdentity;

export const GATEWAY_DEVICE_FILENAME = 'gateway-device.json';
const MAX_IDENTITY_BYTES = 16_384;

function identityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function invalid() { return identityError('GATEWAY_DEVICE_INVALID', 'The Mission Control connection identity has an invalid format.'); }

/** Validate without using OpenClaw's identity store or creating any key material. */
export function validateGatewayIdentity(value) {
  try {
    if (!value || typeof value !== 'object' || typeof value.deviceId !== 'string' || !/^[a-f0-9]{64}$/.test(value.deviceId) || typeof value.privateKeyPem !== 'string' || typeof value.publicKeyPem !== 'string' || value.privateKeyPem.length > 4096 || value.publicKeyPem.length > 4096) throw invalid();
    const privateKey = createPrivateKey(value.privateKeyPem);
    const publicKey = createPublicKey(value.publicKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') throw invalid();
    const declared = publicKey.export({ type: 'spki', format: 'der' });
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (declared.length !== derived.length || !timingSafeEqual(declared, derived)) throw invalid();
    const fingerprint = createHash('sha256').update(declared.subarray(-32)).digest('hex');
    if (fingerprint !== value.deviceId) throw invalid();
    const identity = { deviceId: value.deviceId, publicKeyPem: value.publicKeyPem };
    // The SDK reads this property directly. Accidental JSON/inspection of the
    // object cannot serialize the private key; it never enters process.env.
    Object.defineProperty(identity, 'privateKeyPem', { value: value.privateKeyPem, enumerable: false });
    return Object.freeze(identity);
  } catch { throw invalid(); }
}

/** Identity for the in-image 'runtime' transport: MC_GATEWAY_DEVICE_FILE, or the one kept in MC_STATE_DIR. */
export function getGatewayIdentity(env = process.env) {
  serviceIdentity ||= loadOrCreateGatewayIdentity({ file: env.MC_GATEWAY_DEVICE_FILE || undefined, stateDir: env.MC_STATE_DIR });
  return serviceIdentity;
}

/** Same key format OpenClaw stores: Ed25519 SPKI/PKCS8 PEM, deviceId = sha256(raw public key). */
export function generateGatewayIdentity(now = Date.now()) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { deviceId: createHash('sha256').update(raw).digest('hex'), publicKeyPem, privateKeyPem, createdAtMs: now };
}

// The file holds a private key: refuse symlinks, other owners, and any
// group/other permission bit instead of silently trusting or "fixing" it.
function readIdentityFile(file, { strict }) {
  let fd;
  try {
    const link = lstatSync(file);
    if (!link.isFile()) throw identityError('GATEWAY_DEVICE_UNSAFE', 'The Mission Control connection identity file has unsafe permissions or ownership.');
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (strict && ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)) throw identityError('GATEWAY_DEVICE_UNSAFE', 'The Mission Control connection identity file has unsafe permissions or ownership.');
    if (stat.size > MAX_IDENTITY_BYTES) throw invalid();
    const text = readFileSync(fd, 'utf8');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw invalid(); }
    return validateGatewayIdentity(parsed);
  } catch (error) {
    if (['GATEWAY_DEVICE_UNSAFE', 'GATEWAY_DEVICE_INVALID'].includes(error?.code)) throw error;
    if (error?.code === 'ENOENT') throw identityError('GATEWAY_DEVICE_UNREADABLE', 'The Mission Control connection identity is not available to the service.');
    throw identityError('GATEWAY_DEVICE_UNREADABLE', 'The Mission Control connection identity is not available to the service.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Explicit file (MC_GATEWAY_DEVICE_FILE): must already exist; it may be a
 * read-only mounted secret, so ownership is not enforced there.
 * Otherwise <stateDir>/gateway-device.json is created once (0600, exclusive)
 * and reused; the deviceId stays stable so the Gateway approval survives restarts.
 */
export function loadOrCreateGatewayIdentity({ file, stateDir, now = Date.now } = {}) {
  if (file) return readIdentityFile(file, { strict: false });
  if (typeof stateDir !== 'string' || !stateDir) throw identityError('GATEWAY_DEVICE_UNAVAILABLE', 'The dashboard\'s own connection identity was not loaded.');
  const target = join(stateDir, GATEWAY_DEVICE_FILENAME);
  try { return readIdentityFile(target, { strict: true }); }
  catch (error) { if (error?.code !== 'GATEWAY_DEVICE_UNREADABLE') throw error; }
  let fd, created = false;
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const value = generateGatewayIdentity(now());
    // O_EXCL: never follow or overwrite something created concurrently.
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') return readIdentityFile(target, { strict: true });
    if (created) { try { closeSync(fd); } catch {} fd = undefined; try { unlinkSync(target); } catch {} }
    throw identityError('GATEWAY_DEVICE_CREATE_FAILED', 'Could not create the Mission Control connection identity in the state directory.');
  } finally { if (fd !== undefined) closeSync(fd); }
  return readIdentityFile(target, { strict: true });
}
