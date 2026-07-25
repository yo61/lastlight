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
  const pol = renderStrictEgressPolicy({
    namespace: "lastlight-sandboxes",
    hosts: ["github.com", "openai.com"],
  });

  it("is a namespaced CiliumNetworkPolicy selecting the strict label", () => {
    expect(pol.apiVersion).toBe(`${CILIUM_GROUP}/${CILIUM_VERSION}`);
    expect(pol.kind).toBe("CiliumNetworkPolicy");
    expect(pol.metadata.name).toBe(STRICT_POLICY_NAME);
    expect(pol.metadata.namespace).toBe("lastlight-sandboxes");
    expect(pol.spec.endpointSelector.matchLabels).toEqual({ [EGRESS_POLICY_LABEL]: "strict" });
  });

  it("exposes the CRD coordinates the CustomObjectsApi caller needs", () => {
    expect(CILIUM_CNP_PLURAL).toBe("ciliumnetworkpolicies");
  });

  it("allows DNS to kube-dns with a wildcard dns-proxy rule (so toFQDNs can resolve)", () => {
    const dns = pol.spec.egress.find(
      (r: any) =>
        r.toEndpoints?.[0]?.matchLabels?.["k8s:io.kubernetes.pod.namespace"] === "kube-system",
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
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
      ]),
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
