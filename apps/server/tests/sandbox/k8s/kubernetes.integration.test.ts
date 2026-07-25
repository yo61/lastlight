import { describe, it, expect } from "vitest";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

const RUN = process.env.RUN_K8S_IT === "1";

describe.runIf(RUN)("KubernetesSandbox (integration)", () => {
  it(
    "runs a bash command in a real pod and streams stdout",
    async () => {
      // Unique per run so a prior run's pod (deterministic name) can't collide,
      // and always dispose so a failed assertion never orphans a pod.
      const taskId = `k8s-it-${Date.now()}`;
      const sbx = new KubernetesSandbox(
        {
          taskId,
          egress: { unrestricted: false, hosts: [] },
          env: {},
          stateDir: "/tmp",
          timeoutSeconds: 120,
        } as any,
        {
          namespace: process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes",
          image: process.env.K8S_SANDBOX_IMAGE ?? "ghcr.io/nearform/lastlight-sandbox:latest",
          storageClassName: process.env.K8S_SANDBOX_STORAGE_CLASS ?? "truenas-iscsi",
          workspaceSize: process.env.K8S_SANDBOX_WORKSPACE_SIZE ?? "5Gi",
          runAsUser: Number(process.env.K8S_SANDBOX_RUN_AS_USER ?? 10001),
        },
      );
      await sbx.provision();
      try {
        const res = await sbx.runCommand(taskId, "echo hello-from-pod", {
          cwd: "/home/agent/workspace",
          timeoutSeconds: 120,
        });
        expect(res.stdout).toContain("hello-from-pod");
        expect(res.exitCode).toBe(0);
      } finally {
        await sbx.dispose();
      }
    },
    180_000,
  );
});
