# Handover — Kubernetes sandbox backend

**Last updated:** 2026-07-25 · **Status:** Plan 4 (skills) complete + final-reviewed (opus, clean — ready to merge). Plan 3 (egress) cluster-validated under real enforcement (via admin creds). Plans 4 & 3 are local-only until pushed. Next: Plan 5 (lifecycle).

## TL;DR

Building a new `kubernetes` sandbox backend for Last Light (the `nearform/lastlight`
monorepo) — for Robin's homelab k8s cluster, and as a potential upstream
contribution. It runs each workflow phase as its own Pod (create → wait-for-start
→ stream JSONL → reap) behind the existing `Sandbox` port, instead of the
in-process QEMU (`gondolin`) backend.

- **Plans 1 + 2 DONE + cluster-validated. Plan 3 (egress) DONE + cluster-validated under real enforcement. Plan 4 (skills) DONE + final-reviewed (opus, clean).**
- Branch: **`feat/k8s-sandbox-backend`** — Plan-3 range `02a912a..d573b42` (pushed to the fork); **Plan-4 range `d573b42..7233d2c`** (12 commits incl. the plan doc), **local-only** — push with `git push origin feat/k8s-sandbox-backend`.
- **Roadmap was SPLIT** (Robin's call, Clifton approved the direction): the old "Plan 3 = egress + skills" became two plans, so the roadmap is now **6 plans**: 1 skeleton, 2 creds, **3 egress (DONE)**, **4 skills (DONE)**, 5 lifecycle, 6 Flux. Every "Plan 4 (lifecycle)" / "Plan 5 (Flux)" reference below that predates this split now means Plan 5 / Plan 6.
- Next: **Plan 5 — lifecycle + concurrency** (`reclaimSandbox(selector)` authority: cron / PR-closed / cancel triggers; quota-backpressure admission; `fsGroupChangePolicy: OnRootMismatch` for reused PVCs; the RWO Multi-Attach edge). Design §6 + §8. Then Plan 6 = Flux manifests (Namespace/SA/Role/RoleBinding/ResourceQuota + the harness Deployment SA) — which turns on egress + `toEndpoints` enforcement AND makes the harness reachable in-cluster so the Plan-4 skill fetch validates end-to-end.
- Plan docs: `plan-2-…`, `plan-3-egress.md`, `plan-4-skills.md`. SDD ledgers are per-plan: `.superpowers/sdd/plan-4-skills/progress.md` (Plan 4 — per-task reviews, 6 fix-loop items, the final-review fix wave, deferred minors). Plan 3's is `.superpowers/sdd/plan-3-egress/progress.md`; Plan 2's is the old flat `.superpowers/sdd/progress.md`.

## Plan 2 — what landed + open follow-ups (tracked, deliberately deferred)

Per-run creds Secret (`envFrom`, inline-env removed) + prompt Secret (mounted file → `agentic-pi` stdin), both ownerRef-patched for cascade-GC; per-`(repo,PR)` RWO PVC + **minimal**-clone initContainer (#107 reuse/refresh/merge-base → Plan 4); PodSecurity-`restricted` securityContext; `sandbox.kubernetes.*` config + registry-qualified **yo61** image. #223 killed by construction. A commit-review HIGH command injection (attacker-named PR branch → `sh -c`) was found + fixed (argv, not shell text). Final opus review: ready to merge, no Critical; I1 (opaque clone-init failure) fixed.

- **RunAgentOpts parity:** k8s `runAgent` currently drops `thinking`/`variant` (silent default reasoning), `profile`, `webSearch`, `skillDirs`. `skillDirs`/`webSearch` are **Plan 4 (skills)**; `thinking`/`profile` are a fast-follow.
- **RWO Multi-Attach edge** (fast next-phase pod on a different node): **Plan 5 (lifecycle)**.
- **Sandbox image: BUILT + public.** `ghcr.io/yo61/lastlight-sandbox:latest` is built (native amd64/linux, `sha256:8b774295…`) and the ghcr package is **public** (cluster pulls anonymously — no imagePullSecret needed). Built by a **fork-only** GitHub Actions workflow `.github/workflows/sandbox-image-yo61.yml` (SHA-pinned, on the fork's `main`; NOT upstreamed). Rebuild after sandbox-source changes: `gh workflow run sandbox-image-yo61.yml --repo yo61/lastlight -f tag=latest` (the `--repo` is required — `gh` defaults to the `nearform` upstream). A local cross-arch build on Apple Silicon does NOT work (QEMU segfaults installing `uv`) — always use the workflow / a native amd64 host.
- **Cluster run: VALIDATED — all 3 integration tests green** (Plan 1 bash; Plan 2 clone-into-PVC; Plan 2 AI phase, prompt via mounted Secret → anthropic → agent_end). Re-validate: `RUN_K8S_IT=1 K8S_SANDBOX_IMAGE=ghcr.io/yo61/lastlight-sandbox:latest ANTHROPIC_API_KEY=… GITHUB_TOKEN=… pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts`.
- **3 cluster-surfaced fixes** (regression-tested): test pod-name collision (unique per-case taskId); init-log-fetch (a failed init container's logs now append to the thrown error); **fsGroup** (truenas-iscsi PVC mounts root-owned → non-root uid 10001 couldn't write; `fsGroup=runAsUser` fixes it — CSIDriver `tns.csi.io` is `fsGroupPolicy: File`, so it's honored).
- **Egress caveat (now handled by Plan 3):** the Plan-2 AI test passed on OPEN egress (Cilium default-allow). Plan 3's strict allowlist is rendered from `egress-allowlist.ts` (`DEFAULT_ALLOWLIST` = GitHub + provider/anthropic + package registries), so the validated clone/AI flows keep working under the policy. Confirmed by construction; enforcement re-validation on-cluster is pending Plan 6 RBAC.
- **Plan 5 (lifecycle) note:** `fsGroup` triggers a recursive volume chown on pod start — slow on a large REUSED PVC; set `fsGroupChangePolicy: OnRootMismatch` when PVC reuse lands.
- **Docs-sync gate** still deferred: backend stays unreachable until **Plan 6 Flux manifests**, so mid-build commits keep bypassing docs-check (`LASTLIGHT_SKIP_DOCS_CHECK=1`); run the `docs-sync` skill only when the whole backend is reachable, before merge.

## Plan 3 — what landed + open follow-ups (egress; final review clean)

Scope was **egress only** (skills split out to Plan 4). A strict/open **`CiliumNetworkPolicy`** pair is rendered from the shared `egress-allowlist.ts` (`k8s/egress-policy.ts`, golden-tested) and applied idempotently once per namespace via a new `CustomObjectsApi` client (`k8s/egress-apply.ts`, create-or-`409`→replace). Each sandbox Pod is stamped `egress-policy: strict|open` (from `this.opts.egress.unrestricted`) — the label the policy's `endpointSelector` matches. **Strict** = a DNS-proxy rule (port 53 → kube-dns with `rules.dns:[{matchPattern:"*"}]`, *load-bearing* — without it `toFQDNs` never resolves) + the allowlist `toFQDNs` on 443/TCP, default-deny else. **Open** = DNS + broad 80/443 minus a private/link-local/loopback SSRF-floor except-list. Opus final review: **clean, no Critical, no security holes** (strict is FQDN-only, the label is unforgeable since pods have no SA token, the ensure-once cache is concurrency- and retry-correct).

- **Enforcement is best-effort until Plan 6.** Applying the CNP needs the `cilium.io/CiliumNetworkPolicy` RBAC verb, which lands with the Flux `Role` in **Plan 6**. Until then `ensureEgress` catches the `403`, logs **one** warning per namespace, and the run proceeds on Cilium default-allow — **no regression** to the validated flows. The identical code enforces the moment RBAC exists. (A non-403 clears the cache + propagates so a later run retries; both branches are unit-tested.)
- **CLUSTER-VALIDATED (2026-07-25, via admin creds).** Ran the full IT suite from a cluster-admin kubeconfig (which *can* create CNPs, unlike the harness SA), so `ensureEgress` applied the real policies and every case ran **under enforcement**: Cilium accepted both CNPs (`VALID=True`, correct `endpointSelector`/DNS-proxy/`toFQDNs` shape incl. github+anthropic+registries); **Plan 3 egress case asserted `github=200` AND `example.com=BLOCKED`** (real block); **Plan 2 `git clone github.com` passed under the strict policy** (proves the allowlist permits real git). Plan 2 AI case skipped (no `ANTHROPIC_API_KEY` this session — but `anthropic.com` is in the applied `toFQDNs`, so the path is allowlisted). The 2 admin-staged CNPs were then **deleted** to restore the "no CNP yet" state — the harness-SA enforcement path still genuinely awaits Plan 6 RBAC; this run validated the *policy itself*, not the harness's ability to apply it. Re-run: `RUN_K8S_IT=1 LASTLIGHT_K8S_NAMESPACE=lastlight-sandboxes K8S_SANDBOX_IMAGE=ghcr.io/yo61/lastlight-sandbox:latest GITHUB_TOKEN=… pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts`.
- **The `toEndpoints` sandbox→harness rule is NOT here** — it ships with its only consumer (the skill fetch) in **Plan 4**, extending the same renderer.
- **Enforcement IT is opt-in + skips gracefully.** A new `RUN_K8S_IT` case curls an allowlisted host (expect 200) and a non-allowlisted host (expect blocked); if the strict CNP wasn't applied (403, no RBAC yet) it `console.warn`s and asserts only the allowlisted side. **Robin: full block-assertion validates only after Plan 6 RBAC lands.**
- **5 parked minors** (final review, all safe-to-defer — see `.superpowers/sdd/plan-3-egress/progress.md`): `strictPolicyPresent` blanket `catch` (log the error); DNS `matchPattern:"*"` leaves a DNS-tunnel channel (same exposure as docker; tracked); the open except-list is cluster-scoped (add a comment naming the pod/service-CIDR dependency if reused elsewhere); the `resourceVersion` double-cast is stylistic; **`strictHosts()` duplicates `egressPolicyFor`'s merge — a Plan 6 egress-consolidation candidate (#134)**.

## Plan 4 — what landed + open follow-ups (skills; final review clean, ready to merge)

Skill delivery over an **authenticated HTTP channel** (design §7). Robin chose HTTP-fetch over a simpler ConfigMap-mount (bundles are tiny — ≤68K text — but the design's server-mode-POST-back reuse justifies the channel). The harness tars each phase's resolved skill dirs into a gzipped `Buffer` (via system `tar` — **no new npm dep**) and registers the bytes under a per-run `randomUUID` token; a new `GET /internal/skill-bundle` bearer-auth route (`k8s/skill-bundle-route.ts`, mounted on the shared Hono app) streams them. A **skills initContainer** (`k8s/init-skills.ts`) `curl`s it with the token (delivered in the creds Secret as `LASTLIGHT_SKILL_TOKEN`, endpoint passed as a positional arg — argv-safe) and unpacks into a shared `skills` emptyDir the agent mounts at `/lastlight-skills`; `runAgent` appends `--skill /lastlight-skills/<name>` per skill (names sanitized `[A-Za-z0-9_-]` → injection-safe). The sandbox→harness hop is a **`toEndpoints`** rule added to *both* egress policies (extends the Plan 3 renderer). Closes the tracked `skillDirs` RunAgentOpts gap. Opus final review: **clean, ready to merge** — the 4 named security risks (auth boundary token-gated 401; `--skill` injection closed via the sanitize chain; token reaches the init via `buildPodManifest`'s `envFrom` overwrite; `runCommand` carries no skills state) all verified + test-pinned.

- **E2E pod→harness fetch is deferred to Plan 6.** The initContainer's fetch needs the harness reachable *from* a sandbox Pod, which only happens once the harness deploys in-cluster (Plan 6). So Plan 4 ships with an **in-process** endpoint round-trip IT (`skill-bundle.integration.test.ts`, ungated — build→register→serve→unpack→assert) that validates the serve+unpack contract NOW; the full pod fetch validates post-Plan-6. Under strict egress the fetch ALSO needs the `toEndpoints` rule live (Plan 6 RBAC) — until then default-allow carries it.
- **New config** (`sandbox.kubernetes.*`, Plan-6-finalized defaults): `harnessEndpoint` (`http://lastlight.lastlight.svc.cluster.local:8644`), `harnessNamespace` (`lastlight`), `harnessPodLabels` (`{app.kubernetes.io/name: lastlight}`) — the URL the init fetches + the `toEndpoints` selector.
- **Deferred minors** (final review, all safe-to-defer — see `.superpowers/sdd/plan-4-skills/progress.md`): the `/internal/` route is bearer-only (Plan 6 supplies the cluster-internal network story); the adapter re-trusts `opts.skillDirs` (defense-in-depth only, matches the docker pattern); `harnessPodLabels` normalization throws on a non-string object value (prior-art consistent). The collision-guard + TTL-docstring items were folded into the fix wave.

## Resume the AI session (paste to a fresh Claude)

> Resume the k8s sandbox backend work. Read, in this repo:
> `docs/plans/kubernetes-sandbox-backend/HANDOVER.md`, `design.md` (esp. §6 lifecycle
> + §8 concurrency), and `.superpowers/sdd/plan-4-skills/progress.md`. Plans 1–4 are
> complete (4 = skills, final-reviewed clean); the roadmap was split so lifecycle is
> now **Plan 5**. Write **Plan 5 (lifecycle + concurrency)** with the
> `superpowers:writing-plans` skill (`reclaimSandbox(selector)` — cron/PR-closed/cancel
> triggers; quota-backpressure admission; `fsGroupChangePolicy: OnRootMismatch` for
> reused PVCs; the RWO Multi-Attach edge), then execute it with
> `superpowers:subagent-driven-development`, same as Plans 1–4. We're on branch
> `feat/k8s-sandbox-backend`.

## Key files

| File | What |
|---|---|
| `docs/plans/kubernetes-sandbox-backend/design.md` | Approved design (8 decisions, security posture, Flux manifests). |
| `docs/plans/kubernetes-sandbox-backend/plan-1-walking-skeleton.md` | Plan 1 (executed) + the roadmap table (originally 5 plans; now 6 after the egress/skills split). |
| `docs/plans/kubernetes-sandbox-backend/plan-3-egress.md` | Plan 3 (executed) — the egress plan. |
| `.superpowers/sdd/plan-3-egress/progress.md` | Plan 3 SDD ledger (per-plan path now). Plan 2's is the old flat `.superpowers/sdd/progress.md`. Survives compaction; trust it + `git log`. |
| `apps/server/src/sandbox/k8s/` | The code: `client.ts`, `naming.ts`, `pod.ts`, `log-stream.ts`, `kubernetes-sandbox.ts`, `secret.ts`, `pvc.ts`, `init-clone.ts`, **`egress-policy.ts`, `egress-apply.ts`** (Plan 3). |
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
- **CNI: Cilium** (`toFQDNs` egress landed in Plan 3 — `CiliumNetworkPolicy` strict/open; enforcement needs the Plan 6 RBAC verb). **ESO** for external secrets.
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
