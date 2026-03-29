/**
 * Minimal OAuth callback HTTP server.
 *
 * Listens on CONNECTOR_CALLBACK_PORT (default 3456) for OAuth redirects.
 * This is the only HTTP surface needed for chat-first connector flows before
 * the full Control Plane API (Phase 1 of the roadmap) is built.
 *
 * Binds to localhost by default — only reachable on the same machine.
 * For remote installs, set CONNECTOR_CALLBACK_HOST to a public hostname
 * and ensure the port is reachable.
 */

import http from 'http';
import { URL } from 'url';

import { CONNECTOR_CALLBACK_PORT, CONNECTOR_CALLBACK_HOST } from '../config.js';
import { logger } from '../logger.js';
import { handleCallback } from './service.js';

let server: http.Server | null = null;

const HTML_SUCCESS = `<!DOCTYPE html><html><head><title>Connected</title></head><body>
<h2>Connected successfully!</h2>
<p>You can close this tab and return to your chat.</p>
</body></html>`;

const HTML_ERROR = (msg: string) =>
  `<!DOCTYPE html><html><head><title>Connection failed</title></head><body>
<h2>Connection failed</h2>
<p>${msg}</p>
<p>Please try connecting again from your chat.</p>
</body></html>`;

export function startCallbackServer(
  onConnected?: (connectionId: string, accountLabel: string) => void,
): void {
  if (server) return;

  server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (parsed.pathname !== '/connector/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const state = parsed.searchParams.get('state');
    const code = parsed.searchParams.get('code');
    const error = parsed.searchParams.get('error');

    if (error) {
      logger.warn({ error }, 'OAuth callback received provider error');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(HTML_ERROR(`Provider returned error: ${error}`));
      return;
    }

    if (!state || !code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(HTML_ERROR('Missing state or code parameter.'));
      return;
    }

    try {
      const { connectionId, accountLabel } = await handleCallback(state, code);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML_SUCCESS);
      logger.info({ connectionId, accountLabel }, 'OAuth callback completed');
      onConnected?.(connectionId, accountLabel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'OAuth callback handling failed');
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(HTML_ERROR(msg));
    }
  });

  server.listen(CONNECTOR_CALLBACK_PORT, CONNECTOR_CALLBACK_HOST, () => {
    logger.info(
      { host: CONNECTOR_CALLBACK_HOST, port: CONNECTOR_CALLBACK_PORT },
      'Connector callback server listening',
    );
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Connector callback server error');
  });
}

export function stopCallbackServer(): void {
  server?.close();
  server = null;
}
