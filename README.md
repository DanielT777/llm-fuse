# llm-fuse

> Mount any HTTP API as a virtual filesystem an LLM agent can navigate with `ls` / `cat` / `invoke`.

`llm-fuse` is an open-source toolkit for **authoring connectors** that turn APIs, apps, and internal systems into navigable trees for LLM agents. Instead of growing a list of bespoke tool calls (`listObjects`, `getObject`, `runAction`...), you give the agent **one** workspace and **one** shell, and let it move around like a human would.

```bash
$ llmfuse ls /api/users
1/  2/  3/  ...

$ llmfuse cat /api/users/1/metadata.json
{ "id": 1, "name": "Leanne Graham", ... }

$ llmfuse tree /api/users/1 --depth 2
/api/users/1
├── metadata.json
├── posts/
│   ├── 1/
│   ├── 2/
│   └── ...
├── todos/
├── albums/
└── actions/
    └── createPost!
```

This repo is a **POC** with two goals:

1. Validate whether **FUSE** is portable across the deployment targets where LLM agents actually run — local laptops, Docker, CI runners, **Vercel Sandbox** microVMs, etc.
2. Prove that a **restricted shell** is a portable baseline that works *everywhere* FUSE doesn't.

## Authoring a connector

The key product of this repo is `defineRestProvider`. Connectors are written as a **declarative route table**:

```ts
// packages/provider-jsonplaceholder/src/index.ts
import { defineRestProvider } from "@llm-fuse/core";

export const jsonPlaceholderProvider = defineRestProvider({
  name: "jsonplaceholder",
  mountPoint: "/api",
  baseUrl: "https://jsonplaceholder.typicode.com",
  cacheTtlMs: 60_000,
  routes: [
    { path: "/users", list: "/users", id: "id" },
    { path: "/users/:userId/metadata.json", read: "/users/:userId" },
    { path: "/users/:userId/posts", list: "/users/:userId/posts", id: "id" },
    { path: "/users/:userId/posts/:postId/data.json", read: "/posts/:postId" },
    {
      path: "/users/:userId/actions/createPost",
      invoke: { method: "POST", endpoint: "/posts" },
    },
    // ...
  ],
});
```

That's the entire connector. Each route declares:

| Field    | Meaning                                                                 |
|----------|-------------------------------------------------------------------------|
| `path`   | Virtual path inside the mount point. `:param` placeholders are captured. |
| `list`   | Upstream endpoint returning an array. Each item becomes a child entry.  |
| `read`   | Upstream endpoint returning a single resource. Becomes a file.          |
| `invoke` | `{ method, endpoint }`. Becomes an executable action (trailing `!`).    |
| `id`     | Field name (or function) used to derive child names from list items.    |

To author your own connector, copy `packages/provider-jsonplaceholder/src/index.ts` and rewrite the routes table for your API.

## Repo layout

```
packages/
  core/                          # runtime, path router, policy engine, audit, defineRestProvider DSL
  provider-jsonplaceholder/      # showcase connector (~30 lines)
  cli/                           # `llmfuse` binary (ls, cat, tree, stat, invoke)
  fuse/                          # FUSE adapter + environment probe
apps/
  demo/                          # Next.js + AI SDK chat that runs llmfuse in Vercel Sandbox
```

## Quick start (local)

```bash
pnpm install
pnpm build

# one-shot commands
node packages/cli/dist/bin.js ls /api/users
node packages/cli/dist/bin.js tree /api/users/1 --depth 2
node packages/cli/dist/bin.js cat /api/users/1/metadata.json

# interactive overlay shell — vocab intercepts mounted paths,
# anything else falls through to bash
node packages/cli/dist/bin.js repl

# strict mode: reject anything outside the llm-fuse vocabulary
node packages/cli/dist/bin.js repl --strict
```

### The overlay shell

`llmfuse repl` drops you into a `lfsh>` prompt. The dispatcher routes each line:

- if the command is in the **vocabulary** (`ls`, `cat`, `stat`, `tree`, `invoke`) **and** the first path argument lies under a mount point — the runtime handles it.
- otherwise the line is passed through to `/bin/bash -c '...'`.

```text
lfsh> ls /api/users          # routed to the runtime → JSONPlaceholder
1/  2/  3/  ...
lfsh> ls /tmp                # falls through to bash
...
lfsh> pwd                    # falls through to bash
/Users/.../llm-fuse
lfsh> mode strict            # disable bash fallback
strict mode on (no bash fallback)
lfsh> ls /tmp                # rejected
lfsh: rejected — path is not under a mounted provider (/api) [strict mode]
lfsh> exit
```

This is the model an agent would inhabit inside a sandbox: a normal-looking shell, except the only paths under `/api` are the ones the runtime exposes.

### Real FUSE mount

```bash
node packages/cli/dist/bin.js mount /tmp/llmfuse
# in another terminal:
ls /tmp/llmfuse/api/users
cat /tmp/llmfuse/api/users/1/metadata.json
# Ctrl-C in the first terminal to unmount
```

This requires `fuse-native` + a working FUSE userspace (libfuse on Linux, macFUSE on macOS). See **Validation results** below for which environments actually support it.

## Demo: LLM agent navigating the VFS

`apps/demo` is a Next.js chat (AI SDK v6 + AI Gateway) where the model has a single tool — `llmfuse(command)` — that executes commands inside a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVM.

```bash
cp apps/demo/.env.example apps/demo/.env.local
# fill in AI_GATEWAY_API_KEY, VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
# OR set LLMFUSE_LOCAL_MODE=1 to skip Sandbox and run the CLI in-process

pnpm --filter @llm-fuse/demo dev
```

Try prompts like:

- *"List all users and tell me who lives in the smallest city."*
- *"Read user 1's metadata, then summarize their first post."*
- *"How many photos are in user 2's first album?"*

Each tool call is logged in the UI with the executed shell command, the run mode (`local` vs `sandbox`), and timing.

## The FUSE-vs-shell validation question

`packages/fuse` ships two things:

1. **`buildFuseHandlers(runtime)`** — wraps the `LlmFuseRuntime` as `fuse-native` callbacks (`readdir` / `getattr` / `read`).
2. **`llmfuse-probe`** — a non-destructive environment probe that emits a JSON report on stdout:

```bash
node packages/fuse/dist/probe.js
# optionally attempt a real mount + unmount:
node packages/fuse/dist/probe.js --mount --target /tmp/llmfuse-probe
```

Sample report fields:

- `fuseDevicePresent` — does `/dev/fuse` exist?
- `fuseDeviceReadable` — is it readable/writable by this process?
- `fuseModuleLoaded` — Linux `lsmod | grep fuse`
- `fuseNativePackageInstalled` — did `import("fuse-native")` succeed?
- `mountAttempt` — if `--mount` was passed, was a real mount achievable?
- `verdict` — `fuse_likely | fuse_unlikely | fuse_blocked | unknown`

The demo exposes a `POST /api/probe` route that runs this probe **inside a fresh Vercel Sandbox microVM** and returns its JSON output, so the question "does FUSE work on Vercel Sandbox?" can be answered from the browser.

### Validation results

| Environment                    | Verdict          | Notes                                                                                                |
|--------------------------------|------------------|------------------------------------------------------------------------------------------------------|
| **macOS 25.3 (Apple Silicon)** | `fuse_blocked`   | Two independent blockers (see below).                                                                |
| Linux laptop (libfuse + caps)  | _TBD_            | Expected to work with `fuse-native` + libfuse3 installed.                                            |
| Docker (default caps)          | _TBD_            | Needs `--cap-add SYS_ADMIN --device /dev/fuse` and the host kernel exposing FUSE.                    |
| **Vercel Sandbox (microVM)**   | _TBD_            | The validation we're after — run `POST /api/probe` in the demo app once deployed.                    |
| GitHub Actions runner          | _TBD_            | Default runners block FUSE; usually requires a custom container.                                     |

#### Why macOS Apple Silicon is `fuse_blocked` in practice

Even with macFUSE installed and the user extension approved:

1. **`fuse-native` ships no `darwin-arm64` prebuild.** It only includes `darwin-x64` and `linux-x64` (`node_modules/fuse-native/prebuilds/`). On Apple Silicon, the addon won't load natively — you'd need to run Node under Rosetta or compile from source against macFUSE headers.
2. **The macFUSE kernel extension is not loaded.** `kmutil showloaded | grep fuse` returns nothing on a fresh macFUSE install. Loading it on Apple Silicon requires booting into Recovery, switching to **Reduced Security**, allowing third-party kernel extensions, and rebooting — a setup most developers (and *all* CI agents) won't do.

Conclusion: even on a developer laptop with macFUSE explicitly installed, the FUSE adapter is impractical. This is exactly why the **restricted shell + overlay** is the actual portable surface for LLM agents — not just on serverless, but everywhere.

## Why a VFS, not more tool calls?

A typical LLM agent integration looks like this:

```text
tools: [listObjects, getObject, listActions, getActionSchema, runAction, listDatasets, ...]
```

That surface grows linearly with the API and bloats the model's context. A VFS replaces it with one workspace and one navigation language the model already understands from training:

```text
tools: [llmfuse(command)]
```

The model uses `ls`, `cat`, `tree`, `grep`, `invoke` — primitives it has seen millions of times — and the runtime translates those into upstream API calls. Adding new endpoints means adding rows to the routes table, not new tools.

## Status

This is an early POC, not a production runtime. Not yet shipped:
- multi-provider examples beyond JSONPlaceholder
- a generic `find` / `grep` over provider data
- artifact storage for large outputs
- write/PUT/PATCH on top of the existing `invoke` path
- MCP adapter
- IAM / multi-tenant policies (the policy engine is single-tenant for now)

PRs and connector contributions are welcome.

## License

MIT.
