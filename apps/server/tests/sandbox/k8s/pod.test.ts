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
