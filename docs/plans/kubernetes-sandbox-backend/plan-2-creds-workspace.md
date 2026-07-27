# Kubernetes Sandbox Backend — Plan 2: Credentials + Workspace + Prompt

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Plan 1 walking skeleton into a backend that runs a **real AI phase** — the per-run credentials reach the pod through its **own** Secret (killing #223 by construction), the target repo is checked out into a **per-`(repo,PR)` RWO PVC** by an initContainer, the prompt is delivered to `agentic-pi` over stdin from a mounted file, and the pod satisfies the namespace's PodSecurity `restricted` policy.

**Architecture:** `KubernetesSandbox.provision` ensures a PVC exists for the task (or falls back to `emptyDir` for ephemeral runs) and stashes the pre-clone descriptor. Each `runAgent`/`runCommand` then: (1) writes a per-run **creds Secret** (provider keys + minted `GITHUB_TOKEN` + git identity), (2) for `runAgent`, writes a per-run **prompt Secret**, (3) creates the Pod — `envFrom` the creds Secret, an **initContainer** that clones the repo into the PVC, a `securityContext` compliant with `restricted`, and (for `runAgent`) the prompt Secret mounted as a file the entrypoint pipes into `agentic-pi run`'s stdin — (4) patches each Secret's `ownerReference` to the Pod so it cascade-GCs, (5) streams the log, (6) deletes the Pod (Secrets cascade) and **keeps** the PVC.

**Tech Stack:** TypeScript (ESM, NodeNext), `@kubernetes/client-node@1.4.0` (object-param API), vitest.

## Locked decisions (this plan)

Two mechanisms were left open by Plan 1's design ("via stdin (attach) **or** a mounted prompt file"; "the #107 reuse logic, relocated into the pod"). Resolved with Robin, 2026-07-24:

1. **Prompt delivery = mounted Secret file → stdin (NOT k8s attach).** `agentic-pi run` reads its prompt from **stdin only** (`packages/agentic-pi/src/cli.ts:38` → `readStdin()`), exactly as the docker backend pipes it via `docker exec -i` (`src/sandbox/docker.ts:434`). The k8s `Attach` API would have to win a race against the container calling `readStdin()` on startup (lose → `empty prompt on stdin` → dead run) and hold a second long-lived websocket. A prompt file mounted from a per-run Secret has **no race** (present before the container's first instruction), reuses the same Secret create→ownerRef→cascade machinery, and carries the same at-rest exposure the creds already have.

2. **initContainer clone = minimal now; #107 reuse logic deferred to Plan 4.** Plan 2's testable outcome ("an AI phase runs against a checked-out repo with a scoped token; #223 gone") needs only `git clone --branch --depth` + the clone-default-then-`checkout -B` fallback. The rest of `prePopulateWorkspace` (`src/sandbox/index.ts`) — in-place `fetch`+`reset`+`clean -e node_modules`, `recreateFromBase`, and `ensureBaseAvailable` merge-base deepening — is **optimization** (PVC reuse across runs; pr-review's three-dot diff) that belongs with the PVC **lifecycle** work in Plan 4, next to `reclaimSandbox`. Porting all its branches into initContainer bash now (~200 lines, a DRY liability in a second language) would bloat this plan and delay end-to-end validation. **This narrows the handover's literal Plan 2 scope — deliberately, with sign-off (see the roadmap correction below).**

## Roadmap correction

Plan 1's roadmap put "initContainer clone/refresh (the #107 reuse logic)" in Plan 2. Per locked decision #2 the **reuse/refresh/merge-base** portion moves to **Plan 4** (lifecycle + concurrency), where `reclaimSandbox` and PVC retention live. Plan 2 keeps the **minimal clone**. The rest of Plan 2's original scope (creds Secret, PVC, prompt, securityContext, image config) is unchanged.

| Plan | Delivers | Testable outcome |
|---|---|---|
| 1 — Walking skeleton (done) | `kubernetes` backend; create→stream→reap; `runCommand` | A `type: bash` phase runs in a real Pod, output streams back |
| **2 — Creds + workspace + prompt** (this doc) | Per-run creds/prompt `Secret`s (`envFrom` + mounted file, ownerRef); per-`(repo,PR)` RWO PVC + **minimal** initContainer clone; `securityContext` for `restricted`; `sandbox.kubernetes.*` config incl. registry-qualified image | An **AI phase** runs against a checked-out repo with a scoped token; #223 gone; PodSecurity `restricted` satisfied |
| 3 — Egress + skills | strict/open `CiliumNetworkPolicy` from `egress-allowlist.ts`; HTTP skill-bundle endpoint + initContainer fetch | Egress default-deny enforced; skills reach the pod |
| 4 — Lifecycle + concurrency | `reclaimSandbox(selector)`; quota-backpressure admission; **#107 PVC reuse/refresh + merge-base deepening** (moved from Plan 2) | Stale PVCs reaped; PVC reuse warm across runs; runs queue on `ResourceQuota` |
| 5 — Flux manifests | `Namespace`, `SA`, `Role`, `RoleBinding`, `ResourceQuota` | RBAC + quota live on the cluster |

---

## Global Constraints

- **Node ≥ 22.12**; ESM only; relative imports use `.js` extensions (NodeNext).
- **Do not mutate `process.env`** anywhere in this backend (#223 is the whole point — per-run env lives on the Pod, not the harness global).
- **Hard rule #8:** only the minted short-lived `GITHUB_TOKEN` crosses into the pod; the App PEM never leaves the harness. The creds Secret carries the *minted token + provider keys + git identity* — never `GITHUB_APP_PRIVATE_KEY_PATH` or PEM bytes.
- **`@kubernetes/client-node` is pinned at `1.4.0`** (object-param API). Every new API call (`createNamespacedSecret`, `patchNamespacedSecret`, `createNamespacedPersistentVolumeClaim`, `readNamespacedPersistentVolumeClaim`) **must be verified against the pinned typings** before finalizing — read `node_modules/@kubernetes/client-node/dist/gen/api/coreV1Api.d.ts`. Do not guess the argument shape; Plan 1 already hit a 1.4.0 signature difference.
- **PodSecurity `restricted` (namespace `lastlight-sandboxes`)** requires, on **every** container incl. initContainers: `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, `runAsNonRoot: true`, `seccompProfile.type: RuntimeDefault`. Pod-level sets `runAsNonRoot`, `runAsUser`, `seccompProfile`; containers inherit but the container-level fields above must still be present.
- **Secret keys** must match `[-._a-zA-Z0-9]+`. Env-var keys are UPPER_SNAKE → valid. Put arbitrary-value data in `stringData` (k8s base64-encodes it).
- **ownerReference ordering is fixed:** Secrets must **exist before** the Pod is created (a Pod whose `envFrom`/volume names a missing Secret fails to start with `CreateContainerConfigError`, which Plan 1's `FATAL_WAITING_REASONS` fails fast on). So the sequence is always: create Secret(s) → create Pod → read Pod `.metadata.uid` → patch each Secret's `ownerReference`. On a Pod-create failure, explicitly delete the just-created Secrets.
- **Reuse, don't reinvent:** the merged env the Secret carries is the adapter's existing `{ ...this.opts.env, ...sandboxEnv }` map (already assembled by the orchestrator — provider keys + minted token + git identity). The line→event parser stays `parseLine(onEvent)` from `sandbox.ts`.
- **`SandboxFactoryOpts` is unchanged** by this plan — the k8s config is resolved from `getRuntimeConfig()`/env in the factory, not threaded through opts.

### Naming distinction (important)

- **Pod name** — per *invocation*, already `podNameFor(taskId, "run")` (Plan 1): a Pod is created and reaped per phase.
- **PVC name** — per *`(repo,PR)`*, **stable across runs/phases** so it is reused. Derive it from the `taskId` **only** (no run/phase hash), sanitised to an RFC-1123 label with a `ws-` prefix. `taskId` is already the harness's per-`(repo,PR)` reuse key (docker/none reuse `sandboxes/<taskId>/`).

---

## Task 1: `sandbox.kubernetes` config surface + registry-qualified image

The factory path today hardcodes `namespace` from an env var and the image to the **docker-local** tag `lastlight-sandbox:latest` (`sandbox.ts:242`), which `ImagePullBackOff`s on a real cluster. Add a real `sandbox.kubernetes` config block (design.md "Harness config surface") with a **registry-qualified** default in the **yo61** org, resolved by a pure helper the factory calls.

**Files:**
- Modify: `apps/server/src/config/config.ts` — add `KubernetesConfig`, normalize `sandbox.kubernetes`, expose it, add `resolveKubernetesConfig()`
- Modify: `apps/server/src/sandbox/sandbox.ts:239-243` — `case "kubernetes"` reads the resolved config
- Test: `apps/server/tests/config/kubernetes-config.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface KubernetesConfig {
    namespace: string;        // default "lastlight-sandboxes"
    image: string;            // default "ghcr.io/yo61/lastlight-sandbox:latest"
    storageClassName: string; // default "truenas-iscsi"
    workspaceSize: string;    // default "5Gi"
    runAsUser: number;        // default 10001 (the sandbox image's `agent` uid)
  }
  export function resolveKubernetesConfig(): KubernetesConfig; // runtime config → env overrides → defaults
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/config/kubernetes-config.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveKubernetesConfig } from "#src/config/config.js";

const K8S_ENV = [
  "LASTLIGHT_K8S_NAMESPACE", "K8S_SANDBOX_IMAGE",
  "LASTLIGHT_K8S_STORAGE_CLASS", "LASTLIGHT_K8S_WORKSPACE_SIZE", "LASTLIGHT_K8S_RUN_AS_USER",
];

describe("resolveKubernetesConfig", () => {
  afterEach(() => { for (const k of K8S_ENV) delete process.env[k]; });

  it("defaults to the yo61 registry-qualified image and the sandbox namespace", () => {
    const cfg = resolveKubernetesConfig();
    expect(cfg.image).toBe("ghcr.io/yo61/lastlight-sandbox:latest");
    expect(cfg.namespace).toBe("lastlight-sandboxes");
    expect(cfg.storageClassName).toBe("truenas-iscsi");
    expect(cfg.workspaceSize).toBe("5Gi");
    expect(cfg.runAsUser).toBe(10001);
  });

  it("lets env override the image, namespace, and runAsUser", () => {
    process.env.K8S_SANDBOX_IMAGE = "alpine/git:latest";
    process.env.LASTLIGHT_K8S_NAMESPACE = "ll-test";
    process.env.LASTLIGHT_K8S_RUN_AS_USER = "1000";
    const cfg = resolveKubernetesConfig();
    expect(cfg.image).toBe("alpine/git:latest");
    expect(cfg.namespace).toBe("ll-test");
    expect(cfg.runAsUser).toBe(1000);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/config/kubernetes-config.test.ts`
Expected: FAIL — `resolveKubernetesConfig` is not exported.

- [ ] **Step 3: Implement**

In `config.ts`, add the interface and resolver. `resolveKubernetesConfig` reads the normalized `sandbox.kubernetes` block (add it to `normalizeFileConfig`'s `sandbox` handling near `config.ts:492`, mirroring how `maxTurns` is read from `sandboxRaw`), then applies env overrides and defaults:

```ts
export interface KubernetesConfig {
  namespace: string;
  image: string;
  storageClassName: string;
  workspaceSize: string;
  runAsUser: number;
}

const K8S_DEFAULTS: KubernetesConfig = {
  namespace: "lastlight-sandboxes",
  image: "ghcr.io/yo61/lastlight-sandbox:latest",
  storageClassName: "truenas-iscsi",
  workspaceSize: "5Gi",
  runAsUser: 10001,
};

/** Resolve the kubernetes-backend config: runtime `sandbox.kubernetes` block
 *  (if loaded) → env overrides → defaults. Kept default-safe so the factory can
 *  call it even before `getRuntimeConfig()` has been set (tests). */
export function resolveKubernetesConfig(): KubernetesConfig {
  const fromFile = getRuntimeConfigOrUndefined()?.sandbox; // see note below
  const k = (fromFile && typeof fromFile === "object" && "kubernetes" in fromFile
    ? (fromFile as { kubernetes?: Partial<KubernetesConfig> }).kubernetes
    : undefined) ?? {};
  const runAsUserEnv = parseInt(process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "", 10);
  return {
    namespace: process.env.LASTLIGHT_K8S_NAMESPACE ?? k.namespace ?? K8S_DEFAULTS.namespace,
    image: process.env.K8S_SANDBOX_IMAGE ?? k.image ?? K8S_DEFAULTS.image,
    storageClassName:
      process.env.LASTLIGHT_K8S_STORAGE_CLASS ?? k.storageClassName ?? K8S_DEFAULTS.storageClassName,
    workspaceSize:
      process.env.LASTLIGHT_K8S_WORKSPACE_SIZE ?? k.workspaceSize ?? K8S_DEFAULTS.workspaceSize,
    runAsUser: Number.isFinite(runAsUserEnv) ? runAsUserEnv : k.runAsUser ?? K8S_DEFAULTS.runAsUser,
  };
}
```

> **Executor note:** the current `RuntimeConfig.sandbox` field is just the `SandboxBackend` string (`config.ts:112`), and `normalizeFileConfig` returns `sandbox: { backend, maxTurns }` (`config.ts:538`). Do NOT reshape `RuntimeConfig.sandbox` (many call sites read it as the backend string). Instead: (a) normalize a `sandbox.kubernetes` sub-block inside `normalizeFileConfig` (read `sandboxRaw.kubernetes` with `isPlainObject`, string/number-guard each field), (b) surface the normalized `KubernetesConfig | undefined` on `RuntimeConfig` under a **new** field (e.g. `kubernetes?: KubernetesConfig`, alongside `sandbox`), and (c) have `resolveKubernetesConfig` read *that* field. If a `getRuntimeConfig`-or-undefined accessor doesn't already exist, add one (the existing `getRuntimeConfig()` throws when unset — wrap it in try/catch or add `getRuntimeConfigOrUndefined()`). Keep the resolver default-safe.

- [ ] **Step 4: Wire the factory** — `apps/server/src/sandbox/sandbox.ts:239`

```ts
    case "kubernetes": {
      const k = resolveKubernetesConfig();
      return new KubernetesSandbox(opts, {
        namespace: k.namespace,
        image: opts.imageName ?? k.image,
        storageClassName: k.storageClassName,
        workspaceSize: k.workspaceSize,
        runAsUser: k.runAsUser,
      });
    }
```
(Import `resolveKubernetesConfig` from `../config/config.js`; the `K8sAdapterConfig` fields `storageClassName`/`workspaceSize`/`runAsUser` are added in Tasks 2 & 5 — until then keep only the fields the adapter accepts and add the rest as those tasks land. To avoid a mid-plan type break, add all five fields to `K8sAdapterConfig` in this task as optional, then make them required in Task 6.)

- [ ] **Step 5: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/config/kubernetes-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
pnpm --filter agentic-pi build && pnpm --filter lastlight-core exec tsc --noEmit
git add apps/server/src/config/config.ts apps/server/src/sandbox/sandbox.ts apps/server/tests/config/kubernetes-config.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): sandbox.kubernetes config + registry-qualified yo61 image"
```

---

## Task 2: `securityContext` for PodSecurity `restricted`

Add a config-driven `securityContext` to `buildPodManifest` so pods satisfy the namespace's `restricted` policy (currently WARN — the skeleton still creates; this lets it survive a flip to `enforce`).

**Files:**
- Modify: `apps/server/src/sandbox/k8s/pod.ts`
- Test: `apps/server/tests/sandbox/k8s/pod.test.ts`

**Interfaces:**
- Consumes: `PodSpecInput` (extended with `runAsUser: number`).
- Produces: pod + container `securityContext` fields.

- [ ] **Step 1: Write the failing test** (append to `pod.test.ts`)

```ts
describe("buildPodManifest securityContext", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/yo61/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], env: { FOO: "bar" },
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
    runAsUser: 10001,
  });
  it("sets a restricted-compliant pod securityContext", () => {
    expect(pod.spec?.securityContext?.runAsNonRoot).toBe(true);
    expect(pod.spec?.securityContext?.runAsUser).toBe(10001);
    expect(pod.spec?.securityContext?.seccompProfile?.type).toBe("RuntimeDefault");
  });
  it("sets a restricted-compliant container securityContext", () => {
    const c = pod.spec?.containers[0];
    expect(c?.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c?.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: FAIL — `runAsUser` is not a `PodSpecInput` field / `securityContext` undefined.

- [ ] **Step 3: Implement** — add `runAsUser: number` to `PodSpecInput`, and in `buildPodManifest`:

```ts
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: i.activeDeadlineSeconds,
      automountServiceAccountToken: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: i.runAsUser,
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [{ name: "workspace", emptyDir: {} }],
      containers: [
        {
          name: "agent",
          image: i.image,
          command: i.command,
          workingDir: i.cwd,
          env: Object.entries(i.env).map(([name, value]) => ({ name, value })),
          volumeMounts: [{ name: "workspace", mountPath: i.cwd }],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: PASS (existing pod tests still green — pass `runAsUser: 10001` in their input).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/k8s/pod.ts apps/server/tests/sandbox/k8s/pod.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): PodSecurity restricted securityContext on k8s pods"
```

---

## Task 3: Per-run creds `Secret` + `envFrom` (remove the inline-env path)

Build the creds Secret as a pure function, and switch the Pod from inline `env` (visible via `kubectl get pod -o yaml`) to `envFrom: [{ secretRef }]`. This is the #223 fix's on-cluster half and closes the kubectl-visible-env exposure the Plan 1 final review flagged.

**Files:**
- Create: `apps/server/src/sandbox/k8s/secret.ts`
- Modify: `apps/server/src/sandbox/k8s/pod.ts` (env → envFromSecret)
- Test: `apps/server/tests/sandbox/k8s/secret.test.ts` (create), `apps/server/tests/sandbox/k8s/pod.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // secret.ts
  export function buildSecretManifest(i: {
    name: string; namespace: string; data: Record<string, string>;
    labels?: Record<string, string>;
  }): V1Secret;
  /** ownerReference to a Pod, for cascade-GC of the Secret when the Pod dies. */
  export function podOwnerReference(podName: string, podUid: string): V1OwnerReference;
  export function secretNameFor(podName: string, kind: "creds" | "prompt"): string;
  ```
- `PodSpecInput` change: replace `env: Record<string, string>` with `envFromSecret: string` (the creds Secret name).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/tests/sandbox/k8s/secret.test.ts
import { describe, it, expect } from "vitest";
import { buildSecretManifest, podOwnerReference, secretNameFor } from "#src/sandbox/k8s/secret.js";

describe("buildSecretManifest", () => {
  it("puts values in stringData under the namespace with an Opaque type", () => {
    const s = buildSecretManifest({
      name: "ll-x-creds", namespace: "lastlight-sandboxes",
      data: { GITHUB_TOKEN: "ghs_abc", ANTHROPIC_API_KEY: "sk-1" },
    });
    expect(s.metadata?.namespace).toBe("lastlight-sandboxes");
    expect(s.type).toBe("Opaque");
    expect(s.stringData).toEqual({ GITHUB_TOKEN: "ghs_abc", ANTHROPIC_API_KEY: "sk-1" });
  });
});

describe("podOwnerReference", () => {
  it("is a controller ref that blocks owner deletion", () => {
    const ref = podOwnerReference("ll-x", "uid-123");
    expect(ref).toMatchObject({
      apiVersion: "v1", kind: "Pod", name: "ll-x", uid: "uid-123",
      controller: true, blockOwnerDeletion: true,
    });
  });
});

describe("secretNameFor", () => {
  it("derives distinct RFC-1123 creds/prompt names from the pod name", () => {
    expect(secretNameFor("ll-x-abc123", "creds")).toBe("ll-x-abc123-creds");
    expect(secretNameFor("ll-x-abc123", "prompt")).toBe("ll-x-abc123-prompt");
  });
});
```

```ts
// append to pod.test.ts
describe("buildPodManifest creds via envFrom", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "img", command: ["sh", "-c", "true"],
    envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
    activeDeadlineSeconds: 1800, runAsUser: 10001,
  });
  it("pulls env from the creds Secret, not inline values", () => {
    const c = pod.spec?.containers[0];
    expect(c?.envFrom).toContainEqual({ secretRef: { name: "ll-x-creds" } });
    expect(c?.env).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/secret.test.ts tests/sandbox/k8s/pod.test.ts`
Expected: FAIL — `secret.js` missing; `envFromSecret` not a `PodSpecInput` field.

- [ ] **Step 3: Implement `secret.ts`**

```ts
// apps/server/src/sandbox/k8s/secret.ts
import type { V1Secret, V1OwnerReference } from "@kubernetes/client-node";

export function buildSecretManifest(i: {
  name: string;
  namespace: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
}): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: { "app.kubernetes.io/managed-by": "lastlight", ...(i.labels ?? {}) },
    },
    // stringData: k8s base64-encodes on write; keeps the builder plaintext-simple.
    stringData: i.data,
  };
}

/** Cascade-GC ref: when the Pod is deleted, k8s GCs the owned Secret. */
export function podOwnerReference(podName: string, podUid: string): V1OwnerReference {
  return {
    apiVersion: "v1",
    kind: "Pod",
    name: podName,
    uid: podUid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

export function secretNameFor(podName: string, kind: "creds" | "prompt"): string {
  return `${podName}-${kind}`; // podName is already an RFC-1123 label ≤63; +7/+8 stays ≤63 (pod base ≤55)
}
```

> **Executor note:** confirm `podName` length budget — `podNameFor` caps at 63; `secretNameFor` appends `-creds`/`-prompt` (7/8 chars). Plan 1's `podNameFor` already reserves room (base sliced to `63 - 1 - hash`), so worst-case pod name is ≤63 but the suffix could exceed 63. Tighten `podNameFor`'s slice budget by 8 (or truncate in `secretNameFor`) so the Secret name stays a valid label. Add a test asserting `secretNameFor(podNameFor("x".repeat(80)), "prompt").length <= 63`.

- [ ] **Step 4: Implement the `pod.ts` change** — replace `env` with `envFromSecret`:

```ts
export interface PodSpecInput {
  name: string;
  namespace: string;
  image: string;
  command: string[];
  envFromSecret: string;   // creds Secret name (was: env: Record<string,string>)
  cwd: string;
  activeDeadlineSeconds: number;
  runAsUser: number;
}
// …in the container:
          // env now arrives from the per-run creds Secret — never inline (kubectl-visible).
          envFrom: [{ secretRef: { name: i.envFromSecret } }],
```
(Delete the `env: Object.entries(...)` line.)

- [ ] **Step 5: Run them, verify they pass**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/secret.test.ts tests/sandbox/k8s/pod.test.ts`
Expected: PASS. (Update Task-2's pod tests that passed `env:` to pass `envFromSecret:` instead.)

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sandbox/k8s/secret.ts apps/server/src/sandbox/k8s/pod.ts apps/server/tests/sandbox/k8s/
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): per-run creds Secret + envFrom (remove inline-env path)"
```

---

## Task 4: Prompt delivery — mounted Secret file → stdin

Deliver the `runAgent` prompt to `agentic-pi` via a per-run prompt Secret mounted as a file, with the entrypoint piping it into stdin. `buildPodManifest` gains an optional prompt mount; the command-wrapping (`… < /lastlight/prompt`) is the adapter's job (Task 6), so this task only wires the mount + the mount-path constant.

**Files:**
- Modify: `apps/server/src/sandbox/k8s/pod.ts`
- Test: `apps/server/tests/sandbox/k8s/pod.test.ts`

**Interfaces:**
- Produces: `export const PROMPT_MOUNT_DIR = "/lastlight";` and `export const PROMPT_FILE = "/lastlight/prompt";`
- `PodSpecInput` gains optional `promptSecret?: string` (prompt Secret name; when set, mount its `prompt` key as a file at `PROMPT_FILE`).

- [ ] **Step 1: Write the failing test**

```ts
import { buildPodManifest, PROMPT_FILE } from "#src/sandbox/k8s/pod.js";

describe("buildPodManifest prompt mount", () => {
  it("mounts the prompt Secret's `prompt` key as a read-only file when set", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "lastlight-sandboxes", image: "img",
      command: ["sh", "-c", "exec agentic-pi run --model m --sandbox none --no-session < " + PROMPT_FILE],
      envFromSecret: "ll-x-creds", promptSecret: "ll-x-prompt",
      cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800, runAsUser: 10001,
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "prompt");
    expect(vol?.secret).toMatchObject({
      secretName: "ll-x-prompt",
      items: [{ key: "prompt", path: "prompt" }],
    });
    const mount = pod.spec?.containers[0].volumeMounts?.find((m) => m.name === "prompt");
    expect(mount).toMatchObject({ mountPath: "/lastlight", readOnly: true });
  });

  it("omits the prompt volume when no promptSecret is given (runCommand path)", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "lastlight-sandboxes", image: "img",
      command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
      cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800, runAsUser: 10001,
    });
    expect(pod.spec?.volumes?.some((v) => v.name === "prompt")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: FAIL — `PROMPT_FILE` / `promptSecret` don't exist.

- [ ] **Step 3: Implement** — add the constants and conditional volume/mount:

```ts
export const PROMPT_MOUNT_DIR = "/lastlight";
export const PROMPT_FILE = `${PROMPT_MOUNT_DIR}/prompt`;
```
Add `promptSecret?: string` to `PodSpecInput`. In `buildPodManifest`, when `i.promptSecret` is set, append to `volumes` a Secret volume that projects only the `prompt` key, and to the container's `volumeMounts` a read-only mount at `PROMPT_MOUNT_DIR`:

```ts
      volumes: [
        { name: "workspace", emptyDir: {} },
        ...(i.promptSecret
          ? [{ name: "prompt", secret: { secretName: i.promptSecret, items: [{ key: "prompt", path: "prompt" }] } }]
          : []),
      ],
      // …container.volumeMounts:
          volumeMounts: [
            { name: "workspace", mountPath: i.cwd },
            ...(i.promptSecret ? [{ name: "prompt", mountPath: PROMPT_MOUNT_DIR, readOnly: true }] : []),
          ],
```

- [ ] **Step 4: Run it, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sandbox/k8s/pod.ts apps/server/tests/sandbox/k8s/pod.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): mount the per-run prompt Secret as a stdin file"
```

---

## Task 5: PVC + minimal-clone initContainer

Per `(repo,PR)` RWO PVC (design B) with a **stable** name, plus an initContainer that clones the repo into it (locked decision #2: `clone --branch --depth` + clone-default-then-`checkout -B` fallback only). Ephemeral runs (no pre-clone descriptor) keep the `emptyDir` workspace.

**Files:**
- Create: `apps/server/src/sandbox/k8s/pvc.ts` (`pvcNameFor`, `buildPvcManifest`)
- Create: `apps/server/src/sandbox/k8s/init-clone.ts` (`buildCloneInitContainer`)
- Modify: `apps/server/src/sandbox/k8s/naming.ts` (add `pvcNameFor` — or place it in `pvc.ts`)
- Modify: `apps/server/src/sandbox/k8s/pod.ts` (workspace = PVC | emptyDir; optional initContainer)
- Test: `apps/server/tests/sandbox/k8s/pvc.test.ts`, `init-clone.test.ts`, `pod.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // pvc.ts
  export function pvcNameFor(taskId: string): string;       // ws-<slug>, stable per (repo,PR), RFC-1123 ≤63
  export function buildPvcManifest(i: {
    name: string; namespace: string; storageClassName: string; size: string;
  }): V1PersistentVolumeClaim;                              // accessModes: ["ReadWriteOnce"]
  // init-clone.ts
  export interface CloneSpec { owner: string; repo: string; branch: string; cwd: string; runAsUser: number; }
  export function buildCloneInitContainer(image: string, spec: CloneSpec): V1Container;
  ```
- `PodSpecInput` change: `workspace: { kind: "pvc"; claimName: string } | { kind: "emptyDir" }`; optional `initContainers?: V1Container[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// pvc.test.ts
import { describe, it, expect } from "vitest";
import { pvcNameFor, buildPvcManifest } from "#src/sandbox/k8s/pvc.js";

describe("pvcNameFor", () => {
  it("is a stable RFC-1123 ws- name (no per-run hash)", () => {
    expect(pvcNameFor("acme-web-pr12")).toBe(pvcNameFor("acme-web-pr12"));
    expect(pvcNameFor("acme-web-pr12")).toMatch(/^ws-[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(pvcNameFor("Acme/Web#PR12").length).toBeLessThanOrEqual(63);
  });
});

describe("buildPvcManifest", () => {
  it("is an RWO claim in the sandbox namespace with the requested class + size", () => {
    const pvc = buildPvcManifest({
      name: "ws-acme-web-pr12", namespace: "lastlight-sandboxes",
      storageClassName: "truenas-iscsi", size: "5Gi",
    });
    expect(pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec?.storageClassName).toBe("truenas-iscsi");
    expect(pvc.spec?.resources?.requests?.storage).toBe("5Gi");
  });
});
```

```ts
// init-clone.test.ts
import { describe, it, expect } from "vitest";
import { buildCloneInitContainer } from "#src/sandbox/k8s/init-clone.js";

describe("buildCloneInitContainer", () => {
  const c = buildCloneInitContainer("ghcr.io/yo61/lastlight-sandbox:latest", {
    owner: "acme", repo: "web", branch: "feature/x",
    cwd: "/home/agent/workspace", runAsUser: 10001,
  });
  it("runs a restricted-compliant clone init with the repo coordinates", () => {
    expect(c.name).toBe("clone");
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] },
    });
    const script = (c.command ?? []).join(" ") + " " + (c.args ?? []).join(" ");
    expect(script).toContain("github.com/acme/web");
    expect(script).toContain("feature/x");
  });
  it("delivers git auth from env (GIT_CONFIG_* via the creds Secret), never a URL token", () => {
    // The extraheader arrives via envFrom the creds Secret (agentGitIdentityEnv);
    // the script must not interpolate a token into the clone URL.
    const script = (c.args ?? []).join(" ");
    expect(script).not.toMatch(/x-access-token:/);
  });
  it("skips cloning when the PVC already holds a checkout (idempotent reuse)", () => {
    const script = (c.args ?? []).join(" ");
    expect(script).toContain(".git"); // guards on an existing checkout
  });
});
```

```ts
// pod.test.ts — workspace selection
describe("buildPodManifest workspace", () => {
  it("backs the workspace with the PVC and attaches the init clone when kind=pvc", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "pvc", claimName: "ws-acme-web-pr12" },
      initContainers: [{ name: "clone", image: "img" }],
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.persistentVolumeClaim?.claimName).toBe("ws-acme-web-pr12");
    expect(pod.spec?.initContainers?.[0].name).toBe("clone");
  });
  it("uses emptyDir with no init when kind=emptyDir", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" },
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "workspace");
    expect(vol?.emptyDir).toBeDefined();
    expect(pod.spec?.initContainers).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pvc.test.ts tests/sandbox/k8s/init-clone.test.ts tests/sandbox/k8s/pod.test.ts`
Expected: FAIL — modules missing; `workspace`/`initContainers` not `PodSpecInput` fields.

- [ ] **Step 3: Implement `pvc.ts`**

```ts
// apps/server/src/sandbox/k8s/pvc.ts
import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";

/** Stable per-(repo,PR) claim name — NO run/phase hash, so pods reuse it. */
export function pvcNameFor(taskId: string): string {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `ws-${slug}`.slice(0, 63).replace(/-+$/g, "");
}

export function buildPvcManifest(i: {
  name: string; namespace: string; storageClassName: string; size: string;
}): V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: i.name, namespace: i.namespace,
      labels: { "app.kubernetes.io/managed-by": "lastlight", "lastlight.io/component": "workspace" },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: i.storageClassName,
      resources: { requests: { storage: i.size } },
    },
  };
}
```

- [ ] **Step 4: Implement `init-clone.ts`** (minimal clone; auth via env `GIT_CONFIG_*` from the creds Secret; idempotent)

```ts
// apps/server/src/sandbox/k8s/init-clone.ts
import type { V1Container } from "@kubernetes/client-node";

export interface CloneSpec {
  owner: string;
  repo: string;
  branch: string;
  cwd: string;      // workspace mount root; repo checkout lands at <cwd>/<repo>
  runAsUser: number;
}

/**
 * Minimal clone init (locked decision #2): clone the branch shallow-ish; if the
 * branch isn't on the remote yet (build-style first run), clone the default
 * branch and cut the branch locally. Idempotent: if the PVC already holds a
 * checkout, do nothing (Plan 4 adds fetch+reset refresh + merge-base deepening).
 *
 * Auth is the github.com-scoped `http.extraheader` delivered as `GIT_CONFIG_*`
 * env from the creds Secret (agentGitIdentityEnv) — no token in any URL.
 */
export function buildCloneInitContainer(image: string, spec: CloneSpec): V1Container {
  const url = `https://github.com/${spec.owner}/${spec.repo}.git`;
  const repoDir = `${spec.cwd}/${spec.repo}`;
  // Single-quoted heredoc-free script; values are validated backend-side
  // (owner/repo/branch come from the trigger, asserted upstream). Keep it POSIX sh.
  const script = [
    "set -eu",
    `if [ -d '${repoDir}/.git' ]; then echo '[clone] existing checkout — skipping'; exit 0; fi`,
    `if git clone --branch '${spec.branch}' --depth 50 '${url}' '${repoDir}'; then`,
    `  git -C '${repoDir}' remote set-url origin '${url}'`,
    "else",
    `  echo '[clone] branch not on remote — cloning default and cutting ${spec.branch}'`,
    `  git clone --depth 50 '${url}' '${repoDir}'`,
    `  git -C '${repoDir}' checkout -B '${spec.branch}'`,
    `  git -C '${repoDir}' remote set-url origin '${url}'`,
    "fi",
  ].join("\n");
  return {
    name: "clone",
    image,
    command: ["sh", "-c"],
    args: [script],
    workingDir: spec.cwd,
    envFrom: [], // populated in the pod builder to share the creds Secret (GIT_CONFIG_* extraheader)
    volumeMounts: [{ name: "workspace", mountPath: spec.cwd }],
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
  };
}
```

> **Executor note:** the initContainer needs the same `GIT_CONFIG_*` extraheader env the main container gets (it does the authenticated clone). Simplest: the pod builder sets `initContainers[].envFrom = [{ secretRef: { name: envFromSecret } }]` (same creds Secret) rather than the builder here — so `buildCloneInitContainer` returns `envFrom: []` and Task-5 pod code fills it. Assert in `pod.test.ts` that the init clone's `envFrom` references the creds Secret. Do NOT put a token in the URL (the `x-access-token:` guard test enforces this).

- [ ] **Step 5: Implement the `pod.ts` change** — `workspace` union + `initContainers`:

```ts
export interface PodSpecInput {
  // …existing…
  workspace: { kind: "pvc"; claimName: string } | { kind: "emptyDir" };
  initContainers?: V1Container[];
}
// volumes: pick PVC or emptyDir for the "workspace" volume
      volumes: [
        i.workspace.kind === "pvc"
          ? { name: "workspace", persistentVolumeClaim: { claimName: i.workspace.claimName } }
          : { name: "workspace", emptyDir: {} },
        ...(i.promptSecret ? [/* prompt volume from Task 4 */] : []),
      ],
// spec: attach initContainers when present, each getting the creds envFrom
      ...(i.initContainers && i.initContainers.length
        ? { initContainers: i.initContainers.map((c) => ({ ...c, envFrom: [{ secretRef: { name: i.envFromSecret } }] })) }
        : {}),
```

- [ ] **Step 6: Run all three test files, verify pass**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pvc.test.ts tests/sandbox/k8s/init-clone.test.ts tests/sandbox/k8s/pod.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sandbox/k8s/pvc.ts apps/server/src/sandbox/k8s/init-clone.ts apps/server/src/sandbox/k8s/pod.ts apps/server/tests/sandbox/k8s/
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): per-(repo,PR) RWO PVC + minimal-clone initContainer"
```

---

## Task 6: Wire the adapter — Secrets, PVC, prompt, ownerRef, cascade

Assemble Tasks 1–5 in `KubernetesSandbox`: `provision` ensures the PVC (or picks `emptyDir`) and stashes the pre-clone descriptor; `runAgent`/`runCommand` create the creds Secret (+ prompt Secret for `runAgent`), create the Pod, patch ownerRefs, stream, and reap. **Removes the Plan 1 `runAgent` stub** — the prompt now reaches the container.

**Files:**
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`
- Modify: `apps/server/src/sandbox/k8s/client.ts` (if it needs to expose the added CoreV1 methods — it exposes `core` already, so likely no change)
- Test: `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts`

**Interfaces:**
- Consumes: `buildSecretManifest`, `podOwnerReference`, `secretNameFor`, `pvcNameFor`, `buildPvcManifest`, `buildCloneInitContainer`, `PROMPT_FILE`, `buildPodManifest` (all Tasks 2–5).
- `K8sAdapterConfig` finalized: `{ namespace; image; storageClassName; workspaceSize; runAsUser; apis? }` (all required except `apis`).

- [ ] **Step 1: Write the failing test** (extend the fake `K8sApis` from Plan 1 with secret/PVC methods; assert the full choreography)

```ts
// apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts (add cases)
function fakeApis() {
  const created: any = { pods: [], secrets: [], pvcs: [] };
  const deleted: any = { pods: [], secrets: [] };
  const patched: any[] = [];
  return {
    apis: {
      core: {
        createNamespacedPod: vi.fn(async ({ body }: any) => { created.pods.push(body); return { metadata: { uid: "pod-uid-1" }, ...body }; }),
        readNamespacedPod: vi.fn(async () => ({ metadata: { uid: "pod-uid-1" } })),
        readNamespacedPodStatus: vi.fn(async () => ({ status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] } })),
        deleteNamespacedPod: vi.fn(async ({ name }: any) => { deleted.pods.push(name); }),
        createNamespacedSecret: vi.fn(async ({ body }: any) => { created.secrets.push(body); return { body }; }),
        patchNamespacedSecret: vi.fn(async ({ name }: any) => { patched.push(name); }),
        deleteNamespacedSecret: vi.fn(async ({ name }: any) => { deleted.secrets.push(name); }),
        readNamespacedPersistentVolumeClaim: vi.fn(async () => { const e: any = new Error("not found"); e.code = 404; throw e; }),
        createNamespacedPersistentVolumeClaim: vi.fn(async ({ body }: any) => { created.pvcs.push(body); return { body }; }),
      },
      log: { log: vi.fn(async (_n: any, _p: any, _c: any, s: any) => { s.write('{"type":"agent_end"}\n'); s.end(); return { abort() {} }; }) },
      kc: {} as any,
    },
    created, deleted, patched,
  };
}

describe("KubernetesSandbox (creds + workspace + prompt)", () => {
  const cfg = (apis: any) => ({
    namespace: "lastlight-sandboxes", image: "img",
    storageClassName: "truenas-iscsi", workspaceSize: "5Gi", runAsUser: 10001, apis,
  });

  it("runAgent: ensures a PVC, writes creds+prompt Secrets, delivers the prompt, patches ownerRefs, streams, reaps", async () => {
    const { apis, created, deleted, patched } = fakeApis();
    const sbx = new KubernetesSandbox(
      { taskId: "acme-web-pr12", egress: { unrestricted: false, hosts: [] }, env: { ANTHROPIC_API_KEY: "sk-1", GITHUB_TOKEN: "ghs_x" }, stateDir: "/tmp", timeoutSeconds: 120 } as any,
      cfg(apis),
    );
    await sbx.provision({ owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" } as any);
    expect(created.pvcs).toHaveLength(1);

    const events: any[] = [];
    await sbx.runAgent("acme-web-pr12", "REVIEW THIS PR", { model: "anthropic/claude-sonnet-4-6", sandboxEnv: {}, agentCwd: "/home/agent/workspace/web" } as any, (e) => events.push(e));

    // creds + prompt Secrets created before the pod; prompt carries the text.
    const promptSecret = created.secrets.find((s: any) => s.metadata.name.endsWith("-prompt"));
    expect(promptSecret.stringData.prompt).toBe("REVIEW THIS PR");
    const credsSecret = created.secrets.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(credsSecret.stringData.ANTHROPIC_API_KEY).toBe("sk-1");
    // pod created with envFrom the creds Secret + prompt piped to stdin.
    const pod = created.pods[0];
    expect(pod.spec.containers[0].envFrom).toContainEqual({ secretRef: { name: credsSecret.metadata.name } });
    expect(pod.spec.containers[0].command.join(" ")).toContain("< /lastlight/prompt");
    // ownerRefs patched (both secrets); events streamed; pod reaped on dispose.
    expect(patched).toHaveLength(2);
    expect(events).toContainEqual({ type: "agent_end" });

    await sbx.dispose();
    expect(deleted.pods).toContain(pod.metadata.name);
  });

  it("runCommand: no prompt Secret, no `< /lastlight/prompt`, still creds via envFrom", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(
      { taskId: "acme-web-pr12", egress: { unrestricted: false, hosts: [] }, env: { GITHUB_TOKEN: "ghs_x" }, stateDir: "/tmp", timeoutSeconds: 60 } as any,
      cfg(apis),
    );
    await sbx.provision({ owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" } as any);
    const res = await sbx.runCommand("acme-web-pr12", "echo hi", { cwd: "/home/agent/workspace/web", timeoutSeconds: 60 });
    expect(res.exitCode).toBe(0);
    expect(created.secrets.some((s: any) => s.metadata.name.endsWith("-prompt"))).toBe(false);
    expect(created.pods[0].spec.containers[0].command.join(" ")).not.toContain("/lastlight/prompt");
  });

  it("ephemeral provision (no pre-clone) uses emptyDir, no PVC", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(
      { taskId: "cron-health-1", egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp", timeoutSeconds: 60 } as any,
      cfg(apis),
    );
    await sbx.provision(); // no PrePopulateSpec
    await sbx.runCommand("cron-health-1", "echo hi", { cwd: "/home/agent/workspace", timeoutSeconds: 60 });
    expect(created.pvcs).toHaveLength(0);
    expect(created.pods[0].spec.volumes.find((v: any) => v.name === "workspace").emptyDir).toBeDefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes-sandbox.test.ts`
Expected: FAIL — adapter still uses the Plan 1 inline-env/stub path.

- [ ] **Step 3: Implement the adapter changes**

Key changes to `kubernetes-sandbox.ts`:
- `K8sAdapterConfig` gains `storageClassName`, `workspaceSize`, `runAsUser` (required).
- New fields: `private pre?: PrePopulateSpec;` and `private workspace!: { kind: "pvc"; claimName: string } | { kind: "emptyDir" }`.
- `provision(pre?)`: stash `pre`; if `pre`, ensure the PVC (read; on 404, create `buildPvcManifest`) and set `workspace = { kind: "pvc", claimName: pvcNameFor(taskId) }` and `agentCwd = <WORKSPACE_DIR>/<pre.repo>`; else `workspace = { kind: "emptyDir" }` and `agentCwd = WORKSPACE_DIR`. Return `{ hostWorkspaceDir: WORKSPACE_DIR, agentCwd }`.
- `runAgent`: build the inner argv `["agentic-pi","run","--model",opts.model,"--sandbox","none","--no-session"]`, then wrap for stdin: `command = ["sh","-c", \`exec ${inner.join(" ")} < ${PROMPT_FILE}\`]`; pass `promptText = prompt`. (Model is charset-safe; `opts.model` is validated upstream, but keep the wrap simple — it's a single-quoted-free `sh -c`.) Then `runPod(..., { promptText })` with `parseLine(onEvent)`.
- `runCommand`: `command = ["sh","-c", command]`, no `promptText`.
- New `runPod`:
  1. `credsName = secretNameFor(podName, "creds")`; `credsData = { ...this.opts.env, ...sandboxEnv }`; `createNamespacedSecret(buildSecretManifest({ name: credsName, namespace, data: credsData, labels: { "lastlight.io/pod": podName } }))`.
  2. If `promptText` set: `promptName = secretNameFor(podName, "prompt")`; `createNamespacedSecret(buildSecretManifest({ name: promptName, namespace, data: { prompt: promptText }, labels }))`.
  3. `initContainers = this.workspace.kind === "pvc" && this.pre ? [buildCloneInitContainer(this.image, { owner: this.pre.owner, repo: this.pre.repo, branch: this.pre.branch, cwd: WORKSPACE_DIR, runAsUser: this.runAsUser })] : undefined`.
  4. `manifest = buildPodManifest({ name, namespace, image, command, envFromSecret: credsName, promptSecret: promptText ? promptName : undefined, cwd, activeDeadlineSeconds, runAsUser, workspace: this.workspace, initContainers })`.
  5. `try { const pod = await createNamespacedPod({ namespace, body: manifest }); } catch (e) { await deleteSecret(credsName); if (promptText) await deleteSecret(promptName); throw e; }` — Secrets exist before the Pod (Global Constraint); on Pod-create failure delete them.
  6. Read `pod.metadata.uid` (from create result, or `readNamespacedPod`), then `patchNamespacedSecret` each Secret with `metadata.ownerReferences: [podOwnerReference(name, uid)]`.
  7. `await waitForContainerStart(name)` — but with a PVC + initContainer, the main container is `waiting` (PodInitializing) until the init completes; `waitForContainerStart` already tolerates that (it polls `containerStatuses[0]` — the **main** container — running/terminated or a terminal phase). **Verify** the poll doesn't fast-fail on `PodInitializing` (it's not in `FATAL_WAITING_REASONS`, so it won't) and that its budget (~60s) covers a first clone; bump `POD_START_POLL_ATTEMPTS` if a cold clone needs longer, or add an init-aware branch.
  8. `await streamPodLog(...)`.
- `dispose`: delete the Pod (cascades the owner-ref'd Secrets); also best-effort `deleteNamespacedSecret` both names (belt-and-suspenders if the ownerRef patch hadn't landed). **Keep the PVC** (reused; Plan 4 reclaims it).

> **Executor note:** verify the exact 1.4.0 object-param shapes for `createNamespacedSecret`, `patchNamespacedSecret` (it needs a `PatchStrategy`/content-type header in some client-node versions — a strategic-merge or JSON-merge patch of `{ metadata: { ownerReferences: [...] } }`), `readNamespacedPersistentVolumeClaim`, and `createNamespacedPersistentVolumeClaim` against `node_modules/@kubernetes/client-node/dist/gen/api/coreV1Api.d.ts`. Confirm the 404-detection shape for the PVC "ensure" (an `ApiException` with `.code === 404` vs a thrown `HttpError` with `.statusCode`). Mirror Plan 1's approach: read the typings, don't guess.

- [ ] **Step 4: Run the unit test, verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes-sandbox.test.ts`
Expected: PASS.

- [ ] **Step 5: Full k8s unit suite + typecheck**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/ && pnpm --filter agentic-pi build && pnpm --filter lastlight-core exec tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sandbox/k8s/kubernetes-sandbox.ts apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): k8s adapter wires creds/prompt Secrets, PVC, initContainer clone"
```

---

## Task 7: Real-cluster integration test — an AI phase on a checked-out repo

Extend the opt-in integration test (gated as Plan 1) to prove the Plan 2 outcome on Robin's cluster: a pod with a per-run creds Secret + PVC-backed checkout runs, and the prompt reaches the container. Two tiers — a **creds+PVC+clone** tier (always, needs a git-bearing image + a public repo) and an **AI** tier (skipped unless a provider key is present).

**Files:**
- Modify: `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts`

- [ ] **Step 1: Add the Plan 2 integration cases**

```ts
const RUN = process.env.RUN_K8S_IT === "1";
const IMAGE = process.env.K8S_SANDBOX_IMAGE ?? "ghcr.io/yo61/lastlight-sandbox:latest";
const HAS_AI = !!process.env.ANTHROPIC_API_KEY;

describe.runIf(RUN)("KubernetesSandbox Plan 2 (integration)", () => {
  const mkSbx = (taskId: string, env: Record<string, string>) =>
    new KubernetesSandbox(
      { taskId, egress: { unrestricted: false, hosts: [] }, env, stateDir: "/tmp", timeoutSeconds: 300 } as any,
      {
        namespace: process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes",
        image: IMAGE, storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ?? "truenas-iscsi",
        workspaceSize: "2Gi", runAsUser: parseInt(process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001", 10),
      },
    );

  it("clones a public repo into the PVC and runs a command against it", async () => {
    const sbx = mkSbx(`it-clone-${Date.now()}`, { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "" });
    try {
      await sbx.provision({ owner: "octocat", repo: "Hello-World", branch: "master", token: process.env.GITHUB_TOKEN ?? "" } as any);
      const res = await sbx.runCommand("it", "cat README && git -C . rev-parse --abbrev-ref HEAD",
        { cwd: "/home/agent/workspace/Hello-World", timeoutSeconds: 300 });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.toLowerCase()).toContain("hello");
    } finally {
      await sbx.dispose();
    }
  }, 300_000);

  it.runIf(HAS_AI)("runs an AI phase whose prompt arrives via the mounted Secret", async () => {
    const sbx = mkSbx(`it-ai-${Date.now()}`, {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "", ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    });
    const events: any[] = [];
    try {
      await sbx.provision({ owner: "octocat", repo: "Hello-World", branch: "master", token: process.env.GITHUB_TOKEN ?? "" } as any);
      await sbx.runAgent("it", "Reply with exactly the word PONG and nothing else.",
        { model: "anthropic/claude-haiku-4-5-20251001", sandboxEnv: {}, agentCwd: "/home/agent/workspace/Hello-World" } as any,
        (e) => events.push(e));
      expect(events.some((e) => e.type === "agent_end")).toBe(true);
    } finally {
      await sbx.dispose();
    }
  }, 300_000);
});
```

- [ ] **Step 2: Run it against the cluster**

```bash
kubectl delete pods,secrets,pvc -l app.kubernetes.io/managed-by=lastlight -n lastlight-sandboxes   # clear orphans
RUN_K8S_IT=1 LASTLIGHT_K8S_NAMESPACE=lastlight-sandboxes \
  K8S_SANDBOX_IMAGE=ghcr.io/yo61/lastlight-sandbox:latest \
  GITHUB_TOKEN=$GITHUB_TOKEN ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts
```
Expected: the clone tier PASSES (repo checked out into the PVC, command reads it); the AI tier PASSES when `ANTHROPIC_API_KEY` is set (an `agent_end` streams back). Prereqs: `kubectl config current-context = admin@homelab`; namespace exists; the **`ghcr.io/yo61/lastlight-sandbox` image is pullable by the cluster** (build+push it if absent — it carries git + node + agentic-pi). Verify `kubectl get pvc -n lastlight-sandboxes` shows a bound `ws-it-clone-…` claim during the run.

- [ ] **Step 3: Confirm the default suite still skips it**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/`
Expected: integration cases skipped; all unit tests pass.

- [ ] **Step 4: Verify #223 is gone by construction (manual, optional)**

While the AI tier runs, `kubectl get pod <pod> -n lastlight-sandboxes -o yaml` shows **no plaintext secret values** in `spec` (only `envFrom.secretRef`), and `kubectl describe pod` shows no env values — the creds live only in the pod's own Secret, never the shared `process.env`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "test(sandbox): Plan 2 integration — AI phase on a PVC-checked-out repo"
```

---

## Self-review (author)

- **Spec coverage (Plan 2 slice):** creds Secret + `envFrom` + ownerRef §3 (Tasks 3, 6); inline-env removal (Task 3, the flagged exposure); per-`(repo,PR)` RWO PVC + initContainer clone §1 (Task 5, **minimal** per locked decision #2; reuse → Plan 4); prompt delivery (Tasks 4, 6, locked decision #1); `securityContext` for `restricted` (Task 2, cluster finding); registry-qualified `sandbox.kubernetes.image` in the yo61 org (Task 1, Robin's flag). Egress §4, skills §7, lifecycle §6, concurrency §8, and the #107 reuse/refresh/merge-base logic remain in Plans 3–4 — **not gaps**.
- **Placeholders:** the `Executor note`s flag *version-signature confirmation against pinned typings* (client-node 1.4.0 secret/PVC/patch shapes), the *pod-name length budget* for Secret suffixes, the *initContainer envFrom wiring*, and *`waitForContainerStart` with initContainers* — bounded, real instructions, not "figure it out". Every step shows code.
- **Type consistency:** `PodSpecInput` evolves monotonically (Task 2 `runAsUser`; Task 3 `env`→`envFromSecret`; Task 4 `promptSecret?`; Task 5 `workspace`/`initContainers?`) — each task updates the prior tasks' test inputs in the same step. `KubernetesConfig`, `K8sAdapterConfig`, `secretNameFor`, `pvcNameFor`, `buildCloneInitContainer`, `PROMPT_FILE` names are used identically across Tasks 1–7. `Sandbox` method signatures are unchanged.
- **Ordering invariant** (Secrets-before-Pod, patch-ownerRef-after) is stated once in Global Constraints and enforced in Task 6 Step 3, with the failure-path Secret cleanup.

## Execution handoff

When Plan 2 is green (unit + your cluster integration run), Plan 3 (egress `CiliumNetworkPolicy` + skill-bundle HTTP fetch) is written against the concrete pod-spec this establishes. **Branch-finish docs gate still applies** — the `kubernetes` backend stays unreachable until Flux manifests (Plan 5) land, so mid-build commits keep bypassing the docs-sync hook (`LASTLIGHT_SKIP_DOCS_CHECK=1`); run the `docs-sync` skill only when the backend is functional end-to-end, before any merge.
