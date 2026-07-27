# Plan 5 — Lifecycle & cleanup (`reclaimSandbox` authority + triggers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `kubernetes` sandbox backend a single idempotent `reclaimSandbox(selector)` cleanup authority (the k8s analogue of #106's `reapSandboxWorkspace`) that lists sandbox Pods/PVCs, **never deletes a PVC a live Pod mounts**, and deletes the rest — driven by the existing sweep cron (age + LRU) and admin-cancel (by run) triggers. Plus the two lifecycle fixes the earlier plans deferred: `fsGroupChangePolicy: OnRootMismatch` for reused PVCs, and a `dispose` that waits for Pod deletion to close the RWO Multi-Attach edge (design §6).

**Architecture:** A new `k8s/reclaim.ts` module owns the *only* code that deletes sandbox objects. It lists Pods + PVCs by the managed-by label, computes the set of PVCs mounted by live (non-terminal) Pods, and deletes what a selector matches minus that live set — idempotent (a 404 on delete is success). Selectors are a discriminated union: `{ kind: "run", runId }` (admin-cancel) and `{ kind: "sweep", staleByHours, maxIdlePVCs }` (the cron: age then LRU). Pods and PVCs gain a `lastlight.io/run-id` label so the run selector can find them. `dispose` becomes wait-for-delete so a next-phase Pod never races the prior Pod's RWO volume release.

**Tech Stack:** TypeScript (ESM, NodeNext), `@kubernetes/client-node@1.4.0` (object-param API — `listNamespacedPod`, `listNamespacedPersistentVolumeClaim`, `deleteNamespaced*` all on `apis.core`), vitest.

## Global Constraints

- **Client API shape:** object-param methods only; `ApiException.code` is the HTTP status. `list*` returns `{ items: [...] }`. No new client wiring — `CoreV1Api` already has list/delete.
- **`reclaimSandbox` is the ONLY thing that deletes sandbox objects** (besides the per-run `dispose`). Idempotent: a `404` on any delete is success, not an error. It NEVER deletes a PVC that a live Pod mounts.
- **"Live" Pod** = `status.phase` is `Pending` or `Running` (not `Succeeded`/`Failed`, and not deletion-timestamped). A PVC is protected iff some live Pod's `spec.volumes[].persistentVolumeClaim.claimName` names it.
- **Selector labels:** Pods and PVCs carry `lastlight.io/run-id: <sanitized runId>` (when a runId is available). The existing `app.kubernetes.io/managed-by: lastlight` label is the "all sandbox objects" selector. Label VALUES must be RFC-1123 (`[a-z0-9A-Z._-]`, ≤63 chars) — sanitize the runId the same way `podNameFor` sanitizes.
- **Reuse the existing cleanup config** — `cleanup.sandbox.{enabled, retentionHours, maxDirs}` (`SandboxCleanupConfig`), applied to PVCs (retentionHours → `staleByHours`, maxDirs → `maxIdlePVCs`). No new config surface.
- **Deferred to a fast-follow (NOT this plan):** the `pull_request` closed/merged webhook trigger. `closed` is in `IGNORED_ACTIONS` today; wiring it needs new connector/router work + repo/PR label plumbing, and the age/LRU sweep already bounds disk — so PR-closed is a *reclaim-sooner optimization*, not a correctness requirement. Call it out; don't build it here.
- **Hard rule #8 / no `process.env` mutation** unchanged.
- **Line length ≤100, functions ≤100 lines / complexity ≤8, absolute imports (source relative `./`/`../`, tests `#src/`), Google-style docstrings.** Commit with `LASTLIGHT_SKIP_DOCS_CHECK=1`. Verify widths with `awk 'length>100{print FILENAME":"FNR" ("length")"}' <files>`.

## Locked decisions

1. **Selector union** (this plan): `ReclaimSelector = { kind: "run"; runId: string } | { kind: "sweep"; staleByHours: number; maxIdlePVCs: number }`. The `{ repo, pr }` selector (PR-closed) is deferred with its trigger.
2. **Reclaim deletes Pods and PVCs; Secrets ride the Pod's ownerRef cascade** (Plan 2) — reclaim does not separately enumerate Secrets. It deletes a matched Pod (its creds/prompt Secrets cascade-GC) and matched idle PVCs.
3. **The sweep cron reclaims k8s objects when the backend is `kubernetes`** — the existing host-dir `sweepSandboxes` has nothing to sweep on k8s (no host clones), so the k8s branch calls `reclaimSandbox({ kind: "sweep", … })` instead.
4. **`dispose` waits for Pod deletion** (bounded poll to 404) before returning — closes the RWO Multi-Attach edge for sequential phases sharing a PVC.
5. **Reclaim is best-effort + logged** — a delete failure on one object logs and continues to the next (never aborts a sweep); the RBAC to list/delete lands with the namespace Role in Plan 7, so on a cluster without it reclaim logs the 403 once and no-ops (like Plan 3's egress apply).

---

## File Structure

- **Create** `apps/server/src/sandbox/k8s/reclaim.ts` — `ReclaimSelector`, `reclaimSandbox(apis, namespace, selector, onWarn?)`, the pure helpers `livePvcClaimNames(pods)` and `pvcsToReclaim(pvcs, selector, live)`.
- **Modify** `apps/server/src/sandbox/k8s/pod.ts` — `lastlight.io/run-id` label (when `runId` set) + `fsGroupChangePolicy: "OnRootMismatch"`.
- **Modify** `apps/server/src/sandbox/k8s/pvc.ts` — `lastlight.io/run-id` label on the PVC.
- **Modify** `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` — thread `runId` into the pod/PVC labels; `dispose` wait-for-delete.
- **Modify** `apps/server/src/cron/sandbox-sweep.ts` (or `src/index.ts` cron registration) — k8s branch calls `reclaimSandbox({ kind: "sweep", … })`.
- **Modify** `apps/server/src/admin/routes.ts` — the cancel route reclaims `{ kind: "run", runId }` when the backend is `kubernetes`.
- Matching tests under `apps/server/tests/sandbox/k8s/` + the cron/admin test files.

---

### Task 1: Selector labels (`run-id`) + `fsGroupChangePolicy`

**Files:**
- Modify: `apps/server/src/sandbox/k8s/pod.ts`, `apps/server/src/sandbox/k8s/pvc.ts`
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` (thread the runId)
- Test: `apps/server/tests/sandbox/k8s/pod.test.ts`, `apps/server/tests/sandbox/k8s/pvc.test.ts`

**Interfaces:**
- Consumes: a `runId?: string` the adapter derives from `this.pre?.runId`.
- Produces:
  - `RUN_ID_LABEL = "lastlight.io/run-id"` (export from `pod.ts` — both pod + pvc reuse it).
  - `PodSpecInput` gains `runId?: string`; when set, `buildPodManifest` adds `[RUN_ID_LABEL]: runId` to `metadata.labels`. The pod `securityContext` gains `fsGroupChangePolicy: "OnRootMismatch"` (unconditional — it only matters when `fsGroup` triggers a chown, which it already does).
  - `buildPvcManifest` gains an optional `runId?: string`; when set, adds `[RUN_ID_LABEL]: runId` to the PVC labels.
  - The adapter passes `runId: this.pre?.runId` to both builders (sanitized — see below).

**Dispatch context:** The runId value must be a valid label value (RFC-1123, ≤63 chars). Add a `sanitizeLabelValue(v)` helper (or reuse the sanitize `podNameFor`/`naming.ts` already applies) — `[^a-zA-Z0-9._-]` → `-`, lowercased, truncated to 63. Apply it where the adapter reads `this.pre?.runId` before passing it to the builders, so both the pod and PVC carry the identical sanitized value (the reclaim run-selector matches on it). `fsGroupChangePolicy` is a field of `V1PodSecurityContext` — add it beside the existing `fsGroup`.

- [ ] **Step 1: Write the failing tests**

`pod.test.ts`:
```ts
import { RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";

describe("buildPodManifest run-id label + fsGroupChangePolicy", () => {
  it("labels the pod with the run id and sets OnRootMismatch when runId is given", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict", runId: "run-42",
    });
    expect(pod.metadata?.labels?.[RUN_ID_LABEL]).toBe("run-42");
    expect(pod.spec?.securityContext?.fsGroupChangePolicy).toBe("OnRootMismatch");
  });
  it("omits the run-id label when no runId, but still sets fsGroupChangePolicy", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    expect(pod.metadata?.labels?.[RUN_ID_LABEL]).toBeUndefined();
    expect(pod.spec?.securityContext?.fsGroupChangePolicy).toBe("OnRootMismatch");
  });
});
```

`pvc.test.ts`:
```ts
import { RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";

it("labels the PVC with the run id when given", () => {
  const pvc = buildPvcManifest({ name: "ws-x", namespace: "ns", storageClassName: "sc", size: "5Gi", runId: "run-42" });
  expect(pvc.metadata?.labels?.[RUN_ID_LABEL]).toBe("run-42");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts tests/sandbox/k8s/pvc.test.ts`
Expected: FAIL — `RUN_ID_LABEL` / `runId` / `fsGroupChangePolicy` missing.

- [ ] **Step 3: Implement**

`pod.ts`: add `export const RUN_ID_LABEL = "lastlight.io/run-id";`, the optional `runId?: string` field, merge the label conditionally into `metadata.labels`, and add `fsGroupChangePolicy: "OnRootMismatch"` to the pod `securityContext`.

`pvc.ts`: `import { RUN_ID_LABEL } from "./pod.js";`, add `runId?: string` to the builder input, and merge the label into the PVC `metadata.labels` when set.

`kubernetes-sandbox.ts`: add a `sanitizeLabelValue` (or reuse the naming sanitizer) and pass `runId: this.pre?.runId ? sanitizeLabelValue(this.pre.runId) : undefined` to both `buildPodManifest` (in `runPod`) and `buildPvcManifest` (in `ensurePvc`).

- [ ] **Step 4: Run tests — PASS.** Then whole k8s dir + tsc.

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/` and `pnpm --filter lastlight-core exec tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/pod.ts apps/server/src/sandbox/k8s/pvc.ts apps/server/src/sandbox/k8s/kubernetes-sandbox.ts apps/server/tests/sandbox/k8s/pod.test.ts apps/server/tests/sandbox/k8s/pvc.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): run-id labels + fsGroupChangePolicy on k8s pods/pvcs"
```

---

### Task 2: `reclaimSandbox(selector)` authority

**Files:**
- Create: `apps/server/src/sandbox/k8s/reclaim.ts`
- Test: `apps/server/tests/sandbox/k8s/reclaim.test.ts`

**Interfaces:**
- Consumes: `K8sApis` (`apis.core` — `listNamespacedPod`, `listNamespacedPersistentVolumeClaim`, `deleteNamespacedPod`, `deleteNamespacedPersistentVolumeClaim`); `ApiException`; `RUN_ID_LABEL`, and the managed-by label constant.
- Produces:
  - `type ReclaimSelector = { kind: "run"; runId: string } | { kind: "sweep"; staleByHours: number; maxIdlePVCs: number }`
  - `livePvcClaimNames(pods: V1Pod[]): Set<string>` — claim names mounted by live (Pending/Running, no deletionTimestamp) pods (pure).
  - `pvcsToReclaim(pvcs: V1PersistentVolumeClaim[], selector: ReclaimSelector, live: Set<string>, now: number): V1PersistentVolumeClaim[]` — pure selection: never returns a PVC whose name is in `live`; for `run` returns those whose `RUN_ID_LABEL` matches; for `sweep` returns those older than `staleByHours` (by `creationTimestamp`), then if more than `maxIdlePVCs` idle PVCs remain, the oldest beyond the cap (LRU). Pure + unit-testable without a client.
  - `reclaimSandbox(apis, namespace, selector, opts?: { now?: number; onWarn?: (m: string) => void }): Promise<{ podsDeleted: number; pvcsDeleted: number }>` — lists pods+pvcs (managed-by label), computes `live`, deletes matched pods (run selector: pods with the runId label; sweep: none — sweep only reclaims idle PVCs) and `pvcsToReclaim`, idempotent (404 = success), best-effort (a per-object failure warns + continues; a `403` on the initial list warns once and returns zeros).

**Dispatch context:** Keep `livePvcClaimNames` and `pvcsToReclaim` PURE (no client) so the selection logic is unit-tested with plain arrays — the `reclaimSandbox` orchestration then just wires list→compute→delete and is tested with a fake `apis`. For the `run` selector, delete both the matching pods AND their PVCs (a cancelled run's pod may still be live — deleting the pod first makes its PVC no longer live, but to keep the pure functions simple, compute `live` from the CURRENT pod list; a cancelled run's own pod counts as live and would protect its PVC — so for the `run` kind, exclude the selector's own pods from the `live` set before computing PVCs). Delete pods before PVCs. Use `deleteNamespacedPod({ name, namespace })` etc. `list` filter: pass `labelSelector: "app.kubernetes.io/managed-by=lastlight"` to `listNamespaced*`.

- [ ] **Step 1: Write the failing test** (pure helpers first, then the orchestration with a fake client)

```ts
// apps/server/tests/sandbox/k8s/reclaim.test.ts
import { describe, it, expect, vi } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { livePvcClaimNames, pvcsToReclaim, reclaimSandbox } from "#src/sandbox/k8s/reclaim.js";
import { RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";

const pod = (o: any) => ({ metadata: { name: o.name, labels: o.labels }, status: { phase: o.phase }, spec: { volumes: o.claims?.map((c: string) => ({ persistentVolumeClaim: { claimName: c } })) ?? [] } });
const pvc = (name: string, ageHrs: number, runId?: string, now = 0) => ({ metadata: { name, labels: runId ? { [RUN_ID_LABEL]: runId } : {}, creationTimestamp: new Date(now - ageHrs * 3600_000) } });

describe("livePvcClaimNames", () => {
  it("collects claims from Pending/Running pods, ignores terminal ones", () => {
    const live = livePvcClaimNames([
      pod({ name: "a", phase: "Running", claims: ["ws-1"] }),
      pod({ name: "b", phase: "Succeeded", claims: ["ws-2"] }),
    ] as any);
    expect(live.has("ws-1")).toBe(true);
    expect(live.has("ws-2")).toBe(false);
  });
});

describe("pvcsToReclaim", () => {
  it("never reclaims a live-mounted PVC", () => {
    const out = pvcsToReclaim([pvc("ws-1", 99)] as any, { kind: "sweep", staleByHours: 1, maxIdlePVCs: 0 }, new Set(["ws-1"]), 0);
    expect(out).toHaveLength(0);
  });
  it("sweep reclaims PVCs older than staleByHours", () => {
    const out = pvcsToReclaim([pvc("old", 5), pvc("new", 0.1)] as any, { kind: "sweep", staleByHours: 1, maxIdlePVCs: 99 }, new Set(), 0);
    expect(out.map((p: any) => p.metadata.name)).toEqual(["old"]);
  });
  it("sweep LRU-evicts the oldest beyond maxIdlePVCs", () => {
    const out = pvcsToReclaim([pvc("o1", 3), pvc("o2", 2), pvc("o3", 1)] as any, { kind: "sweep", staleByHours: 0, maxIdlePVCs: 1 }, new Set(), 0);
    // keep the newest 1, evict the 2 oldest
    expect(out.map((p: any) => p.metadata.name).sort()).toEqual(["o1", "o2"]);
  });
  it("run selector matches the run-id label", () => {
    const out = pvcsToReclaim([pvc("ws-a", 0, "run-42"), pvc("ws-b", 0, "run-99")] as any, { kind: "run", runId: "run-42" }, new Set(), 0);
    expect(out.map((p: any) => p.metadata.name)).toEqual(["ws-a"]);
  });
});

describe("reclaimSandbox", () => {
  it("deletes matched pods + idle PVCs; 404 is success; 403 on list warns + no-ops", async () => {
    const listPods = vi.fn().mockResolvedValue({ items: [pod({ name: "p-42", phase: "Succeeded", labels: { [RUN_ID_LABEL]: "run-42" }, claims: ["ws-42"] })] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("ws-42", 0, "run-42")] });
    const delPod = vi.fn().mockResolvedValue({});
    const delPvc = vi.fn().mockResolvedValue({});
    const apis = { core: { listNamespacedPod: listPods, listNamespacedPersistentVolumeClaim: listPvcs, deleteNamespacedPod: delPod, deleteNamespacedPersistentVolumeClaim: delPvc } } as any;
    const res = await reclaimSandbox(apis, "ns", { kind: "run", runId: "run-42" });
    expect(delPod).toHaveBeenCalledWith(expect.objectContaining({ name: "p-42" }));
    expect(delPvc).toHaveBeenCalledWith(expect.objectContaining({ name: "ws-42" }));
    expect(res).toEqual({ podsDeleted: 1, pvcsDeleted: 1 });

    const warn = vi.fn();
    const apis403 = { core: { listNamespacedPod: vi.fn().mockRejectedValue(new ApiException(403, "no", {}, {})), listNamespacedPersistentVolumeClaim: vi.fn() } } as any;
    const r2 = await reclaimSandbox(apis403, "ns", { kind: "run", runId: "x" }, { onWarn: warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(r2).toEqual({ podsDeleted: 0, pvcsDeleted: 0 });
  });
});
```

- [ ] **Step 2: Run — FAIL** (module missing). **Step 3: Implement `reclaim.ts`** per the Interfaces + Dispatch context. **Step 4: Run — PASS** + tsc clean.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/reclaim.ts apps/server/tests/sandbox/k8s/reclaim.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): reclaimSandbox selector authority (run + sweep)"
```

---

### Task 3: `dispose` waits for Pod deletion (RWO Multi-Attach fix)

**Files:**
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`
- Test: `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts`

**Interfaces:**
- Produces: `dispose()` — after issuing `deleteNamespacedPod`, poll `readNamespacedPodStatus` (or `readNamespacedPod`) until it 404s (pod gone) OR a bounded budget elapses (~30 × 1s), THEN return. So a sequential next-phase Pod on the same RWO PVC never races the prior Pod's volume release.

**Dispatch context:** The adapter already deletes the pod best-effort in `dispose`. Add a `waitForPodGone(name)` bounded poll that treats an `ApiException.code === 404` as "gone" (success) and returns; on budget exhaustion it logs a warning and returns anyway (don't hang the run). Keep the Secret eviction + skill-token eviction that `dispose` already does. Do NOT wait in the pod-create failure path — only on the normal `dispose`.

- [ ] **Step 1: Write the failing test**

```ts
it("dispose waits until the pod is gone (404) before returning", async () => {
  const { apis } = fakeApis();
  // readNamespacedPodStatus: Running once, then 404 (gone)
  let calls = 0;
  apis.core.readNamespacedPodStatus = vi.fn(async () => {
    calls += 1;
    if (calls === 1) return { status: { phase: "Running" } };
    throw new ApiException(404, "gone", {}, {});
  }) as any;
  const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
  await sbx.provision();
  await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
  await sbx.dispose();
  expect(apis.core.deleteNamespacedPod).toHaveBeenCalled();
  expect(calls).toBeGreaterThanOrEqual(2); // polled until 404
});
```

- [ ] **Step 2: Run — FAIL** (dispose doesn't poll). **Step 3: Implement** `waitForPodGone` + call it in `dispose` after the delete. **Step 4: Run whole k8s dir — PASS** + tsc clean.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/kubernetes-sandbox.ts apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "fix(sandbox): dispose waits for pod deletion (RWO Multi-Attach edge)"
```

---

### Task 4: Sweep-cron trigger (age + LRU) for the k8s backend

**Files:**
- Modify: `apps/server/src/cron/sandbox-sweep.ts` **or** `apps/server/src/index.ts` (the cron registration) — locate where `sweepSandboxes` runs and branch on the backend.
- Test: the sweep test file (locate the one covering `sweepSandboxes` / the cron handler).

**Interfaces:**
- Consumes: `reclaimSandbox` (Task 2); `cleanup.sandbox.{retentionHours, maxDirs}`; the resolved backend (`getRuntimeConfig()`'s sandbox backend) + `resolveKubernetesConfig().namespace` + `makeK8sApis()`.
- Produces: when the sandbox backend is `kubernetes`, the sweep handler calls `reclaimSandbox(makeK8sApis(), namespace, { kind: "sweep", staleByHours: retentionHours, maxIdlePVCs: maxDirs })` instead of the host-dir `sweepSandboxes` (k8s has no host clones). The `enabled` gate + schedule are unchanged.

**Dispatch context:** The existing cron handler runs `sweepSandboxes` (host dirs). Add a backend check at the top of the handler: `if (backend === "kubernetes") { await reclaimSandbox(...); return; }` before the host-dir sweep. Read the backend from the runtime config the same way the factory does. Only run the k8s path in-cluster / when a client is available — wrap the `makeK8sApis()` call so an off-cluster dev harness (no kubeconfig) doesn't crash the cron (catch + warn, consistent with reclaim's best-effort posture). Keep the existing host-dir path for docker/gondolin untouched.

- [ ] **Step 1: Write the failing test** — assert that with the backend set to `kubernetes`, the sweep handler invokes `reclaimSandbox` with `{ kind: "sweep", staleByHours: <retentionHours>, maxIdlePVCs: <maxDirs> }` (inject a fake reclaim or fake apis; mirror the existing sweep test's harness). With a non-k8s backend, the host-dir `sweepSandboxes` path still runs.
- [ ] **Step 2: Run — FAIL. Step 3: Implement the branch. Step 4: Run — PASS** + tsc clean.
- [ ] **Step 5: Commit** (`feat(sandbox): sweep cron reclaims idle k8s PVCs (age + LRU)`).

---

### Task 5: Admin-cancel trigger (by run) for the k8s backend

**Files:**
- Modify: `apps/server/src/admin/routes.ts` — the `POST /workflow-runs/:id/cancel` route.
- Test: the admin routes test file (locate the cancel-route test).

**Interfaces:**
- Consumes: `reclaimSandbox` (Task 2); the cancelled run's id; the resolved backend + namespace + `makeK8sApis()`.
- Produces: after the existing cancel bookkeeping, when the backend is `kubernetes`, the route calls `reclaimSandbox(makeK8sApis(), namespace, { kind: "run", runId })` (best-effort — a reclaim failure never fails the cancel response). The host-dir `reapSandboxWorkspace` path stays for the other backends.

**Dispatch context:** The cancel route today reaps the host workspace (`reapSandboxWorkspace`) after killing containers. Add a backend branch: for `kubernetes`, call `reclaimSandbox(..., { kind: "run", runId })`; the run-id must be the SAME sanitized value the pod/PVC labels carry (Task 1) — apply the same `sanitizeLabelValue`. Keep it best-effort (wrap in try/catch + warn) so an unreachable cluster never 500s the cancel. Leave the non-k8s reap path as-is.

- [x] **Step 1: Write the failing test** — a cancel request with the backend set to `kubernetes` invokes `reclaimSandbox` with `{ kind: "run", runId: <sanitized run id> }`; a reclaim throw does NOT fail the cancel (still returns success). Non-k8s backend → the existing reap path.
- [x] **Step 2: Run — FAIL. Step 3: Implement. Step 4: Run — PASS** + tsc clean.
- [x] **Step 5: Commit** (`feat(sandbox): admin-cancel reclaims the k8s run's pod + PVC`).

---

### Task 6: Reclaim integration test (opt-in, cluster)

**Files:**
- Modify: `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts` (opt-in `RUN_K8S_IT`, mirror the existing gated block style).

**Interfaces:** Consumes the real `reclaimSandbox` + `makeK8sApis` against the cluster.

**Dispatch context:** A gated end-to-end case: (1) provision a PVC-backed sandbox with a known runId, run a trivial `type: bash` phase, dispose; (2) assert the PVC exists (labelled with the run-id); (3) call `reclaimSandbox(makeK8sApis(), ns, { kind: "run", runId })`; (4) assert the PVC is gone. A second sub-case proves the live-skip: create a PVC-backed pod that stays live (a `sleep`), call `reclaimSandbox({ kind: "sweep", staleByHours: 0, maxIdlePVCs: 0 })`, and assert the live pod's PVC survived (was skipped). Dispose/clean up in a `finally`. Skip gracefully if the list 403s (no RBAC yet — Plan 7), same pattern as Plan 3's egress IT.

- [ ] **Step 1: Write the gated case(s).** **Step 2: Robin runs `RUN_K8S_IT=1 … vitest run …/kubernetes.integration.test.ts`** — reclaim-by-run deletes the PVC; the live-skip case leaves the mounted PVC. Skips if RBAC absent. **Step 3: Commit** (`test(sandbox): opt-in k8s reclaim IT (run-delete + live-skip)`).

---

## Self-Review

**Spec coverage (design §6):**
- "single idempotent `reclaimSandbox(selector)` authority … lists matching Pods/PVCs/Secrets, skips any PVC a live pod mounts, deletes the rest" → Task 2 (`reclaimSandbox` + `livePvcClaimNames` + `pvcsToReclaim`; Secrets via the Pod ownerRef cascade, Locked #2).
- Trigger: `sandbox-sweep` cron `{ staleByHours, maxIdlePVCs }` → Task 4.
- Trigger: admin cancel `{ runId }` → Task 5.
- Trigger: `pull_request` closed `{ repo, pr }` → **deferred with reasoning** (Global Constraints) — the sweep bounds disk; PR-closed is a reclaim-sooner optimization needing new webhook wiring.
- "Reuses `cleanup.sandbox.{enabled,retentionHours,maxDirs}`" → Task 4 (retentionHours→staleByHours, maxDirs→maxIdlePVCs).
- Plan-note `fsGroupChangePolicy: OnRootMismatch` → Task 1.
- RWO Multi-Attach edge → Task 3 (`dispose` wait-for-delete).
- Testing (design): reclaim selector + live-mounter skip unit-tested with a fake lister (Task 2); opt-in integration reclaim (Task 6).

**Placeholder scan:** the cron (Task 4) and admin (Task 5) test files are named "locate the file" because they're existing suites — the implementer greps the one covering `sweepSandboxes` / the cancel route (the research map names `sandbox-sweep.ts` + `admin/routes.ts` `POST /workflow-runs/:id/cancel`). All code steps carry real code or a precise spec.

**Type consistency:** `RUN_ID_LABEL` (Task 1, exported from `pod.ts`) is the same constant `pvc.ts` (Task 1) and `reclaim.ts` (Task 2) match on. `ReclaimSelector` (Task 2) is the same shape Tasks 4 (`sweep`) and 5 (`run`) construct. The sanitized runId is identical on the pod label (Task 1), the PVC label (Task 1), and the cancel selector (Task 5).

**Deferred / not in this plan (tracked):**
- The `pull_request` closed/merged webhook trigger + its `{ repo, pr }` selector (needs un-ignoring `closed` + repo/PR label plumbing) — fast-follow; the sweep is the disk-bound net.
- Full reclaim RBAC (list/delete verbs) lands with the namespace Role in **Plan 7 (Flux)** — until then reclaim logs a 403 once and no-ops; the IT skips.
- Concurrency / quota-backpressure (§8) is now its own plan (**Plan 6**), per the split.
