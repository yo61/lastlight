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
