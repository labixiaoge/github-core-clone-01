// dispatch.ts — transport-independent request dispatch for the forge.
//
// The routing, auth and handler calls that used to live inside the node:http
// callback in app.ts now live here, as a pure function over a parsed request:
//   dispatch(store, { method, pathname, search, headers, body, baseUrl })
//     -> { status, headers, body: Buffer }
// The response is fully serialized (JSON stringified, content-length set, the
// x-github-request-id assigned), so both the node:http adapter and the raw
// TCP server share byte-identical behaviour. The only transport-specific work
// left to the caller is reading the request bytes and writing the response.
//
// Header names in `headers` are lowercased, matching node:http's
// IncomingMessage.headers. `pathname` is still percent-encoded and `search`
// is the raw query string without the leading '?', exactly as splitTarget
// in app.ts produced them. `body` is the raw request body (an empty Buffer
// when the request carries none).

import { handleGraphql } from './graphql.ts';
import {
  advertiseReceivePack,
  advertiseUploadPackV0,
  advertiseUploadPackV2,
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
} from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestResponse } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq}`;
}

export interface DispatchRequest {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  baseUrl: string;
}

export interface DispatchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonResult(status: number, body: unknown, extra: Record<string, string> = {}): DispatchResult {
  const id = nextRequestId();
  if (status === 204) {
    return { status, headers: { 'x-github-request-id': id, ...extra }, body: Buffer.alloc(0) };
  }
  const text = `${JSON.stringify(body)}\n`;
  return {
    status,
    headers: {
      'content-type': JSON_TYPE,
      'content-length': String(Buffer.byteLength(text)),
      'x-github-request-id': id,
      ...extra,
    },
    body: Buffer.from(text, 'utf8'),
  };
}

function bufferResult(status: number, body: Buffer, contentType: string): DispatchResult {
  return {
    status,
    headers: {
      'content-type': contentType,
      'content-length': String(body.length),
      'x-github-request-id': nextRequestId(),
    },
    body,
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function isAuthorized(headers: Record<string, string | string[] | undefined>): boolean {
  const header = headerValue(headers, 'authorization');
  if (!header || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (!presented) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!expected) return true; // No token configured (local dev): any non-empty bearer.
  return presented === expected;
}

function decodeSegments(pathname: string): string[] | null {
  try {
    return pathname.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function respondRest(response: RestResponse): DispatchResult {
  if (response.status === 204) return jsonResult(204, null);
  return jsonResult(response.status, response.body, response.headers ?? {});
}

/**
 * Dispatch one request. `store` is the shared Store; `req` is the parsed
 * request. Never throws for a request-level problem: a handler error becomes
 * a JSON 500, exactly as app.ts did.
 */
export function dispatch(store: Store, req: DispatchRequest): DispatchResult {
  const { method, pathname, search } = req;
  const headers = req.headers;
  const query = new URLSearchParams(search);
  try {
    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && pathname === '/healthz') {
      return jsonResult(200, { ok: true });
    }

    // ---- MCP ---------------------------------------------------------
    if (pathname === '/mcp') {
      if (method === 'DELETE') {
        return jsonResult(200, {});
      }
      if (method !== 'POST') {
        return jsonResult(405, { message: 'Method Not Allowed' });
      }
      if (!isAuthorized(headers)) {
        return jsonResult(401, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'unauthorized' },
        });
      }
      const response = handleMcp(store, req.body.toString('utf8'), headerValue(headers, 'mcp-protocol-version') ?? null, req.baseUrl);
      if (response.status === 202) {
        return { status: 202, headers: { 'x-github-request-id': nextRequestId() }, body: Buffer.alloc(0) };
      }
      return jsonResult(response.status, response.body, response.headers ?? {});
    }

    // ---- GraphQL ------------------------------------------------------
    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        return jsonResult(405, { message: 'Method Not Allowed' });
      }
      if (!isAuthorized(headers)) {
        return jsonResult(401, { message: 'Requires authentication' });
      }
      let parsed: unknown = null;
      if (req.body.length > 0) {
        try {
          parsed = JSON.parse(req.body.toString('utf8'));
        } catch {
          return jsonResult(400, { message: 'Problems parsing JSON' });
        }
      }
      const response = handleGraphql(store, parsed);
      return jsonResult(response.status, response.body);
    }

    // ---- git smart HTTP ----------------------------------------------
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const action = gitMatch[3];
      if (!isAuthorized(headers)) {
        return jsonResult(401, { message: 'Requires authentication' });
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        return jsonResult(404, { message: 'Not Found' });
      }
      if (action === 'info/refs') {
        if (method !== 'GET') {
          return jsonResult(405, { message: 'Method Not Allowed' });
        }
        const service = query.get('service');
        if (service === 'git-upload-pack') {
          const v2 = (headerValue(headers, 'git-protocol') ?? '').includes('version=2');
          const body = v2 ? advertiseUploadPackV2() : advertiseUploadPackV0(repo);
          return bufferResult(200, body, 'application/x-git-upload-pack-advertisement');
        }
        if (service === 'git-receive-pack') {
          return bufferResult(200, advertiseReceivePack(repo), 'application/x-git-receive-pack-advertisement');
        }
        return jsonResult(400, { message: 'service is required' });
      }
      if (method !== 'POST') {
        return jsonResult(405, { message: 'Method Not Allowed' });
      }
      if (action === 'git-upload-pack') {
        const v2 = (headerValue(headers, 'git-protocol') ?? '').includes('version=2');
        if (v2) {
          const first = req.body.subarray(0, 64).toString('utf8');
          const result = first.includes('command=ls-refs') ? handleLsRefs(repo, req.body) : handleFetchV2(repo, req.body);
          return bufferResult(200, result, 'application/x-git-upload-pack-result');
        }
        return bufferResult(200, handleFetchV0(repo, req.body), 'application/x-git-upload-pack-result');
      }
      // git-receive-pack
      const result = handleReceivePack(repo, req.body);
      return bufferResult(200, result.body, 'application/x-git-receive-pack-result');
    }

    // ---- REST v3 ------------------------------------------------------
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const segments = decodeSegments(pathname.slice('/api/v3'.length));
      if (segments === null) {
        return jsonResult(400, { message: 'Bad Request' });
      }
      // Drop the leading empty segment and a trailing slash.
      const restSegments = segments.slice(1).filter((segment, index, all) => !(index === all.length - 1 && segment === ''));
      const isPublic = method === 'GET' && (restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta'));
      if (!isPublic && !isAuthorized(headers)) {
        return jsonResult(401, { message: 'Requires authentication' });
      }
      let parsedBody: unknown;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        if (req.body.length > 0) {
          try {
            parsedBody = JSON.parse(req.body.toString('utf8'));
          } catch {
            return jsonResult(400, { message: 'Problems parsing JSON' });
          }
        }
      }
      const response = handleRest({ store, method, segments: restSegments, query, body: parsedBody, baseUrl: req.baseUrl });
      if (response === null) {
        return jsonResult(404, { message: 'Not Found' });
      }
      return respondRest(response);
    }

    // Everything else: GitHub's 404 body.
    return jsonResult(404, { message: 'Not Found' });
  } catch (err) {
    // Never leak a stack or hang: a JSON 500 is the worst answer.
    try {
      return jsonResult(500, { message: (err as Error).message || 'Internal Server Error' });
    } catch {
      return { status: 500, headers: { 'content-type': JSON_TYPE, 'content-length': '2', 'x-github-request-id': nextRequestId() }, body: Buffer.from('{}\n', 'utf8') };
    }
  }
}
