import { execFile } from 'node:child_process';

// The Claude account beckon's runs use, from `claude auth status`: who is signed in, the plan,
// and when the sign-in runs out. Only these fields are kept (no ids, no paths).
export function pickAccount(status) {
  if (!status || typeof status !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    loggedIn: status.loggedIn === true,
    authMethod: str(status.authMethod),
    email: str(status.email),
    orgName: str(status.orgName),
    plan: str(status.subscriptionType),
    loginExpiresAt: Number.isFinite(Date.parse(status.loginExpiresAt)) ? Date.parse(status.loginExpiresAt) : null,
  };
}

export function readAccount({ bin = 'claude', env = process.env, exec = execFile } = {}) {
  return new Promise((resolve, reject) => {
    exec(bin, ['auth', 'status'], { env, timeout: 20_000 }, (err, stdout) => {
      try {
        resolve(pickAccount(JSON.parse(String(stdout ?? ''))));
      } catch {
        reject(new Error(err?.message ?? 'claude auth status gave no JSON'));
      }
    });
  });
}
