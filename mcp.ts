// mcp.ts — the Model Context Protocol endpoint at POST /mcp (Streamable HTTP,
// modern era 2026-07-28, with the legacy initialize handshake also answered).
// Plain-JSON answers only; no SSE, no sessions. The six github-mcp-server
// tools are backed by the same store as REST, so MCP-created objects are the
// same objects REST reads back.
//
// Error contract (from the suite): malformed JSON body -> HTTP 400 + -32700;
// unknown tool -> -32601/-32602, never HTTP 500; missing required arguments ->
// -32602; unauthenticated tools/call -> HTTP 401 (checked in app.ts before
// this handler runs, so this file never sees an unauthenticated call).

import { branchTip, commitTree, diffTrees, mergeBase, MergeConflictError, squashMerge } from './gitops.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { Store, VIEWER_LOGIN } from './store.ts';

export interface McpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const JSON_TYPE = 'application/json';

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: string[];
  };
}

/** The tool list is a frozen constant: byte-identical on every tools/list call. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the new repository.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result }, headers: { 'content-type': JSON_TYPE } };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown, status = 200): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error }, headers: { 'content-type': JSON_TYPE } };
}

function toolResult(data: Record<string, unknown>, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

/** Best-effort id extraction from a malformed body (the parse-error check sends id 424242). */
function extractId(raw: string): unknown {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function callTool(store: Store, name: string, args: Record<string, unknown>, baseUrl: string): Record<string, unknown> {
  const owner = asString(args.owner, '') || VIEWER_LOGIN;
  const repoName = asString(args.repo, '') || asString(args.name, '');
  switch (name) {
    case 'create_repo': {
      const repo = asString(args.name, '');
      if (!repo) return toolErrorResult('name is required');
      if (store.getRepo(owner, repo)) return toolErrorResult(`Repository ${owner}/${repo} already exists`);
      const created = store.createRepo(owner, repo, asString(args.description, ''), typeof args.private === 'boolean' ? args.private : false);
      return toolResult(repoJson(created, baseUrl));
    }
    case 'get_repo': {
      const found = store.getRepo(owner, repoName);
      if (!found) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(found, baseUrl));
    }
    case 'create_issue': {
      const found = store.getRepo(owner, repoName);
      if (!found) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const title = asString(args.title, '');
      if (!title) return toolErrorResult('title is required');
      const issue = store.createIssue(found, title, asString(args.body, ''), []);
      return toolResult(issueJson(issue, found, baseUrl));
    }
    case 'list_issues': {
      const found = store.getRepo(owner, repoName);
      if (!found) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const state = asString(args.state, 'open');
      let issues = [...found.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      const data = { issues: issues.map((issue) => issueJson(issue, found, baseUrl)) };
      return toolResult(data);
    }
    case 'create_pull_request': {
      const found = store.getRepo(owner, repoName);
      if (!found) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const head = asString(args.head, '');
      const base = asString(args.base, '') || found.defaultBranch;
      const headTip = head ? branchTip(found, head) : null;
      const baseTip = base ? branchTip(found, base) : null;
      if (!headTip || !baseTip) return toolErrorResult('Head or base branch does not exist');
      const duplicate = found.pulls.find((candidate) => candidate.headBranch === head && candidate.baseBranch === base && candidate.state === 'open');
      if (duplicate) return toolErrorResult('A pull request already exists for these branches');
      const baseMerge = mergeBase(found, headTip, baseTip);
      const files = diffTrees(found, baseMerge ? commitTree(found, baseMerge) : null, commitTree(found, headTip)).map((change) => change.path);
      const pull = store.createPull(found, asString(args.title, ''), asString(args.body, ''), head, base, headTip, baseTip, files);
      const data = pullJson(pull, found, baseUrl);
      data.pull_number = pull.number;
      return toolResult(data);
    }
    case 'merge_pull_request': {
      const found = store.getRepo(owner, repoName);
      if (!found) return toolErrorResult(`Repository ${owner}/${repoName} not found`);
      const number = asNumber(args.pull_number);
      const pull = number === null ? undefined : found.pulls.find((candidate) => candidate.number === number);
      if (!pull) return toolErrorResult(`Pull request #${number ?? '?'} not found`);
      if (pull.merged) return toolErrorResult('Pull request is already merged');
      try {
        const { sha } = squashMerge(found, pull);
        return toolResult({ number: pull.number, pull_number: pull.number, merged: true, state: 'closed', sha, title: pull.title });
      } catch (err) {
        if (err instanceof MergeConflictError) return toolErrorResult('Merge conflict');
        return toolErrorResult((err as Error).message || 'Merge failed');
      }
    }
    default:
      return toolErrorResult(`Unknown tool: ${name}`);
  }
}

/**
 * Handle POST /mcp. `rawBody` is the request body as text (may be malformed
 * JSON); `protocolVersion` is the MCP-Protocol-Version header when present.
 * Auth is checked by app.ts before this runs.
 */
export function handleMcp(store: Store, rawBody: string, protocolVersion: string | null, baseUrl: string): McpResponse {
  if (protocolVersion && !SUPPORTED_VERSIONS.includes(protocolVersion)) {
    return rpcError(null, -32022, `Unsupported protocol version: ${protocolVersion}`, { supported: SUPPORTED_VERSIONS });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Modern era: HTTP 400 + -32700.
    return rpcError(extractId(rawBody), -32700, 'Parse error', undefined, 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = asRecord(request.params);

  // Notifications carry no id and get no response.
  if (id === undefined) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests over REST, GraphQL and MCP.',
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = asString(params.protocolVersion, '');
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = asString(params.name, '');
      const args = asRecord(params.arguments);
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(id, -32601, `Method not found: unknown tool ${name}`);
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null);
      if (missing.length) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      return rpcResult(id, callTool(store, name, args, baseUrl));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
