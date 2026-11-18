// app.ts — the forge's HTTP server.
//
// Two transports share one dispatch (dispatch.ts), so routing, auth and the
// handlers behave byte-identically on either:
//
//   createApp()     — raw TCP HTTP/1.1 server (the fast path). Node's http
//                     layer costs ~143us of server CPU per request on this
//                     hardware (IncomingMessage/ServerResponse objects,
//                     header parsing, socket bookkeeping); a hand-rolled
//                     parser that only extracts the headers dispatch needs
//                     costs ~77us. That is the whole point of this file.
//   createHttpApp() — the plain node:http server, kept as a fallback and as
//                     a reference while the TCP transport is validated.
//
// Surfaces: git smart HTTP (/<owner>/<repo>.git/...), REST v3 (/api/v3/...),
// GraphQL v4 (POST /api/graphql), MCP (POST /mcp), and the env's /healthz.
// One Store is shared by every surface. Deterministic: request ids come from
// a counter in dispatch.ts, never from the clock or Math.random.

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { dispatch, type DispatchRequest } from './dispatch.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/**
 * Split a request target into its (still percent-encoded) pathname and its raw
 * query string. This is the only URL work the router needs, and it is far
 * cheaper than a WHATWG URL parse per request (the benchmark issues thousands
 * of requests; the parse was a measurable slice of each one).
 */
function splitTarget(raw: string): { pathname: string; search: string } {
  const q = raw.indexOf('?');
  if (q < 0) return { pathname: raw === '' ? '/' : raw, search: '' };
  return { pathname: q === 0 ? '/' : raw.slice(0, q), search: raw.slice(q + 1) };
}

function baseUrlOfHost(host: string | undefined): string {
  return `http://${host ?? '127.0.0.1'}`;
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
    // Most request bodies arrive in a single chunk: hand that buffer back
    // directly instead of allocating and copying a concat of one element.
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The node:http transport: parse with node:http, dispatch, write the result. */
export function createHttpApp(): HttpServer {
  const store = new Store();
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const { pathname, search } = splitTarget(req.url ?? '/');
      const baseUrl = baseUrlOfHost(req.headers.host);
      let body = Buffer.alloc(0);
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        body = await readBody(req);
      }
      const result = dispatch(store, {
        method,
        pathname,
        search,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
        baseUrl,
      });
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    })();
  });
}

// ---------------------------------------------------------------------------
// Raw TCP transport
// ---------------------------------------------------------------------------

interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: Record<string, string>;
  headLen: number; // bytes consumed by the header block including \r\n\r\n
  contentLength: number;
  chunked: boolean;
  expectContinue: boolean;
  keepAlive: boolean;
}

/**
 * Parse one request head from `buf` (which starts at a request boundary).
 * Returns null when the head is incomplete. Only the headers dispatch needs
 * are kept; duplicates keep the first value.
 */
function parseHead(buf: Buffer): ParsedHead | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) return null;
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lineEnd = head.indexOf('\r\n');
  const line = lineEnd < 0 ? head : head.slice(0, lineEnd);
  const sp1 = line.indexOf(' ');
  if (sp1 <= 0) return null;
  const sp2 = line.indexOf(' ', sp1 + 1);
  if (sp2 <= sp1) return null;
  const method = line.slice(0, sp1);
  const target = line.slice(sp1 + 1, sp2);
  const version = line.slice(sp2 + 1);
  const headers: Record<string, string> = {};
  let pos = lineEnd < 0 ? head.length : lineEnd + 2;
  while (pos < head.length) {
    const eol = head.indexOf('\r\n', pos);
    const end = eol < 0 ? head.length : eol;
    const colon = head.indexOf(':', pos);
    if (colon > pos && colon < end) {
      const name = head.slice(pos, colon).trim().toLowerCase();
      if (headers[name] === undefined) headers[name] = head.slice(colon + 1, end).trim();
    }
    pos = end + 2;
  }
  const connection = (headers['connection'] ?? '').toLowerCase();
  const keepAlive = version === 'HTTP/1.1' ? connection !== 'close' : connection === 'keep-alive';
  const te = (headers['transfer-encoding'] ?? '').toLowerCase();
  return {
    method,
    target,
    version,
    headers,
    headLen: headEnd + 4,
    contentLength: Number(headers['content-length'] ?? 0) || 0,
    chunked: te.includes('chunked'),
    expectContinue: (headers['expect'] ?? '').toLowerCase() === '100-continue',
    keepAlive,
  };
}

/**
 * Decode one chunked body starting at `start` in `buf`. Returns the decoded
 * body and the total bytes consumed, or null when more data is needed.
 */
function decodeChunked(buf: Buffer, start: number): { body: Buffer; consumed: number } | null {
  const chunks: Buffer[] = [];
  let pos = start;
  for (;;) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0) return null;
    const sizeLine = buf.subarray(pos, eol).toString('latin1');
    const semi = sizeLine.indexOf(';');
    const size = parseInt(semi < 0 ? sizeLine : sizeLine.slice(0, semi), 16);
    if (!Number.isFinite(size) || size < 0) return null;
    const dataStart = eol + 2;
    if (size === 0) {
      // Terminal chunk: expect a final \r\n (trailers are ignored).
      if (buf.length < dataStart + 2) return null;
      return { body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks), consumed: dataStart + 2 - start };
    }
    if (buf.length < dataStart + size + 2) return null;
    chunks.push(buf.subarray(dataStart, dataStart + size));
    pos = dataStart + size + 2;
  }
}

function writeResponse(sock: Socket, status: number, headers: Record<string, string>, body: Buffer, keepAlive: boolean): void {
  const reason = REASONS[status] ?? '';
  let head = `HTTP/1.1 ${status}${reason ? ` ${reason}` : ''}\r\n`;
  let hasLength = false;
  for (const name of Object.keys(headers)) {
    if (name === 'content-length') hasLength = true;
    head += `${name}: ${headers[name]}\r\n`;
  }
  // 204/304 carry no body by definition; every other response gets an
  // explicit length so the client never has to guess where the body ends.
  if (!hasLength && status !== 204 && status !== 304) head += `content-length: ${body.length}\r\n`;
  head += `connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n\r\n`;
  sock.write(head);
  if (body.length > 0) sock.write(body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): TcpServer {
  const store = new Store();
  return createTcpServer((sock: Socket) => {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    let sentContinue = false;
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const parsed = parseHead(buf);
        if (parsed === null) break;
        if (parsed.contentLength > MAX_BODY_BYTES) {
          sock.destroy();
          return;
        }
        if (parsed.expectContinue && !sentContinue) {
          sock.write('HTTP/1.1 100 Continue\r\n\r\n');
          sentContinue = true;
        }
        let body: Buffer;
        let total: number;
        if (parsed.chunked) {
          const decoded = decodeChunked(buf, parsed.headLen);
          if (decoded === null) break;
          body = decoded.body;
          total = parsed.headLen + decoded.consumed;
        } else {
          total = parsed.headLen + parsed.contentLength;
          if (buf.length < total) break;
          body = parsed.contentLength === 0 ? Buffer.alloc(0) : buf.subarray(parsed.headLen, total);
        }
        const { pathname, search } = splitTarget(parsed.target);
        const result = dispatch(store, {
          method: parsed.method,
          pathname,
          search,
          headers: parsed.headers,
          body: Buffer.isBuffer(body) ? body : Buffer.from(body),
          baseUrl: baseUrlOfHost(parsed.headers['host']),
        } satisfies DispatchRequest);
        writeResponse(sock, result.status, result.headers, result.body, parsed.keepAlive);
        buf = buf.subarray(total);
        sentContinue = false;
        if (!parsed.keepAlive) {
          sock.end();
          return;
        }
        if (buf.length === 0) break;
      }
    });
    sock.on('error', () => undefined);
  });
}
