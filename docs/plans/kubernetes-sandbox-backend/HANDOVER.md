# Handover — Kubernetes sandbox backend

**Last updated:** 2026-07-25 · **Status:** Plan 2 complete + final-reviewed (opus). Not yet cluster-run on Plan-2 paths.

## TL;DR

Building a new `kubernetes` sandbox backend for Last Light (the `nearform/lastlight`
monorepo) — for Robin's homelab k8s cluster, and as a potential upstream
contribution. It runs each workflow phase as its own Pod (create → wait-for-start
→ stream JSONL → reap) behind the existing `Sandbox` port, instead of the
in-process QEMU (`gondolin`) backend.

- **Plan 1 (walking skeleton) DONE + cluster-validated. Plan 2 (creds + workspace + prompt) DONE + final-reviewed.**
- Branch: **`feat/k8s-sandbox-backend`** — Plan-2 range `0dc9b9d..4ced0ac` (9 commits), **local-only (NOT pushed)**.
- Next: **Plan 3** (egress `CiliumNetworkPolicy` from `egress-allowlist.ts` + HTTP skill-bundle fetch + `toEndpoints`).
- Plan-2 doc: `plan-2-creds-workspace.md`. SDD ledger: `.superpowers/sdd/progress.md` (per-task reviews, the security fix, the I1 fix, all tracked follow-ups).

## Plan 2 — what landed + open follow-ups (tracked, deliberately deferred)

Per-run creds Secret (`envFrom`, inline-env removed) + prompt Secret (mounted file → `agentic-pi` stdin), both ownerRef-patched for cascade-GC; per-`(repo,PR)` RWO PVC + **minimal**-clone initContainer (#107 reuse/refresh/merge-base → Plan 4); PodSecurity-`restricted` securityContext; `sandbox.kubernetes.*` config + registry-qualified **yo61** image. #223 killed by construction. A commit-review HIGH command injection (attacker-named PR branch → `sh -c`) was found + fixed (argv, not shell text). Final opus review: ready to merge, no Critical; I1 (opaque clone-init failure) fixed.

- **RunAgentOpts parity:** k8s `runAgent` currently drops `thinking`/`variant` (silent default reasoning), `profile`, `webSearch`, `skillDirs`. `skillDirs`/`webSearch` are Plan 3; `thinking`/`profile` are a fast-follow.
- **RWO Multi-Attach edge** (fast next-phase pod on a different node): Plan 4 lifecycle.
- **Sandbox image: BUILT + public.** `ghcr.io/yo61/lastlight-sandbox:latest` is built (native amd64/linux, `sha256:8b774295…`) and the ghcr package is **public** (cluster pulls anonymously — no imagePullSecret needed). Built by a **fork-only** GitHub Actions workflow `.github/workflows/sandbox-image-yo61.yml` (SHA-pinned, on the fork's `main`; NOT upstreamed). Rebuild after sandbox-source changes: `gh workflow run sandbox-image-yo61.yml --repo yo61/lastlight -f tag=latest` (the `--repo` is required — `gh` defaults to the `nearform` upstream). A local cross-arch build on Apple Silicon does NOT work (QEMU segfaults installing `uv`) — always use the workflow / a native amd64 host.
- **Cluster run of Plan-2 paths NOT yet done.** Validate: `RUN_K8S_IT=1 K8S_SANDBOX_IMAGE=ghcr.io/yo61/lastlight-sandbox:latest ANTHROPIC_API_KEY=… GITHUB_TOKEN=… pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts`.
- **Docs-sync gate** still deferred: backend stays unreachable until Plan 5 Flux manifests, so mid-build commits keep bypassing docs-check (`LASTLIGHT_SKIP_DOCS_CHECK=1`); run the `docs-sync` skill only when the whole backend is reachable, before merge.

## Resume the AI session (paste to a fresh Claude)

> Resume the k8s sandbox backend work. Read, in this repo:
> `docs/plans/kubernetes-sandbox-backend/HANDOVER.md`, `design.md`,
> `plan-1-walking-skeleton.md`, and `.superpowers/sdd/progress.md`. Plan 1 is
> complete and cluster-validated. Write **Plan 2** with the `superpowers:writing-plans`
> skill (scope in the handover), then execute it with
> `superpowers:subagent-driven-development`, same as Plan 1. We're on branch
> `feat/k8s-sandbox-backend`.

## Key files

| File | What |
|---|---|
| `docs/plans/kubernetes-sandbox-backend/design.md` | Approved design (8 decisions, security posture, Flux manifests). |
| `docs/plans/kubernetes-sandbox-backend/plan-1-walking-skeleton.md` | Plan 1 (executed) + the 5-plan roadmap table. |
| `.superpowers/sdd/progress.md` | SDD ledger — every task, all review findings, the 3 cluster fixes, Plan-2 deferrals. Survives compaction; trust it + `git log`. |
| `apps/server/src/sandbox/k8s/` | The code: `client.ts`, `naming.ts`, `pod.ts`, `log-stream.ts`, `kubernetes-sandbox.ts`. |
| `apps/server/src/sandbox/sandbox.ts` | The `sandboxFor` factory wiring + exported `parseLine`. |
| `apps/server/tests/sandbox/k8s/` | Unit tests + the opt-in integration test. |

## What Plan 1 built

`KubernetesSandbox` behind the `Sandbox` port: creates a Pod, **waits for the
container to start**, streams its JSONL stdout through the shared `parseLine`
path (same as the docker backend), reads the **real** container exit code, reaps.
Tokenless pods (`automountServiceAccountToken: false`), client pinned at
`@kubernetes/client-node@1.4.0`, exhaustive factory switch (no `default`).

- **`runCommand` works end-to-end** (a `type: bash` phase — validated on-cluster).
- **`runAgent` is a deliberate stub** (decision "A"): it creates/streams/reaps but
  does NOT deliver the prompt to the container yet — that needs stdin/attach,
  which is coupled to Plan 2's creds/config channel.

## Validate the skeleton (Robin's cluster)

```bash
kubectl delete pods --all -n lastlight-sandboxes        # clear orphans first
RUN_K8S_IT=1 \
  LASTLIGHT_K8S_NAMESPACE=lastlight-sandboxes \
  K8S_SANDBOX_IMAGE=alpine:latest \
  pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts
```

Prereqs: `kubectl config current-context` = `admin@homelab`; the namespace exists
(`kubectl create ns lastlight-sandboxes`); deps built (`pnpm install &&
pnpm --filter agentic-pi build`). Unit tests (no cluster):
`pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/`. Typecheck:
`pnpm --filter agentic-pi build && pnpm --filter lastlight-core exec tsc --noEmit`.

## Three real-cluster gotchas ALREADY FIXED (don't reintroduce)

1. **`loadFromCluster()` does not throw off-cluster** in 1.4.0 — it builds
   `https://undefined:undefined` → "Invalid URL". We detect in-cluster via the
   `KUBERNETES_SERVICE_HOST` env (`inClusterConfigAvailable`), not by catching.
2. **The kubelet log endpoint 400s before the container starts** — `waitForContainerStart`
   polls until running/terminal (fast-fails `ImagePullBackOff` with the real reason).
3. **Pod names are deterministic** → the integration test uses a unique per-run
   `taskId` + `dispose()` in a `finally` so a failure never orphans a pod (→ 409).

## Cluster specifics (Talos)

- kubeconfig context `admin@homelab`, API server `https://192.168.20.9:6443`.
- **Storage: `truenas-iscsi` (democratic-csi) — RWO only, no RWX.** This is why the
  workspace design is per-`(repo,PR)` RWO PVC (design B), not a shared volume.
- **CNI: Cilium** (`toFQDNs` egress lands in Plan 3). **ESO** for external secrets.
  **generic-device-plugin** advertises `devic.es/kvm` (irrelevant to this backend —
  no KVM needed).
- **Namespace `lastlight-sandboxes` enforces PodSecurity `restricted`** — currently
  **WARN** (pods still create), so it doesn't block Plan 1. Plan 2 must add a
  compliant `securityContext` (see below) before it can go to *enforce*.
- **The sandbox image lives in the `yo61` org** (`ghcr.io/yo61/lastlight-sandbox`),
  NOT nearform. Plan 1's integration test overrides it via `K8S_SANDBOX_IMAGE`
  (used `alpine:latest` to validate the mechanism with zero image dependency).

## Plan 2 scope (no new brainstorm needed — from design.md + cluster findings)

1. **Per-run `Secret` + `envFrom`**, owner-referenced to the Pod → and **REMOVE the
   inline-env path** (`pod.ts` currently puts `env` inline, visible via `kubectl get
   pod -o yaml`; the final review flagged this). Only the minted token crosses
   (hard rule #8).
2. **Per-`(repo,PR)` RWO PVC** (design B) + an **initContainer** that clones /
   `fetch`+`reset` the repo (the #107 reuse logic, relocated into the pod).
3. **`runAgent` prompt delivery** via the container's stdin (attach) or a mounted
   prompt file (the deferred "decision A" stub).
4. **`securityContext`** for PodSecurity `restricted`: pod `runAsNonRoot: true` +
   `seccompProfile.type: RuntimeDefault`; container `allowPrivilegeEscalation: false`
   + `capabilities.drop: ["ALL"]`; plus a **config-driven `runAsUser`** (image-dependent
   — alpine≈any nonzero, the real `lastlight-sandbox` image's `agent` user is uid 10001).
   *(New — surfaced by the cluster.)*
5. **Registry-qualified `K8S_SANDBOX_IMAGE` config** on the `sandboxFor` factory path
   (today it defaults to the docker-local tag `lastlight-sandbox:latest` →
   `ImagePullBackOff` on a real cluster; the factory path is a dead path until this
   lands). Default to the **yo61** org. *(New — Robin flagged it.)*

## Deferred / tracked minors (from reviews — for a later fix-wave)

- `awaitPodResult` budget-exhaustion fallback hardcodes `timedOut:false` (rare: pod
  timed out AND status never syncs within ~8s).
- `#4` single-slot `activePod` / same pod-name for `runAgent`+`runCommand` (fine at
  one-pod-per-phase; revisit if Plan 2 adds init/attach phases on one instance).
- `#5` redundant `opts.imageName ?? cfg.image` re-derivation (cosmetic).

## How we work (process)

- **Flow:** brainstorm (done) → `superpowers:writing-plans` → `superpowers:subagent-driven-development`.
- **SDD mechanics:** scripts live at the skill dir
  (`~/.claude/plugins/cache/claude-plugins-official/superpowers/6.1.1/skills/subagent-driven-development/scripts/`):
  `task-brief PLAN N` and `review-package BASE HEAD`. Templates: `implementer-prompt.md`,
  `task-reviewer-prompt.md`, and `../requesting-code-review/code-reviewer.md`.
- **Per task:** fresh implementer subagent (from a task-brief file) → task review
  (spec + quality) → fix loop on Critical/Important → mark complete in the ledger.
  Final whole-branch review (opus) at the end. Model tiers: haiku for transcription,
  sonnet for integration/verification, opus for the final review.
- **Docs:** every mid-build commit bypasses the docs-sync hook (`LASTLIGHT_SKIP_DOCS_CHECK=1`)
  — "no phantom features" while the backend is unreachable. **BRANCH-FINISH GATE:**
  run the `docs-sync` skill (CLAUDE.md Environment/backends, `spec/09-sandbox.md`,
  `spec/02-configuration.md`) once the backend is functional, before any merge.

## Locked constraints / principles

- **One source of truth:** *generate* mechanical data (egress from `egress-allowlist.ts`),
  *configure* shared names (namespace), *hand-review* privilege (RBAC).
- `repo` build-asset mode (no harvest). **Bare Pod**, not Job. **`ResourceQuota` is the
  concurrency authority** (harness treats quota-rejection as backpressure). Single
  `reclaimSandbox(selector)` cleanup authority (cron / PR-closed / cancel).
- **Hard rule #8:** the App PEM never enters a sandbox — only the minted token.
  **No `process.env` mutation** in the backend (that's the whole point of #223).
- Use **contributory-factors** language, never "root cause" (Robin's rule + skill).

## Other open threads (separate from k8s — mostly upstream's court)

- **pr-review cron repair:** `flux-homelab#69` merged (`MAX_CONCURRENT_WORKFLOWS=1`).
  Upstream PRs on `nearform/lastlight`: **#222** (the cron migration off `mode:scan`),
  **#216** (token-scope diagnostic), **#221** (superseded by #222). Issue **#223**
  (the `process.env` credential race) carries the k8s-backend direction comment —
  **awaiting Clifton's steer** (in-core vs plugin; pod-level vs kernel isolation).
  We are contributors, **not maintainers** — we cannot merge upstream.
- **When #222 merges:** close #221 (superseded), update/close #213, and revert the
  temp flux image pin `3651072` → a release tag.
- **SQLite-recovery runbook:** tracked by `flux-homelab#66`, to be written in
  `../homelab-docs`.

## If you want the branch backed up

It's local-only. To back it up to the fork: `git push -u origin feat/k8s-sandbox-backend`
(a feature branch — never push to `main`).
