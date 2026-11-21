import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_BODY = 1024 * 1024;

// A loopback HTTP server the hook script calls for every tool use. The request stays open
// until the decision is known, which for an approval means until someone presses a button.
export async function startHookServer(handler, { log = () => {} } = {}) {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);

  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (req.method !== 'POST' || req.url !== '/hook' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(404).end();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', async () => {
      let answer;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        answer = await handler(body);
      } catch (e) {
        log(`Hook request failed: ${e.message}`);
        answer = { decision: 'deny', message: `beckon could not handle this request: ${e.message}` };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
    });
  });
  server.requestTimeout = 0;
  server.timeout = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    token,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
