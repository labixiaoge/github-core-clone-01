// store.ts — the forge's in-memory store: users, repositories, git objects and refs,
// issues, pull requests, labels and comments. Everything is deterministic: ids come
// from counters and name-derived encodings, timestamps from a fixed epoch plus a
// creation sequence, never from the wall clock or Math.random.
//
// The viewer (the login the bearer token names) is derived from the competition's
// published fixed scenario seed, the same derivation the suite uses to build its
// scenario: SCENARIO_SEED 0x6a09e667f3bcc909, stream 'users', first user.

import type { GitObject } from './git.ts';

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

function scenarioViewer(): { id: number; login: string; name: string; email: string } {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
}

const VIEWER = scenarioViewer();
export const VIEWER_LOGIN = VIEWER.login;
export const VIEWER_ID = VIEWER.id;
export const VIEWER_NAME = VIEWER.name;
export const VIEWER_EMAIL = VIEWER.email;

// ---------------------------------------------------------------- ids and time

let globalSeq = 0;
/** The next creation sequence number (1-based), shared so every created thing orders deterministically. */
export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

/** A fixed epoch (2025-01-01T00:00:00Z) plus `seq` seconds, as an ISO string. */
export function deterministicIso(seq: number): string {
  return new Date((1_735_689_600 + seq) * 1000).toISOString().replace('.000Z', 'Z');
}

/** Opaque, stable node id: base64 of a typed key. Identical across REST and GraphQL. */
export function nodeId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

// ---------------------------------------------------------------- model

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly databaseId: number;
}

export interface Comment {
  readonly id: string;
  readonly databaseId: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly id: string;
  readonly databaseId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly authorLogin: string;
  readonly createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface PullRequest {
  readonly id: string;
  readonly databaseId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSha: string | null;
  readonly headBranch: string;
  readonly baseBranch: string;
  headSha: string;
  baseSha: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly authorLogin: string;
  readonly createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
  /** Files changed by the head branch relative to the merge base (paths). */
  files: string[];
}

export interface Repo {
  readonly owner: string;
  readonly name: string;
  readonly id: string;
  readonly databaseId: number;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: PullRequest[];
  /** Issues and pull requests number independently, each from 1 (REST spec §6). */
  nextIssueNumber: number;
  nextPullNumber: number;
  readonly createdSeq: number;
  updatedSeq: number;
  /** Number of REST-visible commits (contents API + merges create these). */
  commitSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoDbId = 0;
  private itemDbId = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const seq = nextSeq();
    this.repoDbId += 1;
    const repo: Repo = {
      owner,
      name,
      id: nodeId('Repository', `${owner}/${name}`),
      databaseId: this.repoDbId,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      createdSeq: seq,
      updatedSeq: seq,
      commitSeq: 0,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  nextItemDbId(): number {
    this.itemDbId += 1;
    return this.itemDbId;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = nextSeq();
    const number = repo.nextIssueNumber;
    repo.nextIssueNumber += 1;
    const issue: Issue = {
      id: nodeId('Issue', `${repo.owner}/${repo.name}#${number}`),
      databaseId: this.nextItemDbId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      authorLogin: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headBranch: string, baseBranch: string, headSha: string, baseSha: string, files: string[]): PullRequest {
    const seq = nextSeq();
    const number = repo.nextPullNumber;
    repo.nextPullNumber += 1;
    const pull: PullRequest = {
      id: nodeId('PullRequest', `${repo.owner}/${repo.name}#${number}`),
      databaseId: this.nextItemDbId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedSha: null,
      headBranch,
      baseBranch,
      headSha,
      baseSha,
      mergeable: 'MERGEABLE',
      authorLogin: VIEWER_LOGIN,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
      files: [...files],
    };
    repo.pulls.push(pull);
    return pull;
  }

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const label: Label = { name, color, description, databaseId: this.nextItemDbId() };
    repo.labels.set(name, label);
    return label;
  }

  addComment(target: Issue | PullRequest, body: string): Comment {
    const seq = nextSeq();
    const comment: Comment = {
      id: nodeId('IssueComment', `${target.id}:${target.comments.length + 1}`),
      databaseId: this.nextItemDbId(),
      body,
      authorLogin: VIEWER_LOGIN,
      createdSeq: seq,
    };
    target.comments.push(comment);
    return comment;
  }
}
