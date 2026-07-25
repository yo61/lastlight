/** Pod/selector label choosing which egress policy applies. */
export const EGRESS_POLICY_LABEL = "egress-policy";

/** Name of the CiliumNetworkPolicy applied to strict-egress sandbox pods. */
export const STRICT_POLICY_NAME = "lastlight-sandbox-egress-strict";
/** Name of the CiliumNetworkPolicy applied to open-egress sandbox pods. */
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
const PRIVATE_CIDRS_V4 = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "127.0.0.0/8",
];
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
    toPorts: [
      { ports: [{ port: "53", protocol: "ANY" }], rules: { dns: [{ matchPattern: "*" }] } },
    ],
  };
}

/** Minimal shape of a Cilium `CiliumNetworkPolicy` custom resource. */
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
export function fqdnRulesFor(
  hosts: readonly string[],
): Array<{ matchName: string } | { matchPattern: string }> {
  const rules: Array<{ matchName: string } | { matchPattern: string }> = [];
  for (const host of hosts) {
    rules.push({ matchName: host });
    rules.push({ matchPattern: `*.${host}` });
  }
  return rules;
}

function policy(
  name: string,
  namespace: string,
  value: "strict" | "open",
  egress: unknown[],
): CiliumNetworkPolicy {
  return {
    apiVersion: `${CILIUM_GROUP}/${CILIUM_VERSION}`,
    kind: "CiliumNetworkPolicy",
    metadata: { name, namespace },
    spec: { endpointSelector: { matchLabels: { [EGRESS_POLICY_LABEL]: value } }, egress },
  };
}

/** Strict = DNS + the allowlist FQDNs on 443/TCP; everything else default-denied. */
export function renderStrictEgressPolicy(
  opts: { namespace: string; hosts: readonly string[] },
): CiliumNetworkPolicy {
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

/** Render the strict/open CiliumNetworkPolicy pair for one sandbox namespace. */
export function renderEgressPolicies(opts: {
  namespace: string;
  hosts: readonly string[];
}): { strict: CiliumNetworkPolicy; open: CiliumNetworkPolicy } {
  return {
    strict: renderStrictEgressPolicy(opts),
    open: renderOpenEgressPolicy({ namespace: opts.namespace }),
  };
}
