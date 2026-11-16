// rest.ts — the GitHub REST v3 surface under /api/v3. Shares the store with the
// git, GraphQL and MCP surfaces. Every reply is JSON and carries
// X-GitHub-Request-Id (added by app.ts). Error bodies are always
// {"message": "<non-empty string>"}.

import {
  branchRef,
  branchTip,
  commitContent,
  commitHistory,
  commitTree,
  diffTrees,
  flattenTree,
  listDirectory,
  mergeBase,
  MergeConflictError,
  prConflicts,
  prFiles,
  resolveCommit,
  squashMerge,
} from './gitops.ts';
import { isObjectId } from './git.ts';
import {
  deterministicIso,
  nodeId,
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Comment,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestCtx {
  readonly store: Store;
  readonly method: string;
  /** Decoded path segments after `/api/v3`. */
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** `http://<host>` from the request Host header (for absolute Link/clone urls). */
  readonly baseUrl: string;
}

export interface RestResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const NO_BODY: RestResponse = { status: 204, body: null };

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function err(message: string, status: number): RestResponse {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function perPageOf(query: URLSearchParams, fallback = 30): number {
  const raw = Number.parseInt(query.get('per_page') ?? '', 10);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(raw, 100);
}

function pageOf(query: URLSearchParams): number {
  const raw = Number.parseInt(query.get('page') ?? '', 10);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return raw;
}

// ---------------------------------------------------------------- shapes

/** The viewer object is constant: build it once and reuse it in every shape. */
let cachedUser: Record<string, unknown> | null = null;

function userJson(): Record<string, unknown> {
  if (cachedUser) return cachedUser;
  cachedUser = {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: nodeId('User', VIEWER_LOGIN),
    avatar_url: '',
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
  return cachedUser;
}

export function repoJson(repo: Repo, baseUrl: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.databaseId,
    node_id: repo.id,
    name: repo.name,
    full_name: fullName,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: deterministicIso(repo.createdSeq),
    updated_at: deterministicIso(repo.updatedSeq),
    pushed_at: deterministicIso(repo.updatedSeq),
    git_url: `git://localhost/${fullName}.git`,
    ssh_url: `git@localhost:${fullName}.git`,
    clone_url: `${baseUrl}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.databaseId,
    node_id: nodeId('Label', label.name),
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(issue: Issue, repo: Repo, baseUrl: string): Record<string, unknown> {
  return {
    id: issue.databaseId,
    node_id: issue.id,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { id: 0, node_id: nodeId('Label', name), name, color: 'ededed', default: false, description: '' };
    }),
    state: issue.state,
    locked: false,
    assignees: [],
    comments: issue.comments.length,
    created_at: deterministicIso(issue.createdSeq),
    updated_at: deterministicIso(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? deterministicIso(issue.updatedSeq) : null,
    author_association: 'OWNER',
  };
}

export function pullJson(pull: PullRequest, repo: Repo, baseUrl: string): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headBranch) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseBranch) ?? pull.baseSha;
  return {
    id: pull.databaseId,
    node_id: pull.id,
    url: `${baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? deterministicIso(pull.updatedSeq) : null,
    merge_commit_sha: pull.mergedSha,
    mergeable: prConflicts(repo, pull) ? false : true,
    head: {
      label: `${repo.owner}:${pull.headBranch}`,
      ref: pull.headBranch,
      sha: headSha,
      user: userJson(),
      repo: repoJson(repo, baseUrl),
    },
    base: {
      label: `${repo.owner}:${pull.baseBranch}`,
      ref: pull.baseBranch,
      sha: baseSha,
      user: userJson(),
      repo: repoJson(repo, baseUrl),
    },
    created_at: deterministicIso(pull.createdSeq),
    updated_at: deterministicIso(pull.updatedSeq),
    closed_at: pull.state === 'closed' ? deterministicIso(pull.updatedSeq) : null,
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: pull.files.length,
  };
}

function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.databaseId,
    node_id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: deterministicIso(comment.createdSeq),
    updated_at: deterministicIso(comment.createdSeq),
  };
}

// ---------------------------------------------------------------- helpers

function findRepo(ctx: RestCtx, owner: string, name: string): Repo | null {
  return ctx.store.getRepo(owner, name) ?? null;
}

function parseNumber(segment: string): number | null {
  const n = Number.parseInt(segment, 10);
  return Number.isSafeInteger(n) && n >= 1 && String(n) === segment ? n : null;
}

/** Paginate a list; returns the page plus a Link header value when needed. */
function paginate<T>(items: readonly T[], ctx: RestCtx, path: string): { page: T[]; link: string | null } {
  const perPage = perPageOf(ctx.query);
  const page = pageOf(ctx.query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (totalPages <= 1) return { page: slice, link: null };
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `${ctx.baseUrl}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: slice, link: links.join(', ') };
}

// ---------------------------------------------------------------- contents

function handleContents(ctx: RestCtx, repo: Repo, pathParts: string[]): RestResponse {
  const filePath = pathParts.join('/');
  const refName = ctx.query.get('ref') ?? repo.defaultBranch;
  if (ctx.method === 'PUT') {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const message = asString(body.message, `Update ${filePath}`);
    const contentB64 = asString(body.content, '');
    if (contentB64 === '' && body.content !== '') return err('content is not valid base64', 400);
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      return err('content is not valid base64', 400);
    }
    const branch = asString(body.branch, '') || repo.defaultBranch;
    // A contents write on an unknown branch creates it from the default tip.
    let baseTip = branchTip(repo, branch);
    if (!baseTip && branch !== repo.defaultBranch) {
      const defaultTip = branchTip(repo, repo.defaultBranch);
      if (defaultTip) repo.refs.set(branchRef(branch), defaultTip);
      baseTip = defaultTip;
    }
    const currentFiles = baseTip ? flattenTree(repo, commitTree(repo, baseTip)!) : new Map();
    const existing = currentFiles.get(filePath);
    const isCreate = !existing;
    const givenSha = asString(body.sha, '');
    if (!isCreate && givenSha && givenSha.toLowerCase() !== existing!.oid.toLowerCase()) {
      return err('sha does not match the current blob (stale sha)', 409);
    }
    const result = commitContent(repo, branch, message, new Map([[filePath, content]]));
    return ok(
      {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: result.blobSha,
          size: content.length,
          url: '',
          html_url: '',
          git_url: '',
          download_url: '',
          type: 'file',
          encoding: 'base64',
          content: contentB64,
        },
        commit: { sha: result.commitSha, message },
      },
      isCreate ? 201 : 200,
    );
  }
  if (ctx.method === 'GET') {
    const tip = branchTip(repo, refName) ?? resolveCommit(repo, refName);
    if (!tip) return err('Not Found', 404);
    const treeOid = commitTree(repo, tip);
    if (!treeOid) return err('Not Found', 404);
    if (filePath === '') {
      const entries = listDirectory(repo, treeOid, '');
      return ok(entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.oid, size: 0, url: '', html_url: '', git_url: '', download_url: '' })));
    }
    const flat = flattenTree(repo, treeOid);
    const file = flat.get(filePath);
    if (file) {
      const object = repo.objects.get(file.oid);
      const bytes = object?.data ?? Buffer.alloc(0);
      return ok({
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content: bytes.toString('base64'),
        sha: file.oid,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
      });
    }
    // A directory? Any path under filePath/ means the directory exists.
    if ([...flat.keys()].some((path) => path.startsWith(`${filePath}/`))) {
      const entries = listDirectory(repo, treeOid, filePath);
      return ok(entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.oid, size: 0, url: '', html_url: '', git_url: '', download_url: '' })));
    }
    return err('Not Found', 404);
  }
  if (ctx.method === 'DELETE') {
    const body = isRecord(ctx.body) ? ctx.body : {};
    const message = asString(body.message, `Delete ${filePath}`);
    const branch = asString(body.branch, '') || repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (!tip) return err('Not Found', 404);
    const flat = flattenTree(repo, commitTree(repo, tip)!);
    const existing = flat.get(filePath);
    if (!existing) return err('Not Found', 404);
    const givenSha = asString(body.sha, '');
    if (givenSha && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return err('sha does not match the current blob (stale sha)', 409);
    }
    const result = commitContent(repo, branch, message, new Map([[filePath, null]]));
    return ok({ commit: { sha: result.commitSha, message } }, 200);
  }
  return err('Not Found', 404);
}

// ---------------------------------------------------------------- main dispatch

/** Handle a request under /api/v3; returns null when the path is not a REST route. */
export function handleRest(ctx: RestCtx): RestResponse | null {
  const s = ctx.segments;
  const method = ctx.method;

  // GET /api/v3/ — root (no auth needed; app.ts routes here before auth).
  if (s.length === 0 && method === 'GET') {
    return ok(
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      200,
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta' && method === 'GET') {
    return ok({ installed_version: '1.0.0' });
  }
  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user' && method === 'GET') {
    return ok(userJson());
  }
  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const name = asString(body.name, '');
      if (!name) return err('name is required', 422);
      if (ctx.store.getRepo(VIEWER_LOGIN, name)) return err('Repository already exists', 422);
      const repo = ctx.store.createRepo(
        VIEWER_LOGIN,
        name,
        asString(body.description, ''),
        asBoolean(body.private, false),
      );
      return ok(repoJson(repo, ctx.baseUrl), 201);
    }
    if (method === 'GET') {
      const repos = ctx.store.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(repos, ctx, '/api/v3/user/repos');
      return ok(
        page.map((repo) => repoJson(repo, ctx.baseUrl)),
        200,
        link ? { link } : undefined,
      );
    }
    return err('Not Found', 404);
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1];
    const name = s[2];
    const rest = s.slice(3);

    // POST /git/refs and GET /git/refs/... need the repo to exist; but the
    // repo-not-found shape is the same 404 either way.
    const repo = findRepo(ctx, owner, name);

    if (rest.length === 0) {
      if (method === 'GET') {
        if (!repo) return err('Not Found', 404);
        return ok(repoJson(repo, ctx.baseUrl));
      }
      if (method === 'PATCH') {
        if (!repo) return err('Not Found', 404);
        const body = isRecord(ctx.body) ? ctx.body : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return ok(repoJson(repo, ctx.baseUrl));
      }
      if (method === 'DELETE') {
        if (!repo) return err('Not Found', 404);
        ctx.store.deleteRepo(owner, name);
        return NO_BODY;
      }
      return err('Not Found', 404);
    }

    if (!repo) return err('Not Found', 404);

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(branchRef(branch))! }, protected: false }));
        return ok(branches);
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = rest.slice(1).join('/');
        const tip = branchTip(repo, branch);
        if (!tip) return err('Not Found', 404);
        return ok({ name: branch, commit: { sha: tip }, protected: false });
      }
      return err('Not Found', 404);
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = ctx.query.get('sha');
      const tip = shaParam ? (resolveCommit(repo, shaParam) ?? branchTip(repo, shaParam)) : branchTip(repo, repo.defaultBranch);
      if (!tip) return ok([]);
      const history = commitHistory(repo, tip);
      return ok(
        history.map((entry) => ({
          sha: entry.sha,
          commit: {
            message: entry.message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(entry.timestamp * 1000).toISOString().replace('.000Z', 'Z') },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(entry.timestamp * 1000).toISOString().replace('.000Z', 'Z') },
          },
        })),
      );
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const ref = asString(body.ref, '');
        const sha = asString(body.sha, '');
        if (!ref.startsWith('refs/') || !isObjectId(sha)) return err('Invalid ref or sha', 422);
        if (repo.refs.has(ref)) return err('Reference already exists', 422);
        const object = repo.objects.get(sha);
        if (!object) return err('Object does not exist', 422);
        repo.refs.set(ref, sha);
        return ok({ ref, object: { sha, type: object.type } }, 201);
      }
      if (rest.length >= 3 && method === 'GET') {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (!oid) return err('Not Found', 404);
        const object = repo.objects.get(oid);
        return ok({ ref, object: { sha: oid, type: object?.type ?? 'commit' } });
      }
      return err('Not Found', 404);
    }

    // contents
    if (rest[0] === 'contents') {
      return handleContents(ctx, repo, rest.slice(1));
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'POST' && rest.length === 1) {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const labelName = asString(body.name, '');
        if (!labelName) return err('name is required', 422);
        if (repo.labels.has(labelName)) return err('Label already exists', 422);
        const label = ctx.store.createLabel(repo, labelName, asString(body.color, 'ededed'), asString(body.description, ''));
        return ok(labelJson(label), 201);
      }
      if (method === 'GET' && rest.length === 1) {
        return ok([...repo.labels.values()].map(labelJson));
      }
      return err('Not Found', 404);
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const title = asString(body.title, '');
          const issueBody = asString(body.body, '');
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = [];
          for (const raw of rawLabels) {
            const labelName = typeof raw === 'string' ? raw : isRecord(raw) ? asString(raw.name, '') : '';
            if (!labelName) continue;
            if (!repo.labels.has(labelName)) return err(`Label does not exist: ${labelName}`, 422);
            labels.push(labelName);
          }
          const issue = ctx.store.createIssue(repo, title, issueBody, labels);
          return ok(issueJson(issue, repo, ctx.baseUrl), 201);
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const perPage = perPageOf(ctx.query, 30);
          return ok(issues.slice(0, perPage).map((issue) => issueJson(issue, repo, ctx.baseUrl)));
        }
        return err('Not Found', 404);
      }
      const number = parseNumber(rest[1]);
      if (number === null) return err('Not Found', 404);
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!issue) return err('Not Found', 404);
          return ok(issueJson(issue, repo, ctx.baseUrl));
        }
        if (method === 'PATCH') {
          if (!issue) return err('Not Found', 404);
          const body = isRecord(ctx.body) ? ctx.body : {};
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updatedSeq += 1;
          return ok(issueJson(issue, repo, ctx.baseUrl));
        }
        return err('Not Found', 404);
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return err('Not Found', 404);
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const comment = ctx.store.addComment(issue, asString(body.body, ''));
          return ok(commentJson(comment), 201);
        }
        if (method === 'GET') {
          return ok(issue.comments.map(commentJson));
        }
        return err('Not Found', 404);
      }
      return err('Not Found', 404);
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const title = asString(body.title, '');
          const pullBody = asString(body.body, '');
          const head = asString(body.head, '');
          const base = asString(body.base, '') || repo.defaultBranch;
          const headTip = head ? branchTip(repo, head) : null;
          const baseTip = base ? branchTip(repo, base) : null;
          if (!headTip || !baseTip) return err('Head or base branch does not exist', 422);
          const duplicate = repo.pulls.find((candidate) => candidate.headBranch === head && candidate.baseBranch === base && candidate.state === 'open');
          if (duplicate) return err('A pull request already exists for these branches', 422);
          const mergeBaseOid = mergeBase(repo, headTip, baseTip);
          const files = diffTrees(repo, mergeBaseOid ? commitTree(repo, mergeBaseOid) : null, commitTree(repo, headTip)).map((change) => change.path);
          const pull = ctx.store.createPull(repo, title, pullBody, head, base, headTip, baseTip, files);
          return ok(pullJson(pull, repo, ctx.baseUrl), 201);
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const perPage = perPageOf(ctx.query, 30);
          return ok(pulls.slice(0, perPage).map((pull) => pullJson(pull, repo, ctx.baseUrl)));
        }
        return err('Not Found', 404);
      }
      const number = parseNumber(rest[1]);
      if (number === null) return err('Not Found', 404);
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (rest.length === 2) {
        if (method === 'GET') {
          if (!pull) return err('Not Found', 404);
          return ok(pullJson(pull, repo, ctx.baseUrl));
        }
        return err('Not Found', 404);
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) return err('Not Found', 404);
        const files = prFiles(repo, pull);
        return ok(
          files.map((change) => ({
            sha: change.newOid ?? change.oldOid ?? '',
            filename: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
            blob_url: '',
            raw_url: '',
            contents_url: '',
            patch: '',
          })),
        );
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) return err('Not Found', 404);
        if (pull.merged) return err('Pull request is already merged', 405);
        if (pull.state === 'closed') return err('Pull request is closed', 405);
        try {
          const { sha } = squashMerge(repo, pull);
          return ok({ merged: true, sha, message: 'Pull request successfully merged' }, 200);
        } catch (err2) {
          if (err2 instanceof MergeConflictError) return err('Merge conflict', 405);
          return err((err2 as Error).message || 'Merge failed', 405);
        }
      }
      return err('Not Found', 404);
    }

    return err('Not Found', 404);
  }

  return null;
}
