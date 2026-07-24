import { describe, it, expect } from "vitest";
import { buildPodManifest } from "#src/sandbox/k8s/pod.js";

describe("buildPodManifest", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/nearform/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
    cwd: "/home/agent/workspace", activeDeadlineSeconds: 1800,
    runAsUser: 10001,
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
});

describe("buildPodManifest securityContext", () => {
  const pod = buildPodManifest({
    name: "ll-x", namespace: "lastlight-sandboxes",
    image: "ghcr.io/yo61/lastlight-sandbox:latest",
    command: ["sh", "-c", "echo hi"], envFromSecret: "ll-x-creds",
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
