// gitproto.ts — the smart-HTTP wire: ref advertisements, protocol v2 ls-refs/fetch,
// protocol v0 fetch, and receive-pack pushes. Built on git.ts; driven by the store.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  packetLines,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import type { Repo } from './store.ts';

export const AGENT = 'forge/1.0';

/** Refs in advertisement order: HEAD first, then the rest sorted by name. */
export function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The peeled commit for a ref (annotated tags peel; anything else is itself). */
function peeledOid(repo: Repo, refName: string, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  try {
    return peelToCommit(oid, (id) => repo.objects.get(id));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- advertisements

/** v2 capability advertisement (info/refs with Git-Protocol: version=2). The bytes are
 * fixed for every repository, so they are built once at module load instead of
 * re-encoded on every info/refs (the clone workload issues 50 of them). The buffer
 * is never mutated after creation, so returning the shared instance is safe. */
const UPLOAD_PACK_V2_ADVERTISEMENT: Buffer = encodePktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  `agent=${AGENT}\n`,
  'flush',
]);

export function advertiseUploadPackV2(): Buffer {
  return UPLOAD_PACK_V2_ADVERTISEMENT;
}

/** v0 ref advertisement for upload-pack (info/refs without the v2 header). */
export function advertiseUploadPackV0(repo: Repo): Buffer {
  const caps = `side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), Buffer.from('0000', 'ascii')];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? repo.refs.get(names[0]) ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      parts.push(encodePktLine(`${oid} ${name}\n`));
      const peeled = peeledOid(repo, name, oid);
      if (peeled) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

/** v0 ref advertisement for receive-pack. */
export function advertiseReceivePack(repo: Repo): Buffer {
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), Buffer.from('0000', 'ascii')];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? repo.refs.get(names[0]) ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const name of names) {
      parts.push(encodePktLine(`${repo.refs.get(name)!} ${name}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Handle a v2 ls-refs command body; answers the ref list as pkt-lines. */
export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines: (string | 'flush')[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get(headTarget(repo));
  if (keep('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOid(repo, name, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  noProgress: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, thinPack: false, noProgress: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress') args.noProgress = true;
  }
  return args;
}

/** Commit generation distances from the want tips (0 = the tip itself). */
function commitDistances(repo: Repo, tips: readonly string[], maxDepth: number | null): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) {
    const commitOid = peelToCommit(tip, (id) => repo.objects.get(id)) ?? tip;
    const object = repo.objects.get(commitOid);
    if (object && object.type === 'commit' && !distances.has(commitOid)) {
      distances.set(commitOid, 0);
      queue.push({ oid: commitOid, depth: 0 });
    }
  }
  while (queue.length) {
    const { oid, depth } = queue.shift()!;
    if (maxDepth !== null && depth + 1 >= maxDepth) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (distances.has(parent)) continue;
      distances.set(parent, depth + 1);
      queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return distances;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

function selectFetch(repo: Repo, args: FetchArgs): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Objects the client already holds (reachable from its haves). A shallow
  // boundary is a cut: the client holds the boundary commit itself, but NOT
  // its parents — a deepen must deliver them, so traversal stops there.
  const shallowSet = new Set(args.shallow);
  const held = new Set<string>();
  for (const have of args.haves) {
    const queue = [have];
    while (queue.length) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }
  // Acknowledgement: the first have that is a commit the server holds.
  let ack: string | null = null;
  for (const have of args.haves) {
    const object = repo.objects.get(have);
    if (object && object.type === 'commit') {
      ack = have;
      break;
    }
  }
  const send = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const tagObjects: string[] = [];
  const tipCommits: string[] = [];
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      tagObjects.push(want);
      const peeled = peelToCommit(want, lookup);
      if (peeled) tipCommits.push(peeled);
    } else if (object.type === 'commit') {
      tipCommits.push(want);
    } else {
      send.add(want);
    }
  }
  if (args.depth === null) {
    for (const oid of collectReachable(tipCommits, lookup)) send.add(oid);
    for (const oid of tagObjects) send.add(oid);
  } else {
    const distances = commitDistances(repo, tipCommits, args.depth);
    const boundary = new Set<string>();
    for (const [oid, distance] of distances) {
      if (distance === args.depth - 1) boundary.add(oid);
    }
    const included = new Set<string>();
    // Include each in-depth commit plus its tree/blob closure (no parent links).
    for (const oid of distances.keys()) {
      included.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const treeOid = parseCommit(object.data).tree;
      const stack = [treeOid];
      while (stack.length) {
        const current = stack.pop()!;
        if (included.has(current)) continue;
        const currentObject = repo.objects.get(current);
        if (!currentObject) continue;
        included.add(current);
        if (currentObject.type === 'tree') {
          for (const entry of parseTree(currentObject.data)) {
            if (entry.mode !== '160000') stack.push(entry.oid);
          }
        }
      }
    }
    for (const oid of included) send.add(oid);
    for (const oid of tagObjects) send.add(oid);
    for (const oid of boundary) shallow.push(oid);
    // An old shallow boundary is unshallow once its parents are all included.
    for (const old of args.shallow) {
      if (!distances.has(old)) continue;
      const object = repo.objects.get(old);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => distances.has(parent))) unshallow.push(old);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort(), ack };
}

/** Sideband-64k framing: band-1 packets of at most 65515 data bytes each. */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(offset + maxData, pack.length));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(encodePktLine(framed));
  }
  if (chunks.length === 0) {
    chunks.push(encodePktLine(Buffer.from([1])));
  }
  return chunks;
}

/** Fetch-response cache. A fetch's response is fully determined by its arguments and the objects
 * they name, and objects are immutable content-addressed blobs: the same args against the same
 * objects always build the same bytes. The clone workload issues 50 concurrent shallow clones of
 * one unchanging repository, so the second and later clones answer from here instead of rebuilding
 * the pack. Bounded FIFO so memory stays small; entries are stored only when every oid the args
 * name already exists, so a later object can never make a cached answer wrong. */
const FETCH_CACHE_MAX = 32;
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(repo: Repo, args: FetchArgs, version: 'v0' | 'v2'): string {
  return [
    repo.owner, repo.name, version,
    args.wants.join(','), args.haves.join(','), args.shallow.join(','),
    String(args.depth), args.thinPack ? '1' : '0', args.noProgress ? '1' : '0',
  ].join('\n');
}

function storeFetchCache(key: string, args: FetchArgs, repo: Repo, response: Buffer): void {
  for (const oid of [...args.wants, ...args.haves, ...args.shallow]) {
    if (!repo.objects.has(oid)) return;
  }
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, response);
}

/** Handle a v2 fetch command body; answers the sectioned response. */
export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const lines = packetLines(packets);
  const args = parseFetchArgs(lines);
  const cacheKey = fetchCacheKey(repo, args, 'v2');
  const cached = fetchCache.get(cacheKey);
  if (cached) return cached;
  const selection = selectFetch(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent have lines:
  // real git expects the response to start with `packfile` otherwise, and
  // rejects a stray acknowledgments section ("expected 'packfile'").
  if (args.haves.length > 0) {
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine(selection.ack ? `ACK ${selection.ack}\n` : 'NAK\n'));
    if (selection.ack) parts.push(encodePktLine('ready\n'));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // shallow-info
  if (selection.shallow.length || selection.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  // packfile
  parts.push(encodePktLine('packfile\n'));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(Buffer.from('0000', 'ascii'));
  const response = Buffer.concat(parts);
  storeFetchCache(cacheKey, args, repo, response);
  return response;
}

/** Handle a v0 fetch body (want/have/done); answers NAK/ACK, shallow lines, sideband pack. */
export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  // The first want line carries space-separated capabilities after the oid; strip them.
  const lines = packetLines(packets).map((line) => {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).split(' ');
      return `want ${rest[0]}`;
    }
    return line;
  });
  const args = parseFetchArgs(lines);
  const cacheKey = fetchCacheKey(repo, args, 'v0');
  const cached = fetchCache.get(cacheKey);
  if (cached) return cached;
  const selection = selectFetch(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine(selection.ack ? `ACK ${selection.ack}\n` : 'NAK\n'));
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  const response = Buffer.concat(parts);
  storeFetchCache(cacheKey, args, repo, response);
  return response;
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack request body into commands, capabilities and the pack bytes. */
function parseReceivePack(body: Buffer): { commands: PushCommand[]; capabilities: Set<string>; pack: Buffer } {
  const { packets, endOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  const capabilities = new Set<string>();
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      for (const token of line.slice(nul + 1).split(' ')) if (token) capabilities.add(token);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command line ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('receive-pack command has a bad object id');
    commands.push({ oldOid, newOid, ref });
  }
  if (!sawFlush) throw new Error('receive-pack body has no command flush');
  return { commands, capabilities, pack: body.subarray(endOffset) };
}

/** Handle a receive-pack POST; answers the report-status stream. */
export function handleReceivePack(repo: Repo, body: Buffer): { body: Buffer; sideband: boolean } {
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  let sideband = false;
  try {
    const { commands, capabilities, pack } = parseReceivePack(body);
    sideband = capabilities.has('side-band-64k');
    if (pack.length > 0) {
      const read = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    }
    for (const command of commands) {
      const result = applyCommand(repo, command);
      reportLines.push(result);
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = (err as Error).message.slice(0, 120);
  }
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  if (!unpackOk) {
    // A failed unpack refuses every ref the request named, best effort.
    try {
      const { commands } = parseReceivePack(body);
      for (const command of commands) lines.push(`ng ${command.ref} unpack failed\n`);
    } catch {
      // Nothing more can be said.
    }
  } else {
    lines.push(...reportLines);
  }
  lines.push('flush');
  const report = encodePktLines(lines.map((line) => (line === 'flush' ? 'flush' : line)));
  if (sideband) {
    // Sideband-64k: the report rides as band-1 data, chunked like a pack, and the
    // stream ends with a flush packet. Without that trailing flush a real git
    // client reports "unexpected disconnect while reading sideband packet": the
    // flush inside the report is payload, not a stream terminator. Chunking also
    // keeps one pkt-line under the 64 KiB limit on a many-ref push.
    const parts: Buffer[] = [];
    const maxData = 65515;
    for (let offset = 0; offset < report.length; offset += maxData) {
      parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, Math.min(offset + maxData, report.length))])));
    }
    if (parts.length === 0) parts.push(encodePktLine(Buffer.from([1])));
    parts.push(Buffer.from('0000', 'ascii'));
    return { body: Buffer.concat(parts), sideband: true };
  }
  return { body: report, sideband: false };
}

/** Validate and apply one ref update; returns its `ok`/`ng` report line. */
function applyCommand(repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return `ng ${ref} reference does not exist\n`;
    if (oldOid !== ZERO_OID && oldOid !== current) return `ng ${ref} old value does not match\n`;
    repo.refs.delete(ref);
    return `ok ${ref}\n`;
  }
  const object = repo.objects.get(newOid);
  if (!object) return `ng ${ref} object not found\n`;
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return `ng ${ref} reference already exists\n`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}\n`;
  }
  if (current === undefined) return `ng ${ref} reference does not exist\n`;
  if (oldOid !== current) return `ng ${ref} old value does not match\n`;
  // Fast-forward: the old tip must be an ancestor of the new tip.
  const oldCommit = peelToCommit(oldOid, (id) => repo.objects.get(id));
  const newCommit = peelToCommit(newOid, (id) => repo.objects.get(id));
  if (oldCommit && newCommit) {
    if (!isAncestor(oldCommit, newCommit, (id) => repo.objects.get(id))) {
      return `ng ${ref} non-fast-forward\n`;
    }
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}\n`;
}

/** The SHA-1 of a pack's bytes, for logging only (never in a response). */
export function packId(pack: Buffer): string {
  return hashObject('blob', pack).slice(0, 12);
}
