# Plan 6 — Concurrency / quota-backpressure (k8s sandbox backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Kubernetes `ResourceQuota` — not an app-level `maxWorkflows` number — the concurrency authority for the k8s sandbox backend, by admitting freely and treating a pod-create `403 exceeded quota` as backpressure (requeue the run, retry when capacity frees).

**Architecture:** A pod-create quota rejection is caught deep in `KubernetesSandbox` and rethrown as a typed `QuotaExceededError`. The orchestrator's existing converged catch stamps it as a distinct `stopReason: "error_quota"` on the `ExecutionResult` (everything else — shim, telemetry, artifact harvest — unchanged). The server runner's per-run agent/command port wrapper notices that stop reason and flags the run; `runWorkflow` returns `backpressure: true`. `runSimpleWorkflow` / `resumeSimpleRun` then transition the run `running → queued` (via a new `requeueRunning` store method) instead of `finishRun("failed")`. The existing `AdmissionController` promotes it again as slots free — but in k8s mode it gates on an absurdly-high **sanity fuse** (not `maxWorkflows`) and promotes **one run per invocation** (each promote is a probe; a still-full quota re-403s and re-queues). Dispatch in k8s mode also gates on the fuse, so fresh runs admit freely. **Zero changes to the `lastlight-workflow-engine` package** — the backpressure flag is a server-side intersection on the returned `WorkflowResult`.

**Tech Stack:** TypeScript (Node 22, ESM), `@kubernetes/client-node@1.4.0`, `vitest`, SQLite (`better-sqlite3` via the state store), the existing `EnginePorts`/`runWorkflowCore` engine seam.

## Global Constraints

- **Node** 22 LTS, ESM only (`"type": "module"`); absolute imports only within a package — no `..` relative paths across package boundaries.
- **Do NOT edit `packages/workflow-engine/`.** The dep-cruiser gate forbids an edge from the engine back to core; the backpressure concept stays entirely in `lastlight-core`. `WorkflowResult` gains `backpressure` only as a server-side TypeScript **intersection** at the `runWorkflow` boundary.
- **The k8s concurrency limit is NOT a tuned app number.** The app keeps only an absurdly-high sanity fuse (`K8S_SANITY_FUSE = 1000`, a hardcoded runaway-loop backstop, mirroring the workflow engine's 1000-agent cap). Never read the cluster's `ResourceQuota` value into the app (design.md §8: "the cluster owns the limit").
- **k8s mode discriminator** everywhere is `config.sandbox === "kubernetes"` (the run-level backend string already threaded through `runSimpleWorkflow`/`resumeSimpleRun`).
- **`stopReason` is a plain `string`** (`packages/workflow-engine/src/core/types.ts:233`) — the new value `"error_quota"` needs no union edit.
- Every mid-build commit bypasses the docs-sync hook with `LASTLIGHT_SKIP_DOCS_CHECK=1` (the backend stays unreachable until Plan 7). Run the `docs-sync` skill only at branch-finish, before merge.
- Enforcement of a real `ResourceQuota` requires the Flux manifests in **Plan 7**. Until then this plan is **build + unit-tested**, plus one opt-in integration test that stages a quota via admin creds (the same pattern Plan 3 used to validate CNPs before RBAC landed).
- Branch: `feat/k8s-sandbox-backend`. Feature branch only — never push to `main`.

---

## File structure (what each task touches)

| File | Responsibility | Task |
|---|---|---|
| `apps/server/src/sandbox/k8s/quota.ts` (**create**) | `QuotaExceededError` class + `isQuotaExceeded(err)` predicate (403 + `exceeded quota` message). | 1 |
| `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` (**modify**, `createPodOrCleanupSecrets` ~436) | Throw `QuotaExceededError` on a quota-403; rethrow every other error unchanged. | 1 |
| `apps/server/src/state/workflow-run-store.ts` (**modify**, near `requeue` ~539) | New `requeueRunning(id)`: CAS `running → queued`, re-stamp `started_at`. | 2 |
| `apps/server/src/engine/executors/orchestrator.ts` (**modify**, catch ~239 + `runSandboxedCommand` catch) | Stamp `stopReason: "error_quota"` when the caught error is a `QuotaExceededError`. | 3 |
| `apps/server/src/workflows/runner.ts` (**modify**, `defaultAgentPort` ~142, `runWorkflow` ~184, ports wiring ~377) | Per-run agent/command port wrapper that flags `error_quota`; `runWorkflow` returns `backpressure: true`. | 4 |
| `apps/server/src/workflows/simple.ts` (**modify**, dispatch gate ~332, terminal block ~540) | k8s dispatch gate uses the fuse; terminal block requeues on `backpressure`. | 5 |
| `apps/server/src/workflows/resume.ts` (**modify**, terminal block ~319) | Resume path requeues on `backpressure` instead of `finishRun("failed")`. | 5 |
| `apps/server/src/workflows/admission.ts` (**modify**, `createAdmissionController` ~49, `admitNext` ~54) | k8s backpressure mode: fuse gate + one-promote-per-invocation. `K8S_SANITY_FUSE` constant. | 6 |
| `apps/server/src/index.ts` (**modify**, dispatch `finally` ~675, `createAdmissionController` call ~846) | Skip event-driven `admitNext` when the settled dispatch was itself a backpressure requeue; pass `backpressureMode`. | 6 |
| `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts` (**modify**) | Opt-in quota-backpressure IT (admin-staged `ResourceQuota`). | 7 |
| `apps/server/spec/09-sandbox.md`, `apps/server/spec/06-workflow-engine.md` (**modify**) | Document the k8s concurrency model. | 7 |

---

## Task 1: `QuotaExceededError` + quota-403 detection in the pod-create path

**Files:**
- Create: `apps/server/src/sandbox/k8s/quota.ts`
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts:436-448` (`createPodOrCleanupSecrets`)
- Test: `apps/server/tests/sandbox/k8s/quota.test.ts` (create)

**Interfaces:**
- Produces: `class QuotaExceededError extends Error { readonly name = "QuotaExceededError"; constructor(message: string) }` and `function isQuotaExceeded(err: unknown): boolean` — both exported from `apps/server/src/sandbox/k8s/quota.ts`.
- `isQuotaExceeded` returns `true` iff `err instanceof ApiException && err.code === 403` **and** the error's message/body contains `exceeded quota` (case-insensitive). An RBAC 403 (`... cannot create resource ...`) and a `409` return `false`.

**Background (read first):** A `ResourceQuota` rejection from the API server is HTTP 403 with a message like `pods "sandbox-..." is forbidden: exceeded quota: sandbox-quota, requested: pods=1, used: pods=5, limited: pods=5`. An RBAC 403 is also `Forbidden` but reads `... is forbidden: User "..." cannot create resource "pods" ...`. The only reliable discriminator is the `exceeded quota` substring. `@kubernetes/client-node@1.4.0`'s `ApiException` exposes `.code` (HTTP status, already used at `kubernetes-sandbox.ts:168,223`) and `.body` (the parsed `V1Status`, whose `.message` carries the human text). `ApiException` is generic (`ApiException<T>`); read the message defensively from both `err.body?.message` and `err.message`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/sandbox/k8s/quota.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { QuotaExceededError, isQuotaExceeded } from "../../../src/sandbox/k8s/quota.js";

function apiErr(code: number, message: string): ApiException<unknown> {
  // ApiException<T>(code, message, body, headers)
  return new ApiException(code, message, { message }, {});
}

describe("isQuotaExceeded", () => {
  it("detects a 403 quota rejection by message", () => {
    const err = apiErr(
      403,
      'pods "sandbox-x" is forbidden: exceeded quota: sandbox-quota, requested: pods=1, used: pods=5, limited: pods=5',
    );
    expect(isQuotaExceeded(err)).toBe(true);
  });

  it("is case-insensitive on the quota phrase", () => {
    expect(isQuotaExceeded(apiErr(403, "Exceeded Quota: foo"))).toBe(true);
  });

  it("ignores a 403 RBAC-forbidden error (not a quota)", () => {
    const err = apiErr(403, 'pods is forbidden: User "sa" cannot create resource "pods"');
    expect(isQuotaExceeded(err)).toBe(false);
  });

  it("ignores a 409 conflict", () => {
    expect(isQuotaExceeded(apiErr(409, "exceeded quota"))).toBe(false); // wrong code
  });

  it("ignores non-ApiException errors", () => {
    expect(isQuotaExceeded(new Error("exceeded quota"))).toBe(false);
  });
});

describe("QuotaExceededError", () => {
  it("carries name + message", () => {
    const e = new QuotaExceededError("exceeded quota: pods");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("QuotaExceededError");
    expect(e.message).toContain("exceeded quota");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/quota.test.ts`
Expected: FAIL — `Cannot find module '../../../src/sandbox/k8s/quota.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/server/src/sandbox/k8s/quota.ts`:

```ts
import { ApiException } from "@kubernetes/client-node";

/**
 * Thrown by the pod-create path when the namespace `ResourceQuota` rejects the
 * Pod (`403 ... exceeded quota ...`). Distinct from every other create failure
 * so the orchestrator can stamp a `stopReason: "error_quota"` and the workflow
 * layer can treat it as BACKPRESSURE (requeue + retry) instead of a hard fail.
 * design.md §8: the cluster's quota is the concurrency authority.
 */
export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";
  constructor(message: string) {
    super(message);
  }
}

/** True iff `err` is a k8s `403` whose message names an exceeded quota. */
export function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof ApiException) || err.code !== 403) return false;
  const body = err.body as { message?: string } | undefined;
  const text = `${body?.message ?? ""} ${err.message ?? ""}`;
  return /exceeded quota/i.test(text);
}
```

- [ ] **Step 4: Run the quota unit test — expect PASS**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/quota.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Wire detection into the pod-create path**

In `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`, add the import near the top (beside the existing `import { ApiException } from "@kubernetes/client-node";`):

```ts
import { QuotaExceededError, isQuotaExceeded } from "./quota.js";
```

Then change `createPodOrCleanupSecrets` (currently lines 436-448) so the catch maps a quota-403 before rethrowing:

```ts
  private async createPodOrCleanupSecrets(
    manifest: V1Pod,
    credsName: string,
    promptName: string | undefined,
  ): Promise<V1Pod> {
    try {
      return await this.apis.core.createNamespacedPod({ namespace: this.ns, body: manifest });
    } catch (err) {
      await this.deleteSecretBestEffort(credsName);
      if (promptName) await this.deleteSecretBestEffort(promptName);
      // A ResourceQuota rejection is backpressure, not a failure: rethrow a
      // typed error so the orchestrator stamps `error_quota` and the run
      // requeues (design.md §8). Every other create error propagates as-is.
      if (isQuotaExceeded(err)) {
        const body = (err as { body?: { message?: string } }).body;
        throw new QuotaExceededError(body?.message ?? "pod create rejected by ResourceQuota");
      }
      throw err;
    }
  }
```

- [ ] **Step 6: Add a focused test that the pod-create path maps the quota-403**

Append to `apps/server/tests/sandbox/k8s/quota.test.ts` a test that drives `createPodOrCleanupSecrets` via a fake `core` API. If the existing k8s unit tests already have a `KubernetesSandbox` construction helper (check `apps/server/tests/sandbox/k8s/` for a fake `apis` builder — e.g. `kubernetes-sandbox.test.ts`), reuse it; otherwise assert at the predicate level only (Step 1 already covers the mapping logic) and cover the throw-site in Task 4's runner test. Prefer reusing the existing fake:

```ts
// Only if a fake-apis KubernetesSandbox helper already exists in this dir.
// Construct a sandbox whose core.createNamespacedPod rejects with a quota-403,
// call the (private) create path via runCommand/runAgent's public entry, and:
//   await expect(sandbox.runCommand(...)).rejects.toBeInstanceOf(QuotaExceededError);
```

- [ ] **Step 7: Typecheck + full k8s unit suite**

Run: `pnpm --filter agentic-pi build && pnpm --filter lastlight-core exec tsc --noEmit`
Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/sandbox/k8s/quota.ts apps/server/src/sandbox/k8s/kubernetes-sandbox.ts apps/server/tests/sandbox/k8s/quota.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): k8s pod-create maps quota-403 to QuotaExceededError"
```

---

## Task 2: `requeueRunning` store transition (`running → queued`)

**Files:**
- Modify: `apps/server/src/state/workflow-run-store.ts` (add after `requeue`, ~547)
- Test: `apps/server/tests/state/workflow-run-store.test.ts` (or the existing run-store test file — locate with `git ls-files apps/server/tests | grep -i run-store`)

**Interfaces:**
- Produces: `requeueRunning(id: string): number` on `WorkflowRunStore` — CAS `WHERE status = 'running'`, sets `status = 'queued'` and re-stamps `started_at` (and `updated_at`) to now. Returns rows changed (0 if the run wasn't `running`, so a double-call is a safe no-op).

**Why re-stamp `started_at`:** the admission TTL sweep (`expireStaleRuns`, admission.ts:110) drops a queued run whose `started_at` is older than `maxQueueWaitMs`. A run that was `running` for an hour before hitting quota would carry a stale `started_at` and be instantly TTL-expired to `cancelled`. Re-stamping gives it a fresh queue-wait window — identical reasoning to the existing `requeue` (workflow-run-store.ts:531-547), which the boot-recovery path uses.

- [ ] **Step 1: Write the failing test**

Add to the run-store test file (mirror an existing test's DB-setup helper for `createRun` + a `running` row):

```ts
it("requeueRunning flips a running run back to queued and re-stamps the clock", () => {
  const id = "run-bp-1";
  store.createRun({
    id, workflowName: "build", triggerId: "t1", owner: "o", repo: "r",
    issueNumber: 1, currentPhase: "phase_0", status: "running",
    startedAt: new Date(Date.now() - 3_600_000).toISOString(), // 1h ago
  } as any);

  const before = store.getRun(id)!;
  const changed = store.requeueRunning(id);

  expect(changed).toBe(1);
  const after = store.getRun(id)!;
  expect(after.status).toBe("queued");
  expect(Date.parse(after.startedAt)).toBeGreaterThan(Date.parse(before.startedAt));
});

it("requeueRunning is a no-op on a non-running run (CAS guard)", () => {
  const id = "run-bp-2";
  store.createRun({
    id, workflowName: "build", triggerId: "t2", owner: "o", repo: "r",
    issueNumber: 2, currentPhase: "phase_0", status: "queued",
    startedAt: new Date().toISOString(),
  } as any);
  expect(store.requeueRunning(id)).toBe(0);
  expect(store.getRun(id)!.status).toBe("queued");
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run: `pnpm --filter lastlight-core exec vitest run tests/state/workflow-run-store.test.ts -t requeueRunning`
Expected: FAIL — `store.requeueRunning is not a function`.

- [ ] **Step 3: Implement `requeueRunning`**

In `apps/server/src/state/workflow-run-store.ts`, immediately after the existing `requeue` method (~547):

```ts
  /**
   * Backpressure requeue: flip a RUNNING run back to `queued` and re-stamp its
   * enqueue clock. Used by the k8s backend when a pod-create is rejected by the
   * namespace `ResourceQuota` (design.md §8) — the run isn't failed, it's waiting
   * for capacity, and the AdmissionController promotes it again as slots free.
   * Re-stamping `started_at` gives it a fresh `maxQueueWaitMs` window so the TTL
   * sweep doesn't instantly expire a run that had been running for a while.
   * CAS-guarded on `status = 'running'`; returns rows changed (0 = safe no-op,
   * e.g. the run already finished or was cancelled between phases).
   */
  requeueRunning(id: string): number {
    const now = new Date().toISOString();
    const info = this.db.prepare(`
      UPDATE workflow_runs
      SET status = 'queued', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, now, id);
    return info.changes;
  }
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `pnpm --filter lastlight-core exec vitest run tests/state/workflow-run-store.test.ts -t requeueRunning`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/state/workflow-run-store.ts apps/server/tests/state/workflow-run-store.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(state): requeueRunning transition (running -> queued) for backpressure"
```

---

## Task 3: Orchestrator stamps `stopReason: "error_quota"`

**Files:**
- Modify: `apps/server/src/engine/executors/orchestrator.ts` — the `runSandboxedAgent` catch (~239-266) and `runSandboxedCommand` (~358-426, which currently has **no** try/catch — you ADD one).
- Test: `apps/server/tests/engine/orchestrator.test.ts` (the existing orchestrator test — confirm with `git ls-files apps/server/tests/engine | grep orchestrator`).

**Interfaces:**
- Consumes: `QuotaExceededError` from `../../sandbox/k8s/quota.js` (Task 1) — a relative source import matching orchestrator.ts's existing sibling-module imports (source files use relative paths; the `#src/...` alias is a test-only convention).
- Produces: when `sandbox.runAgent` / `sandbox.runCommand` throws a `QuotaExceededError`, the returned `ExecutionResult` has `stopReason: "error_quota"` (instead of `"error_sandbox"`). All other fields (`success: false`, `error`) are set; any other throw is unchanged — `runSandboxedAgent` keeps mapping to `"error_sandbox"`, and `runSandboxedCommand` **rethrows** every non-quota error exactly as today (it currently has no catch, so non-quota throws must keep propagating).

**Why the two paths differ:** `runSandboxedAgent` (orchestrator.ts:239) already has a single converged catch that turns any sandbox throw into a failed `ExecutionResult` — for the agent path you only change the stop-reason *value*. `runSandboxedCommand` (bash/script phases) has **no** catch: a throw from `sandbox.runCommand` currently propagates uncaught and the engine scheduler records it as a failed phase (`error: String(err)`). On the k8s backend a bash/script phase also creates a pod, so a `runCommand` quota-403 must become backpressure too — you ADD a minimal try/catch that maps **only** `QuotaExceededError` to an `error_quota` result and **rethrows everything else** (preserving today's behavior for real command failures). Do NOT add shim/telemetry to the command path — it has none today; keep the change minimal and behavior-preserving for the non-quota case.

- [ ] **Step 1: Write the failing test**

**First read `apps/server/tests/engine/orchestrator.test.ts`.** It already exercises the fallback path via `FakeSandbox` (from `#src/sandbox/sandbox.js`), injected with `sandboxFactory: fake.asFactory()`, and `FakeSandbox` already supports **`throwOnRunAgent`** and **`throwOnRunCommand`** options (`apps/server/src/sandbox/sandbox.ts:589,595`) — there's an existing test at ~line 108 using `new FakeSandbox({ throwOnRunAgent: new Error("kaboom in the sandbox") })`. So no new fake infrastructure is needed: pass a `QuotaExceededError` instance to those options. Copy the existing "kaboom" test's setup (context construction, the `sandboxFactory: fake.asFactory()` wiring) and add THREE tests:

```ts
import { QuotaExceededError } from "#src/sandbox/k8s/quota.js";
// reuse this file's existing ctx/config setup (the "kaboom in the sandbox" test is the template).

it("runSandboxedAgent maps a QuotaExceededError to stopReason error_quota", async () => {
  const fake = new FakeSandbox({ throwOnRunAgent: new QuotaExceededError("exceeded quota: pods") });
  const res = await runSandboxedAgent("do the thing", makeCtx({ sandboxFactory: fake.asFactory() }));
  expect(res.success).toBe(false);
  expect(res.stopReason).toBe("error_quota");
  expect(res.error).toContain("exceeded quota");
});

it("runSandboxedAgent keeps error_sandbox for a generic sandbox throw", async () => {
  const fake = new FakeSandbox({ throwOnRunAgent: new Error("boom") });
  const res = await runSandboxedAgent("do the thing", makeCtx({ sandboxFactory: fake.asFactory() }));
  expect(res.stopReason).toBe("error_sandbox");
});

it("runSandboxedCommand maps a QuotaExceededError to stopReason error_quota", async () => {
  const fake = new FakeSandbox({ throwOnRunCommand: new QuotaExceededError("exceeded quota: pods") });
  const res = await runSandboxedCommand({ kind: "bash", command: "echo hi" }, makeCtx({ sandboxFactory: fake.asFactory() }), {});
  expect(res.success).toBe(false);
  expect(res.stopReason).toBe("error_quota");
});
```

> `makeCtx({...})` above stands for however the existing tests assemble the `SandboxRunContext` (they build a context object literal and pass overrides like `{ sandboxFactory: fake.asFactory() }` as the 3rd arg / a field). Follow the file's actual shape — don't invent a helper if the file inlines the context. `runSandboxedAgent`/`runSandboxedCommand` are imported from `#src/engine/executors/orchestrator.js`. Confirm `runSandboxedCommand`'s exact signature `(spec: CommandSpec, ctx: SandboxRunContext, cmdOpts: CommandRunOpts)` in the source; the bash `CommandSpec` is `{ kind: "bash", command: string }`.

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `pnpm --filter lastlight-core exec vitest run tests/engine/orchestrator.test.ts -t quota`
Expected: FAIL — the agent test sees `"error_sandbox"`; the command test throws (no catch yet) instead of returning a result.

- [ ] **Step 3: Implement the stamp**

In `orchestrator.ts`, add the import:

```ts
import { QuotaExceededError } from "../../sandbox/k8s/quota.js";
```

In the `runSandboxedAgent` catch (currently ~239), derive the stop reason once and use it in both the tags and the returned result:

```ts
    } catch (err: unknown) {
      // The single converged fallback path (was three near-identical catches).
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      // A k8s ResourceQuota rejection is backpressure, not a sandbox failure:
      // a distinct stop reason lets the runner requeue the run (design.md §8).
      const stopReason = err instanceof QuotaExceededError ? "error_quota" : "error_sandbox";
      const tags = {
        "sandbox.backend": ctx.backend,
        model,
        success: false,
        stop_reason: stopReason,
        "workflow.name": config.telemetry?.workflowName,
        "phase.name": config.telemetry?.phaseName,
      };
      recordError("agent", err, tags);
      recordExecutionMetrics("agent", { ...tags, durationMs });
      const synthesizedId = await shim
        .finalizeWithFallback(emptyResult(stopReason, durationMs), `exec-${basename(ctx.taskId)}`, msg)
        .catch(() => null);
      harvestArtifactsOut(artifacts);
      return {
        success: false,
        output: "",
        turns: 0,
        error: msg,
        durationMs,
        sessionId: synthesizedId ?? undefined,
        stopReason,
      } satisfies ExecutionResult;
    }
```

For the **command path**, `runSandboxedCommand` (orchestrator.ts:358-426) currently has no catch — its body is `return withSandbox(ctx, async (sandbox, prov) => { … });`. Wrap that in a try/catch that maps only a `QuotaExceededError` and rethrows everything else:

```ts
  try {
    return await withSandbox(ctx, async (sandbox, prov) => {
      // … existing body unchanged …
    });
  } catch (err: unknown) {
    // A k8s ResourceQuota rejection on a bash/script phase is backpressure too:
    // surface it as an error_quota RESULT so the runner requeues (design.md §8).
    // Every other throw propagates exactly as before (the engine records it as a
    // failed phase) — we do NOT swallow real command failures.
    if (err instanceof QuotaExceededError) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        output: "",
        turns: 0,
        error: err.message,
        durationMs,
        stopReason: "error_quota",
      } satisfies ExecutionResult;
    }
    throw err;
  }
```

(`startTime` is already declared at the top of `runSandboxedCommand`. `ExecutionResult` is already imported in the file.)

- [ ] **Step 4: Run the orchestrator test — expect PASS**

Run: `pnpm --filter lastlight-core exec vitest run tests/engine/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter lastlight-core exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/engine/executors/orchestrator.ts apps/server/tests/engine/orchestrator.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): orchestrator stamps error_quota stopReason on QuotaExceededError"
```

---

## Task 4: Server runner surfaces `backpressure` on the `WorkflowResult`

**Files:**
- Modify: `apps/server/src/workflows/runner.ts` — `defaultAgentPort` (~142), `runWorkflow` signature/return (~184-395), the ports object passed to `runWorkflowCore` (~377).
- Test: `apps/server/tests/workflows/runner.test.ts` (the existing runner suite — `src/workflows/runner.test.ts` per apps/server/src/workflows/CLAUDE.md; confirm the path with `git ls-files | grep runner.test`).

**Interfaces:**
- Produces: `runWorkflow(...)` now returns `WorkflowResult & { backpressure?: boolean }`. `backpressure` is `true` iff any phase this run returned an `ExecutionResult` with `stopReason === "error_quota"`. The engine (`runWorkflowCore`) is untouched — detection happens in the server-owned agent/command port wrapper, recorded in a per-run mutable flag closed over by that wrapper.
- Consumes (by later tasks): `simple.ts` and `resume.ts` read `result.backpressure`.

**Design note — per-run port, not the module const.** `defaultAgentPort` (runner.ts:142) is a module-level singleton shared across all runs, so it can't hold per-run state. Build a fresh agent/command port **inside `runWorkflow`** that closes over a local `quota` flag and wraps `executeAgent`/`executeCommand`, inspecting each `ExecutionResult.stopReason`. Keep `defaultAgentPort` only if some other caller uses it; otherwise replace its use at the ports-wiring site (~377) with the per-run port.

- [ ] **Step 1: Write the failing test**

The runner test wires fake `EnginePorts`. Add a test whose fake `agent.runAgent` resolves an `ExecutionResult` with `stopReason: "error_quota", success: false`, and assert the returned `WorkflowResult` carries `backpressure: true`:

```ts
it("returns backpressure:true when a phase hits error_quota", async () => {
  const def = /* a one-agent-phase workflow definition, as other runner tests build */;
  const ports = makeFakePorts({
    agent: {
      runAgent: async () => ({
        success: false, output: "", turns: 0, durationMs: 1,
        error: "exceeded quota: pods", stopReason: "error_quota",
      }),
      runCommand: async () => ({ success: true, output: "", turns: 0, durationMs: 1 }),
    },
  });
  const result = await runWorkflow(def, ctx, config, callbacks, db, models, approval, "run-1", variants);
  expect(result.success).toBe(false);
  expect(result.backpressure).toBe(true);
});

it("does not set backpressure for a normal phase failure", async () => {
  const ports = makeFakePorts({
    agent: { runAgent: async () => ({ success: false, output: "", turns: 0, durationMs: 1, stopReason: "error_agent" }) },
  });
  const result = await runWorkflow(def, ctx, config, callbacks, db, models, approval, "run-2", variants);
  expect(result.backpressure).toBeFalsy();
});
```

> The runner test currently injects ports through the `EnginePorts` seam — follow whatever injection the existing tests use (they may pass a ports override, or monkey-patch `executeAgent`). If the suite calls `runWorkflow` with the real `defaultAgentPort` and stubs `executeAgent` via `vi.mock("../engine/agent-executor.js")`, stub it to resolve the `error_quota` result and keep the same assertion.

- [ ] **Step 2: Run the test — expect FAIL**

Run: `pnpm --filter lastlight-core exec vitest run tests/workflows/runner.test.ts -t backpressure`
Expected: FAIL — `result.backpressure` is `undefined`.

- [ ] **Step 3: Build the per-run quota-aware port + thread the flag out**

In `runner.ts`, replace the module-const port usage with a per-run wrapper. Near the top of `runWorkflow` (after the run-scoped setup, before `runWorkflowCore` is called):

```ts
  // Backpressure detection: a phase whose ExecutionResult carries
  // `stopReason: "error_quota"` means the k8s ResourceQuota rejected its pod
  // (design.md §8). We flag the run so the terminal handler requeues instead of
  // failing. The engine (runWorkflowCore) stays backend-agnostic — this lives
  // entirely in the server-owned port wrapper.
  const quota = { hit: false };
  const noteStopReason = (r: ExecutionResult): ExecutionResult => {
    if (r.stopReason === "error_quota") quota.hit = true;
    return r;
  };
  const agentPort: EnginePorts["agent"] = {
    runAgent: (prompt, cfg, opts) => executeAgent(prompt, cfg, opts).then(noteStopReason),
    runCommand: (spec, cfg, opts) => executeCommand(spec, cfg, opts).then(noteStopReason),
  };
```

Import `ExecutionResult` as a type from `lastlight-workflow-engine` if not already imported in runner.ts.

At the ports-wiring site (~377), use `agentPort` instead of `defaultAgentPort`:

```ts
    agent: agentPort,
```

Change `runWorkflow`'s return type to `Promise<WorkflowResult & { backpressure?: boolean }>` and fold the flag into the returned value. The current tail of `runWorkflow` (runner.ts:387-395) is `return runWorkflowCore(runScope, { reporter, resolver, ports, store, reporterActive, capabilities }, outputs);` — a **3-argument** call (`runScope`, the options object, `outputs`). Preserve all three arguments exactly; only capture the result and augment it:

```ts
  const result = await runWorkflowCore(runScope, {
    reporter: phaseReporter,
    resolver: phaseResolver,
    ports,
    store: db,
    reporterActive: !!reporter,
    capabilities: { qaImageAvailable, qaImageName: SANDBOX_IMAGE_QA },
  }, outputs);
  return quota.hit ? { ...result, backpressure: true } : result;
```

Delete `defaultAgentPort` if nothing else references it (grep first: `rg "defaultAgentPort" apps/server/src`).

- [ ] **Step 4: Run the runner test — expect PASS**

Run: `pnpm --filter lastlight-core exec vitest run tests/workflows/runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter lastlight-core exec tsc --noEmit`
Expected: no errors. (If `WorkflowResult` is re-exported at runner.ts:39, the intersection return type is local to `runWorkflow`'s signature — no engine edit.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/workflows/runner.ts apps/server/tests/workflows/runner.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(workflows): runner surfaces backpressure when a phase hits error_quota"
```

---

## Task 5: Requeue on backpressure at dispatch + resume; k8s dispatch admits freely

**Files:**
- Modify: `apps/server/src/workflows/simple.ts` — dispatch gate (~332), terminal block (~540-547), and the return type of `runSimpleWorkflow`/its `WorkflowResult` usages (~11 import + return sites).
- Modify: `apps/server/src/workflows/resume.ts` — terminal block (~319-325).
- Test: `apps/server/tests/workflows/simple-cap.test.ts` — this is the dedicated concurrency-cap suite (issue #172), the correct home for the k8s dispatch-gate + backpressure tests (NOT `simple.test.ts`, which covers `artifactIssueDir`). It already mocks `runWorkflow` via `vi.mock("#src/workflows/runner.js")` and drives `runSimpleWorkflow` with an in-memory DB + a `makeConfig()` fixture (currently `sandbox: "none"`). No separate resume test file exists; cover the resume path here or by direct `resumeSimpleRun` call if convenient — but the resume-side change mirrors the dispatch-side and is low-risk, so a dispatch-path test plus the code change is sufficient.

**Interfaces:**
- Consumes: `runWorkflow(...)` returns `{ ...WorkflowResult, backpressure?: boolean }` (Task 4); `db.runs.requeueRunning(id)` (Task 2).
- **`K8S_SANITY_FUSE` ordering — this task creates it.** Add `export const K8S_SANITY_FUSE = 1000;` to `apps/server/src/workflows/admission.ts` now (with the docstring shown in Task 6), and import it into `simple.ts` from `./admission.js`. Task 6 then only ADDS the backpressure-mode logic to admission.ts — the constant already exists. This keeps both tasks clean (no temporary inline).
- Produces: on `result.backpressure`, `runSimpleWorkflow` and `resumeSimpleRun` transition the run `running → queued` (via `requeueRunning`) and return `{ success: true, queued: true, backpressure: true, phases: result.phases }`. On the k8s backend, the dispatch gate (~332) uses `K8S_SANITY_FUSE` instead of `concurrency.maxWorkflows`.

- [ ] **Step 1: Write the failing tests**

Add two cases to `simple-cap.test.ts`, reusing its existing fixtures. The suite already mocks `runWorkflow` (`mockRunWorkflow`, from `vi.mock("#src/workflows/runner.js")`), has `makeDb()`/`makeRequest()`/`makeConfig()`/`makeCallbacks()` helpers, and calls `runSimpleWorkflow(name, request, config, callbacks, db, models, approval, bootstrapLabel, variants, { maxWorkflows, maxQueueWaitMs })`. `makeConfig()` currently returns `sandbox: "none"` — either give it an override param or spread `{ ...makeConfig(), sandbox: "kubernetes" as const }`. To seed a "running" row, insert one via `db.runs.createRun({ ..., status: "running", ... })` mirroring the file's existing row-creation (the dedup test at ~line 149 shows the `createRun` shape). Capture the created run id from the result or by querying `db.runs` (the existing tests read back via `db.runs.getRun(id)`).

```ts
it("k8s backend admits freely at dispatch (fuse, not maxWorkflows)", async () => {
  // One run already 'running' + maxWorkflows=1 would queue the next on docker/none.
  // On the k8s backend the dispatch gate uses the sanity fuse, so it dispatches 'running'.
  seedRunningRow(db); // insert a status:"running" row via db.runs.createRun(...)
  const result = await runSimpleWorkflow(
    "explore", makeRequest(), { ...makeConfig(), sandbox: "kubernetes" as const },
    makeCallbacks(), db, undefined, undefined, "lastlight:bootstrap", undefined,
    { maxWorkflows: 1, maxQueueWaitMs: 1_800_000 },
  );
  expect(result.queued).toBeFalsy();      // NOT capped by maxWorkflows on k8s
});

it("requeues the run (running -> queued) when runWorkflow reports backpressure", async () => {
  mockRunWorkflow.mockResolvedValue({
    success: false,
    phases: [{ phase: "socratic", success: false, error: "exceeded quota" }],
    backpressure: true,
  });
  const result = await runSimpleWorkflow(
    "explore", makeRequest(), { ...makeConfig(), sandbox: "kubernetes" as const },
    makeCallbacks(), db, undefined, undefined, "lastlight:bootstrap", undefined,
    { maxWorkflows: 1000, maxQueueWaitMs: 1_800_000 },
  );
  expect(result.queued).toBe(true);
  expect(result.backpressure).toBe(true);
  // The row was created 'running', then requeued back to 'queued' by requeueRunning.
  const runs = db.runs.listActive();
  expect(runs.find((r) => r.workflowName === "explore")!.status).toBe("queued");
});
```

> `seedRunningRow` is shorthand — inline the `db.runs.createRun({...status:"running"...})` call mirroring the suite's dedup test. The `mockRunWorkflow.mockResolvedValue({... backpressure: true})` overrides the `beforeEach` default for that test only.

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `pnpm --filter lastlight-core exec vitest run tests/workflows/simple-cap.test.ts -t 'backpressure|admits freely'`
Expected: FAIL (second run queues on maxWorkflows; no backpressure handling).

- [ ] **Step 3: Make the dispatch gate use the fuse on k8s**

In `simple.ts`, at the over-cap check (~332):

```ts
    // Concurrency authority differs by backend: docker/gondolin use the tuned
    // app-level `maxWorkflows`; the k8s backend defers to the namespace
    // ResourceQuota (design.md §8) and keeps only an absurdly-high sanity fuse,
    // so it admits freely here and requeues later if a pod-create is quota-rejected.
    const admitCap =
      config.sandbox === "kubernetes" ? K8S_SANITY_FUSE : concurrency?.maxWorkflows ?? Infinity;
    const overCap = db.runs.countRunning() >= admitCap;
    const runStatus: "running" | "queued" = overCap ? "queued" : "running";
```

**First create the constant** (this task owns it — see the Interfaces note): add to `apps/server/src/workflows/admission.ts`, near the top after the imports:

```ts
/**
 * Absurdly-high runaway-loop backstop for the k8s backend. NOT a tuned
 * concurrency limit — the namespace ResourceQuota is the real authority
 * (design.md §8). Mirrors the workflow engine's 1000-agent cap: a fuse, not a knob.
 */
export const K8S_SANITY_FUSE = 1000;
```

Then import it into `simple.ts`: `import { K8S_SANITY_FUSE } from "./admission.js";`. Keep the existing `overCap` notify/return block unchanged (a fuse-hit on k8s is a genuine runaway backstop and legitimately queues). Note the semantics: with `concurrency` undefined and a non-k8s backend, `concurrency?.maxWorkflows ?? Infinity` yields `Infinity` so `overCap` is `false` — identical to the current `concurrency !== undefined && …` guard.

- [ ] **Step 4: Handle backpressure in the terminal block**

In `simple.ts`, the terminal status block (currently 540-547) becomes:

```ts
    if (result.success && !result.paused) {
      db.runs.finishRun(workflowId, "succeeded");
      reapOnSuccess(workflowName, taskId, config);
    } else if (result.backpressure) {
      // k8s ResourceQuota rejected a pod-create: requeue, don't fail. The
      // AdmissionController promotes it again as capacity frees (design.md §8).
      db.runs.requeueRunning(workflowId);
      await notify(
        `\`${workflowName}\` is waiting for cluster capacity — it'll start automatically when a slot frees.`,
      );
      return { success: true, queued: true, backpressure: true, phases: result.phases };
    } else if (!result.success && !result.paused) {
      db.runs.finishRun(workflowId, "failed", {
        error: result.phases.find((p) => !p.success)?.error || "workflow failed",
      });
    }
```

Add `backpressure?: boolean` to the local return type of `runSimpleWorkflow` (its declared return is `Promise<WorkflowResult>`; widen to `Promise<WorkflowResult & { backpressure?: boolean }>`, matching Task 4).

- [ ] **Step 5: Handle backpressure in the resume path**

In `resume.ts`, the terminal block (319-325) becomes:

```ts
    if (result.success) {
      opts.db.runs.finishRun(run.id, "succeeded");
    } else if (result.backpressure) {
      // Same backpressure requeue as the fresh-dispatch path: a promoted run
      // that re-hits the quota goes back to `queued` for the next admission tick.
      opts.db.runs.requeueRunning(run.id);
      console.log(`[resume] ${run.workflowName} run ${run.id} requeued — cluster at capacity`);
    } else if (!result.paused) {
      opts.db.runs.finishRun(run.id, "failed", {
        error: result.phases.find((p) => !p.success)?.error || "workflow failed during resume",
      });
    }
```

- [ ] **Step 6: Run the tests — expect PASS**

Run: `pnpm --filter lastlight-core exec vitest run tests/workflows/simple-cap.test.ts`
Expected: PASS. Also run the resume suite if the change touched a covered path: `pnpm --filter lastlight-core exec vitest run tests/workflows/` (confirm no regression across the workflow suites).

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter lastlight-core exec tsc --noEmit`

```bash
git add apps/server/src/workflows/admission.ts apps/server/src/workflows/simple.ts apps/server/src/workflows/resume.ts apps/server/tests/workflows/simple-cap.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(workflows): requeue k8s runs on quota backpressure; admit freely at dispatch"
```

---

## Task 6: Admission — k8s backpressure mode (fuse gate + one-promote-per-invocation) and dispatch wiring

**Files:**
- Modify: `apps/server/src/workflows/admission.ts` — `K8S_SANITY_FUSE` export, `AdmissionDeps` (~29), `createAdmissionController` (~49), `admitNext` (~54).
- Modify: `apps/server/src/index.ts` — the `createAdmissionController({...})` call (~846) and the dispatch `finally` `admitNext` (~675-683).
- Test: `apps/server/tests/workflows/admission.test.ts` (locate: `git ls-files | grep admission.test`).

**Interfaces:**
- Produces: `export const K8S_SANITY_FUSE = 1000;` from `admission.ts`. `AdmissionDeps` gains `backpressureMode?: boolean`. In backpressure mode, `admitNext` (a) gates on `countRunning() >= K8S_SANITY_FUSE` (not `maxWorkflows`), and (b) promotes **at most one** queued run per invocation (each promote is a capacity probe; a still-full quota makes the promoted run re-403 and re-queue, so promoting the whole queue at once would stampede). In the default (docker/gondolin) mode, behavior is unchanged: loop up to `maxWorkflows`.
- Consumes (index.ts): `config.sandbox === "kubernetes"` sets `backpressureMode: true`; the dispatch `finally` skips the event-driven `admitNext` when the just-settled dispatch returned `backpressure` (so a quota-requeued run isn't instantly re-promoted into the same full quota — it waits for the 15 s sweep or another run's real completion).

**Why one-per-invocation:** the app cannot know how many quota slots are free (design forbids mirroring the `ResourceQuota` number). Each promotion is a probe: succeed → filled a real slot; 403 → requeue, and the next tick probes again. Promoting the entire queue on one tick would fire N concurrent creates, N−freeSlots of which 403 and requeue — a stampede with no benefit. One probe per tick paces retries to the completion/sweep cadence.

- [ ] **Step 1: Write the failing tests**

```ts
import { createAdmissionController, K8S_SANITY_FUSE } from "#src/workflows/admission.js";

it("backpressure mode promotes at most one queued run per admitNext", async () => {
  seedQueuedRuns(db, 3);          // 3 runs in 'queued'
  const ctl = createAdmissionController({
    db, resumeOpts, maxWorkflows: 1, maxQueueWaitMs: 60_000, backpressureMode: true,
  });
  await ctl.admitNext();
  expect(db.runs.countRunning()).toBe(1); // only ONE promoted despite 3 queued
});

it("default mode still fills up to maxWorkflows", async () => {
  seedQueuedRuns(db, 3);
  const ctl = createAdmissionController({
    db, resumeOpts, maxWorkflows: 2, maxQueueWaitMs: 60_000, // backpressureMode omitted
  });
  await ctl.admitNext();
  expect(db.runs.countRunning()).toBe(2);
});

it("backpressure mode gates on the sanity fuse, not maxWorkflows", async () => {
  // maxWorkflows=1 with one already running would block default mode; backpressure
  // mode admits because countRunning (1) < K8S_SANITY_FUSE.
  seedRunningRuns(db, 1);
  seedQueuedRuns(db, 1);
  const ctl = createAdmissionController({
    db, resumeOpts, maxWorkflows: 1, maxQueueWaitMs: 60_000, backpressureMode: true,
  });
  await ctl.admitNext();
  expect(db.runs.countRunning()).toBe(2);
  expect(K8S_SANITY_FUSE).toBeGreaterThan(100);
});
```

> `seedQueuedRuns`/`seedRunningRuns` mirror the existing admission-test seeding (create rows via the store with the right status). `resumeOpts` must be the fake the existing tests pass so a promoted run's background `resumeSimpleRun` is a harmless no-op. If `resumeSimpleRun` isn't easily faked, assert on `db.runs.admitRun` side effects (status flips to `running`) rather than the dispatch.

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `pnpm --filter lastlight-core exec vitest run tests/workflows/admission.test.ts -t 'backpressure|sanity fuse'`
Expected: FAIL — `backpressureMode` ignored (the `K8S_SANITY_FUSE` export already exists from Task 5).

- [ ] **Step 3: Implement the backpressure mode**

**`K8S_SANITY_FUSE` already exists** in `admission.ts` (Task 5 created the `export const K8S_SANITY_FUSE = 1000;` with its docstring). Do NOT re-declare it. This task only adds the `backpressureMode` plumbing.

Extend `AdmissionDeps`:

```ts
export interface AdmissionDeps {
  db: StateDb;
  resumeOpts: ResumeOptions;
  maxWorkflows: number;
  maxQueueWaitMs: number;
  sweepIntervalMs?: number;
  /**
   * k8s backpressure mode (design.md §8): gate on `K8S_SANITY_FUSE` instead of
   * `maxWorkflows`, and promote at most ONE queued run per `admitNext` (each
   * promote is a quota probe; the run re-queues if the ResourceQuota is full).
   */
  backpressureMode?: boolean;
}
```

In `createAdmissionController`, read the flag and rework `admitNext`:

```ts
  const { db, resumeOpts, maxWorkflows, maxQueueWaitMs } = deps;
  const backpressureMode = deps.backpressureMode ?? false;
  const cap = backpressureMode ? K8S_SANITY_FUSE : maxWorkflows;
  // ...

  async function admitNext(): Promise<void> {
    for (;;) {
      if (db.runs.countRunning() >= cap) break;
      const queued = db.runs.listQueued();
      if (queued.length === 0) break;
      const next = queued[0];
      const changes = db.runs.admitRun(next.id);
      if (changes !== 1) continue; // CAS lost — re-check from scratch.
      const admitted = db.runs.getRun(next.id);
      if (admitted) dispatchAdmitted(admitted, resumeOpts);
      // Backpressure mode: promote ONE probe per invocation. In app-count mode,
      // keep filling up to `cap` (the old behavior).
      if (backpressureMode) break;
    }
  }
```

- [ ] **Step 4: Run the admission tests — expect PASS**

Run: `pnpm --filter lastlight-core exec vitest run tests/workflows/admission.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the mode + finally-skip in index.ts**

At the `createAdmissionController` call (~846):

```ts
  admissionController = createAdmissionController({
    db,
    resumeOpts,
    maxWorkflows: config.concurrency.maxWorkflows,
    maxQueueWaitMs: config.concurrency.maxQueueWaitMs,
    backpressureMode: config.sandbox === "kubernetes",
  });
```

In `dispatchWorkflow` (index.ts), `result` is currently `const`-declared inside the `try` (`const result = await runSimpleWorkflow(...)`), so the `finally` can't see it. **Hoist it** to the function scope: declare `let result: Awaited<ReturnType<typeof runSimpleWorkflow>> | undefined;` just before the `try`, and change the in-`try` line to `result = await runSimpleWorkflow(...)` (drop the `const`). The existing `try`-body logic and its `return { success: result.success, paused: result.paused, queued: result.queued }` stay unchanged.

Then the dispatch `finally` (currently ~675-683) becomes — skip the event-driven `admitNext` when THIS dispatch just requeued on quota backpressure. A quota-requeued run must NOT be instantly re-promoted into the same full quota (a tight loop); the 15 s sweep + real completions of other runs pace its retry:

```ts
    } finally {
      // Event-driven admission: after each dispatch settles, pull the next queued
      // run into a free slot. Skip it when THIS dispatch just requeued on quota
      // backpressure — re-promoting instantly would re-hit the full quota in a
      // tight loop; the periodic sweep + real completions pace the retry.
      if (!result?.backpressure) {
        admissionController?.admitNext().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[admission] admitNext error: ${msg}`);
        });
      }
    }
```

> On a thrown dispatch, `result` stays `undefined` → `!result?.backpressure` is `true` → `admitNext` runs (correct — a throw isn't backpressure). The `catch` branch is unchanged.

- [ ] **Step 6: Typecheck + focused run**

Run: `pnpm --filter lastlight-core exec tsc --noEmit`
Run: `pnpm --filter lastlight-core exec vitest run tests/workflows/admission.test.ts tests/workflows/simple-cap.test.ts`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/workflows/admission.ts apps/server/src/index.ts apps/server/tests/workflows/admission.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(workflows): k8s admission backpressure mode (fuse gate + one-probe-per-tick)"
```

---

## Task 7: Opt-in integration test + spec docs

**Files:**
- Modify: `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts` (add a gated quota-backpressure case).
- Modify: `apps/server/spec/09-sandbox.md`, `apps/server/spec/06-workflow-engine.md`.

**Interfaces:**
- Consumes: everything from Tasks 1-6. The IT stages a `ResourceQuota` in `lastlight-sandboxes` via admin creds (the harness SA can't create quotas until Plan 7 — same admin-staging pattern Plan 3 used for CNPs), dispatches two k8s runs against a `pods=1` quota, and asserts one runs while the other requeues, then completes after the first frees the slot.

**Why gated + admin-staged:** the harness SA gains quota-management RBAC only in Plan 7's Flux `Role`. Until then the IT applies the quota itself via the admin kubeconfig, validates the mechanism, and deletes the quota afterward — mirroring Plan 3's admin-staged CNP validation (HANDOVER.md). The steady-state enforcement (harness reacting to a Flux-managed quota) validates post-Plan-7.

- [ ] **Step 1: Add the opt-in IT case**

Guard it behind the existing `RUN_K8S_IT` env gate. Sketch (adapt to the file's existing helpers for building a `KubernetesSandbox`, the admin `CoreV1Api`, and unique taskIds):

```ts
// RUN_K8S_IT only. Requires admin kubeconfig (admin@homelab) + the namespace.
it.runIf(process.env.RUN_K8S_IT === "1")(
  "requeues a second run under a pods=1 ResourceQuota, then runs it after the first frees the slot",
  async () => {
    const ns = process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes";
    const core = adminCoreApi(); // admin creds — see other cases in this file
    // 1. Stage a pods=1 quota (admin; the harness SA can't until Plan 7).
    await core.createNamespacedResourceQuota({
      namespace: ns,
      body: {
        metadata: { name: "it-sandbox-quota" },
        spec: { hard: { pods: "1" } },
      },
    });
    try {
      // 2. Create pod #1 directly (fills the quota).
      // 3. Attempt a KubernetesSandbox pod-create → expect QuotaExceededError.
      await expect(sandboxB.runCommand(taskB, "echo hi", {})).rejects.toBeInstanceOf(QuotaExceededError);
      // 4. Delete pod #1; retry sandboxB.runCommand → now succeeds.
    } finally {
      // 5. Always delete the quota to restore the "no quota yet" state.
      await core.deleteNamespacedResourceQuota({ name: "it-sandbox-quota", namespace: ns }).catch(() => {});
    }
  },
  120_000,
);
```

> Keep it self-cleaning (delete the quota + any pods in `finally`) and note in a comment — as HANDOVER.md flags for Plan 5's Case B — that a repeated run may vacuum leftover PVCs/pods in `lastlight-sandboxes`.

- [ ] **Step 2: Run the unit suites (IT stays skipped without the gate)**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/`
Expected: PASS; the new IT case is skipped (no `RUN_K8S_IT`).

- [ ] **Step 3: (Robin, on-cluster — optional) run the gated IT**

```bash
RUN_K8S_IT=1 LASTLIGHT_K8S_NAMESPACE=lastlight-sandboxes \
  K8S_SANDBOX_IMAGE=ghcr.io/yo61/lastlight-sandbox:latest GITHUB_TOKEN=… \
  pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts
```

Expected: the quota-backpressure case passes (rejects with `QuotaExceededError`, then succeeds after the slot frees). Requires `kubectl config current-context` = `admin@homelab`.

- [ ] **Step 4: Document the concurrency model**

In `apps/server/spec/09-sandbox.md`, under the kubernetes backend, add a "Concurrency" subsection: the cluster `ResourceQuota` is the authority; the harness admits freely (sanity fuse `K8S_SANITY_FUSE = 1000`), maps a pod-create `403 exceeded quota` to `QuotaExceededError` → `stopReason: "error_quota"` → `WorkflowResult.backpressure` → `requeueRunning` (running→queued), and the `AdmissionController` (backpressure mode: fuse gate + one-probe-per-tick) retries as capacity frees. Note that real enforcement needs Plan 7's Flux `ResourceQuota`.

In `apps/server/spec/06-workflow-engine.md`, note the new `backpressure` outcome on the server-side `WorkflowResult` (a k8s-only, server-layer intersection — the engine `WorkflowResult` is unchanged) and the `running → queued` requeue transition, alongside the existing `paused`/`queued` vocabulary.

- [ ] **Step 5: Commit**

```bash
git add apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts apps/server/spec/09-sandbox.md apps/server/spec/06-workflow-engine.md
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "test(sandbox): opt-in k8s quota-backpressure IT + spec docs"
```

---

## Whole-branch verification (after all tasks)

- [ ] `pnpm --filter agentic-pi build && pnpm --filter lastlight-core exec tsc --noEmit` — clean.
- [ ] `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/ tests/workflows/ tests/state/ tests/engine/` — green.
- [ ] `pnpm turbo run typecheck` from the repo root — the dep-cruiser boundary gate confirms **no new edge** from `lastlight-workflow-engine` back to core (proof the backpressure concept stayed server-side).
- [ ] Final whole-branch review (opus), same as Plans 1-5.
- [ ] Update `docs/plans/kubernetes-sandbox-backend/HANDOVER.md`: Plan 6 done; next = **Plan 7 (Flux manifests)** — which turns on the ResourceQuota (+ egress/reclaim RBAC) so backpressure enforces end-to-end.

---

## Self-review (against design.md §8 + the reactive-flow findings)

- **§8 "admit freely, attempt the pod create, treat quota rejection as backpressure — run stays queued, retried when a pod completion frees capacity"** → Tasks 1-6: free dispatch on k8s (Task 5 fuse gate), `QuotaExceededError` on create (Task 1), requeue on backpressure (Task 5), retry via AdmissionController (Task 6). ✓
- **§8 "reuses the existing 'promote queued runs as slots free' machinery, re-sourcing the slot signal"** → the *literal* re-source is impossible at admission time (the create happens mid-phase, deep in `KubernetesSandbox`, past the orchestrator's converged catch — the pre-plan finding). The plan realizes §8's **intent** reactively: the slot signal becomes "a pod-create succeeded / 403'd," surfaced as `stopReason: "error_quota"` and paced by one-probe-per-tick promotion. Documented in Task 4/6 rationale. ✓
- **§8 "app keeps only an absurdly-high sanity fuse"** → `K8S_SANITY_FUSE = 1000`, hardcoded constant, both dispatch gate and admission. No new tuned config. ✓
- **§8 "scaling is a one-line Flux edit to the ResourceQuota"** → nothing in the app caps k8s concurrency below the fuse; the quota alone gates. ✓
- **Locked constraint "ResourceQuota is the concurrency authority; harness treats quota-rejection as backpressure"** (HANDOVER "Locked constraints") → the whole plan. ✓
- **No engine edit** (dep invariant) → backpressure is a server-side intersection on `WorkflowResult`; verified by the root `turbo run typecheck` dep-cruiser gate. ✓
- **Placeholder scan** → every code step carries real code; test-harness specifics (`makeCtx`, `seedQueuedRuns`, the runner ports-injection style) are flagged as "match the existing suite" because they depend on conventions the implementer will read in-file — not invented signatures. ✓
- **Type consistency** → `QuotaExceededError`/`isQuotaExceeded` (Task 1) consumed by Tasks 3; `requeueRunning` (Task 2) by Task 5; `backpressure` (Task 4) by Task 5; `K8S_SANITY_FUSE`/`backpressureMode` (Task 6) by Tasks 5-6 and index.ts. `stopReason: "error_quota"` is the single string used in Tasks 3-4. ✓
- **Open follow-ups (deferred, tracked):** (a) end-to-end enforcement needs Plan 7's Flux `ResourceQuota` + quota-management RBAC — until then build/unit + admin-staged IT; (b) the requeue currently posts a Slack-style notify only via `notify()` — GitHub-origin runs get no PR comment (consistent with `postExpiryAck`'s deliberate no-comment policy, admission.ts:133); (c) one-probe-per-tick makes backlog drain at the sweep cadence (~15 s/run) after capacity opens — acceptable for a homelab, revisit only if throughput demands it.
