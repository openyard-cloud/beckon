// The only script the relay pages run. It encrypts the secret on the phone to the daemon's key
// (from the link's #fragment), asks for the passkey over the ciphertext, and posts the result.
// Kept dependency-free and small enough to read in one go.
export const PAGE_SCRIPT = String.raw`(() => {
  'use strict';
  const meta = JSON.parse(document.getElementById('meta').textContent);
  const statusEl = document.getElementById('status');
  const say = (text, bad) => { statusEl.textContent = text; statusEl.className = bad ? 'bad' : ''; };
  const te = new TextEncoder();
  const enc = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const post = async (body) => {
    const r = await fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
    try { return await r.json(); } catch { return { status: 'failed', reason: 'HTTP ' + r.status }; }
  };
  const buttons = () => document.querySelectorAll('button');
  const lock = (on) => buttons().forEach((b) => { b.disabled = on; });
  const done = (res, okText) => {
    if (res.status === 'filled' || res.status === 'enrolled') { say(okText); lock(true); return; }
    if (res.status === 'cancelled') { say('Cancelled. Nothing was typed.'); lock(true); return; }
    say('Not done: ' + (res.reason || res.status), true);
    lock(true);
  };

  if (meta.mode === 'secret') {
    const key = new URLSearchParams(location.hash.slice(1)).get('k');
    history.replaceState(null, '', location.pathname); // keep the key out of history and screenshots
    if (!key) { say('This link is missing its key. Open it again from Slack.', true); lock(true); return; }
    document.getElementById('cancel').addEventListener('click', async () => {
      lock(true);
      done(await post({ cancel: true }));
    });
    document.getElementById('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      lock(true);
      const input = document.getElementById('secret');
      const plain = te.encode(input.value);
      input.value = '';
      try {
        say('Encrypting…');
        const daemonKey = await crypto.subtle.importKey('raw', dec(key), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const mine = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: daemonKey }, mine.privateKey, 256);
        const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(meta.id), info: te.encode('beckon-secret-v1') }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(meta.id) }, aes, plain));
        plain.fill(0);
        const epk = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey));
        say('Confirm with your passkey…');
        const challenge = await crypto.subtle.digest('SHA-256', concat(dec(meta.challenge), epk, iv, ct));
        const cred = await navigator.credentials.get({ publicKey: {
          challenge, rpId: location.hostname, userVerification: 'required', timeout: 120000,
          allowCredentials: meta.credentials.map((id) => ({ type: 'public-key', id: dec(id) })),
        } });
        const a = cred.response;
        say('Sending to beckon…');
        done(await post({
          epk: enc(epk), iv: enc(iv), ct: enc(ct),
          passkey: { id: enc(new Uint8Array(cred.rawId)), authenticatorData: enc(new Uint8Array(a.authenticatorData)), clientDataJSON: enc(new Uint8Array(a.clientDataJSON)), signature: enc(new Uint8Array(a.signature)) },
        }), 'Filled in on your Mac. You can close this page.');
      } catch (e) {
        plain.fill(0);
        say('Not sent: ' + (e && e.message ? e.message : e) + '. Nothing was typed.', true);
      }
    });
  } else if (meta.mode === 'enroll') {
    document.getElementById('enroll').addEventListener('click', async () => {
      lock(true);
      try {
        say('Creating the passkey…');
        const cred = await navigator.credentials.create({ publicKey: {
          rp: { id: location.hostname, name: 'beckon' },
          user: { id: dec(meta.userId), name: meta.userName, displayName: meta.userName },
          challenge: dec(meta.challenge),
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          attestation: 'none', timeout: 120000,
          excludeCredentials: meta.credentials.map((id) => ({ type: 'public-key', id: dec(id) })),
        } });
        const r = cred.response;
        const spki = r.getPublicKey && r.getPublicKey();
        if (!spki) throw new Error('this browser cannot share the passkey public key; use Safari or Chrome');
        done(await post({
          id: enc(new Uint8Array(cred.rawId)), publicKey: enc(new Uint8Array(spki)), alg: r.getPublicKeyAlgorithm(),
          clientDataJSON: enc(new Uint8Array(r.clientDataJSON)), transports: r.getTransports ? r.getTransports() : [],
        }), 'Passkey added. beckon will ask for it when you enter a secret.');
      } catch (e) {
        say('Not added: ' + (e && e.message ? e.message : e), true);
      }
    });
  }
})();`;
