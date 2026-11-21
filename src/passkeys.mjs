import { createHash, createECDH, createPublicKey, verify as verifySignature, hkdfSync, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

// End-to-end encryption and passkey checks for the secret handoff. The page (relay/page.mjs)
// encrypts with ECDH P-256 + HKDF-SHA256 + AES-256-GCM to a key pair made here for each request,
// and signs SHA-256(challenge || epk || iv || ct) with a passkey registered here before.

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const unb64url = (s) => Buffer.from(String(s ?? ''), 'base64url');

// A fresh key pair per request; only the public half leaves this process (in the link fragment).
export function newKeyPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { ecdh, publicKey: b64url(ecdh.getPublicKey()) };
}

// Returns the plaintext as a Buffer (the caller wipes it), or throws.
export function decrypt({ ecdh, id, epk, iv, ct }) {
  const shared = ecdh.computeSecret(unb64url(epk));
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(id), Buffer.from('beckon-secret-v1'), 32));
  shared.fill(0);
  const sealed = unb64url(ct);
  if (sealed.length < 17) throw new Error('ciphertext too short');
  const decipher = createDecipheriv('aes-256-gcm', key, unb64url(iv));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const head = decipher.update(sealed.subarray(0, sealed.length - 16));
  const tail = decipher.final();
  key.fill(0);
  const plain = Buffer.concat([head, tail]);
  head.fill(0);
  tail.fill(0);
  return plain;
}

export function signedChallenge(challenge, { epk, iv, ct }) {
  return createHash('sha256').update(unb64url(challenge)).update(unb64url(epk)).update(unb64url(iv)).update(unb64url(ct)).digest();
}

function clientData(raw, type, challenge, origin) {
  let data;
  try {
    data = JSON.parse(unb64url(raw).toString('utf8'));
  } catch {
    throw new Error('the passkey response is not readable');
  }
  if (data.type !== type) throw new Error('the passkey response is of the wrong type');
  if (data.origin !== origin) throw new Error(`the passkey was used on ${data.origin}, not ${origin}`);
  if (data.challenge !== b64url(challenge)) throw new Error('the passkey signed something else');
  if (data.crossOrigin === true) throw new Error('the passkey was used from another site');
  return data;
}

// Checks a new passkey from the enrollment page. Attestation is not used (the browser hands over
// the public key directly), so the enrollment link itself is the trust: it goes to members by DM,
// works once and expires.
export function verifyRegistration(body, { challenge, origin }) {
  clientData(body.clientDataJSON, 'webauthn.create', unb64url(challenge), origin);
  if (body.alg !== -7) throw new Error('only ES256 passkeys are supported');
  const spki = unb64url(body.publicKey);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('the passkey key is not P-256');
  if (!/^[A-Za-z0-9_-]{16,1024}$/.test(body.id ?? '')) throw new Error('the passkey id is not valid');
  return { id: body.id, publicKey: b64url(spki), alg: -7, transports: Array.isArray(body.transports) ? body.transports.slice(0, 8).map(String) : [] };
}

// Checks a passkey signature over a submission. Requires user presence and user verification
// (Face ID, Touch ID or the device passcode).
export function verifyAssertion(passkey, { stored, challenge, origin, rpId }) {
  const known = stored.find((k) => k.id === passkey?.id);
  if (!known) throw new Error('that passkey is not registered with this beckon');
  clientData(passkey.clientDataJSON, 'webauthn.get', challenge, origin);
  const auth = unb64url(passkey.authenticatorData);
  if (auth.length < 37) throw new Error('the passkey response is too short');
  if (!auth.subarray(0, 32).equals(createHash('sha256').update(rpId).digest())) throw new Error('the passkey belongs to another site');
  const flags = auth[32];
  if (!(flags & 0x01)) throw new Error('the passkey did not confirm the person was present');
  if (!(flags & 0x04)) throw new Error('the passkey did not verify the person (Face ID, Touch ID or passcode)');
  const signed = Buffer.concat([auth, createHash('sha256').update(unb64url(passkey.clientDataJSON)).digest()]);
  const key = createPublicKey({ key: unb64url(known.publicKey), format: 'der', type: 'spki' });
  if (!verifySignature('sha256', signed, { key, dsaEncoding: 'der' }, unb64url(passkey.signature))) {
    throw new Error('the passkey signature does not match');
  }
  return known;
}

// ~/.beckon/passkeys.json, mode 600: public keys only.
export class PasskeyStore {
  constructor(file) {
    this.file = file;
  }

  list() {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(data.passkeys) ? data.passkeys : [];
    } catch {
      return [];
    }
  }

  save(passkeys) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ passkeys }, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  add(passkey) {
    const all = this.list().filter((k) => k.id !== passkey.id);
    all.push(passkey);
    this.save(all);
  }

  remove(prefix) {
    const all = this.list();
    const keep = all.filter((k) => !k.id.startsWith(prefix));
    this.save(keep);
    return all.length - keep.length;
  }
}

export const newId = () => randomBytes(32).toString('base64url');
