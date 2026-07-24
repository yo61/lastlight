import { describe, it, expect } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import { makeK8sApis } from "#src/sandbox/k8s/client.js";

describe("makeK8sApis", () => {
  it("builds core + log clients from an injected KubeConfig", () => {
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: "c", server: "http://127.0.0.1:1" }],
      users: [{ name: "u" }],
      contexts: [{ name: "x", cluster: "c", user: "u" }],
      currentContext: "x",
    });
    const apis = makeK8sApis(kc);
    expect(apis.core).toBeDefined();
    expect(apis.log).toBeDefined();
  });
});
