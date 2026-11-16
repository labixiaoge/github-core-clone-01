// gitops.ts — git-level operations on a Repo: building commits from content
// changes (the contents API, squash merges), walking history, diffing trees,
// finding merge bases and detecting merge conflicts. Everything is
// deterministic: commit timestamps come from the store's creation sequence,
// author/committer are the fixed conformance identity.

import {
  buildCommit,
  buildTree,
  hashObject,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './git.ts';
import { deterministicIso, nextSeq, VIEWER_EMAIL, VIEWER_NAME, type PullRequest, type Repo } from './store.ts';

/** Fixed commit identity (the suite's CONFORMANCE_IDENTITY shape). */
export const COMMIT_AUTHOR = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
/** Deterministic commit timestamp: fixed epoch (2025-01-01) plus sequence seconds. */
export function commitTimestamp(): number {
  return 1_735_689_600 + nextSeq();
}

/** The ref name of a branch. */
export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The tip commit oid of a branch, or null when the branch has no commits. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(branchRef(branch)) ?? null;
}

/** Resolve a ref-ish (branch name or full ref or oid) to a commit oid. */
export function resolveCommit(repo: Repo, ref: string): string | null {
  const direct = repo.refs.get(ref) ?? repo.refs.get(branchRef(ref));
  if (direct) return peelToCommit(direct, (id) => repo.objects.get(id)) ?? direct;
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    if (object && object.type === 'commit') return ref;
    if (object && object.type === 'tag') return peelToCommit(ref, (id) => repo.objects.get(id));
  }
  return null;
}

/** The tree oid of a commit. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------- trees

export interface FlatFile {
  readonly mode: string;
  readonly oid: string;
}

/** Flatten a tree (recursively) into path -> {mode, oid}. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, FlatFile> {
  const out = new Map<string, FlatFile>();
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      for (const [subPath, file] of flattenTree(repo, entry.oid, path)) out.set(subPath, file);
    } else if (entry.mode !== '160000') {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Store an object in the repo (idempotent) and return its oid. */
export function putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/**
 * Build (and store) a tree from a flat file map. Creates intermediate
 * directory trees as needed; empty directories are dropped (git has none).
 */
export function buildTreeFromFiles(repo: Repo, files: ReadonlyMap<string, FlatFile>): string {
  interface Node {
    files: Map<string, FlatFile>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) {
      const childOid = build(child);
      entries.push({ mode: '40000', name, oid: childOid });
    }
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The direct children of a directory path in a tree: files and subdirs. */
export function listDirectory(repo: Repo, treeOid: string, dirPath: string): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; mode: string }> {
  const flat = flattenTree(repo, treeOid);
  const prefix = dirPath ? `${dirPath}/` : '';
  const seen = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string; mode: string }>();
  for (const [path, file] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      seen.set(rest, { name: rest, path, type: 'file', oid: file.oid, mode: file.mode });
    } else {
      const dirName = rest.slice(0, slash);
      if (!seen.has(dirName)) {
        // The dir's tree oid: walk the tree to find it (needed for the `sha` field).
        seen.set(dirName, { name: dirName, path: `${prefix}${dirName}`, type: 'dir', oid: dirTreeOid(repo, treeOid, `${prefix}${dirName}`) ?? '', mode: '40000' });
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The tree oid of a directory path inside a tree, or null. */
export function dirTreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  if (!dirPath) return treeOid;
  let current = treeOid;
  for (const part of dirPath.split('/')) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------- commits

export interface ContentCommit {
  readonly commitSha: string;
  readonly blobSha: string;
  readonly treeSha: string;
}

/**
 * Create one commit on `branch` applying `changes` (path -> new blob bytes,
 * or null to delete the path) on top of the branch tip. Creates the branch
 * when it does not exist yet (first commit). Returns the commit and blob shas.
 */
export function commitContent(
  repo: Repo,
  branch: string,
  message: string,
  changes: ReadonlyMap<string, Buffer | null>,
): ContentCommit {
  const tip = branchTip(repo, branch);
  const baseFiles = tip ? flattenTree(repo, commitTree(repo, tip)!) : new Map<string, FlatFile>();
  const files = new Map<string, FlatFile>(baseFiles);
  let lastBlobSha = '';
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
    } else {
      const blobSha = putObject(repo, 'blob', content);
      files.set(path, { mode: '100644', oid: blobSha });
      lastBlobSha = blobSha;
    }
  }
  const treeSha = buildTreeFromFiles(repo, files);
  const commitData = buildCommit({
    tree: treeSha,
    parents: tip ? [tip] : [],
    message,
    author: COMMIT_AUTHOR,
    committer: COMMIT_AUTHOR,
    timestamp: commitTimestamp(),
  });
  const commitSha = putObject(repo, 'commit', commitData);
  repo.refs.set(branchRef(branch), commitSha);
  repo.commitSeq += 1;
  return { commitSha, blobSha: lastBlobSha, treeSha };
}

/** History of a tip commit, newest first (linear histories in practice). */
export function commitHistory(repo: Repo, tipOid: string, limit = 1000): Array<{ sha: string; message: string; timestamp: number }> {
  const out: Array<{ sha: string; message: string; timestamp: number }> = [];
  const seen = new Set<string>();
  const stack = [tipOid];
  while (stack.length && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const authorParts = commit.author.split(' ');
    const timestamp = Number.parseInt(authorParts[authorParts.length - 2] ?? '0', 10) || 0;
    out.push({ sha: oid, message: commit.message, timestamp });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

/** The first common ancestor commit of two tips, or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const queue = [a];
  while (queue.length) {
    const oid = queue.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- diffs

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

/** Count added/removed lines between two texts (LCS on lines; small files). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop a trailing empty line produced by a final newline: it is not a line.
  if (oldLines.length && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const common = prev[m];
  return { additions: m - common, deletions: n - common };
}

/** Diff two trees (by oid) into per-file changes with line counts. */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map<string, FlatFile>();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map<string, FlatFile>();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldFile = base.get(path);
    const newFile = head.get(path);
    if (oldFile && !newFile) {
      const oldText = repo.objects.get(oldFile.oid)?.data.toString('utf8') ?? '';
      const diff = lineDiff(oldText, '');
      out.push({ path, status: 'removed', oldOid: oldFile.oid, newOid: null, additions: 0, deletions: diff.deletions, changes: diff.deletions });
    } else if (!oldFile && newFile) {
      const newText = repo.objects.get(newFile.oid)?.data.toString('utf8') ?? '';
      const diff = lineDiff('', newText);
      out.push({ path, status: 'added', oldOid: null, newOid: newFile.oid, additions: Math.max(diff.additions, 1), deletions: 0, changes: Math.max(diff.additions, 1) });
    } else if (oldFile && newFile && oldFile.oid !== newFile.oid) {
      const oldText = repo.objects.get(oldFile.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(newFile.oid)?.data.toString('utf8') ?? '';
      const diff = lineDiff(oldText, newText);
      out.push({
        path,
        status: 'modified',
        oldOid: oldFile.oid,
        newOid: newFile.oid,
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
      });
    }
  }
  return out;
}

/** The files a pull request changes: head tree vs the merge-base tree. */
export function prFiles(repo: Repo, pull: PullRequest): FileChange[] {
  const headTip = branchTip(repo, pull.headBranch);
  if (!headTip) return [];
  const headTree = commitTree(repo, headTip);
  const baseTip = branchTip(repo, pull.baseBranch);
  const base = headTip && baseTip ? mergeBase(repo, headTip, baseTip) : null;
  const baseTree = base ? commitTree(repo, base) : null;
  return diffTrees(repo, baseTree, headTree);
}

/**
 * Would merging this PR conflict? A path changed on both sides of the merge
 * base with different resulting contents is a conflict.
 */
export function prConflicts(repo: Repo, pull: PullRequest): boolean {
  const headTip = branchTip(repo, pull.headBranch);
  const baseTip = branchTip(repo, pull.baseBranch);
  if (!headTip || !baseTip) return false;
  const base = mergeBase(repo, headTip, baseTip);
  if (!base) return false;
  const baseTree = commitTree(repo, base);
  const headTree = commitTree(repo, headTip);
  const baseTipTree = commitTree(repo, baseTip);
  const headChanges = new Map(diffTrees(repo, baseTree, headTree).map((change) => [change.path, change]));
  const baseChanges = new Map(diffTrees(repo, baseTree, baseTipTree).map((change) => [change.path, change]));
  for (const [path, headChange] of headChanges) {
    const baseChange = baseChanges.get(path);
    if (!baseChange) continue;
    if (headChange.newOid !== baseChange.newOid) return true;
  }
  return false;
}

/** MERGEABLE / CONFLICTING for a PR (UNKNOWN is never needed: we compute it). */
export function prMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  return prConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

export class MergeConflictError extends Error {
  constructor() {
    super('merge conflict');
  }
}

/**
 * Squash-merge a PR onto its base branch: one commit whose tree is the base
 * tip's tree plus the head's changes, parented on the base tip. Updates the
 * base ref and the PR record. Throws MergeConflictError on conflict.
 */
export function squashMerge(repo: Repo, pull: PullRequest): { sha: string } {
  if (pull.merged) throw new MergeConflictError();
  const headTip = branchTip(repo, pull.headBranch);
  const baseTip = branchTip(repo, pull.baseBranch);
  if (!headTip || !baseTip) throw new Error('pull request branches are missing');
  if (prConflicts(repo, pull)) throw new MergeConflictError();
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base ? commitTree(repo, base) : null;
  const headTree = commitTree(repo, headTip);
  const baseTipTree = commitTree(repo, baseTip);
  const headChanges = diffTrees(repo, baseTree, headTree);
  const files = new Map<string, FlatFile>(baseTipTree ? flattenTree(repo, baseTipTree) : new Map());
  for (const change of headChanges) {
    if (change.status === 'removed') files.delete(change.path);
    else if (change.newOid) files.set(change.path, { mode: '100644', oid: change.newOid });
  }
  const treeSha = buildTreeFromFiles(repo, files);
  const message = `Merge pull request #${pull.number} from ${pull.headBranch}\n\n${pull.title}`;
  const commitData = buildCommit({
    tree: treeSha,
    parents: [baseTip],
    message,
    author: COMMIT_AUTHOR,
    committer: COMMIT_AUTHOR,
    timestamp: commitTimestamp(),
  });
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set(branchRef(pull.baseBranch), sha);
  repo.commitSeq += 1;
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedSha = sha;
  pull.updatedSeq = nextSeq();
  pull.files = headChanges.map((change) => change.path);
  return { sha };
}

/** The ISO timestamp of a pull request's merge (deterministic). */
export function mergedAtIso(pull: PullRequest): string {
  return deterministicIso(pull.updatedSeq);
}
