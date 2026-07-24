import { describe, it, expect } from "vitest";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

const RUN = process.env.RUN_K8S_IT === "1";

describe.runIf(RUN)("KubernetesSandbox (integration)", () => {
  it(
    "runs a bash command in a real pod and streams stdout",
    async () => {
      const sbx = new KubernetesSandbox(
        {
          taskId: `it-${Date.now()}`,
          egress: { unrestricted: false, hosts: [] },
          env: {},
          stateDir: "/tmp",
          timeoutSeconds: 120,
        } as any,
        {
          namespace: process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes",
          image: process.env.K8S_SANDBOX_IMAGE ?? "ghcr.io/nearform/lastlight-sandbox:latest",
        },
      );
      await sbx.provision();
      const res = await sbx.runCommand("it", "echo hello-from-pod", {
        cwd: "/home/agent/workspace",
        timeoutSeconds: 120,
      });
      expect(res.stdout).toContain("hello-from-pod");
      expect(res.exitCode).toBe(0);
      await sbx.dispose();
    },
    180_000,
  );
});
