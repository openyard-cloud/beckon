// Plays the phone in tests: does what relay/page.mjs does in the browser (WebCrypto ECDH +
// HKDF + AES-GCM) and what a passkey authenticator does (ES256 over authenticatorData and the
// client data hash).
import { createHash, generateKeyPairSync, sign, randomBytes } from 'node:crypto';

const { subtle } = globalThis.crypto;
const te = new TextEncoder();
const b64 = (b) => Buffer.from(b).toString('base64url');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

export function makeAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { id: b64(randomBytes(32)), privateKey, spki: publicKey.export({ format: 'der', type: 'spki' }) };
}

export function registration(authenticator, { challenge, origin }) {
  return {
    id: authenticator.id,
    publicKey: b64(authenticator.spki),
    alg: -7,
    clientDataJSON: b64(Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }))),
    transports: ['internal'],
  };
}

export async function submission({ url, meta, secret, authenticator, flags = 0x05, origin, rpId }) {
  const parsed = new URL(url);
  origin ??= parsed.origin;
  rpId ??= parsed.hostname;
  const key = new URLSearchParams(parsed.hash.slice(1)).get('k');
  const daemonKey = await subtle.importKey('raw', unb64(key), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const mine = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: daemonKey }, mine.privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const aes = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(meta.id), info: te.encode('beckon-secret-v1') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(meta.id) }, aes, te.encode(secret)));
  const epk = new Uint8Array(await subtle.exportKey('raw', mine.publicKey));

  const challenge = createHash('sha256').update(unb64(meta.challenge)).update(epk).update(iv).update(ct).digest();
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: b64(challenge), origin, crossOrigin: false }));
  const authenticatorData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
  const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), authenticator.privateKey);
  return {
    epk: b64(epk), iv: b64(iv), ct: b64(ct),
    passkey: { id: authenticator.id, authenticatorData: b64(authenticatorData), clientDataJSON: b64(clientDataJSON), signature: b64(signature) },
  };
}
