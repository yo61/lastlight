# Plan 4 — Skills (HTTP skill-bundle fetch + `toEndpoints`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver each phase's already-resolved skill bundle into the sandbox Pod over an authenticated HTTP channel — the harness serves the bundle, an initContainer fetches + unpacks it into a shared `emptyDir`, and `agentic-pi` loads it via `--skill` — so the `kubernetes` backend runs workflows with their real skills (design §7), reached through the Cilium `toEndpoints` sandbox→harness rule (design §4).

**Architecture:** Skill resolution stays on the harness (core *or* overlay). At `stageSkills` time the adapter tars the resolved skill dirs into a gzipped `Buffer` and registers it in an in-memory `SkillBundleRegistry` under a fresh per-run token; the token rides into the Pod in the creds Secret. A new authenticated harness HTTP route (`GET /internal/skill-bundle`, bearer token) streams the stored tar. A skills initContainer `curl`s it and unpacks into a `skills` `emptyDir` the main container also mounts at `/lastlight-skills`; `runAgent` appends `--skill /lastlight-skills/<name>` per skill. The sandbox→harness hop is permitted by a `toEndpoints` rule added to *both* egress policies (extending Plan 3's renderer). No new npm dependency — the tar is built by shelling out to system `tar` (present in the harness image and the sandbox image).

**Tech Stack:** TypeScript (ESM, NodeNext), `@kubernetes/client-node@1.4.0` (object-param API), Hono (the harness's existing HTTP app), Node `child_process.execFileSync` + system `tar`/`gzip`, Cilium `cilium.io/v2` `CiliumNetworkPolicy` `toEndpoints`, vitest.

## Global Constraints

- **Client API shape:** object-param methods only; `ApiException.code` is the HTTP status.
- **No new npm dependency.** Build the gzipped tar via `execFileSync("tar", ["-czf", "-", "-C", <dir>, ...<names>], { maxBuffer })` — do NOT add `tar`/`tar-stream`/`archiver`. The sandbox image unpacks with `tar xzf -`.
- **The bundle registry holds tar *bytes*, keyed by an opaque per-run token.** `stageSkills` builds the tar from the resolved paths immediately (the files are on the harness FS only then), registers the `Buffer`, and deletes its temp staging dir. The endpoint streams stored bytes — never touches the harness FS at fetch time.
- **Endpoint auth = the per-run token, `Authorization: Bearer <token>`.** An unknown/absent token is `401`. The token is a `crypto.randomUUID()` (or 128-bit random hex), carried to the Pod in the creds Secret as `LASTLIGHT_SKILL_TOKEN`. A Pod can fetch **only its own** bundle.
- **Skill names are sanitized to `[A-Za-z0-9_-]`** at the single point where the in-pod path is formed (`stageSkills`/tar build). The same sanitized name is the tar top-level entry AND the `--skill /lastlight-skills/<name>` path — so the argv/script interpolation of skill paths is safe by construction (no shell metacharacters possible). Model still passes as positional `$1` (unchanged from Plan 2/3).
- **The `toEndpoints` rule extends the Plan 3 renderer** (`k8s/egress-policy.ts`), added to BOTH strict and open, selecting the harness pods by `{namespace, labels}` on the harness port. Do not hand-write a second policy.
- **No harness-Service value is hardcoded.** The harness endpoint URL and the `toEndpoints` harness selector (namespace + labels + port) are `sandbox.kubernetes.*` config with sensible defaults, finalized when the harness deploys in-cluster (Plan 6).
- **Hard rule #8 unchanged** (App PEM never crosses; only the minted token + the skill-fetch token). **No `process.env` mutation** in the backend.
- **Line length ≤100, functions ≤100 lines / complexity ≤8, absolute imports (source uses relative `./`/`../`; tests use `#src/`), Google-style docstrings on public APIs.** Commit with `LASTLIGHT_SKIP_DOCS_CHECK=1` (backend still unreachable until Plan 6).
- **Verify line widths directly** (`awk 'length>100{print FILENAME":"FNR" ("length")"}' <files>`) — oxlint does not enforce line length here.

## Locked decisions (from design §7/§4 + the skill-size measurement)

1. **HTTP-fetch, not ConfigMap-mount** (Robin's call — bundles are tiny but the design's server-mode-POST-back reuse justifies the channel).
2. **In-process registry singleton** shared by the adapter (writer) and the endpoint (reader), both in the harness process. TTL backstop (30 min) so a crashed run's bytes don't leak; `dispose` evicts explicitly.
3. **`GET /internal/skill-bundle`**, bearer token, streams `application/gzip`. Mounted once at boot on the shared Hono app.
4. **Constants:** `SKILLS_MOUNT_DIR = "/lastlight-skills"`; creds env key `LASTLIGHT_SKILL_TOKEN`.
5. **The e2e in-cluster fetch is validatable only after the harness deploys in-cluster (Plan 6).** Plan 4's integration test validates the harness endpoint in-process (start app → curl with token → unpack tar); the full pod→harness fetch is documented-deferred.

---

## File Structure

- **Create** `apps/server/src/sandbox/k8s/skill-bundle.ts` — `SKILLS_MOUNT_DIR`, `sanitizeSkillName`, `buildSkillTar(skillPaths)` (copy→temp→`tar -czf`→cleanup→`{ tar, names }`), `SkillBundleRegistry` (map + TTL: `register(tar)→token`, `get(token)`, `evict(token)`), and the module singleton `skillBundleRegistry`.
- **Create** `apps/server/src/sandbox/k8s/skill-bundle-route.ts` — `mountSkillBundle(app, registry)`: `GET /internal/skill-bundle` bearer-auth → stream the tar.
- **Modify** `apps/server/src/index.ts` — call `mountSkillBundle(app, skillBundleRegistry)` where the shared Hono app is built.
- **Modify** `apps/server/src/config/config.ts` — `KubernetesConfig` gains `harnessEndpoint`, `harnessNamespace`, `harnessPodLabels`; defaults + env + `resolveKubernetesConfig`.
- **Modify** `apps/server/src/sandbox/k8s/egress-policy.ts` — add a `toEndpoints` harness rule to strict + open; `renderEgressPolicies` gains a `harness` param.
- **Modify** `apps/server/src/sandbox/k8s/egress-apply.ts` — thread the `harness` selector through `applyEgressPolicies`.
- **Modify** `apps/server/src/sandbox/k8s/pod.ts` — add the `skills` `emptyDir` + skills-init container slot + main mount at `SKILLS_MOUNT_DIR`.
- **Modify** `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` — implement `stageSkills`; add `LASTLIGHT_SKILL_TOKEN` to the creds Secret; build the skills-init container; append `--skill` to the `runAgent` command; pass the harness selector to `ensureEgress`; evict the bundle on `dispose`.
- **Create** the matching tests under `apps/server/tests/sandbox/k8s/` + `apps/server/tests/` for the route.

---

### Task 1: Skill-bundle registry + tar builder

**Files:**
- Create: `apps/server/src/sandbox/k8s/skill-bundle.ts`
- Test: `apps/server/tests/sandbox/k8s/skill-bundle.test.ts`

**Interfaces:**
- Produces:
  - `SKILLS_MOUNT_DIR = "/lastlight-skills"` (string const)
  - `sanitizeSkillName(name: string): string` — `[A-Za-z0-9_-]`, non-empty (fallback `"skill"`)
  - `buildSkillTar(skillPaths: readonly string[]): { tar: Buffer; names: string[] }` — copies each resolved dir into a fresh `mkdtemp` under its sanitized basename, `tar -czf - -C <tmp> <names…>` to a Buffer, removes the temp dir, returns the gzipped tar + the sanitized top-level names (order preserved). Empty/undefined input → `{ tar: Buffer.alloc(0), names: [] }`.
  - `class SkillBundleRegistry { register(tar: Buffer): string; get(token: string): Buffer | undefined; evict(token: string): void }` — in-memory `Map<string, { tar: Buffer; expires: number }>`; `register` mints a `randomUUID()` token, stores with a 30-min expiry; `get` returns `undefined` for unknown/expired (and drops expired); constructor takes an optional `ttlMs` (default `30 * 60_000`) for tests.
  - `const skillBundleRegistry = new SkillBundleRegistry()` (module singleton)

**Dispatch context for the implementer/reviewer:** `buildSkillTar` uses `execFileSync` (not `execFile`) so it stays synchronous — the `Sandbox.stageSkills` port method is synchronous, and bundles are ≤~68K so the blocking cost is a few ms. Pass `{ maxBuffer: 16 * 1024 * 1024 }` to be safe. Reuse `cpSync(src, dest, { recursive: true, dereference: true })` (same as `stageSkillBundle`'s copy mode) so symlinked skill sources are materialized.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/skill-bundle.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  SKILLS_MOUNT_DIR,
  sanitizeSkillName,
  buildSkillTar,
  SkillBundleRegistry,
} from "#src/sandbox/k8s/skill-bundle.js";

describe("sanitizeSkillName", () => {
  it("keeps safe chars and strips the rest", () => {
    expect(sanitizeSkillName("pr-review")).toBe("pr-review");
    expect(sanitizeSkillName("weird name;rm -rf/")).toBe("weirdname_rm-rf");
    expect(sanitizeSkillName("")).toBe("skill");
  });
});

describe("buildSkillTar", () => {
  it("tars resolved skill dirs into a gzip that unpacks under sanitized names", () => {
    const src = mkdtempSync(join(tmpdir(), "skills-src-"));
    const a = join(src, "pr-review");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "SKILL.md"), "# pr-review");
    mkdirSync(join(a, "scripts"), { recursive: true });
    writeFileSync(join(a, "scripts", "run.sh"), "echo hi");

    const { tar, names } = buildSkillTar([a]);
    expect(names).toEqual(["pr-review"]);
    expect(tar.length).toBeGreaterThan(0);

    // Unpack and confirm structure survives (nested dir + file).
    const out = mkdtempSync(join(tmpdir(), "skills-out-"));
    const tarPath = join(out, "b.tgz");
    writeFileSync(tarPath, tar);
    execFileSync("tar", ["xzf", tarPath, "-C", out]);
    expect(() => execFileSync("cat", [join(out, "pr-review", "SKILL.md")])).not.toThrow();
    expect(() => execFileSync("cat", [join(out, "pr-review", "scripts", "run.sh")])).not.toThrow();
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("returns an empty bundle for no skills", () => {
    expect(buildSkillTar([])).toEqual({ tar: Buffer.alloc(0), names: [] });
  });
});

describe("SkillBundleRegistry", () => {
  it("register → get round-trips the bytes; evict + unknown → undefined", () => {
    const reg = new SkillBundleRegistry();
    const token = reg.register(Buffer.from("hello"));
    expect(reg.get(token)?.toString()).toBe("hello");
    expect(reg.get("nope")).toBeUndefined();
    reg.evict(token);
    expect(reg.get(token)).toBeUndefined();
  });

  it("expires entries past the TTL", () => {
    const reg = new SkillBundleRegistry(0); // immediate expiry
    const token = reg.register(Buffer.from("x"));
    expect(reg.get(token)).toBeUndefined();
  });

  it("exposes the in-pod mount root", () => {
    expect(SKILLS_MOUNT_DIR).toBe("/lastlight-skills");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/skill-bundle.test.ts`
Expected: FAIL — `Cannot find module '#src/sandbox/k8s/skill-bundle.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/sandbox/k8s/skill-bundle.ts
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/** In-pod mount root where the skills initContainer unpacks the bundle and the
 *  agent loads it from via `--skill`. */
export const SKILLS_MOUNT_DIR = "/lastlight-skills";

const DEFAULT_TTL_MS = 30 * 60_000;

/** Reduce a skill dir name to a shell/path-safe token so the `--skill
 *  <SKILLS_MOUNT_DIR>/<name>` path can be interpolated without escaping. */
export function sanitizeSkillName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, "");
  return clean || "skill";
}

/**
 * Package the resolved skill dirs into a gzipped tar (built via system `tar` —
 * no npm dep). Each dir lands under its sanitized basename, so the tar unpacks
 * to `<name>/SKILL.md`, `<name>/scripts/…`, etc. Synchronous by design: the
 * `Sandbox.stageSkills` port is sync and bundles are tiny (~tens of KB).
 */
export function buildSkillTar(skillPaths: readonly string[]): { tar: Buffer; names: string[] } {
  if (!skillPaths.length) return { tar: Buffer.alloc(0), names: [] };
  const staging = mkdtempSync(join(tmpdir(), "ll-skills-"));
  try {
    const names: string[] = [];
    for (const src of skillPaths) {
      const name = sanitizeSkillName(basename(src));
      cpSync(src, join(staging, name), { recursive: true, dereference: true });
      names.push(name);
    }
    const tar = execFileSync("tar", ["-czf", "-", "-C", staging, ...names], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return { tar, names };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * In-memory token→bundle store shared by the adapter (writer) and the
 * `/internal/skill-bundle` route (reader). A per-run token gates each Pod to
 * its own bundle; a TTL backstop drops bytes a crashed run never evicted.
 */
export class SkillBundleRegistry {
  private readonly bundles = new Map<string, { tar: Buffer; expires: number }>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  register(tar: Buffer): string {
    const token = randomUUID();
    this.bundles.set(token, { tar, expires: Date.now() + this.ttlMs });
    return token;
  }

  get(token: string): Buffer | undefined {
    const entry = this.bundles.get(token);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.bundles.delete(token);
      return undefined;
    }
    return entry.tar;
  }

  evict(token: string): void {
    this.bundles.delete(token);
  }
}

/** Process-wide singleton: the adapter registers, the HTTP route serves. */
export const skillBundleRegistry = new SkillBundleRegistry();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/skill-bundle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/skill-bundle.ts apps/server/tests/sandbox/k8s/skill-bundle.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): skill-bundle tar builder + per-run registry (k8s)"
```

---

### Task 2: Authenticated `/internal/skill-bundle` route

**Files:**
- Create: `apps/server/src/sandbox/k8s/skill-bundle-route.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/tests/sandbox/k8s/skill-bundle-route.test.ts`

**Interfaces:**
- Consumes: `Hono` (from `hono`); `SkillBundleRegistry` (Task 1).
- Produces: `mountSkillBundle(app: Hono, registry: SkillBundleRegistry): void` — registers `GET /internal/skill-bundle`. Reads `Authorization: Bearer <token>`; `registry.get(token)` → 200 `application/gzip` with the tar bytes, else `401`.

**Dispatch context:** Hono returns raw bytes with `c.body(buf, 200, { "Content-Type": "application/gzip" })` — no streaming helper needed for a ≤68K buffer. Parse the header with `c.req.header("authorization")` and strip a leading `"Bearer "` (case-insensitive). In `index.ts`, call `mountSkillBundle(app, skillBundleRegistry)` right after `app.get("/health", …)` (line ~695) — it's backend-agnostic and harmless when the k8s backend is unused (no tokens are ever registered, so every request just 401s).

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/skill-bundle-route.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountSkillBundle } from "#src/sandbox/k8s/skill-bundle-route.js";
import { SkillBundleRegistry } from "#src/sandbox/k8s/skill-bundle.js";

function appWith(registry: SkillBundleRegistry): Hono {
  const app = new Hono();
  mountSkillBundle(app, registry);
  return app;
}

describe("GET /internal/skill-bundle", () => {
  it("serves the registered tar to a valid bearer token", async () => {
    const reg = new SkillBundleRegistry();
    const token = reg.register(Buffer.from("TARBYTES"));
    const app = appWith(reg);
    const res = await app.request("/internal/skill-bundle", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/gzip");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("TARBYTES");
  });

  it("401s an unknown token", async () => {
    const app = appWith(new SkillBundleRegistry());
    const res = await app.request("/internal/skill-bundle", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("401s a missing Authorization header", async () => {
    const app = appWith(new SkillBundleRegistry());
    const res = await app.request("/internal/skill-bundle");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/skill-bundle-route.test.ts`
Expected: FAIL — `Cannot find module '#src/sandbox/k8s/skill-bundle-route.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/sandbox/k8s/skill-bundle-route.ts
import type { Hono } from "hono";
import type { SkillBundleRegistry } from "./skill-bundle.js";

/**
 * Mount the internal skill-bundle endpoint on the shared Hono app. A sandbox
 * Pod's initContainer fetches `GET /internal/skill-bundle` with the per-run
 * token (`Authorization: Bearer <token>`) it received in its creds Secret; the
 * token gates each Pod to its own bundle. Backend-agnostic — with no k8s runs,
 * nothing is ever registered, so every request 401s.
 */
export function mountSkillBundle(app: Hono, registry: SkillBundleRegistry): void {
  app.get("/internal/skill-bundle", (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const tar = token ? registry.get(token) : undefined;
    if (!tar) return c.body(null, 401);
    return c.body(tar, 200, { "Content-Type": "application/gzip" });
  });
}
```

In `apps/server/src/index.ts`, add the import near the other sandbox imports and mount it after `app.get("/health", …)`:

```ts
import { mountSkillBundle } from "./sandbox/k8s/skill-bundle-route.js";
import { skillBundleRegistry } from "./sandbox/k8s/skill-bundle.js";
// … after `app.get("/health", (c) => c.json({ status: "ok" }));`
mountSkillBundle(app, skillBundleRegistry);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/skill-bundle-route.test.ts`
Expected: PASS. Also `pnpm --filter lastlight-core exec tsc --noEmit` clean (the index.ts wiring compiles).

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/skill-bundle-route.ts apps/server/src/index.ts apps/server/tests/sandbox/k8s/skill-bundle-route.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): serve the k8s skill bundle over an authed HTTP route"
```

---

### Task 3: Harness-endpoint config

**Files:**
- Modify: `apps/server/src/config/config.ts`
- Test: `apps/server/tests/config/kubernetes-config.test.ts` (the existing `resolveKubernetesConfig` suite). **Add the three new env vars (`LASTLIGHT_K8S_HARNESS_ENDPOINT`, `LASTLIGHT_K8S_HARNESS_NAMESPACE`, `LASTLIGHT_K8S_HARNESS_POD_LABELS`) to that file's `K8S_ENV` cleanup array** (used by its `afterEach`) so the new env-override case can't leak into sibling tests.

**Interfaces:**
- Produces: `KubernetesConfig` gains three fields; `resolveKubernetesConfig` resolves them (env → runtime block → default):
  - `harnessEndpoint: string` — base URL the sandbox uses to reach the harness (e.g. `http://lastlight.lastlight.svc.cluster.local:8644`). Env `LASTLIGHT_K8S_HARNESS_ENDPOINT`. Default `http://lastlight.lastlight.svc.cluster.local:8644`.
  - `harnessNamespace: string` — the harness Pod's namespace for the `toEndpoints` selector. Env `LASTLIGHT_K8S_HARNESS_NAMESPACE`. Default `lastlight`.
  - `harnessPodLabels: Record<string, string>` — the harness Pod's Cilium selector labels. Env `LASTLIGHT_K8S_HARNESS_POD_LABELS` (parsed as `k=v,k=v`). Default `{ "app.kubernetes.io/name": "lastlight" }`.

**Dispatch context:** These are all deployment-specific placeholders finalized when the harness deploys in-cluster (Plan 6) — pick the defaults above, they're overridable. Follow the exact resolution pattern already in `resolveKubernetesConfig` (`process.env.X ?? k.field ?? K8S_DEFAULTS.field`). For `harnessPodLabels`, add a small `parseLabels(s)` helper: split on `,`, then `=`, trim, drop empties; an unparseable/empty env falls through to the runtime block then the default. `normalizeKubernetesFileConfig` (the runtime-block normalizer, ~line 584) must also carry the three fields through when present.

- [ ] **Step 1: Write the failing test**

Add cases to the file that tests `resolveKubernetesConfig` (mirror its existing env-override + default cases):

```ts
it("defaults the harness endpoint + toEndpoints selector", () => {
  // (ensure the three env vars are unset for this case)
  const k = resolveKubernetesConfig();
  expect(k.harnessEndpoint).toBe("http://lastlight.lastlight.svc.cluster.local:8644");
  expect(k.harnessNamespace).toBe("lastlight");
  expect(k.harnessPodLabels).toEqual({ "app.kubernetes.io/name": "lastlight" });
});

it("env overrides the harness endpoint + parses pod labels", () => {
  process.env.LASTLIGHT_K8S_HARNESS_ENDPOINT = "http://h.ns.svc:9000";
  process.env.LASTLIGHT_K8S_HARNESS_NAMESPACE = "ll-sys";
  process.env.LASTLIGHT_K8S_HARNESS_POD_LABELS = "app=lastlight,tier=control";
  try {
    const k = resolveKubernetesConfig();
    expect(k.harnessEndpoint).toBe("http://h.ns.svc:9000");
    expect(k.harnessNamespace).toBe("ll-sys");
    expect(k.harnessPodLabels).toEqual({ app: "lastlight", tier: "control" });
  } finally {
    delete process.env.LASTLIGHT_K8S_HARNESS_ENDPOINT;
    delete process.env.LASTLIGHT_K8S_HARNESS_NAMESPACE;
    delete process.env.LASTLIGHT_K8S_HARNESS_POD_LABELS;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/config/kubernetes-config.test.ts`
Expected: FAIL — the three fields are missing / `undefined`.

- [ ] **Step 3: Write minimal implementation**

Extend the `KubernetesConfig` interface:

```ts
export interface KubernetesConfig {
  namespace: string;
  image: string;
  storageClassName: string;
  workspaceSize: string;
  runAsUser: number;
  /** Base URL the sandbox's skills initContainer fetches the bundle from
   *  (the harness Service, cross-namespace). */
  harnessEndpoint: string;
  /** The harness Pod's namespace — the `toEndpoints` egress selector. */
  harnessNamespace: string;
  /** The harness Pod's Cilium selector labels — the `toEndpoints` egress rule. */
  harnessPodLabels: Record<string, string>;
}
```

Extend `K8S_DEFAULTS`:

```ts
const K8S_DEFAULTS: KubernetesConfig = {
  namespace: "lastlight-sandboxes",
  image: "ghcr.io/yo61/lastlight-sandbox:latest",
  storageClassName: "truenas-iscsi",
  workspaceSize: "5Gi",
  runAsUser: 10001,
  harnessEndpoint: "http://lastlight.lastlight.svc.cluster.local:8644",
  harnessNamespace: "lastlight",
  harnessPodLabels: { "app.kubernetes.io/name": "lastlight" },
};

/** Parse a `k=v,k=v` env string into a label map; empty/malformed → {}. */
function parseLabels(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
```

Extend `resolveKubernetesConfig`'s return:

```ts
    harnessEndpoint:
      process.env.LASTLIGHT_K8S_HARNESS_ENDPOINT ?? k.harnessEndpoint ?? K8S_DEFAULTS.harnessEndpoint,
    harnessNamespace:
      process.env.LASTLIGHT_K8S_HARNESS_NAMESPACE ?? k.harnessNamespace ?? K8S_DEFAULTS.harnessNamespace,
    harnessPodLabels:
      parseLabels(process.env.LASTLIGHT_K8S_HARNESS_POD_LABELS) ??
      k.harnessPodLabels ??
      K8S_DEFAULTS.harnessPodLabels,
```

Carry the three fields through `normalizeKubernetesFileConfig` too (same shape as the existing fields).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/config/kubernetes-config.test.ts`
Expected: PASS. `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/config/config.ts apps/server/tests/config/
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(config): harness-endpoint + toEndpoints selector for the k8s backend"
```

---

### Task 4: `toEndpoints` sandbox→harness egress rule

**Files:**
- Modify: `apps/server/src/sandbox/k8s/egress-policy.ts`
- Modify: `apps/server/src/sandbox/k8s/egress-apply.ts`
- Test: `apps/server/tests/sandbox/k8s/egress-policy.test.ts`
- Test: `apps/server/tests/sandbox/k8s/egress-apply.test.ts`

**Interfaces:**
- Consumes: the `HarnessSelector` shape `{ namespace: string; labels: Record<string, string>; port: number }`.
- Produces:
  - `renderStrictEgressPolicy` / `renderOpenEgressPolicy` / `renderEgressPolicies` gain a `harness: HarnessSelector` field in their opts. Both policies get a `toEndpoints` egress rule selecting the harness Pod (`{ "k8s:io.kubernetes.pod.namespace": harness.namespace, ...harness.labels }`) on `harness.port`/TCP.
  - `applyEgressPolicies(custom, { namespace, hosts, harness })` threads `harness` into `renderEgressPolicies`.

**Dispatch context:** This is an additive rule in the existing renderer — do NOT restructure the DNS/FQDN/CIDR rules. The harness port comes from the endpoint config (parse it, or add a `harnessPort` — simplest: the adapter derives `port` from `new URL(harnessEndpoint).port` and passes the `HarnessSelector`). The Cilium `toEndpoints` rule shape: `{ toEndpoints: [{ matchLabels: {...} }], toPorts: [{ ports: [{ port: String(harness.port), protocol: "TCP" }] }] }`. Add it as an additional element of `spec.egress` in BOTH strict and open. The existing tests assert strict has "no toCIDRSet"; keep that true (a `toEndpoints` is not a `toCIDRSet`).

- [ ] **Step 1: Write the failing test**

Add to `egress-policy.test.ts`:

```ts
const harness = { namespace: "lastlight", labels: { "app.kubernetes.io/name": "lastlight" }, port: 8644 };

describe("toEndpoints harness rule", () => {
  it("strict permits sandbox→harness on the harness port (identity-based, not a CIDR hole)", () => {
    const pol = renderStrictEgressPolicy({ namespace: "ns", hosts: ["github.com"], harness });
    const rule = pol.spec.egress.find((r: any) => r.toEndpoints) as any;
    expect(rule.toEndpoints[0].matchLabels).toMatchObject({
      "k8s:io.kubernetes.pod.namespace": "lastlight",
      "app.kubernetes.io/name": "lastlight",
    });
    expect(rule.toPorts[0].ports).toContainEqual({ port: "8644", protocol: "TCP" });
    // still no CIDR escape hatch in strict
    expect(pol.spec.egress.some((r: any) => r.toCIDRSet)).toBe(false);
  });

  it("open also carries the harness rule", () => {
    const pol = renderOpenEgressPolicy({ namespace: "ns", harness });
    expect(pol.spec.egress.some((r: any) => r.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight")).toBe(true);
  });
});
```

Update the existing `renderStrictEgressPolicy` / `renderOpenEgressPolicy` / `renderEgressPolicies` call sites in this test file to pass `harness` (the field is now required).

Add to `egress-apply.test.ts`: pass `harness` in the `applyEgressPolicies(custom, { namespace, hosts, harness })` calls and assert the created strict body contains a `toEndpoints` rule.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/egress-policy.test.ts tests/sandbox/k8s/egress-apply.test.ts`
Expected: FAIL — `harness` unknown / no `toEndpoints` rule present.

- [ ] **Step 3: Write minimal implementation**

In `egress-policy.ts`, add the type + a rule builder and thread it in:

```ts
/** The harness Pod the sandbox may reach for the skill fetch (design §4/§7). */
export interface HarnessSelector {
  namespace: string;
  labels: Record<string, string>;
  port: number;
}

/** Permit sandbox→harness only, by Cilium identity (namespace + labels), on the
 *  harness port — an identity rule, not a CIDR hole. Carries the Section 7 skill
 *  fetch under both strict and open. */
function harnessEgressRule(h: HarnessSelector): unknown {
  return {
    toEndpoints: [{ matchLabels: { "k8s:io.kubernetes.pod.namespace": h.namespace, ...h.labels } }],
    toPorts: [{ ports: [{ port: String(h.port), protocol: "TCP" }] }],
  };
}
```

Add `harness: HarnessSelector` to both render opts and push `harnessEgressRule(opts.harness)` into each policy's `egress` array (strict: after the FQDN rule; open: after the CIDR rule). `renderEgressPolicies({ namespace, hosts, harness })` forwards `harness` to both.

In `egress-apply.ts`, add `harness: HarnessSelector` to the `opts` param and pass it to `renderEgressPolicies`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/egress-policy.test.ts tests/sandbox/k8s/egress-apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/egress-policy.ts apps/server/src/sandbox/k8s/egress-apply.ts apps/server/tests/sandbox/k8s/egress-policy.test.ts apps/server/tests/sandbox/k8s/egress-apply.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): add the toEndpoints sandbox→harness egress rule"
```

---

### Task 5: Pod — skills initContainer + shared `emptyDir`

**Files:**
- Modify: `apps/server/src/sandbox/k8s/pod.ts`
- Test: `apps/server/tests/sandbox/k8s/pod.test.ts`

**Interfaces:**
- Consumes: `SKILLS_MOUNT_DIR` (Task 1).
- Produces: `PodSpecInput` gains `skillsInitContainer?: V1Container`. When set, `buildPodManifest`:
  - adds a `skills` `emptyDir` volume,
  - mounts it at `SKILLS_MOUNT_DIR` in the **main** container,
  - includes the passed `skillsInitContainer` in `initContainers` (it already carries its own `skills` volumeMount + the creds `envFrom`, built by the adapter),
  - leaves the clone initContainer handling unchanged (both inits coexist).

**Dispatch context:** `skillsInitContainer` is prepended/appended to whatever `initContainers` the adapter passes (today just the clone). The existing code maps `i.initContainers` and attaches the creds `envFrom`; the skills init also needs that `envFrom` (for `LASTLIGHT_SKILL_TOKEN`), so the simplest wiring is: the adapter passes the skills init as ANOTHER element of `initContainers` (so it gets the same `envFrom` mapping), and `buildPodManifest` gains only the `skills` emptyDir + the main-container mount when any skills init is present. Add a boolean `withSkills` derived from a new `skillsMount: boolean` field, OR infer from an initContainer named `"skills"`. Prefer an explicit `skillsMount?: boolean` field to avoid magic-name coupling. Keep the prompt/workspace volumes + mounts exactly as they are.

- [ ] **Step 1: Write the failing test**

Add to `pod.test.ts`:

```ts
import { SKILLS_MOUNT_DIR } from "#src/sandbox/k8s/skill-bundle.js";

describe("buildPodManifest skills mount", () => {
  it("adds a skills emptyDir + mounts it in the agent container when skillsMount is set", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict", skillsMount: true,
      initContainers: [{ name: "skills", image: "img" }],
    });
    const vol = pod.spec?.volumes?.find((v) => v.name === "skills");
    expect(vol?.emptyDir).toBeDefined();
    const mount = pod.spec?.containers[0].volumeMounts?.find((m) => m.name === "skills");
    expect(mount?.mountPath).toBe(SKILLS_MOUNT_DIR);
    expect(pod.spec?.initContainers?.some((c) => c.name === "skills")).toBe(true);
  });

  it("omits the skills volume when skillsMount is not set", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    expect(pod.spec?.volumes?.some((v) => v.name === "skills")).toBe(false);
    expect(pod.spec?.containers[0].volumeMounts?.some((m) => m.name === "skills")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: FAIL — `skillsMount` unknown / no `skills` volume.

- [ ] **Step 3: Write minimal implementation**

Add the import and field, and gate the volume + mount on `i.skillsMount`:

```ts
import { SKILLS_MOUNT_DIR } from "./skill-bundle.js";
```

Add to `PodSpecInput`:

```ts
  /** When set, add a `skills` emptyDir shared with the skills initContainer and
   *  mount it at SKILLS_MOUNT_DIR in the agent container (the initContainer,
   *  passed in `initContainers`, unpacks the fetched bundle into it). */
  skillsMount?: boolean;
```

In the `volumes` array, append when `i.skillsMount`:

```ts
        ...(i.skillsMount ? [{ name: "skills", emptyDir: {} }] : []),
```

In the agent container's `volumeMounts`, append when `i.skillsMount`:

```ts
            ...(i.skillsMount ? [{ name: "skills", mountPath: SKILLS_MOUNT_DIR }] : []),
```

(The `skills` initContainer arrives via `i.initContainers` and already carries its own `skills` mount + `envFrom`, built by the adapter in Task 6.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/pod.ts apps/server/tests/sandbox/k8s/pod.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): mount a shared skills emptyDir + init in the k8s pod"
```

---

### Task 6: Adapter — `stageSkills`, fetch token, skills-init, `--skill` command, egress selector, evict

**Files:**
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`
- Create: `apps/server/src/sandbox/k8s/init-skills.ts` (the skills-init container builder, mirroring `init-clone.ts`)
- Test: `apps/server/tests/sandbox/k8s/init-skills.test.ts`
- Test: `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts`

**Interfaces:**
- Consumes: `buildSkillTar`, `skillBundleRegistry`, `SKILLS_MOUNT_DIR` (Task 1); `SkillBundleRegistry` type; the config `harnessEndpoint`/`harnessNamespace`/`harnessPodLabels` (Task 3); `applyEgressPolicies`'s new `harness` param (Task 4); `buildPodManifest`'s `skillsMount` + `initContainers` (Task 5).
- Produces:
  - `buildSkillsInitContainer(image, opts: { endpoint: string; runAsUser: number }): V1Container` (in `init-skills.ts`) — a `restricted`-compliant init that fetches + unpacks the bundle. Command (argv-safe; token from env, endpoint from a positional arg):
    ```
    ["sh", "-c",
     'curl -fsS -H "Authorization: Bearer $LASTLIGHT_SKILL_TOKEN" "$1/internal/skill-bundle" | tar xzf - -C ' + SKILLS_MOUNT_DIR,
     "sh", endpoint]
    ```
    with `name: "skills"`, `image`, `volumeMounts: [{ name: "skills", mountPath: SKILLS_MOUNT_DIR }]`, and the restricted `securityContext` (mirror `init-clone.ts`). `envFrom` is filled by `buildPodManifest` (creds Secret) — leave `envFrom: []`.
  - `KubernetesSandbox.stageSkills(phaseKey, skillPaths)` — real implementation: `buildSkillTar(skillPaths)`; if no names, return `undefined`; else `this.skillToken = skillBundleRegistry.register(tar)`, stash the sanitized names, return `names.map((n) => \`${SKILLS_MOUNT_DIR}/${n}\`)`.
  - The adapter carries the fetch token into the creds Secret (`LASTLIGHT_SKILL_TOKEN`), builds + attaches the skills-init (with `skillsMount: true`) when a bundle was staged, appends `--skill <dir>` per staged dir to the `runAgent` command, passes the `HarnessSelector` to `ensureEgress`/`applyEgressPolicies`, and `skillBundleRegistry.evict(this.skillToken)` in `dispose`.

**Dispatch context (this is the integration task — several coupled edits):**
1. `KubernetesSandbox` needs a registry handle for testability: add a constructor/config field `skillRegistry?: SkillBundleRegistry` defaulting to the singleton `skillBundleRegistry`, so tests inject a fresh registry.
2. `stageSkills` is called by the orchestrator BEFORE `runAgent`. Stash the resulting in-pod dirs on the instance (e.g. `this.skillDirs`) AND the token, because `runPod` needs both (the token → creds Secret env; the dirs → the `--skill` flags + `skillsMount`). Note the orchestrator ALSO passes the returned dirs back as `opts.skillDirs` to `runAgent` — use `opts.skillDirs` in `runAgent` for the command (consistent with the other adapters), and use `this.skillToken`/a `this.skillsStaged` flag in `runPod` for the Secret + init wiring.
3. Creds Secret: when `this.skillToken` is set, add `LASTLIGHT_SKILL_TOKEN: this.skillToken` to the `env` map the creds Secret is built from (the same map that carries provider keys) — so it crosses via `envFrom` and the skills-init reads it.
4. `runAgent` command: build the skill flags from `opts.skillDirs` (each already `${SKILLS_MOUNT_DIR}/<sanitized-name>`, so interpolation is safe) and splice them into the script BEFORE `< ${PROMPT_FILE}`:
   ```
   const skillFlags = (opts.skillDirs ?? []).map((d) => `--skill ${d}`).join(" ");
   const script = `exec agentic-pi run --model "$1" --sandbox none --no-session ${skillFlags} < ${PROMPT_FILE}`;
   ```
5. `runPod`: when `this.skillToken` is set, build `buildSkillsInitContainer(this.image, { endpoint: this.harnessEndpoint, runAsUser: this.runAsUser })` and add it to the `initContainers` array alongside the clone init (both coexist), and pass `skillsMount: true` to `buildPodManifest`.
6. `ensureEgress`: build the `HarnessSelector` (`{ namespace: this.harnessNamespace, labels: this.harnessPodLabels, port: new URL(this.harnessEndpoint).port ? Number(...) : 8644 }`) and pass it through `applyEgressPolicies`. Cache key stays the namespace.
7. `dispose`: `if (this.skillToken) this.skillRegistry.evict(this.skillToken)`.
8. `runCommand` stages no skills (it already passes no `skillDirs`) — leave it unaffected; a `runCommand` pod gets no skills-init and no `LASTLIGHT_SKILL_TOKEN`.

- [ ] **Step 1 (init-skills.ts): Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/init-skills.test.ts
import { describe, it, expect } from "vitest";
import { buildSkillsInitContainer } from "#src/sandbox/k8s/init-skills.js";
import { SKILLS_MOUNT_DIR } from "#src/sandbox/k8s/skill-bundle.js";

describe("buildSkillsInitContainer", () => {
  const c = buildSkillsInitContainer("img", { endpoint: "http://h.ns.svc:8644", runAsUser: 10001 });

  it("fetches the bundle with the token from env and unpacks into the skills mount", () => {
    expect(c.name).toBe("skills");
    const script = c.command?.[2] ?? "";
    expect(script).toContain('Authorization: Bearer $LASTLIGHT_SKILL_TOKEN');
    expect(script).toContain("/internal/skill-bundle");
    expect(script).toContain(`tar xzf - -C ${SKILLS_MOUNT_DIR}`);
    // endpoint is a positional arg ($1), not interpolated into the script text
    expect(c.args).toEqual(["sh", "http://h.ns.svc:8644"]);
    expect(script).not.toContain("http://h.ns.svc:8644");
  });

  it("mounts the shared skills volume and is restricted-compliant", () => {
    expect(c.volumeMounts).toContainEqual({ name: "skills", mountPath: SKILLS_MOUNT_DIR });
    expect(c.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c.securityContext?.capabilities?.drop).toEqual(["ALL"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/init-skills.test.ts`
Expected: FAIL — `Cannot find module '#src/sandbox/k8s/init-skills.js'`.

- [ ] **Step 3: Write `init-skills.ts`**

```ts
// apps/server/src/sandbox/k8s/init-skills.ts
import type { V1Container } from "@kubernetes/client-node";
import { SKILLS_MOUNT_DIR } from "./skill-bundle.js";

/**
 * The skills initContainer: fetch the per-phase bundle from the harness
 * (bearer token from the creds Secret env, endpoint as a positional arg so it
 * is never interpolated into the script) and unpack it into the shared
 * `skills` emptyDir the agent container reads via `--skill`. `envFrom` (creds
 * Secret) is attached by `buildPodManifest`. `-f` makes curl fail the init on a
 * non-2xx so a bad fetch surfaces (checkInitContainerFailure appends its logs).
 */
export function buildSkillsInitContainer(
  image: string,
  opts: { endpoint: string; runAsUser: number },
): V1Container {
  const script =
    'curl -fsS -H "Authorization: Bearer $LASTLIGHT_SKILL_TOKEN" ' +
    `"$1/internal/skill-bundle" | tar xzf - -C ${SKILLS_MOUNT_DIR}`;
  return {
    name: "skills",
    image,
    command: ["sh", "-c", script],
    args: ["sh", opts.endpoint],
    envFrom: [],
    volumeMounts: [{ name: "skills", mountPath: SKILLS_MOUNT_DIR }],
    securityContext: {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: opts.runAsUser,
      capabilities: { drop: ["ALL"] },
    },
  };
}
```

- [ ] **Step 4: Run the init-skills test — PASS.**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/init-skills.test.ts`

- [ ] **Step 5: Write the adapter integration test**

Add to `kubernetes-sandbox.test.ts` (inject a fresh `SkillBundleRegistry` via `cfg(apis, { skillRegistry })`, and use a real temp skill dir so `buildSkillTar` produces a bundle). Assert, for a `runAgent` after `stageSkills`:
- `stageSkills` returns `["/lastlight-skills/pr-review"]` and registers one bundle (`skillRegistry.get(token)` is defined for the token that ends up in the creds Secret).
- the created pod has a `skills` initContainer, a `skills` emptyDir, and the agent container mounts `/lastlight-skills`;
- the creds Secret's `stringData.LASTLIGHT_SKILL_TOKEN` is set;
- the agent command contains `--skill /lastlight-skills/pr-review`;
- after `dispose`, `skillRegistry.get(token)` is `undefined` (evicted).

```ts
import { SkillBundleRegistry } from "#src/sandbox/k8s/skill-bundle.js";
// … build a temp skill dir `skillSrc` with a SKILL.md (see skill-bundle.test.ts) …
it("stages skills: registers a bundle, wires the init + token + --skill, evicts on dispose", async () => {
  const { apis, created, secretsCreated } = fakeApis();
  const skillRegistry = new SkillBundleRegistry();
  const sbx = new KubernetesSandbox(
    { taskId: "t-skills", egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp", timeoutSeconds: 60 } as any,
    cfg(apis, { namespace: "ns-skills", skillRegistry }),
  );
  await sbx.provision();
  const dirs = sbx.stageSkills("pr-review", [skillSrc]);
  expect(dirs).toEqual(["/lastlight-skills/pr-review"]);

  await sbx.runAgent("t-skills", "hello",
    { model: "anthropic/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace", skillDirs: dirs } as any,
    () => {});

  const pod = created[0];
  expect(pod.spec.initContainers.some((c: any) => c.name === "skills")).toBe(true);
  expect(pod.spec.volumes.some((v: any) => v.name === "skills")).toBe(true);
  expect(pod.spec.containers[0].command.join(" ")).toContain("--skill /lastlight-skills/pr-review");
  const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
  const token = creds.stringData.LASTLIGHT_SKILL_TOKEN;
  expect(token).toBeTruthy();
  expect(skillRegistry.get(token)).toBeDefined();

  await sbx.dispose();
  expect(skillRegistry.get(token)).toBeUndefined();
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes-sandbox.test.ts`
Expected: FAIL — `stageSkills` still returns `undefined`; no skills init/token/`--skill`.

- [ ] **Step 7: Implement the adapter wiring** per the Dispatch context (1–8). Then run the WHOLE k8s dir + tsc.

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/` and `pnpm --filter lastlight-core exec tsc --noEmit`
Expected: PASS (all k8s suites) + clean tsc. Verify no line >100 in the changed files.

- [ ] **Step 8: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/kubernetes-sandbox.ts apps/server/src/sandbox/k8s/init-skills.ts apps/server/tests/sandbox/k8s/init-skills.test.ts apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): deliver skills to the k8s pod over the authed HTTP channel"
```

---

### Task 7: Integration test — harness endpoint round-trip (validatable now) + deferred pod-fetch note

**Files:**
- Modify: `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts` (or a new `skill-bundle.integration.test.ts` — keep the opt-in gate style)

**Interfaces:** Consumes the real `mountSkillBundle` + `skillBundleRegistry` + `buildSkillTar`.

**Dispatch context:** The full pod→harness fetch cannot run until the harness is reachable *from* a sandbox Pod, which needs the harness deployed in-cluster (Plan 6). So this task's runnable test is an **in-process endpoint round-trip** (no cluster, no `RUN_K8S_IT`): register a real bundle built from a temp skill dir, start the Hono app with `mountSkillBundle`, `curl` it via `app.request` with the token, pipe the body through `tar xzf`, and assert the skill files materialize. This validates the serve+unpack contract the initContainer depends on. Add a top-of-file comment documenting that the end-to-end pod fetch is deferred to post-Plan-6 (harness in-cluster) and how to run it then (`RUN_K8S_IT=1` against a cluster where the harness Service resolves).

- [ ] **Step 1: Write the round-trip test** (no gate — runs in the normal suite):

```ts
it("harness endpoint serves a tar that unpacks to the staged skills", async () => {
  const skillSrc = /* temp dir with pr-review/SKILL.md, as in skill-bundle.test.ts */;
  const { tar } = buildSkillTar([skillSrc]);
  const reg = new SkillBundleRegistry();
  const token = reg.register(tar);
  const app = new Hono();
  mountSkillBundle(app, reg);

  const res = await app.request("/internal/skill-bundle", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const out = mkdtempSync(join(tmpdir(), "it-skills-"));
  const tgz = join(out, "b.tgz");
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["xzf", tgz, "-C", out]);
  expect(existsSync(join(out, "pr-review", "SKILL.md"))).toBe(true);
});
```

- [ ] **Step 2: Run it — PASS.**

Run: `pnpm --filter lastlight-core exec vitest run <the IT file>`
Expected: PASS (this one runs without a cluster). The pre-existing `RUN_K8S_IT` cases stay skipped without the flag.

- [ ] **Step 3: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/tests/sandbox/k8s/
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "test(sandbox): skill-bundle endpoint round-trip (pod fetch deferred to Plan 6)"
```

---

## Self-Review

**Spec coverage (design §7 + §4 harness-channel):**
- "Harness serves the already-resolved per-phase skill bundle at an authenticated internal endpoint" → Task 1 (registry + tar) + Task 2 (route, bearer auth).
- "An initContainer fetches + unpacks it into an emptyDir shared with the main container" → Task 5 (emptyDir + mount) + Task 6 (`init-skills.ts` fetch/unpack).
- "One uniform mechanism for core and overlay; no image rebuild on a skill edit" → the harness resolves `skillPaths` (core/overlay) upstream; `stageSkills` tars whatever it's handed — no image coupling.
- "Reached via the Section 4 Cilium toEndpoints rule (sandbox→harness only)" → Task 4 (extends the Plan 3 renderer).
- "The per-run Secret carries a scoped fetch token so a pod can pull only its own bundle" → Task 6 (`LASTLIGHT_SKILL_TOKEN` in the creds Secret) + Task 2 (token-gated 401).
- "This harness↔pod HTTP channel is the same one a future server-mode POST-back reuses" → the route + registry are the reusable seam; server-mode is a documented non-goal here.
- Wiring `--skill` into the agent run → Task 6 (command builder) — closes the `skillDirs` RunAgentOpts-parity gap the HANDOVER tracked.

**Placeholder scan:** every code step carries real code; Task 3's config-test file and Task 7's temp-skill-dir are named against existing patterns (the `skill-bundle.test.ts` temp-dir recipe), not TODOs.

**Type consistency:** `SKILLS_MOUNT_DIR` (Task 1) is the single source for the mount path in pod.ts (Task 5), init-skills.ts (Task 6), and the returned in-pod dirs (Task 6). `HarnessSelector` (Task 4) is the same shape the adapter builds (Task 6) and `applyEgressPolicies` consumes (Task 4). `LASTLIGHT_SKILL_TOKEN` is the same key in the creds Secret (Task 6) and the init script (Task 6). `skillsMount`/`initContainers` (Task 5) are what the adapter passes (Task 6).

**Deferred / not in this plan (tracked):**
- **End-to-end pod→harness fetch** validates only after the harness deploys in-cluster (Plan 6) — Task 7 validates the endpoint contract in-process; the cluster fetch is documented-deferred.
- **`toEndpoints` enforcement** (like all Plan 3 egress) is live only once the CNP is applied under Plan 6 RBAC — until then default-allow lets the fetch through.
- **Server-mode artifact POST-back** over this same channel — design non-goal, future plan.
- The RunAgentOpts `thinking`/`profile` parity gap (HANDOVER) stays a fast-follow — not skills.
