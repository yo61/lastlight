# Plan 8 — Harness artifact store (pluggable shared-state layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the k8s sandbox backend a way to hand agent-written workspace artifacts (`.lastlight/…`) back to the harness's post-phase handlers, via a harness-owned **`ArtifactStore`** (authority) over a pluggable **`ArtifactBackend`** seam, shipping a **local-durable** backend that lands bytes where the existing handlers already read them.

**Architecture:** The pod tars `.lastlight/` after the agent run and POSTs it to a new bearer-token-gated harness route (mirror of the Plan-4 skill-bundle route, reversed). The route streams it through the `ArtifactStore` (auth, per-run namespace, size caps, traversal guards) into the `LocalArtifactBackend`, which writes to `$STATE_DIR/sandboxes/<taskId>/<repo>/.lastlight/…` — the exact path `post-review.ts`/`verdict-reader.ts` reconstruct. Zero handler changes. The backend seam has an optional `presign()` so a future S3 backend can take the harness out of the byte path with no pod-contract change (designed, not built).

**Tech Stack:** TypeScript (Node 22, ESM), Hono (the shared HTTP app), `@kubernetes/client-node`, system `tar` (no new npm dep — same as Plan 4), `vitest`.

## Global Constraints

- **No `packages/workflow-engine` edits** (dependency invariant, every prior plan). **No changes to `post-review.ts` / `verdict-reader.ts`** — the local backend lands bytes at the path they already read.
- **Design authority:** `docs/plans/kubernetes-sandbox-backend/plan-8-artifact-store-design.md`. Read it. Non-goals: no S3 backend impl (seam + local only), no skills convergence, no `buildAssets: server` for k8s.
- **Mirror the Plan-4 skill-bundle trio** — `apps/server/src/sandbox/k8s/skill-bundle{-route,}.ts` — for the route, the token registry, and the token injection. Same auth model (per-run bearer token in the creds Secret), same `tar` mechanism, same in-memory registry + `evict()` lifecycle.
- **Security:** per-run token scopes access to that run's namespace only; validate every path segment (reuse `assertSafeSegment` from `apps/server/src/state/build-assets.ts` if present, else port it); enforce a max artifact-bundle size (reject 413); stream, never buffer the whole body in heap beyond the size cap. No new egress rule — the sandbox→harness `toEndpoints` rule (Plan 4) already permits this.
- **Absolute imports within a package via the `#src/` alias in tests**; source files use relative imports (repo convention).
- Node 22 ESM. Conventional commits. Commit each task separately.
- Branch: `feat/k8s-artifact-store` (off `main`). Feature branch only.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/sandbox/artifact-backend.ts` (**create**) | `ArtifactBackend` interface + `LocalArtifactBackend` (put/get/list/remove; optional `presign`). | 1 |
| `apps/server/src/sandbox/artifact-store.ts` (**create**) | `ArtifactStore` authority: per-run token→target registry, `register`/`evict`, size cap, `unpackTo` (streamed untar with traversal guards). | 2 |
| `apps/server/src/sandbox/k8s/artifact-upload-route.ts` (**create**) | `POST /internal/sandbox-artifacts` (mirror of `skill-bundle-route.ts`, reversed: reads body, streams to the store). | 3 |
| `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` (**modify**) | Mint the artifact token, inject via creds Secret, register the run's target dir, extend the in-pod script to tar+upload `.lastlight/`, evict on dispose. | 4 |
| `apps/server/src/engine/executors/orchestrator.ts` (**modify**) | Skip `writeAgentsMd` for the k8s backend (the AGENTS.md write-side fix). | 5 |
| `apps/server/src/sandbox/k8s/init-clone.ts` or entrypoint (**modify**) | Deliver `AGENTS.md` pod-side (agent-context) so the agent still gets it on k8s. | 5 |
| `apps/server/src/index.ts` (**modify**) | Mount the route; construct the store + local backend; evict/GC on run completion. | 6 |
| Tests alongside each + `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts` (**modify**) | Unit per component + opt-in `RUN_K8S_IT` end-to-end. | 1–6 |

---

## Task 1: `ArtifactBackend` interface + `LocalArtifactBackend`

**Files:**
- Create: `apps/server/src/sandbox/artifact-backend.ts`
- Test: `apps/server/tests/sandbox/artifact-backend.test.ts`

**Interfaces (Produces):**

```ts
import type { Readable } from "node:stream";

export interface ArtifactBackend {
  /** Stream one artifact's bytes in (proxy mode). `relPath` is run-relative,
   *  already traversal-validated by the store. */
  put(runKey: string, relPath: string, body: Readable): Promise<void>;
  /** Stream one artifact's bytes out (proxy mode / harness self-read). */
  get(runKey: string, relPath: string): Promise<Readable>;
  /** List a run's artifact rel-paths. */
  list(runKey: string): Promise<string[]>;
  /** GC a run's whole namespace. */
  remove(runKey: string): Promise<void>;
  /** OPTIONAL broker capability — return a direct URL the POD uses to bypass the
   *  harness (e.g. S3 pre-signed), or null/omit for proxy mode. Not implemented
   *  by the local backend. */
  presign?(runKey: string, relPath: string, op: "put" | "get"):
    Promise<{ url: string; headers?: Record<string, string> } | null>;
}

/** Local-durable backend. `rootFor(runKey)` maps a run to a host directory; the
 *  store passes a resolver so the root is the SAME dir post-review.ts reads
 *  (`$STATE_DIR/sandboxes/<taskId>/<repo>`). */
export class LocalArtifactBackend implements ArtifactBackend {
  constructor(private readonly rootFor: (runKey: string) => string) {}
  // put/get/list/remove operate under rootFor(runKey); no presign.
}
```

- [ ] **Step 1: Write the failing test**

`apps/server/tests/sandbox/artifact-backend.test.ts` — round-trip against a temp root:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalArtifactBackend } from "#src/sandbox/artifact-backend.js";

const root = mkdtempSync(join(tmpdir(), "ll-artifacts-"));
const backend = new LocalArtifactBackend(() => root);

describe("LocalArtifactBackend", () => {
  it("put then get round-trips bytes under the run root", async () => {
    await backend.put("run-1", ".lastlight/pr-review/findings.json", Readable.from(['{"summary":"ok"}']));
    const out = await backend.get("run-1", ".lastlight/pr-review/findings.json");
    const chunks: Buffer[] = [];
    for await (const c of out) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('{"summary":"ok"}');
    // Landed at the real host path a handler would read:
    expect(readFileSync(join(root, ".lastlight/pr-review/findings.json"), "utf8")).toBe('{"summary":"ok"}');
  });

  it("list enumerates a run's artifacts and remove clears them", async () => {
    await backend.put("run-2", ".lastlight/a.txt", Readable.from(["a"]));
    expect(await backend.list("run-2")).toContain(".lastlight/a.txt");
    await backend.remove("run-2");
    expect(await backend.list("run-2")).toEqual([]);
  });

  it("does not implement presign (proxy-only backend)", () => {
    expect(backend.presign).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pnpm --filter lastlight-core exec vitest run tests/sandbox/artifact-backend.test.ts`) — module not found.

- [ ] **Step 3: Implement `artifact-backend.ts`** — `put` `mkdirSync(dirname, {recursive})` then pipe the stream to a `createWriteStream` (await finished); `get` returns `createReadStream`; `list` walks `rootFor(runKey)` returning rel-paths (empty if absent); `remove` `rmSync(rootFor(runKey)/.lastlight, {recursive, force})` (only the artifact subtree — do NOT delete the whole checkout). Root all paths under `rootFor(runKey)` and resolve-check they stay within it (defense-in-depth even though the store guards too).

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Typecheck + commit** — `pnpm --filter agentic-pi build && pnpm --filter lastlight-core exec tsc --noEmit`; `git commit -m "feat(sandbox): ArtifactBackend interface + LocalArtifactBackend"`.

---

## Task 2: `ArtifactStore` — the authority

**Files:**
- Create: `apps/server/src/sandbox/artifact-store.ts`
- Test: `apps/server/tests/sandbox/artifact-store.test.ts`

**Interfaces:**
- Consumes: `ArtifactBackend` (Task 1). Mirrors `SkillBundleRegistry` (`skill-bundle.ts`) for the token→run registry + `evict`.
- Produces:

```ts
export interface ArtifactStore {
  /** Register a run's upload target; returns the per-run artifact token the pod
   *  presents. `runKey` keys the backend namespace. */
  register(runKey: string): string;
  /** Resolve a bearer token to its runKey (or undefined → the route 401s). */
  resolve(token: string): string | undefined;
  /** Stream a gzipped-tar upload body into the run's namespace via the backend,
   *  enforcing the size cap + per-entry traversal guards. Throws on cap/traversal. */
  unpack(token: string, body: Readable): Promise<void>;
  /** Drop a run's token (called on dispose) — the bytes are GC'd separately. */
  evict(token: string): void;
  /** GC a run's artifacts (backend.remove) — called on run completion. */
  gc(runKey: string): Promise<void>;
}

export function createArtifactStore(backend: ArtifactBackend, opts?: {
  maxBundleBytes?: number;   // default e.g. 16 MiB
  ttlMs?: number;            // lazy backstop, like SkillBundleRegistry
}): ArtifactStore;
```

**Design notes for the implementer:**
- Token registry: reuse `SkillBundleRegistry`'s shape (Map<token,{runKey,expires}>, `randomUUID` token, lazy TTL, `evict`). This is the authority's auth + namespace binding.
- `unpack`: pipe `body` → `gunzip` → `tar -x` into a temp dir with a hard byte cap (count bytes; abort + throw `ArtifactTooLarge` past `maxBundleBytes`), then for each extracted file validate every path segment (`assertSafeSegment`) and `backend.put(runKey, relPath, stream)`. Reject any entry that isn't under `.lastlight/`. (Simplest robust impl: extract to a temp dir under a size-capped read, walk it, guard each rel-path, `put` each; then `rm` the temp dir.)
- Keep the size cap enforced on the *compressed* read as the first line, and optionally on decompressed bytes.

- [ ] **Step 1: Failing tests** — cover: (a) `register`→`resolve` round-trip; an unknown token resolves `undefined`. (b) `unpack` of a small gzipped tar containing `.lastlight/pr-review/findings.json` lands it via the backend (use a fake backend capturing `put` calls, or the `LocalArtifactBackend` over a temp root + assert the file). (c) a tar entry with `../escape` is rejected (throws). (d) a body over `maxBundleBytes` throws `ArtifactTooLarge`. (e) `evict` then `resolve` → undefined.

```ts
// sketch — build a gz tar in-test via execFileSync("tar", ["-czf", ...]) over a temp dir,
// then feed createReadStream(tarPath) to store.unpack(token, body).
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `artifact-store.ts`.**
- [ ] **Step 4: Run — expect PASS** (5 cases).
- [ ] **Step 5: Typecheck + commit** — `git commit -m "feat(sandbox): ArtifactStore authority (token-scoped, size-capped, traversal-guarded)"`.

---

## Task 3: `POST /internal/sandbox-artifacts` route

**Files:**
- Create: `apps/server/src/sandbox/k8s/artifact-upload-route.ts`
- Test: `apps/server/tests/sandbox/k8s/artifact-upload-route.test.ts`

**Interfaces:**
- Consumes: `ArtifactStore` (Task 2).
- Produces: `mountArtifactUpload(app: Hono, store: ArtifactStore): void`, mirroring `mountSkillBundle` (`skill-bundle-route.ts`) but POST:

```ts
export function mountArtifactUpload(app: Hono, store: ArtifactStore): void {
  app.post("/internal/sandbox-artifacts", async (c) => {
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token || !store.resolve(token)) return c.body(null, 401);
    try {
      // Hono/Node stream: convert c.req.raw.body (web ReadableStream) to a Node Readable.
      const body = Readable.fromWeb(c.req.raw.body as import("node:stream/web").ReadableStream);
      await store.unpack(token, body);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof ArtifactTooLarge) return c.body(null, 413);
      // traversal / malformed tar → 400
      return c.body(null, 400);
    }
  });
}
```

- [ ] **Step 1: Failing tests** — build a Hono app + a fake/real store: (a) no token → 401; unknown token → 401. (b) valid token + a small gz-tar body → 204, and the store received the bytes (assert via the backend/temp root). (c) an over-size body → 413. Drive via `app.request("/internal/sandbox-artifacts", { method: "POST", headers, body })`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement the route.** Confirm the Hono web-stream→Node-Readable conversion works in this repo's Hono version (check how other POST routes read bodies; `Readable.fromWeb` is the Node 22 path).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Typecheck + commit** — `git commit -m "feat(sandbox): POST /internal/sandbox-artifacts upload route"`.

---

## Task 4: k8s adapter — mint token, register target, in-pod tar+upload, evict

**Files:**
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`
- Test: `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts` (or the adapter's existing unit test)

**Interfaces:**
- Consumes: `ArtifactStore` (injected into the adapter like `skillRegistry` is). The adapter registers `runKey = this.opts.taskId`; the store's `LocalArtifactBackend` `rootFor(taskId)` must resolve to the SAME dir `post-review.resolveHostRepoDir` uses — `$STATE_DIR/sandboxes/<taskId>/<repo>` (thread the repo subdir: the adapter knows `this.pre?.repo`).

**Steps (mirror the `skillToken` wiring — `kubernetes-sandbox.ts:132,196,350,399`):**
- [ ] **Step 1:** Add `private artifactToken?: string;`. In `runAgent` (before creating the creds Secret), `this.artifactToken = this.artifactStore.register(this.opts.taskId)`. The `rootFor` resolver the store was constructed with (Task 6) maps `taskId` → the host repo dir (using `this.pre?.repo`; pass the repo through when constructing, or register with `(taskId, repoDir)`).
- [ ] **Step 2:** Inject the token into the creds Secret (`kubernetes-sandbox.ts:350`): `credsData = { ...env, ...(skillToken && {LASTLIGHT_SKILL_TOKEN}), LASTLIGHT_ARTIFACT_TOKEN: this.artifactToken }`. (Artifact token is always minted for `runAgent`.)
- [ ] **Step 3:** Extend the in-pod script (`kubernetes-sandbox.ts:268`). Drop the leading `exec` so a post-run step runs, and append a best-effort upload of `.lastlight/` (harness endpoint passed as a positional arg like the skills init does; the token is in the env via `envFrom`):

```sh
# was: exec agentic-pi run --model "$1" ... < PROMPT
agentic-pi run --model "$1" --sandbox none --no-session <skillFlags> < PROMPT ; rc=$?
if [ -d .lastlight ]; then
  tar -czf - .lastlight | curl -sf -X POST \
    -H "Authorization: Bearer $LASTLIGHT_ARTIFACT_TOKEN" \
    --data-binary @- "$HARNESS_ENDPOINT/internal/sandbox-artifacts" || true
fi
exit $rc
```
Interpolate `$HARNESS_ENDPOINT` as a shell arg / env (from `this.harnessEndpoint`), NOT into the script text (argv-safe, same rule as the skills init). Keep the upload best-effort (`|| true`) so a post-run upload hiccup never masks the agent's real exit code. Confirm the sandbox image has `curl` + `tar` (it does — the skills init uses `curl`).
- [ ] **Step 4:** In `dispose` (`kubernetes-sandbox.ts:~618`), `this.artifactStore.evict(this.artifactToken)` alongside the skill-token evict.
- [ ] **Step 5: Tests** — assert (unit, no cluster): the creds Secret data carries `LASTLIGHT_ARTIFACT_TOKEN`; the in-pod script contains the tar+curl upload block and no longer `exec`s (so the upload runs); dispose evicts the token. Mirror the existing adapter unit tests' fake-`apis` construction.
- [ ] **Step 6: Typecheck + commit** — `git commit -m "feat(sandbox): k8s adapter uploads .lastlight/ artifacts after the agent run"`.

---

## Task 5: `AGENTS.md` pod-side delivery (write-side fix)

**Files:**
- Modify: `apps/server/src/engine/executors/orchestrator.ts` (`writeAgentsMd` call site, ~line 166 in `runSandboxedAgent`)
- Modify: `apps/server/src/sandbox/k8s/init-clone.ts` (or the sandbox entrypoint) to write `AGENTS.md` pod-side
- Test: adapter/orchestrator unit tests

- [ ] **Step 1: Failing test** — for `ctx.backend === "kubernetes"`, `runSandboxedAgent` must NOT call `writeFileSync` on a host `AGENTS.md` (assert no ENOENT-warn path / that `writeAgentsMd` is skipped). And the k8s clone init (or entrypoint) writes `AGENTS.md` from the resolved agent-context into the pod workspace.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — guard `writeAgentsMd` to skip when the backend has no host-visible workspace (k8s): simplest is to skip when `ctx.backend === "kubernetes"`. Deliver AGENTS.md pod-side: the clone initContainer already writes into `WORKSPACE_DIR`; add a step that writes `AGENTS.md` from the agent-context (the harness can stage the agent-context text into the creds/prompt channel, or the sandbox image bakes it and the entrypoint cats it — pick the lowest-effort consistent with how agent-context reaches the pod today; document the choice in the report).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -m "fix(sandbox): deliver AGENTS.md pod-side on k8s (skip host writeAgentsMd)"`.

---

## Task 6: Wire it up (index.ts) + opt-in integration test

**Files:**
- Modify: `apps/server/src/index.ts` (mount route; construct store + local backend; GC on completion)
- Modify: `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts` (opt-in IT)

- [ ] **Step 1:** In `index.ts`, construct the store next to the skill registry (~line 30/704):
```ts
import { createArtifactStore } from "./sandbox/artifact-store.js";
import { LocalArtifactBackend } from "./sandbox/artifact-backend.js";
import { mountArtifactUpload } from "./sandbox/k8s/artifact-upload-route.js";
// rootFor mirrors post-review.resolveHostRepoDir: $STATE_DIR/sandboxes/<taskId>/<repo>.
const artifactStore = createArtifactStore(new LocalArtifactBackend(rootForRun /* (taskId)->hostRepoDir */));
mountArtifactUpload(app, artifactStore);
```
Inject `artifactStore` into the k8s adapter wherever `skillBundleRegistry` is wired (the `sandboxFor` factory / adapter construction). GC: call `artifactStore.gc(taskId)` where the run's workspace is reaped (`reapOnSuccess` / cancel), so artifacts don't outlive the run.
- [ ] **Step 2:** Full unit suites green — `pnpm --filter lastlight-core exec vitest run tests/sandbox/ tests/engine/ tests/workflows/` + `tsc --noEmit` + `pnpm turbo run typecheck` (dep-cruiser: no engine edit).
- [ ] **Step 3: Opt-in IT** (`RUN_K8S_IT`, mirrors the existing k8s IT block) — a sandbox run whose command writes `.lastlight/pr-review/findings.json`, then assert the file exists at `$STATE_DIR/sandboxes/<taskId>/<repo>/.lastlight/pr-review/findings.json` on the harness host after the run (the upload round-trip). Gated off without `RUN_K8S_IT`.
- [ ] **Step 4: Commit** — `git commit -m "feat(sandbox): wire ArtifactStore + upload route; GC on run completion"`.

---

## Whole-branch verification

- [ ] `pnpm --filter agentic-pi build && pnpm --filter lastlight-core exec tsc --noEmit` — clean.
- [ ] `pnpm --filter lastlight-core exec vitest run tests/sandbox/ tests/engine/ tests/workflows/` — green.
- [ ] `pnpm turbo run typecheck` — dep-cruiser confirms no `workflow-engine`→core edge (store is server-side only).
- [ ] Confirm **`post-review.ts` / `verdict-reader.ts` are untouched** (`git diff --stat` shows neither).
- [ ] Final whole-branch review (opus), same as Plans 1–6.
- [ ] **Deploy loop:** build a new harness image via the `agent-image-yo61` workflow (from this branch merged to `main`), bump `flux-homelab` `apps/lastlight/deployment.yaml` image tag, reconcile, then re-run a real pr-review on k8s and confirm the review **posts** (post-review reads the uploaded findings).

## Self-review (against the design spec)

- **§2 ArtifactStore authority** → Task 2 (token scoping, size cap, traversal guards, GC). ✓
- **§3 pluggable backend seam** → Task 1 (`ArtifactBackend` + `presign?` optional; `LocalArtifactBackend` proxy-only). ✓
- **§4 pod-facing handoff** → Task 3 (route) + Task 4 (in-pod tar+upload, token injection). Zero handler changes (local backend lands at `resolveHostRepoDir`'s path). ✓
- **§5 AGENTS.md fix** → Task 5. ✓
- **§6 S3 future** → seam only; `presign?` optional on `ArtifactBackend`, documented not implemented. ✓
- **Non-goals** → no S3 impl, no skills convergence, no engine/handler edits. ✓
- **Placeholder scan** → the one deferred decision (exact AGENTS.md pod-side delivery mechanism, Task 5 Step 3) is flagged for the implementer to choose + document, because it depends on how agent-context reaches the pod today (verify in-file); everything else carries concrete signatures + mirror references. ✓
