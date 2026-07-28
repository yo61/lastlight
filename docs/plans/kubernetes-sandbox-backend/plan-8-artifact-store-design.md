# Design: Plan 8 — Harness artifact store (pluggable shared-state layer)

**Date:** 2026-07-27 · **Repo:** `nearform/lastlight` (fork `yo61/lastlight`), `lastlight-core` at `apps/server/`
**Status:** design for review · **Branch:** `feat/k8s-artifact-store` (off `main`, which has Plans 1–6)

## Summary

The `kubernetes` sandbox backend runs the agent in an isolated Pod and streams
its logs, but harness-side post-phase handlers then read agent-written workspace
files from a **local host path that doesn't exist on k8s** — because the k8s
workspace lives only on the Pod's PVC, not on the harness filesystem. Every other
backend (docker/gondolin/none/smol) shares the workspace filesystem with the
harness, so this "read the agent's output file off disk" pattern is an *implicit
shared-state layer* that k8s is the first backend to lack.

This plan makes that shared state **explicit and backend-agnostic**: a
harness-owned **`ArtifactStore`** (the authority over per-run artifact namespaces,
access, and lifecycle) sitting above a **pluggable `ArtifactBackend`** seam. The
sandbox→harness artifact handoff (`.lastlight/`) flows through it. v1 ships a
single **local-durable** backend that lands artifacts at exactly the host path the
existing handlers already read — **zero changes to `post-review.ts` /
`verdict-reader.ts`**. The seam is designed so an **S3/object-store backend** slots
in later with no change to the pod contract or the authority model (documented
here, not implemented).

## Motivation — the observed gap

Live pr-review run on the k8s backend:
```
[executor] Result: success (9 turns, 62s)  [sandbox: kubernetes]
[resume] ▶ pr-review/post-review
[post-review] could not read findings (…/sandboxes/…/.lastlight/pr-review/findings.json): ENOENT
[resume] ◀ pr-review/post-review: FAILED
```
The agent ran fine and wrote `findings.json` — inside the Pod's PVC. `post-review`
(a separate, non-sandboxed phase) reads it from `$STATE_DIR/sandboxes/<taskId>/<repo>/.lastlight/pr-review/findings.json`
on the **harness host**, which is empty on k8s.

**Affected harness-side reads** (all assume a host-shared workspace):
- `apps/server/src/workflows/handlers/post-review.ts` → `.lastlight/pr-review/findings.json` — **fatal** (fails the workflow).
- `apps/server/src/workflows/handlers/verdict-reader.ts` (`fileVerdictReader`) → `reviewer-verdict.md` host-FS fallback — same gap, affects the reviewer loop.
- `apps/server/src/engine/executors/orchestrator.ts` `writeAgentsMd` → **write** side (`AGENTS.md`) — non-fatal (caught + warned), same root cause.

`findings.json` is deliberately git-excluded by the pr-review skill
(`.git/info/exclude`), so it never leaves via the branch push — the shared
filesystem was its only intended transport. This is an unaddressed gap in a
mainline workflow, not a knowingly-deferred one; the design doc's non-goal
("`server` build-asset mode is a fast-follow") is narrower than this bug (a
third, always-on read path in default `repo` mode). See
`docs/plans/kubernetes-sandbox-backend/design.md` §2, §7, Non-goals.

## Design decisions

### 1. The harness is the shared-state authority

The harness is the orchestrator — it owns runs, their lifecycle, and the per-run
token minting. It is therefore the correct **authority** over the shared artifact
state: it defines each run's artifact namespace, brokers access, and owns
retention/GC. "Authority" is distinct from "in the data path": the authority can
mediate the bytes (proxy) **or** broker direct access to a backing store — that's
the pluggable seam (§3).

### 2. `ArtifactStore` — the authority (backend-independent)

A single harness-owned service. Everything policy-bearing lives here, above the
backend seam, so it's identical regardless of where bytes physically land:

- **Per-run namespace.** Keyed by `runKey` (the run's `taskId`); artifacts
  addressed by a run-relative path (e.g. `.lastlight/pr-review/findings.json`).
- **Run-token-scoped auth.** Reuses the per-run token already minted for the
  creds Secret (`LASTLIGHT_SKILL_TOKEN`'s sibling — a new
  `LASTLIGHT_ARTIFACT_TOKEN`, or the same token with an artifact scope). A token
  authorizes access **only** to its own run's namespace.
- **Streaming + bounds.** Uploads/downloads stream to/from the backend; a
  configurable **max artifact size** and a per-run **max total** cap protect the
  harness (never buffer a whole tarball in heap). Reject over-cap with 413.
- **Path-traversal guards.** Every run-relative path segment is validated
  (reuse the `assertSafeSegment`-style guard already used by `BuildAssetStore`);
  a malicious agent cannot escape its run namespace or the sandbox dir.
- **Lifecycle / GC.** The store deletes a run's artifacts when the run completes
  (tied into the existing reap/reclaim path), so artifacts don't accumulate.
- **Observability.** Counts/bytes per run, upload/download outcomes (metrics +
  structured logs), so the layer is operable at scale.

### 3. `ArtifactBackend` — the pluggable broker seam

The one seam. The store delegates *where bytes live* to a backend, and *how the
pod moves them* to a broker decision:

```ts
export interface ArtifactBackend {
  /** Stream bytes in (proxy mode: the harness mediates). */
  put(runKey: string, relPath: string, body: Readable): Promise<void>;
  /** Stream bytes out (proxy mode). */
  get(runKey: string, relPath: string): Promise<Readable>;
  /** Enumerate a run's artifacts. */
  list(runKey: string): Promise<string[]>;
  /** GC a run's whole namespace. */
  remove(runKey: string): Promise<void>;
  /**
   * OPTIONAL broker capability. Return a direct URL (+ headers) the POD can use
   * to PUT/GET this object WITHOUT the harness in the byte path (e.g. an S3
   * pre-signed URL). Return `null` to fall back to proxy mode (put/get above).
   * A backend that omits this (or returns null) is always proxied.
   */
  presign?(
    runKey: string,
    relPath: string,
    op: "put" | "get",
  ): Promise<{ url: string; headers?: Record<string, string> } | null>;
}
```

- **Local-durable backend (v1, shipped).** `put`/`get`/`list`/`remove` operate on
  the harness filesystem, rooted so a run's `.lastlight/…` lands at **exactly**
  `$STATE_DIR/sandboxes/<taskId>/<repo>/.lastlight/…` — the path `post-review.ts`
  / `verdict-reader.ts` already reconstruct. `presign` omitted → always proxy.
  Result: **zero handler changes**; the handlers read what the store wrote.
- **Object-store backend (future, documented not built).** Implements
  `presign` → the store returns the pod a pre-signed PUT/GET URL and the pod
  talks to the store directly (**harness out of the byte path**). `put`/`get`
  remain as a proxy fallback + for the harness's own reads. See §6.

The authority (§2) — auth, scoping, bounds, traversal guards, lifecycle — is the
same for every backend; only the seam swaps.

### 4. Pod-facing contract + the sandbox→harness handoff

The pod uploads its `.lastlight/` artifacts **during the run, before the Pod
terminates** (the Pod is deleted at end of the review phase, one phase before
`post-review` reads — so harvest must happen in-run, not after; there is no
`pods/exec` and no reverse channel today — see design.md §5 security posture).

**v1 (proxy mode):** extend `KubernetesSandbox.runAgent`'s in-pod script so, after
`agentic-pi run` exits, it tars `.lastlight/` (if present) and `curl`s it to a new
harness route:

```
POST /internal/sandbox-artifacts   (bearer: run artifact token)
Body: gzipped tar of the run's .lastlight/ subtree
```
A new Hono route (`apps/server/src/sandbox/k8s/artifact-upload-route.ts`, mirror of
`skill-bundle-route.ts`) authenticates the token → resolves `runKey` → streams the
untar through the `ArtifactStore` (bounds + traversal guards) → the local backend
lands it at the sandbox dir. **No egress-policy change** — the sandbox→harness
`toEndpoints` rule from Plan 4 is L3/L4 and already permits this.

**Forward-compat:** when the object-store backend lands, the in-pod script gains a
broker round-trip first (ask the harness "where do I upload run X?" → the store
calls `backend.presign` → returns a pre-signed URL → the pod PUTs there). v1's
proxy POST is a strict subset; only the in-pod script (which ships in the image,
rebuilt per change anyway) evolves. The route + store + token model are unchanged.

### 5. `AGENTS.md` (the write-side symptom) — fixed here

Fold the non-fatal `AGENTS.md` ENOENT into this plan. On the k8s backend the
harness's `writeAgentsMd` writes to an in-pod path that doesn't exist on the
harness host. Fix by **not** having the harness write AGENTS.md for k8s; instead
deliver it into the Pod alongside the workspace — the clone/skills initContainer
writes `AGENTS.md` from the baked agent-context (mirrors how skills are already
delivered), or the sandbox entrypoint cats agent-context into `$WORKSPACE/AGENTS.md`
(the documented sandbox behavior). Result: the agent runs *with* its
persona/hard-rules context on k8s, and the warning is gone. (Low effort; folded in
because it's the same shared-workspace root cause.)

### 6. Future: the S3/object-store backend (shape only — NOT built in Plan 8)

Documented so the seam is validated against a real second backend:

- **Backend impl** of `ArtifactBackend` over an S3-compatible store (MinIO
  in-cluster, or managed S3/GCS/R2 in cloud-prod). `put`/`get` via the S3 SDK;
  **`presign`** returns per-object pre-signed PUT/GET URLs scoped to the run's
  prefix with a short TTL.
- **Isolation preserved** (the key advantage over an RWX shared volume): each run
  writes only to its own key prefix via a short-lived pre-signed URL — no
  cross-pod visibility, no long-lived creds in the untrusted Pod (same trust
  model as today's skill token).
- **Harness out of the byte path** → scales natively with concurrent Pods.
- **Deltas needed when adopted:** the MinIO Deployment/Service/PVC + a scoped
  egress CNP (sandbox→store) in `flux-homelab`; the in-pod script's broker
  round-trip (§4); handlers optionally read via the store instead of the host
  path. All additive to this plan's seam.

**Decision gate:** whether to actually stand up S3/MinIO is revisited *after*
Plan 8 ships and the seam is proven with the local backend.

## Non-goals (Plan 8)

- **No object-store backend implementation** — seam + local backend only; S3
  shape documented (§6), decision deferred.
- **No skills convergence** — the Plan-4 skill-bundle channel stays as-is; routing
  skills through the same `ArtifactStore` is a **follow-up after Plan 8**.
- **No `buildAssets: server` mode for k8s** — the relocated `../.lastlight/<key>`
  build-asset case stays deferred (design.md's original non-goal); Plan 8 targets
  the always-on `.lastlight/` reads (`findings.json`, `reviewer-verdict.md`).
- **No changes to `packages/workflow-engine`** (dependency invariant, as every
  prior plan) and **no changes to `post-review.ts` / `verdict-reader.ts`**.

## Files (anticipated)

| File | Role |
|---|---|
| `apps/server/src/sandbox/artifact-store.ts` (new) | `ArtifactStore` authority — auth, per-run namespace, bounds, traversal guards, lifecycle; wraps an `ArtifactBackend`. |
| `apps/server/src/sandbox/artifact-backend.ts` (new) | The `ArtifactBackend` interface + `LocalArtifactBackend` (v1). |
| `apps/server/src/sandbox/k8s/artifact-upload-route.ts` (new) | `POST /internal/sandbox-artifacts` (mirror of `skill-bundle-route.ts`). |
| `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` (modify) | In-pod `runAgent` script: tar+upload `.lastlight/` after the run; AGENTS.md delivery fix. |
| `apps/server/src/sandbox/k8s/secret.ts` (modify) | Mint/inject the run artifact token. |
| `apps/server/src/index.ts` (modify) | Mount the upload route; wire the store + local backend; GC on run completion. |
| Tests | Unit: store (auth, scoping, bounds, traversal), local backend, the route; opt-in `RUN_K8S_IT`: a run writes `.lastlight/…`, the store lands it, `post-review` reads it. |

## Testing strategy

- **Unit** — `ArtifactStore`: token scoping (a run's token can't touch another
  run's namespace), size/total caps (413), path-traversal rejection, streaming.
  `LocalArtifactBackend`: put/get/list/remove round-trip lands at the expected
  sandbox path. The route: auth 401, happy-path untar, over-size 413,
  traversal-guard.
- **Opt-in integration** (`RUN_K8S_IT`, mirrors the existing k8s IT pattern) — a
  sandbox run that writes a `.lastlight/pr-review/findings.json`, uploaded via the
  route, then assert the file exists at the host path `post-review` reads (and,
  if feasible, that `post-review` succeeds end-to-end).
- Regression: docker/gondolin/none unaffected (they never call the store — their
  workspace is already host-shared); the handlers are untouched.

## Security posture

- **Run-token-scoped**, per-run namespace; a token opens only its own run's
  artifacts. No new long-lived credential in the Pod (same model as the skill
  token). **Traversal guards** on every path segment; **size/total caps** to
  bound the harness. Proxy mode reuses the existing sandbox→harness `toEndpoints`
  egress rule — **no new network exposure**. The future S3 backend keeps isolation
  via short-lived, prefix-scoped pre-signed URLs (§6).

## Rollback / risk

- Additive and isolated to the k8s adapter + a new harness service; **no handler
  changes, no engine changes**. If the upload path fails, it degrades to today's
  behavior (the post-phase read fails) — no worse than the current state, and the
  agent run itself is unaffected. Requires a new harness image (built via the
  `agent-image-yo61` workflow) + a deployment image-tag bump to deploy, same loop
  proven in the Plan 7 go-live.
