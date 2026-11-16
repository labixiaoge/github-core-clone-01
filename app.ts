// app.ts — the forge's HTTP server: routing, auth, request ids, body reading.
// Surfaces: git smart HTTP (/<owner>/<repo>.git/...), REST v3 (/api/v3/...),
// GraphQL v4 (POST /api/graphql), MCP (POST /mcp), and the env's /healthz.
// One Store is shared by every surface. Deterministic: request ids come from
// a counter, never from the clock or Math.random.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphql } from './graphql.ts';
import { advertiseReceivePack, advertiseUploadPackV0, advertiseUploadPackV2, handleFetchV0, handleFetchV2, handleLsRefs, handleReceivePack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestResponse } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq}`;
}

function urlOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return null;
  }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const all: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': nextRequestId(),
    ...headers,
  };
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': all['x-github-request-id'] });
    res.end();
    return;
  }
  res.writeHead(status, all);
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (!presented) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!expected) return true; // No token configured (local dev): any non-empty bearer.
  return presented === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function respondRest(res: ServerResponse, response: RestResponse): void {
  if (response.status === 204) {
    sendJson(res, 204, null);
    return;
  }
  sendJson(res, response.status, response.body, response.headers ?? {});
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const url = urlOf(req);
      const pathname = url?.pathname ?? '/';
      const query = url?.searchParams ?? new URLSearchParams();
      const baseUrl = baseUrlOf(req);

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---- MCP ---------------------------------------------------------
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!isAuthorized(req)) {
            res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
            res.end(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unauthorized' } })}\n`);
            return;
          }
          const raw = await readBody(req);
          const protocolVersionHeader = req.headers['mcp-protocol-version'];
          const protocolVersion = typeof protocolVersionHeader === 'string' ? protocolVersionHeader : null;
          const response = handleMcp(store, raw.toString('utf8'), protocolVersion, baseUrl);
          if (response.status === 202) {
            res.writeHead(202, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, response.status, response.body, response.headers ?? {});
          return;
        }

        // ---- GraphQL ------------------------------------------------------
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown = null;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
          const response = handleGraphql(store, parsed);
          sendJson(res, response.status, response.body);
          return;
        }

        // ---- git smart HTTP ----------------------------------------------
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const action = gitMatch[3];
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const repo = store.getRepo(owner, repoName);
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (action === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const service = query.get('service');
            if (service === 'git-upload-pack') {
              const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
              const body = v2 ? advertiseUploadPackV2() : advertiseUploadPackV0(repo);
              sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuffer(res, 200, advertiseReceivePack(repo), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendJson(res, 400, { message: 'service is required' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          if (action === 'git-upload-pack') {
            const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            if (v2) {
              const first = body.subarray(0, 64).toString('utf8');
              const result = first.includes('command=ls-refs') ? handleLsRefs(repo, body) : handleFetchV2(repo, body);
              sendBuffer(res, 200, result, 'application/x-git-upload-pack-result');
              return;
            }
            sendBuffer(res, 200, handleFetchV0(repo, body), 'application/x-git-upload-pack-result');
            return;
          }
          // git-receive-pack
          const result = handleReceivePack(repo, body);
          sendBuffer(res, 200, result.body, 'application/x-git-receive-pack-result');
          return;
        }

        // ---- REST v3 ------------------------------------------------------
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const segments = decodeSegments(pathname.slice('/api/v3'.length));
          if (segments === null) {
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }
          // Drop the leading empty segment and a trailing slash.
          const restSegments = segments.slice(1).filter((segment, index, all) => !(index === all.length - 1 && segment === ''));
          const isPublic = method === 'GET' && (restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta'));
          if (!isPublic && !isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          let parsedBody: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                parsedBody = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' });
                return;
              }
            }
          }
          const response = handleRest({ store, method, segments: restSegments, query, body: parsedBody, baseUrl });
          if (response === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          respondRest(res, response);
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never leak a stack or hang: a JSON 500 is the worst answer.
        try {
          sendJson(res, 500, { message: (err as Error).message || 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing more can be done.
        }
      }
    })();
  });
}
