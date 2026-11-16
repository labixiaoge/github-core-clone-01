// graphql.ts — a minimal GraphQL executor for the v4 subset the suite sends
// (the 18 documents in checks-graphql.ts): queries, mutations, variables,
// aliases, inline fragments, inline enum lists / input objects, __type
// introspection, and batched operation arrays. No external library.
//
// Validation is schema-driven: an unknown field answers HTTP 200 with an
// `errors` entry naming the field (GitHub-style), never an HTTP error.

import { branchTip, commitTree, diffTrees, mergeBase, MergeConflictError, prConflicts, prFiles, squashMerge } from './gitops.ts';
import {
  deterministicIso,
  nodeId,
  Store,
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------- schema

/** Fields each type exposes (used for validation and __type introspection). */
const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'updatedAt',
  ],
  User: ['login', 'id', 'name', 'email'],
  Ref: ['name', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'filename'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  Node: ['id'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldSelection {
  readonly kind: 'field';
  readonly name: string;
  readonly alias: string | null;
  readonly args: Array<{ name: string; value: Value }>;
  readonly selections: Selection[];
}

interface FragmentSelection {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selections: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    this.skipIgnored();
    while (this.pos < this.text.length) {
      operations.push(this.parseOperation());
      this.skipIgnored();
    }
    return operations;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos])) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    return this.text[this.pos] ?? '';
  }

  private expect(char: string): void {
    if (this.text[this.pos] !== char) throw new Error(`expected ${JSON.stringify(char)} at ${this.pos}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipIgnored();
    const start = this.pos;
    while (this.pos < this.text.length && /[_A-Za-z0-9]/.test(this.text[this.pos])) this.pos += 1;
    if (start === this.pos) throw new Error(`expected a name at ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private parseOperation(): Operation {
    this.skipIgnored();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const word = this.peekWord();
    if (word === 'query' || word === 'mutation') {
      kind = word;
      this.readName();
      this.skipIgnored();
      if (/[_A-Za-z]/.test(this.peek())) name = this.readName();
    } else if (word === 'subscription') {
      throw new Error('subscriptions are not supported');
    }
    this.skipIgnored();
    if (this.peek() === '(') this.skipVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, selections };
  }

  private peekWord(): string {
    const start = this.pos;
    let end = start;
    while (end < this.text.length && /[_A-Za-z0-9]/.test(this.text[end])) end += 1;
    return this.text.slice(start, end);
  }

  /** Skip `( $var: Type = default, ... )` — types are not needed to execute. */
  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (this.pos < this.text.length && depth > 0) {
      const char = this.text[this.pos];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth -= 1;
      else if (char === '"') this.skipString();
      this.pos += 1;
    }
  }

  private skipString(): void {
    this.expect('"');
    while (this.pos < this.text.length) {
      const char = this.text[this.pos];
      this.pos += 1;
      if (char === '\\') this.pos += 1;
      else if (char === '"') return;
    }
  }

  private parseSelectionSet(): Selection[] {
    this.skipIgnored();
    this.expect('{');
    const selections: Selection[] = [];
    for (;;) {
      this.skipIgnored();
      if (this.peek() === '}') {
        this.pos += 1;
        return selections;
      }
      if (this.pos >= this.text.length) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    this.skipIgnored();
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipIgnored();
      if (this.peekWord() === 'on') {
        this.readName();
        const typeCondition = this.readName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      // Named fragment spread: not used by the suite; parse the name and
      // treat it as an empty fragment (its fields are never selected).
      this.readName();
      return { kind: 'fragment', typeCondition: null, selections: [] };
    }
    let name = this.readName();
    let alias: string | null = null;
    this.skipIgnored();
    if (this.peek() === ':') {
      this.pos += 1;
      alias = name;
      name = this.readName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    this.skipIgnored();
    if (this.peek() === '(') {
      this.pos += 1;
      for (;;) {
        this.skipIgnored();
        if (this.peek() === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.readName();
        this.skipIgnored();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        this.skipIgnored();
      }
    }
    this.skipIgnored();
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): Value {
    this.skipIgnored();
    const char = this.peek();
    if (char === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (char === '"') return { kind: 'string', value: this.readString() };
    if (char === '[') {
      this.pos += 1;
      const items: Value[] = [];
      for (;;) {
        this.skipIgnored();
        if (this.peek() === ']') {
          this.pos += 1;
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (char === '{') {
      this.pos += 1;
      const fields: Array<{ name: string; value: Value }> = [];
      for (;;) {
        this.skipIgnored();
        if (this.peek() === '}') {
          this.pos += 1;
          return { kind: 'object', fields };
        }
        const name = this.readName();
        this.skipIgnored();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    const word = this.readName();
    if (word === 'true') return { kind: 'boolean', value: true };
    if (word === 'false') return { kind: 'boolean', value: false };
    if (word === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(word)) return { kind: 'int', value: Number.parseInt(word, 10) };
    if (/^-?\d+\.\d+$/.test(word)) return { kind: 'float', value: Number.parseFloat(word) };
    return { kind: 'enum', value: word };
  }

  private readString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const char = this.text[this.pos];
      this.pos += 1;
      if (char === '"') return out;
      if (char === '\\') {
        const next = this.text[this.pos];
        this.pos += 1;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += next;
      } else {
        out += char;
      }
    }
    throw new Error('unterminated string');
  }
}

// ---------------------------------------------------------------- values

type Vars = Record<string, unknown>;

function evalValue(value: Value, vars: Vars): unknown {
  switch (value.kind) {
    case 'variable':
      return vars[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => evalValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, vars);
      return out;
    }
  }
}

function argMap(field: FieldSelection, vars: Vars): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = evalValue(arg.value, vars);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asInt(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

// ---------------------------------------------------------------- node ids

function decodeNodeId(id: string): { kind: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 1) return null;
    return { kind: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberAfter(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const n = Number.parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- sources

type Source =
  | { type: 'root'; store: Store }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { type: 'User'; login: string }
  | { type: 'Ref'; name: string }
  | { type: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { type: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[] }
  | { type: 'PullRequestChangedFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changes: number }> }
  | { type: 'IssueCommentConnection'; repo: Repo; issue: Issue }
  | { type: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changes: number }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { type: '__Type'; name: string; fields: string[]; enumValues: string[] | null }
  | { type: '__Field'; name: string }
  | { type: '__EnumValue'; name: string }
  | { type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: string; databaseId: number; body: string } }
  | { type: 'IssueCommentEdge'; repo: Repo; issue: Issue; comment: { id: string; databaseId: number; body: string } }
  | { type: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { type: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { type: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { type: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: string; databaseId: number; body: string } };

interface GqlError {
  message: string;
  path?: (string | number)[];
}

function findRepoByNodeId(store: Store, id: string): Repo | null {
  const decoded = decodeNodeId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 1) return null;
  return store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) ?? null;
}

function findIssueByNodeId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeNodeId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 1) return null;
  const repoKey = decoded.key.slice(0, hash);
  const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
  const slash = repoKey.indexOf('/');
  if (slash < 1 || !Number.isFinite(number)) return null;
  const repo = store.getRepo(repoKey.slice(0, slash), repoKey.slice(slash + 1));
  if (!repo) return null;
  const issue = repo.issues.find((candidate) => candidate.number === number);
  return issue ? { repo, issue } : null;
}

function findPullByNodeId(store: Store, id: string): { repo: Repo; pull: PullRequest } | null {
  const decoded = decodeNodeId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 1) return null;
  const repoKey = decoded.key.slice(0, hash);
  const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
  const slash = repoKey.indexOf('/');
  if (slash < 1 || !Number.isFinite(number)) return null;
  const repo = store.getRepo(repoKey.slice(0, slash), repoKey.slice(slash + 1));
  if (!repo) return null;
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  return pull ? { repo, pull } : null;
}

function issueState(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------- execution

type FieldValue =
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'source'; source: Source }
  | { kind: 'list'; itemType: string; items: Source[] };

function executeSelection(typeName: string, source: Source, selections: readonly Selection[], vars: Vars, errors: GqlError[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelection(typeName, source, selection.selections, vars, errors));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fields = SCHEMA_FIELDS[typeName] ?? [];
    if (!fields.includes(selection.name)) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const args = argMap(selection, vars);
    const resolved = resolveField(typeName, source, selection.name, args);
    if (resolved.kind === 'scalar') {
      out[key] = resolved.value;
    } else if (resolved.kind === 'source') {
      out[key] = selection.selections.length
        ? executeSelection(resolved.source.type, resolved.source, selection.selections, vars, errors)
        : null;
    } else {
      out[key] = resolved.items.map((item) =>
        selection.selections.length ? executeSelection(resolved.itemType, item, selection.selections, vars, errors) : null,
      );
    }
  }
  return out;
}

function resolveField(typeName: string, source: Source, name: string, args: Record<string, unknown>): FieldValue {
  const scalar = (value: string | number | boolean | null): FieldValue => ({ kind: 'scalar', value });
  const obj = (next: Source): FieldValue => ({ kind: 'source', source: next });
  const list = (itemType: string, items: Source[]): FieldValue => ({ kind: 'list', itemType, items });

  if (typeName === 'Query') {
    const root = source as { type: 'root'; store: Store };
    if (name === 'viewer') return obj({ type: 'User', login: VIEWER_LOGIN });
    if (name === 'repository') {
      const repo = root.store.getRepo(asString(args.owner), asString(args.name));
      return repo ? obj({ type: 'Repository', repo }) : scalar(null);
    }
    if (name === 'node') {
      const id = asString(args.id);
      const repo = findRepoByNodeId(root.store, id);
      if (repo) return obj({ type: 'Repository', repo });
      const issue = findIssueByNodeId(root.store, id);
      if (issue) return obj({ type: 'Issue', repo: issue.repo, issue: issue.issue });
      const pull = findPullByNodeId(root.store, id);
      if (pull) return obj({ type: 'PullRequest', repo: pull.repo, pull: pull.pull });
      return scalar(null);
    }
    if (name === '__type') {
      const type = asString(args.name);
      if (type === 'SearchType') return obj({ type: '__Type', name: type, fields: [], enumValues: SEARCH_TYPE_VALUES });
      const fields = SCHEMA_FIELDS[type];
      if (!fields) return scalar(null);
      return obj({ type: '__Type', name: type, fields, enumValues: null });
    }
  }

  if (typeName === 'Mutation') {
    const root = source as { type: 'root'; store: Store };
    if (name === 'createIssue') {
      const input = asRecord(args.input) ?? {};
      const repo = findRepoByNodeId(root.store, asString(input.repositoryId));
      if (!repo) throw new Error('repository not found');
      const issue = root.store.createIssue(repo, asString(input.title), asString(input.body), []);
      return obj({ type: 'CreateIssuePayload', repo, issue });
    }
    if (name === 'closeIssue') {
      const input = asRecord(args.input) ?? {};
      const found = findIssueByNodeId(root.store, asString(input.issueId));
      if (!found) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.updatedSeq += 1;
      return obj({ type: 'CloseIssuePayload', repo: found.repo, issue: found.issue });
    }
    if (name === 'createPullRequest') {
      const input = asRecord(args.input) ?? {};
      const repo = findRepoByNodeId(root.store, asString(input.repositoryId));
      if (!repo) throw new Error('repository not found');
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      const headTip = branchTip(repo, head);
      const baseTip = branchTip(repo, base);
      if (!headTip || !baseTip) throw new Error('head or base branch does not exist');
      const baseMerge = mergeBase(repo, headTip, baseTip);
      const files = diffTrees(repo, baseMerge ? commitTree(repo, baseMerge) : null, commitTree(repo, headTip)).map((change) => change.path);
      const pull = root.store.createPull(repo, asString(input.title), '', head, base, headTip, baseTip, files);
      return obj({ type: 'CreatePullRequestPayload', repo, pull });
    }
    if (name === 'mergePullRequest') {
      const input = asRecord(args.input) ?? {};
      const found = findPullByNodeId(root.store, asString(input.pullRequestId));
      if (!found) throw new Error('pull request not found');
      try {
        squashMerge(found.repo, found.pull);
      } catch (err) {
        if (err instanceof MergeConflictError) throw new Error('merge conflict');
        throw err;
      }
      return obj({ type: 'MergePullRequestPayload', repo: found.repo, pull: found.pull });
    }
    if (name === 'addComment') {
      const input = asRecord(args.input) ?? {};
      const found = findIssueByNodeId(root.store, asString(input.subjectId));
      if (!found) throw new Error('comment subject not found');
      const comment = root.store.addComment(found.issue, asString(input.body));
      return obj({ type: 'AddCommentPayload', repo: found.repo, issue: found.issue, comment });
    }
  }

  if (typeName === 'Repository') {
    const { repo } = source as { type: 'Repository'; repo: Repo };
    switch (name) {
      case 'id':
        return scalar(repo.id);
      case 'databaseId':
        return scalar(repo.databaseId);
      case 'name':
        return scalar(repo.name);
      case 'nameWithOwner':
        return scalar(`${repo.owner}/${repo.name}`);
      case 'owner':
        return obj({ type: 'User', login: repo.owner });
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip ? obj({ type: 'Ref', name: repo.defaultBranch }) : scalar(null);
      }
      case 'viewerPermission':
        return scalar('ADMIN');
      case 'hasIssuesEnabled':
        return scalar(true);
      case 'description':
        return scalar(repo.description);
      case 'private':
        return scalar(repo.isPrivate);
      case 'createdAt':
        return scalar(deterministicIso(repo.createdSeq));
      case 'updatedAt':
        return scalar(deterministicIso(repo.updatedSeq));
      case 'url':
        return scalar(`/repos/${repo.owner}/${repo.name}`);
      case 'issue': {
        const number = asInt(args.number, null);
        const issue = number === null ? undefined : repo.issues.find((candidate) => candidate.number === number);
        return issue ? obj({ type: 'Issue', repo, issue }) : scalar(null);
      }
      case 'issues': {
        let issues = [...repo.issues];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states) issues = issues.filter((issue) => states.includes(issueState(issue)));
        const orderBy = asRecord(args.orderBy);
        const direction = orderBy ? asString(orderBy.direction, 'DESC') : 'ASC';
        const field = orderBy ? asString(orderBy.field, 'CREATED_AT') : 'CREATED_AT';
        issues.sort((a, b) => {
          const byCreated = direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq;
          if (field === 'CREATED_AT' && byCreated !== 0) return byCreated;
          return direction === 'DESC' ? b.number - a.number : a.number - b.number;
        });
        const first = asInt(args.first, null);
        const after = numberAfter(args.after as string | null | undefined);
        if (after !== null) issues = issues.filter((issue) => issue.number > after);
        const hasNextPage = first !== null && issues.length > first;
        const page = first !== null ? issues.slice(0, first) : issues;
        const endCursor = page.length ? cursorFor(page[page.length - 1].number) : null;
        return obj({ type: 'IssueConnection', repo, issues: page, hasNextPage, endCursor });
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls];
        pulls.sort((a, b) => a.number - b.number);
        const first = asInt(args.first, null);
        if (first !== null) pulls = pulls.slice(0, first);
        return obj({ type: 'PullRequestConnection', repo, pulls });
      }
      case 'pullRequest': {
        const number = asInt(args.number, null);
        const pull = number === null ? undefined : repo.pulls.find((candidate) => candidate.number === number);
        return pull ? obj({ type: 'PullRequest', repo, pull }) : scalar(null);
      }
    }
  }

  if (typeName === 'Issue') {
    const { issue } = source as { type: 'Issue'; issue: Issue };
    switch (name) {
      case 'id':
        return scalar(issue.id);
      case 'number':
        return scalar(issue.number);
      case 'title':
        return scalar(issue.title);
      case 'body':
        return scalar(issue.body);
      case 'state':
        return scalar(issueState(issue));
      case 'createdAt':
        return scalar(deterministicIso(issue.createdSeq));
      case 'updatedAt':
        return scalar(deterministicIso(issue.updatedSeq));
      case 'author':
        return obj({ type: 'User', login: issue.authorLogin });
      case 'labels':
        return list('__EnumValue', issue.labels.map((label) => ({ type: '__EnumValue', name: label }) as Source));
      case 'comments': {
        const issueSource = source as { type: 'Issue'; repo: Repo; issue: Issue };
        return obj({ type: 'IssueCommentConnection', repo: issueSource.repo, issue: issueSource.issue });
      }
    }
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = source as { type: 'PullRequest'; repo: Repo; pull: PullRequest };
    switch (name) {
      case 'id':
        return scalar(pull.id);
      case 'number':
        return scalar(pull.number);
      case 'title':
        return scalar(pull.title);
      case 'body':
        return scalar(pull.body);
      case 'state':
        return scalar(pullState(pull));
      case 'merged':
        return scalar(pull.merged);
      case 'mergeable':
        return scalar(prConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE');
      case 'headRefName':
        return scalar(pull.headBranch);
      case 'baseRefName':
        return scalar(pull.baseBranch);
      case 'headRefOid':
        return scalar(branchTip(repo, pull.headBranch) ?? pull.headSha);
      case 'baseRefOid':
        return scalar(branchTip(repo, pull.baseBranch) ?? pull.baseSha);
      case 'mergedAt':
        return scalar(pull.merged ? deterministicIso(pull.updatedSeq) : null);
      case 'mergeCommit':
        return pull.mergedSha ? obj({ type: 'Ref', name: pull.mergedSha }) : scalar(null);
      case 'author':
        return obj({ type: 'User', login: pull.authorLogin });
      case 'createdAt':
        return scalar(deterministicIso(pull.createdSeq));
      case 'updatedAt':
        return scalar(deterministicIso(pull.updatedSeq));
      case 'files': {
        const changes = prFiles(repo, pull);
        const first = asInt(args.first, null);
        const sliced = first !== null ? changes.slice(0, first) : changes;
        return obj({
          type: 'PullRequestChangedFileConnection',
          files: sliced.map((change) => ({ path: change.path, additions: change.additions, deletions: change.deletions, changes: change.changes })),
        });
      }
    }
  }

  if (typeName === 'User') {
    const { login } = source as { type: 'User'; login: string };
    switch (name) {
      case 'login':
        return scalar(login);
      case 'id':
        return scalar(nodeId('User', login));
      case 'name':
        return scalar(login);
      case 'email':
        return scalar(`${login}@example.invalid`);
    }
  }

  if (typeName === 'Ref') {
    const { name: refName } = source as { type: 'Ref'; name: string };
    if (name === 'name') return scalar(refName);
    if (name === 'target') return scalar(refName);
  }

  if (typeName === 'IssueConnection') {
    const conn = source as { type: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null };
    if (name === 'nodes') return list('Issue', conn.issues.map((issue) => ({ type: 'Issue', repo: conn.repo, issue }) as Source));
    if (name === 'edges') return list('IssueCommentEdge', []);
    if (name === 'pageInfo') return obj({ type: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor, startCursor: conn.issues.length ? cursorFor(conn.issues[0].number) : null });
    if (name === 'totalCount') return scalar(conn.issues.length);
  }

  if (typeName === 'PullRequestConnection') {
    const conn = source as { type: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[] };
    if (name === 'nodes') return list('PullRequest', conn.pulls.map((pull) => ({ type: 'PullRequest', repo: conn.repo, pull }) as Source));
    if (name === 'edges') return list('IssueCommentEdge', []);
    if (name === 'pageInfo') return obj({ type: 'PageInfo', hasNextPage: false, endCursor: null, startCursor: null });
    if (name === 'totalCount') return scalar(conn.pulls.length);
  }

  if (typeName === 'IssueCommentConnection') {
    const conn = source as { type: 'IssueCommentConnection'; repo: Repo; issue: Issue };
    if (name === 'nodes') return list('IssueComment', conn.issue.comments.map((comment) => ({ type: 'IssueComment', repo: conn.repo, issue: conn.issue, comment }) as Source));
    if (name === 'edges') return list('IssueCommentEdge', conn.issue.comments.map((comment) => ({ type: 'IssueCommentEdge', repo: conn.repo, issue: conn.issue, comment }) as Source));
    if (name === 'pageInfo') return obj({ type: 'PageInfo', hasNextPage: false, endCursor: null, startCursor: null });
    if (name === 'totalCount') return scalar(conn.issue.comments.length);
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    const conn = source as { type: 'PullRequestChangedFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changes: number }> };
    if (name === 'nodes') return list('PullRequestChangedFile', conn.files.map((file) => ({ type: 'PullRequestChangedFile', ...file }) as Source));
    if (name === 'edges') return list('IssueCommentEdge', []);
    if (name === 'pageInfo') return obj({ type: 'PageInfo', hasNextPage: false, endCursor: null, startCursor: null });
    if (name === 'totalCount') return scalar(conn.files.length);
  }

  if (typeName === 'PullRequestChangedFile') {
    const file = source as { type: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changes: number };
    if (name === 'path' || name === 'filename') return scalar(file.path);
    if (name === 'additions') return scalar(file.additions);
    if (name === 'deletions') return scalar(file.deletions);
    if (name === 'changes') return scalar(file.changes);
  }

  if (typeName === 'PageInfo') {
    const page = source as { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null };
    if (name === 'hasNextPage') return scalar(page.hasNextPage);
    if (name === 'hasPreviousPage') return scalar(false);
    if (name === 'endCursor') return scalar(page.endCursor);
    if (name === 'startCursor') return scalar(page.startCursor);
  }

  if (typeName === '__Type') {
    const type = source as { type: '__Type'; name: string; fields: string[]; enumValues: string[] | null };
    if (name === 'name') return scalar(type.name);
    if (name === 'kind') return scalar(type.enumValues ? 'ENUM' : 'OBJECT');
    if (name === 'description') return scalar(null);
    if (name === 'fields') return list('__Field', type.fields.map((field) => ({ type: '__Field', name: field }) as Source));
    if (name === 'enumValues') return list('__EnumValue', (type.enumValues ?? []).map((value) => ({ type: '__EnumValue', name: value }) as Source));
  }

  if (typeName === '__Field') {
    const field = source as { type: '__Field'; name: string };
    if (name === 'name') return scalar(field.name);
    if (name === 'description') return scalar(null);
    if (name === 'args') return list('__Field', []);
    if (name === 'type') return scalar(null);
  }

  if (typeName === '__EnumValue') {
    const value = source as { type: '__EnumValue'; name: string };
    if (name === 'name') return scalar(value.name);
    if (name === 'description') return scalar(null);
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const payload = source as { type: 'CreateIssuePayload' | 'CloseIssuePayload'; repo: Repo; issue: Issue };
    if (name === 'issue') return obj({ type: 'Issue', repo: payload.repo, issue: payload.issue });
    if (name === 'clientMutationId') return scalar(null);
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const payload = source as { type: 'CreatePullRequestPayload' | 'MergePullRequestPayload'; repo: Repo; pull: PullRequest };
    if (name === 'pullRequest') return obj({ type: 'PullRequest', repo: payload.repo, pull: payload.pull });
    if (name === 'clientMutationId') return scalar(null);
  }

  if (typeName === 'AddCommentPayload') {
    const payload = source as { type: 'AddCommentPayload'; repo: Repo; issue: Issue; comment: { id: string; databaseId: number; body: string } };
    if (name === 'commentEdge') return obj({ type: 'IssueCommentEdge', repo: payload.repo, issue: payload.issue, comment: payload.comment });
    if (name === 'clientMutationId') return scalar(null);
  }

  if (typeName === 'IssueCommentEdge') {
    const edge = source as { type: 'IssueCommentEdge'; repo: Repo; issue: Issue; comment: { id: string; databaseId: number; body: string } };
    if (name === 'node') return obj({ type: 'IssueComment', repo: edge.repo, issue: edge.issue, comment: edge.comment });
    if (name === 'cursor') return scalar(cursorFor(edge.comment.databaseId));
  }

  if (typeName === 'IssueComment') {
    const commentSource = source as { type: 'IssueComment'; comment: { id: string; databaseId: number; body: string } };
    if (name === 'id') return scalar(commentSource.comment.id);
    if (name === 'body') return scalar(commentSource.comment.body);
    if (name === 'author') return obj({ type: 'User', login: VIEWER_LOGIN });
    if (name === 'createdAt') return scalar(deterministicIso(commentSource.comment.databaseId));
    if (name === 'updatedAt') return scalar(deterministicIso(commentSource.comment.databaseId));
  }

  return scalar(null);
}

// ---------------------------------------------------------------- entry

export interface GraphqlResponse {
  readonly status: number;
  readonly body: unknown;
}

interface SingleRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOne(store: Store, request: SingleRequest): Record<string, unknown> {
  const query = typeof request.query === 'string' ? request.query : '';
  const vars = (request.variables && typeof request.variables === 'object' && !Array.isArray(request.variables) ? request.variables : {}) as Vars;
  const errors: GqlError[] = [];
  try {
    const operations = new Parser(query).parseDocument();
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'Syntax Error: empty document.' }] };
    }
    const operation = operations[0];
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelection(rootType, { type: 'root', store }, operation.selections, vars, errors);
    return errors.length ? { data, errors } : { data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A mutation-side failure (unknown id, missing branch, conflict) is a
    // GraphQL error, not an HTTP error.
    if (message.startsWith('Cannot query field')) return { data: null, errors: [{ message }] };
    return { data: null, errors: [{ message }] };
  }
}

/** Handle POST /api/graphql (single operation or a JSON array batch). */
export function handleGraphql(store: Store, body: unknown): GraphqlResponse {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, (entry ?? {}) as SingleRequest)) };
  }
  if (typeof body === 'object' && body !== null) {
    return { status: 200, body: executeOne(store, body as SingleRequest) };
  }
  return { status: 200, body: { data: null, errors: [{ message: 'Request body must be a JSON object or array.' }] } };
}
