# Design: Kubernetes sandbox backend (`sandbox.backend: kubernetes`)

**Status:** Proposed — pending upstream direction (see [#223](https://github.com/nearform/lastlight/issues/223) discussion, and [#210](https://github.com/nearform/lastlight/issues/210)).
**Date:** 2026-07-24
**Author:** Robin Bowes (with Claude)

## Summary

A new sandbox backend that runs each workflow phase as its own **Kubernetes
Pod**, instead of in a QEMU micro-VM inside the harness process (`gondolin`) or a
`docker run` container (`docker`). The harness becomes a Kubernetes client: it
creates a Pod running `agentic-pi run --sandbox none`, streams the Pod's JSONL
stdout, and reaps it. The Pod itself is the isolation boundary — the same
posture the `docker` backend already uses for a hardened container.

It slots in behind the existing `Sandbox` port (`provision` / `stageSkills` /
`runAgent` / `runCommand` / `dispose`) as a fourth adapter — `KubernetesSandbox`
— beside `DockerSandbox`, `SmolSandbox`, and `InProcessSandbox`. The orchestrator
above the port is unchanged.

## Motivation

Running Last Light on Kubernetes today (Talos/containerd, bare-metal amd64) the
only viable backend is `gondolin` **in-process in the harness pod**, which has
three problems this design removes:

1. **[#223] Per-run credentials leak across concurrent in-process runs.**
   `gondolin`/`none` inject per-run creds by mutating the global `process.env`
   (`applyEnv` in `InProcessSandbox.runAgent`). Concurrent runs interleave on the
   shared global, so one run's agent can read another run's scoped token
   (observed: the `post-review` EISDIR crash and the pr-review 404-wrong-repo).
   A separate Pod has its **own** environment, so this cannot happen by
   construction — no `applyEnv`, no shared global, nothing to race.

2. **[#210] Gondolin isn't first-class on k8s.** The published image ships no
   QEMU, and on containerd there is no docker socket, so neither the default
   `gondolin` nor the `docker` backend works out of the box. A Pod-per-run
   backend needs **neither QEMU nor a docker socket**.

3. **KVM contention caps concurrency.** In-pod QEMU needs `/dev/kvm`
   (`devic.es/kvm: 1`), so concurrent micro-VMs contend for one accelerator —
   the reason `MAX_CONCURRENT_WORKFLOWS=1` is currently forced. Pods are ordinary
   CPU/memory workloads the scheduler spreads across the cluster, with **no
   `/dev/kvm`**, so concurrency is bounded by cluster capacity rather than one
   node's device.

This distributes **sandbox execution** across the cluster. It does *not* make the
harness itself HA — the scheduler, cron, and SQLite state stay single-pod, so
multi-replica HA remains separate future work (shared DB + leader election).

## Non-goals (v1)

- **Not** making the harness HA / multi-replica.
- **Not** `server` build-asset mode (harvest-back). v1 runs `repo` mode (the
  current default), where the agent commits artifacts to the branch and they
  leave via the push to GitHub. `server`-mode harvest-via-HTTP-POST-back is a
  documented fast-follow that reuses the Section 7 channel.
- **Not** replacing `gondolin`/`docker`. This is an additional backend.
- **Not** kernel-level (QEMU) per-run isolation. v1 uses Pod-level isolation,
  matching the `docker` backend's existing posture.

## Architecture overview

```
harness pod (control plane, single replica)
  workflow runner → orchestrator → Sandbox port
                                    └── KubernetesSandbox (new)
                                          │  @kubernetes/client-node (in-cluster)
                                          ▼
   namespace: lastlight-sandboxes  (Flux-managed: NS, SA, Role, RoleBinding, ResourceQuota)
     per phase:
        Secret  (per-run creds, envFrom, ownerRef → Pod)
        Pod     (agentic-pi run --sandbox none)
                  initContainer: fetch skill bundle (HTTP → harness) + clone/refresh workspace
                  main:          run agent, emit JSONL on stdout
                  mounts:        PVC ws-<repo>-pr<N> (RWO, per (repo,PR), reused)
        CiliumNetworkPolicy (generated: strict|open, selected by pod label)
```

One **Pod per phase**. Phases of a run share one `(repo,PR)` PVC (sequential, so
RWO's single-mounter rule holds — the harness's admission already serialises
same-trigger runs). The harness watches the Pod, parses its JSONL log stream
with the *same* parser the `docker` backend uses, and on completion deletes the
Pod (its Secret cascades) while keeping the PVC for reuse.

## Design decisions

### 1. Workspace — per-`(repo,PR)` RWO PVC, reused across pods

Storage on the target cluster is `truenas-iscsi` (democratic-csi), which is
**RWO only** (no RWX). A shared harness↔pod volume is therefore impossible, which
pushes us to a stateless-pod model anyway — the idiomatic k8s choice.

- A PVC named `ws-<owner>-<repo>-pr<N>` (sanitised) is created on first use for a
  `(repo,PR)` and **reused** by later pods for that PR. RWO is satisfied because
  only one sandbox pod for a given PR runs at a time.
- An **initContainer** provisions the workspace on the mounted PVC: `git clone`
  (shallow) on first use, else `git fetch` + `reset --hard` + `clean -fdx -e
  node_modules` — the #107 reuse logic, relocated from host into the pod. Base
  merge-base deepening (for the three-dot PR diff) moves here too.
- Ephemeral (non-PR) workflows get an `emptyDir` workspace, no PVC.

### 2. Execution — bare Pod, JSONL over logs, `repo` mode

- **Bare Pod, not Job.** The workflow runner already owns run lifecycle, retries
  (ledger-driven resume), and cancellation; a Job's retry/backoff/TTL semantics
  would duplicate and fight that. A bare Pod the harness creates/watches/deletes
  keeps one source of truth for "what's running."
- **Data-out = the JSONL stream over the Pod log** (`follow: true`), parsed by
  the existing `docker`-backend parser. A dropped log connection mid-run
  re-attaches from the last-seen point (a reliability detail, not hand-waved —
  see Testing).
- **`repo` build-asset mode** (the current default): the agent commits artifacts
  into the branch and they leave via the push to GitHub. The workspace PVC is
  therefore write-only from the pod side and never read back by the harness — so
  RWO imposes no harvest problem in v1.

### 3. Credentials — per-run Secret + `envFrom`, owner-ref'd to the Pod

Because the pod runs `--sandbox none`, the **model call happens in the pod**, so
the pod needs the provider API key(s) and makes the LLM egress calls itself —
exactly the `docker` backend's posture.

- The harness mints the short-lived scoped `GITHUB_TOKEN` **host-side** (it alone
  holds the App PEM — **hard rule #8**: the PEM never crosses) and writes a
  per-run `Secret` holding `{ GITHUB_TOKEN, GIT_TOKEN, provider keys, OTEL/git
  identity }`.
- The Pod consumes it via `envFrom: [{ secretRef }]`. Each pod → its own Secret →
  its own env → **#223 solved by construction**.
- The Secret carries an `ownerReference` to the Pod, so k8s cascade-GCs it when
  the Pod is deleted (crash-safe); the harness also deletes explicitly on the
  happy path.
- Secrets (not pod-spec env) keep tokens out of `kubectl describe pod` and behind
  their own RBAC verb; encrypted-at-rest if etcd encryption is enabled.

### 4. Egress — harness-generated `CiliumNetworkPolicy`, one source of truth

The allowlist lives in `egress-allowlist.ts` (`GITHUB_HOSTS` + `PROVIDER_HOSTS` +
`PACKAGE_REGISTRY_HOSTS`; leading-dot = apex+subdomain wildcard). The harness
**renders** `CiliumNetworkPolicy` objects from it at boot — the same
generate-from-the-shared-source pattern the `docker` backend uses for its
nginx/coredns configs. No hand-kept second copy.

- **Two policies, selected by a pod label** `egress-policy: strict|open`. `strict`
  = the allowlist FQDNs (`toFQDNs` `matchName` for exact, `matchPattern:
  "*.github.com"` for leading-dot wildcards). `open` = broad, for phases with
  `unrestricted_egress: true`. The harness stamps the label per phase.
- **SSRF floor:** both policies **deny egress to private CIDRs** (LAN + cluster
  pod/service ranges) except FQDN-resolved targets. Cilium's DNS proxy only lets
  a pod connect to an IP it was allowed to *resolve* — closing the private-IP gap
  the `docker` backend's SNI-peek admits it cannot. This is the #134 "unify
  egress behind one seam" convergence on k8s.
- **Harness channel:** a `toEndpoints` rule permits sandbox→harness Service
  **only** (identity-based, not a CIDR hole) for the Section 7 skill fetch.

### 5. Cluster access — client, namespace, least-privilege RBAC

- **Client:** `@kubernetes/client-node` (official). In-cluster:
  `KubeConfig.loadFromCluster()`; local dev: `loadFromDefault()`.
- **Dedicated namespace** `lastlight-sandboxes` (not the harness namespace):
  scoped RBAC blast radius, a single `ResourceQuota` ceiling, and a namespace of
  uniformly-untrusted pods for the NetworkPolicy to bite on.
- **Namespaced least-privilege `Role`** bound to the harness ServiceAccount:

  | Resource | Verbs |
  |---|---|
  | `pods` | create, get, list, watch, delete |
  | `pods/log` | get |
  | `secrets` | create, get, delete |
  | `persistentvolumeclaims` | create, get, list, delete |
  | `cilium.io/CiliumNetworkPolicy` | create, update, get, delete |

  A `Role` (not `ClusterRole`), confined to the namespace. No App-PEM Secret, no
  `exec`, no cluster scope. The RBAC table is the security contract.
- The `Namespace`, `ServiceAccount`, `Role`, `RoleBinding`, and `ResourceQuota`
  are **Flux-managed** (privilege is hand-reviewed, not generated). The harness
  only creates the *ephemeral* Pods/Secrets/PVCs/policies.
- **Two ServiceAccounts, opposite privilege:**
  - the **harness** authenticates as its own SA (set on its Flux-managed
    Deployment; bound to the `Role` above via the `RoleBinding`). The harness
    code never names it — `loadFromCluster()` uses the mounted token — so there
    is nothing to sync in app config.
  - the **sandbox pods** run with **`automountServiceAccountToken: false`**. An
    agent inside a sandbox pod needs no Kubernetes API access, so it gets **no
    token** — a compromised agent cannot talk to the API server at all.
- **Shared name, single source:** the one name both code and manifests need is
  the **namespace**, so it is harness config (`sandbox.kubernetes.namespace`),
  referenced once — never duplicated.

**Adopted rule:** *generate mechanical data (egress), configure shared names
(ns/SA), hand-review privilege (RBAC).*

### 6. Lifecycle & cleanup — one reclaim authority, many triggers

A single idempotent **`reclaimSandbox(selector)`** authority (the k8s analogue of
#106's `reapSandboxWorkspace`, "the single safe-remove authority") lists matching
Pods/PVCs/Secrets, **skips any PVC a live pod mounts**, and deletes the rest. It
is the *only* thing that deletes sandbox objects. Triggers pass selectors:

| Trigger | Selector |
|---|---|
| `sandbox-sweep` cron (existing #106 machinery) | `{ staleByHours, maxIdlePVCs }` — age + LRU |
| `pull_request` closed/merged webhook | `{ repo, pr }` |
| admin cancel | `{ runId }` |

Reuses the existing `cleanup.sandbox.{enabled,retentionHours,maxDirs}` config
(applied to PVCs instead of host dirs) — no new config surface. k8s-native
backstops complement it: Secret owner-ref GC, `activeDeadlineSeconds` (hung-pod
kill from the phase timeout), and the `ResourceQuota` hard ceiling.

### 7. Skill delivery — initContainer fetches the resolved bundle over HTTP

The pod can't see the harness filesystem, and the agent needs skills as real
`--skill <dir>` paths. So:

- The harness serves the **already-resolved** per-phase skill bundle (core *or*
  overlay — resolution stays on the harness) at an authenticated internal
  endpoint.
- An **initContainer** fetches + unpacks it into an `emptyDir` shared with the
  main container. One uniform mechanism for core and overlay; no image rebuild on
  a skill edit.
- Reached via the Section 4 Cilium `toEndpoints` rule (sandbox→harness only). The
  per-run Secret carries a **scoped fetch token** so a pod can pull *only its
  own* bundle.
- This harness↔pod HTTP channel is the same one a future `server`-mode artifact
  POST-back will reuse.

### 8. Concurrency — `ResourceQuota` is the single authority

The `MAX_CONCURRENT_WORKFLOWS=1` KVM workaround is unnecessary here. Rather than
keep an app-level `maxWorkflows` *and* a namespace `ResourceQuota` in sync (two
numbers a human must align — the same bad smell as a hand-kept allowlist), the
**cluster owns the limit**:

- The harness admits freely, attempts the pod create, and treats a **quota
  rejection** (`403 exceeded quota`) as **backpressure**: the run stays queued and
  is retried when a pod completion frees capacity (the harness already observes
  completion when the log stream closes). This reuses the existing "promote
  queued runs as slots free" machinery, re-sourcing the slot signal from
  `countRunning < maxWorkflows` to "did the create succeed."
- The app keeps only an absurdly-high **sanity fuse** (a runaway-loop backstop,
  like the workflow engine's 1000-agent cap) — not a tuned number.
- Scaling is then a one-line Flux edit to the `ResourceQuota`.

## Data flow — one phase, start to finish

1. Runner reaches a phase → orchestrator calls `KubernetesSandbox`.
2. `provision`: ensure the `(repo,PR)` PVC exists (create if absent).
3. Mint the scoped token → create the per-run `Secret`.
4. Generate/ensure the `CiliumNetworkPolicy` pair (idempotent, boot-cached).
5. Create the Pod: `envFrom` the Secret, mount the PVC, label
   `egress-policy: strict|open`, `activeDeadlineSeconds` from the phase timeout,
   `automountServiceAccountToken: false`, initContainers (fetch skills; provision
   workspace), main container `agentic-pi run --sandbox none`.
6. Set the Secret's `ownerReference` to the created Pod.
7. Stream the Pod log (`follow`) → existing JSONL parser → `ExecutionResult` +
   dashboard shim jsonl.
8. On stream close / completion: delete the Pod (Secret cascades); **keep** the
   PVC for reuse. Artifacts already left via the branch push (`repo` mode).
9. Cleanup of PVCs happens later via `reclaimSandbox` (cron / PR-closed / cancel).

## Security posture

- **Hard rule #8 preserved:** only the minted short-lived token crosses into the
  pod; the App PEM never leaves the harness.
- **#223 eliminated:** per-pod environment, no shared global.
- **Least privilege:** namespaced Role, no ClusterRole, no `exec`, no PEM Secret
  access.
- **Egress:** default-deny + FQDN allowlist + private-CIDR SSRF floor (stronger
  than the docker SNI-peek).
- **Blast radius:** a compromised harness SA can only churn disposable pods in one
  namespace, bounded by the `ResourceQuota`.

## Harness config surface (new)

```yaml
sandbox:
  backend: kubernetes
  kubernetes:
    namespace: lastlight-sandboxes           # the only name code + manifests share
    image: ghcr.io/nearform/lastlight-sandbox:<tag>
    storageClassName: truenas-iscsi
    workspaceSize: 5Gi
    # harness SA: from its Deployment (Flux), not app config
    # sandbox pods: automountServiceAccountToken=false (no API token)
    # concurrency: no app cap — the namespace ResourceQuota governs
```

## Flux-managed manifests (in `flux-homelab`)

`Namespace`, `ServiceAccount`, `Role` (the table above), `RoleBinding`,
`ResourceQuota` (CPU/memory/pod-count ceiling). The harness's own Deployment gets
the ServiceAccount + in-cluster RBAC to reach the sandbox namespace.

## Testing strategy

- **Unit:** `KubernetesSandbox` against a faked k8s client (object create/delete
  calls asserted; no real cluster) — mirrors `FakeSandbox`. Egress-policy
  rendering from `egress-allowlist.ts` gets a golden test (like the docker
  config-generation tests).
- **Reclaim:** `reclaimSandbox` selector logic + live-mounter skip, unit-tested
  with a fake lister.
- **Integration (opt-in, gated like `RUN_SANDBOX_IT`):** against a real cluster
  (or `kind`), run a no-AI `type: bash` phase end-to-end — Pod create, log
  stream, PVC reuse across two runs, reclaim.
- **Reliability:** a test that severs the log stream mid-run and asserts
  re-attach + no duplicate/lost events.

## Deferred / future

- **`server` build-asset mode** via HTTP-POST-back over the Section 7 channel.
- **Event-driven cleanup** is already in v1 (the PR-closed trigger into the one
  reclaim authority).
- **Egress-policy generation unification** across all backends (#134) — v1
  already generates the k8s policy from the shared source.
- **Harness HA** (shared DB + leader election) — out of scope; this design
  distributes execution, not the control plane.

## Open questions for upstream

1. In-core backend, or out-of-tree/overlay plugin?
2. Is Pod-level isolation acceptable as the k8s default, or is gondolin's per-run
   kernel isolation a hard requirement for untrusted repos?
3. Does the egress-policy generation belong in the #134 "one seam" work?
