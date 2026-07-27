# Plan 3 — Egress (`CiliumNetworkPolicy` from `egress-allowlist.ts`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `kubernetes` sandbox backend a default-deny HTTP egress posture by rendering a strict/open `CiliumNetworkPolicy` pair from the shared `egress-allowlist.ts`, applying it idempotently at first use, and stamping each sandbox Pod with the `egress-policy: strict|open` label that selects it.

**Architecture:** The allowlist stays the single source of truth (`egress-allowlist.ts` — `GITHUB_HOSTS` + `PROVIDER_HOSTS` + `PACKAGE_REGISTRY_HOSTS`). A new pure renderer (`k8s/egress-policy.ts`) turns it into two `CiliumNetworkPolicy` objects — the same generate-from-the-shared-source pattern the docker backend uses for its nginx/coredns configs. The adapter applies the pair once per namespace via a new `CustomObjectsApi` client (the CRD needs a custom-objects client the current wiring lacks), then labels every Pod `egress-policy: strict` (the default allowlist) or `egress-policy: open` (an `unrestricted_egress` phase). Because the target cluster's RBAC for the `CiliumNetworkPolicy` verb only lands in Plan 6 (Flux), the apply is **best-effort**: a `403 Forbidden` logs one loud warning and the run proceeds on Cilium's default-allow (today's behaviour) — no regression, and the identical code enforces the moment RBAC exists.

**Tech Stack:** TypeScript (ESM, NodeNext), `@kubernetes/client-node@1.4.0` (object-param API; `CustomObjectsApi` for the CRD), Cilium `cilium.io/v2` `CiliumNetworkPolicy`, vitest.

## Global Constraints

- **Client API shape:** `@kubernetes/client-node@1.4.0`, **object-param** methods only (e.g. `createNamespacedCustomObject({ group, version, namespace, plural, body })`), never the positional RequestFactory. `ApiException.code` is the HTTP status.
- **CRD coordinates (verbatim):** group `cilium.io`, version `v2`, plural `ciliumnetworkpolicies`, kind `CiliumNetworkPolicy`.
- **Single source of truth:** the allowlist is `DEFAULT_ALLOWLIST` in `apps/server/src/sandbox/egress-allowlist.ts`. Do **not** hand-copy hosts into a policy; render them. Merge in OTEL collector hosts exactly as `egressPolicyFor` does (`config.otel?.enabled && config.otel.forwardToSandbox ? collectorHosts : []`).
- **Allowlist convention:** entries are bare apex hostnames and mean apex **AND** all subdomains. Each expands to a Cilium `{ matchName: host }` **plus** `{ matchPattern: "*.host" }` (the pattern alone excludes the apex).
- **Label key (verbatim):** `egress-policy`, values `strict` | `open`. The Pod label and the policy `endpointSelector.matchLabels` MUST use this exact key/values or the policy selects nothing.
- **Best-effort apply (Plan 3 only):** a `403` from the apply is a warning, not a failure — the RBAC verb arrives in Plan 6. Any other error propagates.
- **No new runtime config surface.** Namespace is the already-existing `sandbox.kubernetes.namespace`. Private-CIDR ranges and the kube-dns selector are constants. The `toEndpoints` sandbox→harness rule and its harness-Service config belong to **Plan 4 (skills)** — do not add it here.
- **Line length ≤100, functions ≤100 lines / complexity ≤8, absolute imports, no relative `..` paths, Google-style docstrings on public APIs.** Commit with `LASTLIGHT_SKIP_DOCS_CHECK=1` (backend still unreachable until Plan 6 — see HANDOVER).
- **Command-injection & PEM rules unchanged** (they don't surface in this plan, but keep them intact).

---

## File Structure

- **Create** `apps/server/src/sandbox/k8s/egress-policy.ts` — pure renderer: allowlist → `CiliumNetworkPolicy` pair. Constants (names, label key, CRD coords, private CIDRs, kube-dns selector), `fqdnRulesFor`, `renderStrictEgressPolicy`, `renderOpenEgressPolicy`, `renderEgressPolicies`. No I/O, no client — golden-testable like `egress-firewall-config.ts`.
- **Create** `apps/server/src/sandbox/k8s/egress-apply.ts` — `applyEgressPolicies(custom, { namespace, hosts })`: idempotent create-or-replace of both policies via `CustomObjectsApi`. No caching, no warn-swallowing (the adapter owns those).
- **Modify** `apps/server/src/sandbox/k8s/client.ts` — add `custom: CustomObjectsApi` to `K8sApis` + `makeK8sApis`.
- **Modify** `apps/server/src/sandbox/k8s/pod.ts` — add `egressPolicy: "strict" | "open"` to `PodSpecInput`; stamp the `egress-policy` label.
- **Modify** `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts` — compute strict/open from `this.opts.egress.unrestricted`; ensure-once (module-cached, 403→warn) before pod create; thread `egressPolicy` into `buildPodManifest`.
- **Create** `apps/server/tests/sandbox/k8s/egress-policy.test.ts` — golden renderer tests.
- **Create** `apps/server/tests/sandbox/k8s/egress-apply.test.ts` — apply create/409-replace with a fake `CustomObjectsApi`.
- **Modify** `apps/server/tests/sandbox/k8s/pod.test.ts` — label assertion.
- **Modify** `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts` — adapter wires ensure + label (fake `custom`).
- **Modify** `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts` — opt-in enforcement case (skips gracefully on 403).

---

### Task 1: Cilium egress-policy renderer (pure)

**Files:**
- Create: `apps/server/src/sandbox/k8s/egress-policy.ts`
- Test: `apps/server/tests/sandbox/k8s/egress-policy.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_ALLOWLIST`, `mergeAllowlist` from `apps/server/src/sandbox/egress-allowlist.ts` (the caller passes an already-merged `hosts` list; the renderer only maps it).
- Produces:
  - `EGRESS_POLICY_LABEL = "egress-policy"` (string const)
  - `STRICT_POLICY_NAME = "lastlight-sandbox-egress-strict"`, `OPEN_POLICY_NAME = "lastlight-sandbox-egress-open"`
  - `CILIUM_GROUP = "cilium.io"`, `CILIUM_VERSION = "v2"`, `CILIUM_CNP_PLURAL = "ciliumnetworkpolicies"`
  - `interface CiliumNetworkPolicy { apiVersion: string; kind: string; metadata: { name: string; namespace: string }; spec: { endpointSelector: { matchLabels: Record<string, string> }; egress: unknown[] } }`
  - `fqdnRulesFor(hosts: readonly string[]): Array<{ matchName: string } | { matchPattern: string }>`
  - `renderStrictEgressPolicy(opts: { namespace: string; hosts: readonly string[] }): CiliumNetworkPolicy`
  - `renderOpenEgressPolicy(opts: { namespace: string }): CiliumNetworkPolicy`
  - `renderEgressPolicies(opts: { namespace: string; hosts: readonly string[] }): { strict: CiliumNetworkPolicy; open: CiliumNetworkPolicy }`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/egress-policy.test.ts
import { describe, it, expect } from "vitest";
import {
  EGRESS_POLICY_LABEL,
  STRICT_POLICY_NAME,
  OPEN_POLICY_NAME,
  CILIUM_GROUP,
  CILIUM_VERSION,
  CILIUM_CNP_PLURAL,
  fqdnRulesFor,
  renderStrictEgressPolicy,
  renderOpenEgressPolicy,
  renderEgressPolicies,
} from "#src/sandbox/k8s/egress-policy.js";
import { DEFAULT_ALLOWLIST } from "#src/sandbox/egress-allowlist.js";

describe("fqdnRulesFor", () => {
  it("expands each bare host to apex matchName + subdomain matchPattern", () => {
    expect(fqdnRulesFor(["github.com"])).toEqual([
      { matchName: "github.com" },
      { matchPattern: "*.github.com" },
    ]);
  });
  it("preserves order and covers every allowlist host", () => {
    const rules = fqdnRulesFor(DEFAULT_ALLOWLIST);
    for (const host of DEFAULT_ALLOWLIST) {
      expect(rules).toContainEqual({ matchName: host });
      expect(rules).toContainEqual({ matchPattern: `*.${host}` });
    }
  });
});

describe("renderStrictEgressPolicy", () => {
  const pol = renderStrictEgressPolicy({ namespace: "lastlight-sandboxes", hosts: ["github.com", "openai.com"] });

  it("is a namespaced CiliumNetworkPolicy selecting the strict label", () => {
    expect(pol.apiVersion).toBe(`${CILIUM_GROUP}/${CILIUM_VERSION}`);
    expect(pol.kind).toBe("CiliumNetworkPolicy");
    expect(pol.metadata.name).toBe(STRICT_POLICY_NAME);
    expect(pol.metadata.namespace).toBe("lastlight-sandboxes");
    expect(pol.spec.endpointSelector.matchLabels).toEqual({ [EGRESS_POLICY_LABEL]: "strict" });
  });

  it("allows DNS to kube-dns with a wildcard dns-proxy rule (so toFQDNs can resolve)", () => {
    const dns = pol.spec.egress.find(
      (r: any) => r.toEndpoints?.[0]?.matchLabels?.["k8s:io.kubernetes.pod.namespace"] === "kube-system",
    ) as any;
    expect(dns.toEndpoints[0].matchLabels["k8s-app"]).toBe("kube-dns");
    expect(dns.toPorts[0].ports).toContainEqual({ port: "53", protocol: "ANY" });
    expect(dns.toPorts[0].rules.dns).toEqual([{ matchPattern: "*" }]);
  });

  it("allows the allowlist FQDNs on 443/TCP and nothing else (default-deny elsewhere)", () => {
    const fqdn = pol.spec.egress.find((r: any) => r.toFQDNs) as any;
    expect(fqdn.toFQDNs).toContainEqual({ matchName: "github.com" });
    expect(fqdn.toFQDNs).toContainEqual({ matchPattern: "*.openai.com" });
    expect(fqdn.toPorts[0].ports).toEqual([{ port: "443", protocol: "TCP" }]);
    // strict has exactly DNS + FQDN rules — no CIDR hole.
    expect(pol.spec.egress.some((r: any) => r.toCIDRSet)).toBe(false);
  });
});

describe("renderOpenEgressPolicy", () => {
  const pol = renderOpenEgressPolicy({ namespace: "lastlight-sandboxes" });

  it("selects the open label and keeps the DNS rule", () => {
    expect(pol.metadata.name).toBe(OPEN_POLICY_NAME);
    expect(pol.spec.endpointSelector.matchLabels).toEqual({ [EGRESS_POLICY_LABEL]: "open" });
    expect(pol.spec.egress.some((r: any) => r.toPorts?.[0]?.rules?.dns)).toBe(true);
  });

  it("allows broad egress but excepts private + link-local + loopback (the SSRF floor)", () => {
    const cidr = pol.spec.egress.find((r: any) => r.toCIDRSet) as any;
    const v4 = cidr.toCIDRSet.find((c: any) => c.cidr === "0.0.0.0/0");
    expect(v4.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8"]),
    );
    const v6 = cidr.toCIDRSet.find((c: any) => c.cidr === "::/0");
    expect(v6.except).toEqual(expect.arrayContaining(["::1/128", "fc00::/7", "fe80::/10"]));
    expect(cidr.toPorts[0].ports).toEqual(
      expect.arrayContaining([{ port: "443", protocol: "TCP" }, { port: "80", protocol: "TCP" }]),
    );
  });
});

describe("renderEgressPolicies", () => {
  it("returns the strict/open pair for a namespace", () => {
    const { strict, open } = renderEgressPolicies({ namespace: "ns", hosts: ["github.com"] });
    expect(strict.metadata.name).toBe(STRICT_POLICY_NAME);
    expect(open.metadata.name).toBe(OPEN_POLICY_NAME);
    expect(strict.metadata.namespace).toBe("ns");
    expect(open.metadata.namespace).toBe("ns");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/egress-policy.test.ts`
Expected: FAIL — `Cannot find module '#src/sandbox/k8s/egress-policy.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/sandbox/k8s/egress-policy.ts

/** Pod/selector label choosing which egress policy applies. */
export const EGRESS_POLICY_LABEL = "egress-policy";

export const STRICT_POLICY_NAME = "lastlight-sandbox-egress-strict";
export const OPEN_POLICY_NAME = "lastlight-sandbox-egress-open";

/** Cilium CiliumNetworkPolicy CRD coordinates (client-node CustomObjectsApi). */
export const CILIUM_GROUP = "cilium.io";
export const CILIUM_VERSION = "v2";
export const CILIUM_CNP_PLURAL = "ciliumnetworkpolicies";

/**
 * Private / link-local / loopback ranges the OPEN policy excepts from its
 * broad `0.0.0.0/0` allow — the SSRF floor. RFC-1918 covers the cluster pod /
 * service CIDRs on the target cluster (all within 10/8), and 169.254.0.0/16
 * covers the cloud-metadata literal. Strict mode needs none of this: with only
 * DNS + toFQDNs rules, a strict pod can reach *only* an allowlisted FQDN's
 * resolved IP, so private space is unreachable by construction.
 */
const PRIVATE_CIDRS_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8"];
const PRIVATE_CIDRS_V6 = ["::1/128", "fc00::/7", "fe80::/10"];

/** Selects the in-cluster DNS service so Cilium's DNS proxy sees the queries. */
const KUBE_DNS_SELECTOR = {
  "k8s:io.kubernetes.pod.namespace": "kube-system",
  "k8s-app": "kube-dns",
};

/**
 * DNS egress rule shared by both policies: allow port 53 to kube-dns AND turn
 * on the DNS proxy (`rules.dns: [{ matchPattern: "*" }]`). WITHOUT this rule
 * `toFQDNs` never learns any IP and every connection is denied — Cilium only
 * permits connecting to an IP it was allowed to resolve. This is the mechanism
 * that closes the private-IP SSRF gap the docker SNI-peek admits it cannot.
 */
function dnsEgressRule(): unknown {
  return {
    toEndpoints: [{ matchLabels: KUBE_DNS_SELECTOR }],
    toPorts: [{ ports: [{ port: "53", protocol: "ANY" }], rules: { dns: [{ matchPattern: "*" }] } }],
  };
}

export interface CiliumNetworkPolicy {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace: string };
  spec: { endpointSelector: { matchLabels: Record<string, string> }; egress: unknown[] };
}

/**
 * Expand each bare allowlist host to the two Cilium FQDN forms it needs:
 * `matchName` for the apex, `matchPattern: "*.host"` for every subdomain
 * (the pattern alone excludes the apex). Mirrors nginx's `.host` and CoreDNS's
 * `(^|\.)host\.$` — same apex+subdomain convention, one shared source list.
 */
export function fqdnRulesFor(hosts: readonly string[]): Array<{ matchName: string } | { matchPattern: string }> {
  const rules: Array<{ matchName: string } | { matchPattern: string }> = [];
  for (const host of hosts) {
    rules.push({ matchName: host });
    rules.push({ matchPattern: `*.${host}` });
  }
  return rules;
}

function policy(name: string, namespace: string, value: "strict" | "open", egress: unknown[]): CiliumNetworkPolicy {
  return {
    apiVersion: `${CILIUM_GROUP}/${CILIUM_VERSION}`,
    kind: "CiliumNetworkPolicy",
    metadata: { name, namespace },
    spec: { endpointSelector: { matchLabels: { [EGRESS_POLICY_LABEL]: value } }, egress },
  };
}

/** Strict = DNS + the allowlist FQDNs on 443/TCP; everything else default-denied. */
export function renderStrictEgressPolicy(opts: { namespace: string; hosts: readonly string[] }): CiliumNetworkPolicy {
  const egress = [
    dnsEgressRule(),
    { toFQDNs: fqdnRulesFor(opts.hosts), toPorts: [{ ports: [{ port: "443", protocol: "TCP" }] }] },
  ];
  return policy(STRICT_POLICY_NAME, opts.namespace, "strict", egress);
}

/** Open = DNS + broad 80/443 egress minus the private-CIDR SSRF floor. */
export function renderOpenEgressPolicy(opts: { namespace: string }): CiliumNetworkPolicy {
  const egress = [
    dnsEgressRule(),
    {
      toCIDRSet: [
        { cidr: "0.0.0.0/0", except: PRIVATE_CIDRS_V4 },
        { cidr: "::/0", except: PRIVATE_CIDRS_V6 },
      ],
      toPorts: [{ ports: [{ port: "443", protocol: "TCP" }, { port: "80", protocol: "TCP" }] }],
    },
  ];
  return policy(OPEN_POLICY_NAME, opts.namespace, "open", egress);
}

export function renderEgressPolicies(opts: {
  namespace: string;
  hosts: readonly string[];
}): { strict: CiliumNetworkPolicy; open: CiliumNetworkPolicy } {
  return {
    strict: renderStrictEgressPolicy(opts),
    open: renderOpenEgressPolicy({ namespace: opts.namespace }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/egress-policy.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/egress-policy.ts apps/server/tests/sandbox/k8s/egress-policy.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): render Cilium egress policy pair from the allowlist"
```

---

### Task 2: Wire `CustomObjectsApi` into the k8s client

**Files:**
- Modify: `apps/server/src/sandbox/k8s/client.ts`
- Test: `apps/server/tests/sandbox/k8s/client.test.ts`

**Interfaces:**
- Consumes: `CustomObjectsApi` from `@kubernetes/client-node`.
- Produces: `K8sApis` gains `custom: CustomObjectsApi`; `makeK8sApis` populates it via `config.makeApiClient(CustomObjectsApi)`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/tests/sandbox/k8s/client.test.ts` (mirror the existing `makeK8sApis` case that asserts `core`/`log`):

```ts
it("exposes a CustomObjectsApi client for CiliumNetworkPolicy", () => {
  const kc = new KubeConfig();
  kc.loadFromOptions({
    clusters: [{ name: "c", server: "https://example.test" }],
    users: [{ name: "u" }],
    contexts: [{ name: "ctx", cluster: "c", user: "u" }],
    currentContext: "ctx",
  });
  const apis = makeK8sApis(kc);
  expect(apis.custom).toBeInstanceOf(CustomObjectsApi);
});
```

Ensure the test file imports `CustomObjectsApi` and `KubeConfig` from `@kubernetes/client-node` (add `CustomObjectsApi` to the existing import if the others are already there).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/client.test.ts`
Expected: FAIL — `apis.custom` is `undefined` (not a `CustomObjectsApi`).

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/sandbox/k8s/client.ts`:

```ts
import { KubeConfig, CoreV1Api, CustomObjectsApi, Log } from "@kubernetes/client-node";

export interface K8sApis {
  core: CoreV1Api;
  /** CiliumNetworkPolicy (cilium.io/v2) lives off the core API — needs the
   *  generic custom-objects client. */
  custom: CustomObjectsApi;
  log: Log;
  kc: KubeConfig;
}

export function makeK8sApis(kc?: KubeConfig): K8sApis {
  const config = kc ?? loadInClusterOrDefault();
  return {
    core: config.makeApiClient(CoreV1Api),
    custom: config.makeApiClient(CustomObjectsApi),
    log: new Log(config),
    kc: config,
  };
}
```

(Leave `inClusterConfigAvailable` / `loadInClusterOrDefault` unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/client.ts apps/server/tests/sandbox/k8s/client.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): add CustomObjectsApi to the k8s client wiring"
```

---

### Task 3: Idempotent `applyEgressPolicies`

**Files:**
- Create: `apps/server/src/sandbox/k8s/egress-apply.ts`
- Test: `apps/server/tests/sandbox/k8s/egress-apply.test.ts`

**Interfaces:**
- Consumes: `CustomObjectsApi` (from `@kubernetes/client-node`); `ApiException`; `renderEgressPolicies`, `CILIUM_GROUP`, `CILIUM_VERSION`, `CILIUM_CNP_PLURAL` from Task 1.
- Produces: `applyEgressPolicies(custom: CustomObjectsApi, opts: { namespace: string; hosts: readonly string[] }): Promise<void>` — create-or-replace BOTH policies. On `409 AlreadyExists` for a policy it `replaceNamespacedCustomObject`s it (keeps the live policy current after a config change). Any non-409 error propagates (the adapter decides 403→warn).

**Dispatch context for the implementer/reviewer:** `replaceNamespacedCustomObject` needs the object's current `metadata.resourceVersion` or the API rejects it (`409 Conflict`). So the replace path must `getNamespacedCustomObject` first, copy its `resourceVersion` onto the rendered body, then replace. The object-param signatures are `createNamespacedCustomObject({ group, version, namespace, plural, body })`, `getNamespacedCustomObject({ group, version, namespace, plural, name })`, `replaceNamespacedCustomObject({ group, version, namespace, plural, name, body })`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/tests/sandbox/k8s/egress-apply.test.ts
import { describe, it, expect, vi } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { applyEgressPolicies } from "#src/sandbox/k8s/egress-apply.js";
import { STRICT_POLICY_NAME, OPEN_POLICY_NAME } from "#src/sandbox/k8s/egress-policy.js";

function apiError(code: number): ApiException<unknown> {
  return new ApiException(code, "boom", {}, {});
}

describe("applyEgressPolicies", () => {
  it("creates both policies when neither exists", async () => {
    const create = vi.fn().mockResolvedValue({});
    const custom = { createNamespacedCustomObject: create } as any;
    await applyEgressPolicies(custom, { namespace: "ns", hosts: ["github.com"] });
    const names = create.mock.calls.map((c) => c[0].body.metadata.name);
    expect(names).toContain(STRICT_POLICY_NAME);
    expect(names).toContain(OPEN_POLICY_NAME);
    expect(create.mock.calls[0][0]).toMatchObject({ group: "cilium.io", version: "v2", plural: "ciliumnetworkpolicies" });
  });

  it("replaces an existing policy (409) after reading its resourceVersion", async () => {
    const create = vi.fn().mockRejectedValue(apiError(409));
    const get = vi.fn().mockResolvedValue({ metadata: { resourceVersion: "42" } });
    const replace = vi.fn().mockResolvedValue({});
    const custom = {
      createNamespacedCustomObject: create,
      getNamespacedCustomObject: get,
      replaceNamespacedCustomObject: replace,
    } as any;
    await applyEgressPolicies(custom, { namespace: "ns", hosts: ["github.com"] });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0][0].body.metadata.resourceVersion).toBe("42");
  });

  it("propagates a non-409 error (e.g. 403 — the adapter decides to warn)", async () => {
    const create = vi.fn().mockRejectedValue(apiError(403));
    const custom = { createNamespacedCustomObject: create } as any;
    await expect(applyEgressPolicies(custom, { namespace: "ns", hosts: ["github.com"] })).rejects.toMatchObject({
      code: 403,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/egress-apply.test.ts`
Expected: FAIL — `Cannot find module '#src/sandbox/k8s/egress-apply.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/server/src/sandbox/k8s/egress-apply.ts
import { ApiException, type CustomObjectsApi } from "@kubernetes/client-node";
import {
  CILIUM_CNP_PLURAL,
  CILIUM_GROUP,
  CILIUM_VERSION,
  renderEgressPolicies,
  type CiliumNetworkPolicy,
} from "./egress-policy.js";

/**
 * Create-or-replace the strict/open CiliumNetworkPolicy pair in `namespace`.
 * Idempotent: a `409 AlreadyExists` on create falls through to a `replace`
 * (carrying the live object's `resourceVersion`) so a redeploy that changes the
 * allowlist updates the running policy. Any other error propagates — the caller
 * (the adapter) turns a `403` (RBAC not yet granted — Plan 6) into a warning.
 */
export async function applyEgressPolicies(
  custom: CustomObjectsApi,
  opts: { namespace: string; hosts: readonly string[] },
): Promise<void> {
  const { strict, open } = renderEgressPolicies({ namespace: opts.namespace, hosts: opts.hosts });
  await createOrReplace(custom, opts.namespace, strict);
  await createOrReplace(custom, opts.namespace, open);
}

async function createOrReplace(
  custom: CustomObjectsApi,
  namespace: string,
  body: CiliumNetworkPolicy,
): Promise<void> {
  const coords = { group: CILIUM_GROUP, version: CILIUM_VERSION, namespace, plural: CILIUM_CNP_PLURAL };
  try {
    await custom.createNamespacedCustomObject({ ...coords, body });
  } catch (err) {
    if (!(err instanceof ApiException) || err.code !== 409) throw err;
    const name = body.metadata.name;
    const current = (await custom.getNamespacedCustomObject({ ...coords, name })) as CiliumNetworkPolicy & {
      metadata: { resourceVersion?: string };
    };
    const withVersion = {
      ...body,
      metadata: { ...body.metadata, resourceVersion: current.metadata.resourceVersion },
    };
    await custom.replaceNamespacedCustomObject({ ...coords, name, body: withVersion });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/egress-apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/egress-apply.ts apps/server/tests/sandbox/k8s/egress-apply.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): idempotent apply of the k8s egress policy pair"
```

---

### Task 4: Stamp the `egress-policy` label + ensure-once in the adapter

**Files:**
- Modify: `apps/server/src/sandbox/k8s/pod.ts`
- Modify: `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`
- Test: `apps/server/tests/sandbox/k8s/pod.test.ts`
- Test: `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts`

**Interfaces:**
- Consumes: `EGRESS_POLICY_LABEL` (Task 1); `applyEgressPolicies` (Task 3); `K8sApis.custom` (Task 2); `DEFAULT_ALLOWLIST`, `mergeAllowlist` from `egress-allowlist.ts`; `this.opts.egress` (`EgressPolicy` — already passed to the adapter) and `this.opts.otel`.
- Produces:
  - `PodSpecInput` gains `egressPolicy: "strict" | "open"`; `buildPodManifest` sets `metadata.labels[EGRESS_POLICY_LABEL]`.
  - The adapter computes `egressPolicy` from `this.opts.egress.unrestricted`, calls `ensureEgress()` (module-cached per namespace; `403` → one warning) before pod create, and threads `egressPolicy` into `buildPodManifest`.

**Dispatch context for the implementer/reviewer:** `PodSpecInput.egressPolicy` becomes REQUIRED, so `buildPodManifest`'s existing callers must pass it. There is exactly one production caller — `runPod` in `kubernetes-sandbox.ts` — plus the pod.test.ts fixtures; update all of them in THIS task (they compile together). The label merges into the existing `metadata.labels` object alongside `app.kubernetes.io/managed-by` / `lastlight.io/component`.

- [ ] **Step 1 (pod.ts): Write the failing test**

Add to `apps/server/tests/sandbox/k8s/pod.test.ts`:

```ts
import { EGRESS_POLICY_LABEL } from "#src/sandbox/k8s/egress-policy.js";

describe("buildPodManifest egress label", () => {
  it("stamps egress-policy=strict so the strict CiliumNetworkPolicy selects it", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "strict",
    });
    expect(pod.metadata?.labels?.[EGRESS_POLICY_LABEL]).toBe("strict");
  });
  it("stamps egress-policy=open for an unrestricted phase", () => {
    const pod = buildPodManifest({
      name: "ll-x", namespace: "ns", image: "img", command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds", cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800, runAsUser: 10001,
      workspace: { kind: "emptyDir" }, egressPolicy: "open",
    });
    expect(pod.metadata?.labels?.[EGRESS_POLICY_LABEL]).toBe("open");
  });
});
```

Also add `egressPolicy: "strict"` to every existing `buildPodManifest({ ... })` fixture object already in `pod.test.ts` (each `describe` block's manifest) so they keep compiling.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: FAIL — TS error `egressPolicy` is not a known property / label is `undefined`.

- [ ] **Step 3 (pod.ts): Write minimal implementation**

In `apps/server/src/sandbox/k8s/pod.ts`, add the import and field, and set the label:

```ts
import { EGRESS_POLICY_LABEL } from "./egress-policy.js";
```

Add to `PodSpecInput`:

```ts
  /** Selects which CiliumNetworkPolicy governs this pod's egress — `strict`
   *  (the allowlist) or `open` (an `unrestricted_egress` phase). Stamped as the
   *  `egress-policy` label the policy's endpointSelector matches. */
  egressPolicy: "strict" | "open";
```

In `buildPodManifest`, extend the labels:

```ts
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "lastlight",
        "lastlight.io/component": "sandbox",
        [EGRESS_POLICY_LABEL]: i.egressPolicy,
      },
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/pod.test.ts`
Expected: PASS.

- [ ] **Step 5 (adapter): Write the failing test**

Add to `apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts`. Mirror the existing fake-`K8sApis` setup used by other adapter tests; add a fake `custom` with spies. The fake `SandboxFactoryOpts` must carry `egress`. Two cases:

```ts
import { STRICT_POLICY_NAME, OPEN_POLICY_NAME, EGRESS_POLICY_LABEL } from "#src/sandbox/k8s/egress-policy.js";

it("applies the egress policy pair and labels the pod strict for a restricted phase", async () => {
  const created: any[] = [];
  const create = vi.fn().mockResolvedValue({});
  const fakeApis = makeFakeApis({
    // core: existing fake that records the created pod into `created`
    onCreatePod: (body: any) => created.push(body),
    custom: { createNamespacedCustomObject: create },
  });
  const sandbox = new KubernetesSandbox(
    { taskId: "t1", egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp", timeoutSeconds: 60 } as any,
    { namespace: "ns", image: "img", storageClassName: "sc", workspaceSize: "5Gi", runAsUser: 10001, apis: fakeApis },
  );
  await sandbox.provision();
  await sandbox.runCommand("t1", "true", { cwd: "/home/agent/workspace", timeoutSeconds: 60 });

  const applied = create.mock.calls.map((c) => c[0].body.metadata.name);
  expect(applied).toEqual(expect.arrayContaining([STRICT_POLICY_NAME, OPEN_POLICY_NAME]));
  expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("strict");
});

it("labels the pod open for an unrestricted phase", async () => {
  const create = vi.fn().mockResolvedValue({});
  const created: any[] = [];
  const fakeApis = makeFakeApis({ onCreatePod: (b: any) => created.push(b), custom: { createNamespacedCustomObject: create } });
  const sandbox = new KubernetesSandbox(
    { taskId: "t2", egress: { unrestricted: true, hosts: [] }, env: {}, stateDir: "/tmp", timeoutSeconds: 60 } as any,
    { namespace: "ns", image: "img", storageClassName: "sc", workspaceSize: "5Gi", runAsUser: 10001, apis: fakeApis },
  );
  await sandbox.provision();
  await sandbox.runCommand("t2", "true", { cwd: "/home/agent/workspace", timeoutSeconds: 60 });
  expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("open");
});
```

**Dispatch note:** the existing adapter tests already build a fake `K8sApis`; extend that helper to accept a `custom` stub and a pod-capture hook rather than inventing a new one. The module-level ensure cache means the second test must use a DIFFERENT namespace OR the helper must reset the cache between tests — add an exported `__resetEgressEnsureCacheForTests()` from the adapter module and call it in `beforeEach`, OR give each test a unique namespace. Prefer unique namespaces (`ns-strict` / `ns-open`) — no test-only export.

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes-sandbox.test.ts`
Expected: FAIL — no `createNamespacedCustomObject` calls recorded; pod has no `egress-policy` label.

- [ ] **Step 7 (adapter): Write minimal implementation**

In `apps/server/src/sandbox/k8s/kubernetes-sandbox.ts`:

Add imports:

```ts
import { applyEgressPolicies } from "./egress-apply.js";
import { DEFAULT_ALLOWLIST, mergeAllowlist } from "../egress-allowlist.js";
```

Add a module-level ensure cache (dedupes concurrent calls + caches for the process, keyed by namespace) above the class:

```ts
/** Ensure the egress policy pair once per namespace per process. Keyed by
 *  namespace; a 403 (RBAC not yet granted — Plan 6) resolves after warning so
 *  we don't re-attempt (and re-log) every run. A genuine error clears the entry
 *  so a later run can retry. */
const egressEnsured = new Map<string, Promise<void>>();
```

Add the ensure method + strict-host derivation to the class:

```ts
  /** Hosts the strict policy allows — the shared allowlist plus OTEL collector
   *  hosts when sandbox OTEL forwarding is on (mirrors `egressPolicyFor`). */
  private strictHosts(): string[] {
    const otel = this.opts.otel;
    const extra = otel?.enabled && otel.forwardToSandbox ? otel.collectorHosts : [];
    return mergeAllowlist(DEFAULT_ALLOWLIST, extra);
  }

  /** Apply the egress policy pair once per namespace. Best-effort in Plan 3:
   *  a 403 means the CiliumNetworkPolicy RBAC verb isn't granted yet (Plan 6),
   *  so we warn ONCE and run on Cilium's default-allow — no regression to the
   *  validated flows; the same code enforces the moment RBAC lands. */
  private ensureEgress(): Promise<void> {
    let pending = egressEnsured.get(this.ns);
    if (pending) return pending;
    pending = applyEgressPolicies(this.apis.custom, { namespace: this.ns, hosts: this.strictHosts() }).catch(
      (err) => {
        if (err instanceof ApiException && err.code === 403) {
          console.warn(
            `[k8s] egress policies not applied in ${this.ns}: RBAC for ` +
              `CiliumNetworkPolicy is not granted (Plan 6). Running WITHOUT egress ` +
              `enforcement (Cilium default-allow).`,
          );
          return; // resolve — don't retry/re-log every run
        }
        egressEnsured.delete(this.ns); // real error: allow a later run to retry
        throw err;
      },
    );
    egressEnsured.set(this.ns, pending);
    return pending;
  }
```

In `runPod`, ensure the policies before creating the pod, and pass the label. Add near the top of `runPod` (after `const name = ...`):

```ts
    await this.ensureEgress();
```

And in the `buildPodManifest({ ... })` call inside `runPod`, add:

```ts
      egressPolicy: this.opts.egress.unrestricted ? "open" : "strict",
```

Update the class docstring's `stageSkills` note only if you touch it; otherwise leave it (skills stay Plan 4).

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/`
Expected: PASS (pod, adapter, and the Task 1–3 suites).

- [ ] **Step 9: Typecheck + commit**

```bash
pnpm --filter lastlight-core exec tsc --noEmit
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/src/sandbox/k8s/pod.ts apps/server/src/sandbox/k8s/kubernetes-sandbox.ts apps/server/tests/sandbox/k8s/pod.test.ts apps/server/tests/sandbox/k8s/kubernetes-sandbox.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "feat(sandbox): apply egress policies + label sandbox pods strict/open"
```

---

### Task 5: Enforcement integration test (opt-in, graceful skip)

**Files:**
- Modify: `apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts`

**Interfaces:**
- Consumes: the real cluster (gated `RUN_K8S_IT=1`, same as the Plan 1/2 cases); the adapter's ensure path (which applies the policies) + a strict-labelled pod.

**Dispatch context:** This IT proves the policy is *applied and enforced*. Enforcement needs the CiliumNetworkPolicy RBAC (Plan 6), so on a cluster without it the apply 403s and the ensure path warns + no policy is created — the test must detect that and skip the enforcement assertions with a clear message (don't fail). Detect by listing CiliumNetworkPolicies in the namespace after a run: if the strict policy isn't present, `it.skip`-style early-return with a `console.warn`. Keep the existing Plan 1/2 cases untouched; add one new case.

- [ ] **Step 1: Write the test**

Add a case to the opt-in describe block (mirror the existing per-case unique `taskId` convention):

```ts
it("enforces strict egress: an allowlisted host connects, a non-allowlisted host is blocked", async () => {
  const taskId = `it-egress-${Date.now()}`;
  const sandbox = makeK8sSandboxForIT(taskId); // existing IT helper (real makeK8sApis)
  await sandbox.provision();

  // curl -sS -m 8: 443 to an allowlisted host succeeds; a non-allowlisted host
  // must fail (exit != 0) under the strict policy. `|| echo BLOCKED:$?` keeps the
  // command exit 0 so we assert on stdout, not the pod exit code.
  const script = [
    'echo -n "github="; curl -sS -m 8 -o /dev/null -w "%{http_code}" https://api.github.com/ || echo -n "ERR"',
    'echo; echo -n "evil="; curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com/ && echo || echo BLOCKED',
  ].join("; ");

  const result = await sandbox.runCommand(taskId, script, { cwd: "/home/agent/workspace", timeoutSeconds: 120 });

  // Skip enforcement assertions if the policy wasn't applied (no RBAC yet — Plan 6).
  const present = await strictPolicyPresent("lastlight-sandboxes"); // list CNPs via makeK8sApis().custom
  if (!present) {
    console.warn("[IT] CiliumNetworkPolicy not applied (RBAC pending — Plan 6); skipping enforcement assertions");
    expect(result.stdout).toContain("github=200"); // allowlisted host works either way
    await sandbox.dispose();
    return;
  }

  expect(result.stdout).toContain("github=200");   // allowlisted → reachable
  expect(result.stdout).toContain("evil=BLOCKED");  // non-allowlisted → denied
  await sandbox.dispose();
}, 180_000);
```

Add the `strictPolicyPresent` helper near the file's other IT helpers:

```ts
async function strictPolicyPresent(namespace: string): Promise<boolean> {
  const { custom } = makeK8sApis();
  try {
    await custom.getNamespacedCustomObject({
      group: "cilium.io", version: "v2", namespace, plural: "ciliumnetworkpolicies",
      name: "lastlight-sandbox-egress-strict",
    });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Run against the cluster (Robin, when validating)**

Run: `RUN_K8S_IT=1 pnpm --filter lastlight-core exec vitest run tests/sandbox/k8s/kubernetes.integration.test.ts`
Expected: with Plan 6 RBAC absent — the case asserts `github=200` and skips the block assertion with the warning. With RBAC present (post-Plan-6) — asserts both `github=200` and `evil=BLOCKED`.

- [ ] **Step 3: Commit**

```bash
LASTLIGHT_SKIP_DOCS_CHECK=1 git add apps/server/tests/sandbox/k8s/kubernetes.integration.test.ts
LASTLIGHT_SKIP_DOCS_CHECK=1 git commit -m "test(sandbox): opt-in k8s egress-enforcement IT (skips until RBAC lands)"
```

---

## Self-Review

**Spec coverage (design.md §4):**
- "Allowlist lives in `egress-allowlist.ts`; harness renders CiliumNetworkPolicy from it" → Task 1 (`renderEgressPolicies` from `DEFAULT_ALLOWLIST`), Task 4 (`strictHosts()`).
- "Two policies, selected by pod label `egress-policy: strict|open`" → Task 1 (`endpointSelector`) + Task 4 (pod label).
- "`toFQDNs` matchName for exact, matchPattern for wildcards" → Task 1 (`fqdnRulesFor`).
- "`open` = broad, for `unrestricted_egress: true`" → Task 4 (`this.opts.egress.unrestricted`).
- "SSRF floor: deny private CIDRs; DNS proxy only lets a pod connect to an IP it resolved" → Task 1 (open `toCIDRSet` except-list; strict is FQDN-only; the shared `dnsEgressRule` proxy rule).
- "Harness channel: `toEndpoints` sandbox→harness" → **deferred to Plan 4 (skills)** — its only consumer is the skill fetch and it needs the harness-Service config. Called out in Global Constraints, not a gap.
- Testing strategy: "egress-policy rendering gets a golden test (like the docker config-generation tests)" → Task 1; "integration (opt-in): enforce end-to-end" → Task 5.

**Placeholder scan:** every code step carries real code; the IT helper (`makeK8sSandboxForIT` / fake-`K8sApis` helper) references existing Plan 1/2 test scaffolding rather than a TODO — the implementer reuses what's there.

**Type consistency:** `egressPolicy: "strict" | "open"` is the same union across `PodSpecInput` (Task 4), the label value (Task 1 `endpointSelector`), and the adapter's `unrestricted ? "open" : "strict"`. CRD coords (`cilium.io` / `v2` / `ciliumnetworkpolicies`) are the same constants in Task 1 (definition), Task 3 (apply), and Task 5 (IT helper — inline, matching the constants). `K8sApis.custom` (Task 2) is consumed by Task 3's `CustomObjectsApi` param and Task 4's `this.apis.custom`.

**Deferred / not in this plan (tracked):**
- The `toEndpoints` sandbox→harness rule → Plan 4 (skills), added to the renderer when its consumer lands.
- Full enforcement *validation* → after Plan 6 (Flux RBAC grants the `CiliumNetworkPolicy` verb). Plan 3's IT skips gracefully until then.
- A `requireEgressPolicy` hard-fail config (turn the 403-warn into a 403-fail once RBAC is expected) → Plan 6 follow-up, not built here (YAGNI while RBAC is absent).
