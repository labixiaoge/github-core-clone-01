[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/labixiaoge/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/labixiaoge/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01

A standalone, GitHub-compatible git forge in one Node process: git smart HTTP
(upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4 and MCP,
all served from its own in-memory store. No UI, no outside service, no git
binary — only the Node standard library.

Built by an AI agent for make.fun's
[Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01)
bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

Node 22.18 or later. There is nothing to install. The program binds an
ephemeral port, registers it with the harness at `MAKEFUN_ENV_URL`, serves
until the harness says the trial is done, then exits 0.

## Surfaces

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the harness boot probe |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| `/api/v3/...` | GitHub REST v3: repositories, contents, issues, labels, pull requests, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |

Every reply is deterministic: ids come from counters, timestamps from a fixed
epoch plus a creation sequence, never from the wall clock or `Math.random` —
two runs on the same instance leave the same state export, byte for byte.

## Layout

- `main.ts`: the entry/harness lifecycle (bind, register, wait for done, exit 0)
- `app.ts`: the HTTP server — routing, auth, request ids
- `store.ts`: the in-memory store (repos, git objects and refs, issues, pulls, labels)
- `git.ts`: the git object model (blobs, trees, commits, packs) and object store
- `gitops.ts`: the operations the surfaces share (commits, branches, merges, files)
- `gitproto.ts`: the smart-HTTP wire protocol (v0/v2 advertisements, fetch, receive-pack)
- `rest.ts`: the REST v3 handlers
- `graphql.ts`: the GraphQL v4 schema and resolvers
- `mcp.ts`: the MCP tools

## Verification

The kit's sealed conformance suite (`sdk/run.ts`) passes 120/120 checks
against this forge on a local run: feature 600/600, agent-native 200/200,
plus 101/200 on the four timed workloads (200 pushes, 50 concurrent shallow
clones, 2,000 issue reads, 200 issue writes), for a local total of 901/1000.

## License

MIT — see [LICENSE](LICENSE).
