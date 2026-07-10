// Minimal static file server for running PDF Stack Reader as a web app in a
// normal browser (the Electron desktop shell serves the UI over a custom
// protocol instead and does not use this). No dependencies.
//
// Usage: node build-node/node/server.js [port]   (default 8377, 127.0.0.1 only)

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';

// build-node/node -> project root
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const WEB_ROOT = path.join(PROJECT_ROOT, 'dist-web');

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.psr': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const handler: http.RequestListener = (req, res) => {
  // Reject non-local Host headers (defense against DNS rebinding).
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end('bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  // /sample/* is served from the project root (handy for testing); everything
  // else comes from the built web app.
  const root = pathname.startsWith('/sample/') ? PROJECT_ROOT : WEB_ROOT;
  const filePath = path.normalize(path.join(root, pathname));
  if (filePath !== root && !filePath.startsWith(root + path.sep)) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
};

/**
 * Start the server. Port 0 picks a free ephemeral port; returns the
 * http.Server.
 */
export function start(port: number): http.Server {
  const server = http.createServer(handler);
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`PDF Stack Reader running at http://127.0.0.1:${p}`);
  });
  return server;
}

if (require.main === module) {
  start(parseInt(process.argv[2] ?? process.env.PORT ?? '8377', 10));
}
