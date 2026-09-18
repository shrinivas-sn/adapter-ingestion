import { createServer } from 'node:http';
import { once } from 'node:events';

// A real loopback HTTP server for transport tests. Byte caps, timeouts,
// aborts, and redirect handling can only be genuinely proved against actual
// sockets and actual native Fetch -- a hand-rolled { json: async () => ... }
// double has no body stream, no headers, and no network timing to violate.
export async function startServer(routes) {
  const sockets = new Set();
  const server = createServer((req, res) => {
    // Route by pathname only — fetchAll appends its own query string
    // (?page=1, incremental params, …), which must not affect routing any
    // more than it would against a real API.
    const pathname = new URL(req.url, 'http://placeholder').pathname;
    const handler = routes[pathname] ?? routes.default;
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  async function close() {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  return { origin, close, sockets };
}
