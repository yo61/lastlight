import { describe, it, expect } from "vitest";
import { buildSecretManifest, podOwnerReference, secretNameFor } from "#src/sandbox/k8s/secret.js";
import { podNameFor } from "#src/sandbox/k8s/naming.js";

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

  it("stays within the 63-char RFC-1123 label budget for a max-length pod name", () => {
    expect(secretNameFor(podNameFor("x".repeat(80)), "prompt").length).toBeLessThanOrEqual(63);
  });
});
