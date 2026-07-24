# Kubernetes Sandbox Backend — Plan 1: Walking Skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `kubernetes` sandbox backend that runs one deterministic (no-AI) `type: bash` phase inside a real Kubernetes Pod and streams its output back to the harness — proving the create → stream → reap mechanism end-to-end before any creds/PVC/egress are layered on.

**Architecture:** A new `KubernetesSandbox` adapter implements the existing `Sandbox` port (`apps/server/src/sandbox/sandbox.ts`) and is selected by `sandboxFor("kubernetes", …)`. It talks to the cluster via `@kubernetes/client-node`: create a Pod running the sandbox image, stream the Pod log (`follow`) line-by-line through the existing `parseLine`→`onEvent` path (the same parser the docker backend uses), then delete the Pod on dispose.

**Tech Stack:** TypeScript (ESM, NodeNext), `@kubernetes/client-node@1.4.0` (object-param API), vitest.

## Global Constraints

- **Node ≥ 22.12**; ESM only; relative imports use `.js` extensions (NodeNext).
- **`SandboxBackend`** is defined in `lastlight-workflow-engine` and re-exported from `apps/server/src/config/config.ts`. Adding a backend touches the type there **and** the two string validators in `config.ts` (`sandboxBackend`, ~line 618, and the check at ~line 666) **and** the `sandboxFor` switch (`apps/server/src/sandbox/sandbox.ts:227`).
- **Do not mutate `process.env`** anywhere in this backend — the whole point (#223) is that per-run env lives on the Pod, not the harness global.
- **Hard rule #8** (agentic-pi): the App PEM never crosses into a sandbox. Plan 1 uses no GitHub creds at all; credential delivery is Plan 2.
- **Reuse, don't reinvent:** the line→event parser is the existing `parseLine(onEvent)` in `apps/server/src/sandbox/`. The `Sandbox` port signatures are fixed (see below) — match them exactly.
- Pin the exact client version with `pnpm add @kubernetes/client-node@1.4.0 --filter lastlight-core` (no `^`).

### Sandbox port contract (match exactly — from `sandbox.ts`)

```ts
interface Sandbox {
  readonly backend: SandboxBackend;
  provision(prePopulate?: PrePopulateSpec): Promise<ProvisionResult>;   // { hostWorkspaceDir, agentCwd }
  stageSkills(phaseKey: string, skillPaths: string[] | undefined): string[] | undefined;
  sandboxPathFor(relPath: string): string;
  runAgent(taskId: string, prompt: string, opts: RunAgentOpts, onEvent: (r: SandboxEvent) => void): Promise<RunResult | undefined>;
  runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult>;
  dispose(): Promise<void> | void;
}
// SandboxFactoryOpts { taskId, egress, env, stateDir, sandboxDir?, repoSubdir?, imageName?, otel?, timeoutSeconds? }
// RunCommandOpts { cwd, sandboxEnv?, timeoutSeconds }; RawCommandResult { exitCode, stdout, stderr, timedOut }
```

## Roadmap (this plan is Plan 1 of 5)

| Plan | Delivers | Testable outcome |
|---|---|---|
| **1 — Walking skeleton** (this doc) | `kubernetes` backend; `KubernetesSandbox` creates a Pod, streams JSONL logs, reaps it; `runCommand` for a no-AI bash phase | A `type: bash` phase runs in a real Pod and its output streams back |
| 2 — Creds + workspace (design B) | Per-run `Secret` + `envFrom` + ownerRef; per-`(repo,PR)` RWO PVC reuse; initContainer clone/refresh | An AI phase runs against a checked-out repo with a scoped token; #223 gone |
| 3 — Egress + skills | Harness-generated strict/open `CiliumNetworkPolicy` from `egress-allowlist.ts`; HTTP skill-bundle endpoint + initContainer fetch; Cilium `toEndpoints` | Egress default-deny enforced; skills reach the pod |
| 4 — Lifecycle + concurrency | `reclaimSandbox(selector)` authority (cron / PR-closed / cancel triggers); quota-backpressure admission | Stale PVCs reaped; runs queue on `ResourceQuota` rejection |
| 5 — Flux manifests (`flux-homelab`) | `Namespace`, `ServiceAccount`, `Role`, `RoleBinding`, `ResourceQuota`; harness Deployment SA | RBAC + quota live on the cluster |

Each subsequent plan is written after its predecessor is executed (its concrete pod-spec shape informs the next).

---

## Task 1: Register the `kubernetes` backend value

**Files:**
- Modify: `packages/workflow-engine/src/…` — the `SandboxBackend` union type (find with `rg -n "gondolin" packages/workflow-engine/src`)
- Modify: `apps/server/src/config/config.ts:618-619` (validator) and `:666` (backend check)
- Test: `apps/server/tests/config/sandbox-backend.test.ts` (create)

**Interfaces:**
- Produces: `SandboxBackend` now includes the literal `"kubernetes"`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/config/sandbox-backend.test.ts
import { describe, it, expect } from "vitest";
import { loadConfigFromLayers } from "#src/config/config-resolve.js"; // adjust to the real loader entry

describe("sandbox.backend: kubernetes", () => {
  it("validates 'kubernetes' as a backend", () => {
    const cfg = loadConfigFromLayers({ sandbox: { backend: "kubernetes" } });
    expect(cfg.sandbox.backend).toBe("kubernetes");
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/config/sandbox-backend.test.ts`
Expected: FAIL — `sandboxBackend` throws `unknown sandbox backend "kubernetes"`.

- [ ] **Step 3: Add `"kubernetes"` to the type and validators**

In the workflow-engine `SandboxBackend` union:
```ts
export type SandboxBackend = "gondolin" | "docker" | "smol" | "none" | "kubernetes";
```
In `config.ts:619`:
```ts
if (raw === "gondolin" || raw === "docker" || raw === "smol" || raw === "none" || raw === "kubernetes") return raw;
```
In `config.ts:666` (the second guard), add `|| backend === "kubernetes"` to the same disjunction.

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/config/sandbox-backend.test.ts`
Expected: PASS. Also run `pnpm --filter lastlight-workflow-engine build` to confirm the type change compiles downstream.

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine apps/server/src/config/config.ts apps/server/tests/config/sandbox-backend.test.ts
git commit -m "feat(sandbox): register the kubernetes backend value"
```

---

## Task 2: Add the client dependency and a `KubeClientFactory`

A thin wrapper isolates `@kubernetes/client-node` construction (in-cluster vs local kubeconfig) so the adapter and tests never touch `KubeConfig` directly and can inject a fake.

**Files:**
- Modify: `apps/server/package.json` (dependency)
- Create: `apps/server/src/sandbox/k8s/client.ts`
- Test: `apps/server/tests/sandbox/k8s/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface K8sApis { core: CoreV1Api; log: Log; }
  export function makeK8sApis(kc?: KubeConfig): K8sApis;  // kc injectable for tests; default loads in-cluster then falls back to default
  ```

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @kubernetes/client-node@1.4.0 --filter lastlight-core`
Verify `apps/server/package.json` pins `"@kubernetes/client-node": "1.4.0"` (no caret).

- [ ] **Step 2: Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/client.test.ts
import { describe, it, expect } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import { makeK8sApis } from "#src/sandbox/k8s/client.js";

describe("makeK8sApis", () => {
  it("builds core + log clients from an injected KubeConfig", () => {
    const kc = new KubeConfig();
    kc.loadFromOptions({ clusters: [{ name: "c", server: "http://127.0.0.1:1" }], users: [{ name: "u" }], contexts: [{ name: "x", cluster: "c", user: "u" }], currentContext: "x" });
    const apis = makeK8sApis(kc);
    expect(apis.core).toBeDefined();
    expect(apis.log).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/client.test.ts`
Expected: FAIL — `Cannot find module '#src/sandbox/k8s/client.js'`.

- [ ] **Step 4: Implement the wrapper**

```ts
// apps/server/src/sandbox/k8s/client.ts
import { KubeConfig, CoreV1Api, Log } from "@kubernetes/client-node";

export interface K8sApis {
  core: CoreV1Api;
  log: Log;
  kc: KubeConfig;
}

/** Build the k8s clients. In-cluster by default (mounted SA token); falls back
 *  to the local kubeconfig for dev. Pass an explicit `kc` in tests. */
export function makeK8sApis(kc?: KubeConfig): K8sApis {
  const config = kc ?? loadInClusterOrDefault();
  return { core: config.makeApiClient(CoreV1Api), log: new Log(config), kc: config };
}

function loadInClusterOrDefault(): KubeConfig {
  const kc = new KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return kc;
}
```

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/sandbox/k8s/client.ts apps/server/tests/sandbox/k8s/client.test.ts
git commit -m "feat(sandbox): add @kubernetes/client-node + KubeClientFactory"
```

---

## Task 3: Pod-name derivation + the sandbox image name

Deterministic, DNS-safe Pod names derived from the taskId, and the sandbox image the Pod runs. Pure functions — no k8s.

**Files:**
- Create: `apps/server/src/sandbox/k8s/naming.ts`
- Test: `apps/server/tests/sandbox/k8s/naming.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function podNameFor(taskId: string, phaseSuffix?: string): string; // ≤63 chars, RFC-1123 label
  export const K8S_SANDBOX_IMAGE: string; // read from config in the adapter; a constant here for the skeleton
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/naming.test.ts
import { describe, it, expect } from "vitest";
import { podNameFor } from "#src/sandbox/k8s/naming.js";

describe("podNameFor", () => {
  it("produces an RFC-1123 label ≤63 chars", () => {
    const name = podNameFor("MyRepo/PR#12_build-ABCDEF", "run");
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith("ll-")).toBe(true);
  });
  it("is deterministic for the same input", () => {
    expect(podNameFor("t", "run")).toBe(podNameFor("t", "run"));
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/naming.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/sandbox/k8s/naming.ts
import { createHash } from "node:crypto";

/** RFC-1123 label: lowercase alnum + '-', ≤63 chars, starts/ends alnum.
 *  We slug the taskId and append a short stable hash to guarantee uniqueness
 *  after truncation. */
export function podNameFor(taskId: string, phaseSuffix = "run"): string {
  const hash = createHash("sha1").update(`${taskId}/${phaseSuffix}`).digest("hex").slice(0, 8);
  const slug = `${taskId}-${phaseSuffix}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `ll-${slug}`.slice(0, 63 - 1 - hash.length).replace(/-+$/g, "");
  return `${base}-${hash}`;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/naming.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/k8s/naming.ts apps/server/tests/sandbox/k8s/naming.test.ts
git commit -m "feat(sandbox): deterministic RFC-1123 pod naming"
```

---

## Task 4: `buildPodManifest` — pure Pod-spec construction

The Pod spec is pure data; build it in a tested pure function so the adapter stays thin and the spec is asserted without a cluster. Plan 1 uses an `emptyDir` workspace and **inline env** (no Secret yet — Plan 2 swaps in `envFrom`), and runs one command.

**Files:**
- Create: `apps/server/src/sandbox/k8s/pod.ts`
- Test: `apps/server/tests/sandbox/k8s/pod.test.ts`

**Interfaces:**
- Consumes: `K8S_SANDBOX_IMAGE` (Task 3-adjacent constant / config).
- Produces:
  ```ts
  export interface PodSpecInput {
    name: string; namespace: string; image: string;
    command: string[];            // container entrypoint argv
    env: Record<string, string>;  // inline for the skeleton
    cwd: string;                  // WORKDIR / -w
    activeDeadlineSeconds: number;
  }
  export function buildPodManifest(i: PodSpecInput): V1Pod;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/pod.test.ts
import { describe, it, expect } from "vitest";
import { buildPodManifest } from "#src/sandbox/k8s/pod.js";

describe("buildPodManifest", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/nearform/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], env: { FOO: "bar" },
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
  });
  it("targets the sandbox namespace and image", () => {
    expect(pod.metadata?.namespace).toBe("lastlight-sandboxes");
    expect(pod.spec?.containers[0].image).toBe("ghcr.io/nearform/lastlight-sandbox:latest");
  });
  it("never restarts and has a deadline", () => {
    expect(pod.spec?.restartPolicy).toBe("Never");
    expect(pod.spec?.activeDeadlineSeconds).toBe(1800);
  });
  it("gives the sandbox pod no service-account token", () => {
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
  });
  it("carries inline env as name/value pairs", () => {
    expect(pod.spec?.containers[0].env).toContainEqual({ name: "FOO", value: "bar" });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/sandbox/k8s/pod.ts
import type { V1Pod } from "@kubernetes/client-node";

export interface PodSpecInput {
  name: string;
  namespace: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  cwd: string;
  activeDeadlineSeconds: number;
}

export function buildPodManifest(i: PodSpecInput): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: { "app.kubernetes.io/managed-by": "lastlight", "lastlight.io/component": "sandbox" },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: i.activeDeadlineSeconds,
      automountServiceAccountToken: false, // an agent needs no k8s API access
      volumes: [{ name: "workspace", emptyDir: {} }],
      containers: [
        {
          name: "agent",
          image: i.image,
          command: i.command,
          workingDir: i.cwd,
          env: Object.entries(i.env).map(([name, value]) => ({ name, value })),
          volumeMounts: [{ name: "workspace", mountPath: i.cwd }],
        },
      ],
    },
  };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/k8s/pod.ts apps/server/tests/sandbox/k8s/pod.test.ts
git commit -m "feat(sandbox): pure Pod-manifest builder (emptyDir, no-token, deadline)"
```

---

## Task 5: `streamPodLog` — follow logs, buffer lines, feed `parseLine`

Wraps `Log.log(...)` into a promise that resolves when the stream ends, forwarding each complete stdout line to a callback. This is the k8s analogue of the docker adapter's `child.stdout` line-buffer loop.

**Files:**
- Create: `apps/server/src/sandbox/k8s/log-stream.ts`
- Test: `apps/server/tests/sandbox/k8s/log-stream.test.ts`

**Interfaces:**
- Consumes: `K8sApis.log` (Task 2).
- Produces:
  ```ts
  export function streamPodLog(
    log: Log, namespace: string, pod: string, container: string,
    onLine: (line: string) => void,
  ): Promise<void>;  // resolves on stream end
  ```

- [ ] **Step 1: Write the failing test** (drive a fake `Log` that writes JSONL to the passed stream)

```ts
// apps/server/tests/sandbox/k8s/log-stream.test.ts
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { streamPodLog } from "#src/sandbox/k8s/log-stream.js";

describe("streamPodLog", () => {
  it("forwards complete lines and resolves on stream end", async () => {
    const fakeLog = {
      log: vi.fn(async (_ns, _pod, _c, stream: PassThrough) => {
        stream.write('{"type":"a"}\n{"type":"b"}\n');
        stream.end();
        return { abort() {} };
      }),
    } as any;
    const lines: string[] = [];
    await streamPodLog(fakeLog, "ns", "p", "agent", (l) => lines.push(l));
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/log-stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/sandbox/k8s/log-stream.ts
import { PassThrough } from "node:stream";
import type { Log } from "@kubernetes/client-node";

/** Stream a pod's stdout (follow) and forward complete lines. Resolves when the
 *  log stream closes (pod terminated). Mirrors the docker adapter's line buffer. */
export function streamPodLog(
  log: Log,
  namespace: string,
  pod: string,
  container: string,
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = new PassThrough();
    let buf = "";
    stream.setEncoding("utf-8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) {
          try { onLine(line); } catch { /* swallow listener errors */ }
        }
      }
    });
    stream.on("end", () => { if (buf.length > 0) { try { onLine(buf); } catch { /* */ } } resolve(); });
    stream.on("error", reject);
    // follow: stream until the container terminates.
    log.log(namespace, pod, container, stream, { follow: true, pretty: false }).catch(reject);
  });
}
```

> **Executor note:** confirm the `Log.log(namespace, pod, container, stream, options)` signature against `@kubernetes/client-node@1.4.0` typings before finalizing; adjust the argument shape if the pinned version differs. Do not guess — read `node_modules/@kubernetes/client-node/dist/log.d.ts`.

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/log-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/k8s/log-stream.ts apps/server/tests/sandbox/k8s/log-stream.test.ts
git commit -m "feat(sandbox): follow pod logs and forward complete lines"
```

---

## Task 6: `KubernetesSandbox` adapter + wire into `sandboxFor`

Assemble Tasks 2–5 into the `Sandbox` adapter. Plan 1 implements `provision` (emptyDir, returns paths), `runCommand` (create pod running the command → stream → collect stdout/exit → delete), a minimal `runAgent` (create pod running `agentic-pi run --sandbox none` → stream via `parseLine(onEvent)` → delete), and `dispose`. `stageSkills`/`sandboxPathFor` are stubs until Plan 3.

**Files:**
- Create: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`
- Modify: `apps/server/src/sandbox/sandbox.ts:227-238` (add the `case "kubernetes"`)
- Test: `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts`

**Interfaces:**
- Consumes: `makeK8sApis`, `buildPodManifest`, `podNameFor`, `streamPodLog`, `parseLine` (existing, in `apps/server/src/sandbox/` — find with `rg -n "export function parseLine"`).
- Produces: `class KubernetesSandbox implements Sandbox`; `sandboxFor("kubernetes", opts)` returns it.

- [ ] **Step 1: Write the failing test** (inject a fake `K8sApis`; assert pod created + deleted, and `onEvent` receives parsed events)

```ts
// apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

function fakeApis() {
  const created: any[] = []; const deleted: string[] = [];
  return {
    apis: {
      core: {
        createNamespacedPod: vi.fn(async ({ body }: any) => { created.push(body); return { body }; }),
        readNamespacedPodStatus: vi.fn(async () => ({ status: { phase: "Succeeded" } })),
        deleteNamespacedPod: vi.fn(async ({ name }: any) => { deleted.push(name); }),
      },
      log: { log: vi.fn(async (_n, _p, _c, s: PassThrough) => { s.write('{"type":"agent_end"}\n'); s.end(); return { abort() {} }; }) },
      kc: {} as any,
    } as any,
    created, deleted,
  };
}

describe("KubernetesSandbox", () => {
  it("runAgent creates a pod, streams parsed events, and deletes the pod", async () => {
    const { apis, created, deleted } = fakeApis();
    const sbx = new KubernetesSandbox(
      { taskId: "t1", egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp", timeoutSeconds: 60 } as any,
      { namespace: "lastlight-sandboxes", image: "img", apis: apis },
    );
    await sbx.provision();
    const events: any[] = [];
    await sbx.runAgent("t1", "hello", { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any, (e) => events.push(e));
    expect(created).toHaveLength(1);
    expect(events).toContainEqual({ type: "agent_end" });
    await sbx.dispose();
    expect(deleted).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes-sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

```ts
// apps/server/src/sandbox/k8s/kubernetes-sandbox.ts
import type { RunResult } from "agentic-pi";
import type {
  Sandbox, SandboxFactoryOpts, PrePopulateSpec, ProvisionResult,
  RunAgentOpts, RunCommandOpts, RawCommandResult, SandboxEvent,
} from "../sandbox.js";
import type { SandboxBackend } from "../../config/config.js";
import { parseLine } from "../sandbox.js"; // confirm the exact export path with rg
import { makeK8sApis, type K8sApis } from "./client.js";
import { buildPodManifest } from "./pod.js";
import { podNameFor } from "./naming.js";
import { streamPodLog } from "./log-stream.js";

const WORKSPACE_DIR = "/home/agent/workspace";

/** Skeleton config the adapter needs; grows in later plans. */
export interface K8sAdapterConfig {
  namespace: string;
  image: string;
  apis?: K8sApis; // injectable for tests
}

export class KubernetesSandbox implements Sandbox {
  readonly backend: SandboxBackend = "kubernetes";
  private readonly apis: K8sApis;
  private readonly ns: string;
  private readonly image: string;
  private activePod?: string;

  constructor(private readonly opts: SandboxFactoryOpts, cfg: K8sAdapterConfig) {
    this.apis = cfg.apis ?? makeK8sApis();
    this.ns = cfg.namespace;
    this.image = cfg.imageName ?? cfg.image;
  }

  async provision(_pre?: PrePopulateSpec): Promise<ProvisionResult> {
    // Plan 1: emptyDir workspace inside the pod; nothing to pre-clone yet.
    return { hostWorkspaceDir: WORKSPACE_DIR, agentCwd: WORKSPACE_DIR };
  }

  stageSkills(_phaseKey: string, _skillPaths: string[] | undefined): string[] | undefined {
    return undefined; // Plan 3
  }
  sandboxPathFor(relPath: string): string { return `${WORKSPACE_DIR}/${relPath}`; }

  async runAgent(
    taskId: string, prompt: string, opts: RunAgentOpts, onEvent: (r: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    const cmd = ["agentic-pi", "run", "--model", opts.model, "--sandbox", "none", "--no-session"];
    // prompt arrives on the container's stdin in Plan 2 (attach); for the
    // skeleton, pass it via a heredoc-safe arg-free stdin substitute:
    await this.runPod(taskId, [...cmd], { ...this.opts.env, ...opts.sandboxEnv }, opts.agentCwd, parseLine(onEvent));
    return undefined; // orchestrator reconstructs from events
  }

  async runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    let stdout = "";
    await this.runPod(taskId, ["sh", "-c", command], { ...this.opts.env, ...(opts.sandboxEnv ?? {}) }, opts.cwd,
      (line) => { stdout += line + "\n"; });
    const phase = await this.apis.core.readNamespacedPodStatus({ name: this.activePod!, namespace: this.ns });
    const ok = phase.status?.phase === "Succeeded";
    return { exitCode: ok ? 0 : 1, stdout, stderr: "", timedOut: false };
  }

  private async runPod(
    taskId: string, command: string[], env: Record<string, string>, cwd: string, onLine: (l: string) => void,
  ): Promise<void> {
    const name = podNameFor(taskId, "run");
    this.activePod = name;
    const manifest = buildPodManifest({
      name, namespace: this.ns, image: this.image, command, env, cwd,
      activeDeadlineSeconds: this.opts.timeoutSeconds ?? 1800,
    });
    await this.apis.core.createNamespacedPod({ namespace: this.ns, body: manifest });
    await streamPodLog(this.apis.log, this.ns, name, "agent", onLine);
  }

  async dispose(): Promise<void> {
    if (!this.activePod) return;
    try {
      await this.apis.core.deleteNamespacedPod({ name: this.activePod, namespace: this.ns });
    } catch { /* already gone — reclaim (Plan 4) is the backstop */ }
    this.activePod = undefined;
  }
}
```

> **Executor note:** the exact `@kubernetes/client-node@1.4.0` method shapes (`createNamespacedPod`, `readNamespacedPodStatus`, `deleteNamespacedPod` — object-param vs positional) must be confirmed against the pinned typings. The **prompt-on-stdin** path is stubbed here; Plan 2 wires the container's stdin via an attach/`--command`-file so the agent receives the prompt. For Plan 1's acceptance we exercise `runCommand` (no stdin needed).

- [ ] **Step 4: Wire the factory** — `apps/server/src/sandbox/sandbox.ts:227`

```ts
    case "kubernetes":
      return new KubernetesSandbox(opts, {
        namespace: process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes",
        image: opts.imageName ?? K8S_SANDBOX_IMAGE, // resolve K8S_SANDBOX_IMAGE from config/images.ts
      });
```
(Import `KubernetesSandbox` at the top of `sandbox.ts`.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes-sandbox.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter lastlight-core exec tsc --noEmit
git add apps/server/src/sandbox
git commit -m "feat(sandbox): KubernetesSandbox adapter (skeleton) wired into sandboxFor"
```

---

## Task 7: Opt-in real-cluster integration test

Gated like `RUN_SANDBOX_IT` so CI skips it; on Robin's cluster (or `kind`) it proves a `type: bash` phase runs in a real Pod and streams back.

**Files:**
- Create: `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts`

**Interfaces:**
- Consumes: `KubernetesSandbox` (real `makeK8sApis`, no fake).

- [ ] **Step 1: Write the gated integration test**

```ts
// apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts
import { describe, it, expect } from "vitest";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

const RUN = process.env.RUN_K8S_IT === "1";
describe.runIf(RUN)("KubernetesSandbox (integration)", () => {
  it("runs a bash command in a real pod and streams stdout", async () => {
    const sbx = new KubernetesSandbox(
      { taskId: `it-${Date.now()}`, egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp", timeoutSeconds: 120 } as any,
      { namespace: process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes", image: process.env.K8S_SANDBOX_IMAGE ?? "ghcr.io/nearform/lastlight-sandbox:latest" },
    );
    await sbx.provision();
    const res = await sbx.runCommand("it", "echo hello-from-pod", { cwd: "/home/agent/workspace", timeoutSeconds: 120 });
    expect(res.stdout).toContain("hello-from-pod");
    expect(res.exitCode).toBe(0);
    await sbx.dispose();
  }, 180_000);
});
```

- [ ] **Step 2: Run it locally against your cluster**

Run: `RUN_K8S_IT=1 LASTLIGHT_K8S_NAMESPACE=lastlight-sandboxes pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts`
Expected: PASS (needs kubeconfig context pointing at the cluster + the namespace to exist — create it manually for Plan 1: `kubectl create ns lastlight-sandboxes`). Without `RUN_K8S_IT=1`, it's skipped.

- [ ] **Step 3: Confirm the default suite still skips it**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/`
Expected: the integration test is skipped; unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts
git commit -m "test(sandbox): opt-in real-cluster integration test for the k8s backend"
```

---

## Self-review (completed by author)

- **Spec coverage (Plan 1 slice):** backend registration (Task 1), client wiring §5 (Task 2), Pod execution §2 bare-Pod + JSONL-over-logs (Tasks 4–6), no-token pods §5 (Task 4), integration test from the spec's Testing section (Task 7). Creds §3, PVC §1, egress §4, skills §7, lifecycle §6, concurrency §8 are **explicitly deferred to Plans 2–4** (roadmap) — not gaps.
- **Placeholders:** the two `Executor note`s flag *version-signature confirmation against pinned typings* and the *stdin-prompt path deferred to Plan 2* — these are real, bounded instructions, not "figure it out" placeholders. Everything a step changes has code.
- **Type consistency:** `K8sApis`, `PodSpecInput`, `podNameFor`, `streamPodLog`, `K8sAdapterConfig` names are used identically across Tasks 2–7; the `Sandbox` method signatures match `sandbox.ts` verbatim.

---

## Execution handoff

Plan 1 is the walking skeleton. When it's green (unit + your cluster integration run), Plan 2 (creds `Secret` + `envFrom`, per-`(repo,PR)` PVC, initContainer clone) gets written against the concrete pod-spec this establishes.
