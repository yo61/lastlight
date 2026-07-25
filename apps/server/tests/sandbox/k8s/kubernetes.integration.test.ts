import { describe, it, expect } from "vitest";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

const RUN = process.env.RUN_K8S_IT === "1";
const IMAGE = process.env.K8S_SANDBOX_IMAGE ??
  "ghcr.io/yo61/lastlight-sandbox:latest";
const HAS_AI = !!process.env.ANTHROPIC_API_KEY;

describe.runIf(RUN)("KubernetesSandbox Plan 1 (integration)", () => {
  it(
    "runs a bash command in a real pod and streams stdout",
    async () => {
      // Unique per run so a prior run's pod (deterministic name) can't
      // collide, and always dispose so a failed assertion never orphans
      // a pod.
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
          namespace: process.env.LASTLIGHT_K8S_NAMESPACE ??
            "lastlight-sandboxes",
          image: IMAGE,
          storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
            "truenas-iscsi",
          workspaceSize: "2Gi",
          runAsUser: parseInt(
            process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
            10,
          ),
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

describe.runIf(RUN)("KubernetesSandbox Plan 2 (integration)", () => {
  const mkSbx = (taskId: string, env: Record<string, string>) =>
    new KubernetesSandbox(
      {
        taskId,
        egress: { unrestricted: false, hosts: [] },
        env,
        stateDir: "/tmp",
        timeoutSeconds: 300,
      } as any,
      {
        namespace: process.env.LASTLIGHT_K8S_NAMESPACE ??
          "lastlight-sandboxes",
        image: IMAGE,
        storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
          "truenas-iscsi",
        workspaceSize: "2Gi",
        runAsUser: parseInt(
          process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
          10,
        ),
      },
    );

  it(
    "clones a public repo into the PVC and runs a command against it",
    async () => {
      const sbx = mkSbx(`it-clone-${Date.now()}`, {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
      });
      try {
        await sbx.provision({
          owner: "octocat",
          repo: "Hello-World",
          branch: "master",
          token: process.env.GITHUB_TOKEN ?? "",
        } as any);
        const res = await sbx.runCommand(
          "it",
          "cat README && git -C . rev-parse --abbrev-ref HEAD",
          {
            cwd: "/home/agent/workspace/Hello-World",
            timeoutSeconds: 300,
          },
        );
        expect(res.exitCode).toBe(0);
        expect(res.stdout.toLowerCase()).toContain("hello");
      } finally {
        await sbx.dispose();
      }
    },
    300_000,
  );

  it.runIf(HAS_AI)(
    "runs an AI phase whose prompt arrives via the mounted Secret",
    async () => {
      const sbx = mkSbx(`it-ai-${Date.now()}`, {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
      });
      const events: any[] = [];
      try {
        await sbx.provision({
          owner: "octocat",
          repo: "Hello-World",
          branch: "master",
          token: process.env.GITHUB_TOKEN ?? "",
        } as any);
        await sbx.runAgent(
          "it",
          "Reply with exactly the word PONG and nothing else.",
          {
            model: "anthropic/claude-haiku-4-5-20251001",
            sandboxEnv: {},
            agentCwd: "/home/agent/workspace/Hello-World",
          } as any,
          (e) => events.push(e),
        );
        expect(events.some((e) => e.type === "agent_end")).toBe(true);
      } finally {
        await sbx.dispose();
      }
    },
    300_000,
  );
});
