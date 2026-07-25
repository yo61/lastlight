import { describe, it, expect } from "vitest";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";
import { makeK8sApis } from "#src/sandbox/k8s/client.js";
import {
  CILIUM_CNP_PLURAL,
  CILIUM_GROUP,
  CILIUM_VERSION,
  STRICT_POLICY_NAME,
} from "#src/sandbox/k8s/egress-policy.js";

const RUN = process.env.RUN_K8S_IT === "1";
const IMAGE = process.env.K8S_SANDBOX_IMAGE ??
  "ghcr.io/yo61/lastlight-sandbox:latest";
const HAS_AI = !!process.env.ANTHROPIC_API_KEY;

/** True once the strict CiliumNetworkPolicy has actually been applied in
 *  `namespace` — false when the apply 403'd (RBAC not yet granted, Plan 6)
 *  and the adapter's ensure path fell back to a warning. */
async function strictPolicyPresent(namespace: string): Promise<boolean> {
  const { custom } = makeK8sApis();
  try {
    await custom.getNamespacedCustomObject({
      group: CILIUM_GROUP,
      version: CILIUM_VERSION,
      namespace,
      plural: CILIUM_CNP_PLURAL,
      name: STRICT_POLICY_NAME,
    });
    return true;
  } catch {
    return false;
  }
}

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
      // The pod name derives from the runCommand/runAgent taskId arg, so it
      // must be unique per case — else back-to-back cases collide on a pod name
      // whose prior instance is still terminating (409 AlreadyExists).
      const taskId = `it-clone-${Date.now()}`;
      const sbx = mkSbx(taskId, {
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
          taskId,
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
      const taskId = `it-ai-${Date.now()}`;
      const sbx = mkSbx(taskId, {
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
          taskId,
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

describe.runIf(RUN)("KubernetesSandbox Plan 3 egress (integration)", () => {
  const NAMESPACE = process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes";

  const mkSbx = (taskId: string) =>
    new KubernetesSandbox(
      {
        taskId,
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 120,
      } as any,
      {
        namespace: NAMESPACE,
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
    "enforces strict egress: an allowlisted host connects, a non-allowlisted host is blocked",
    async () => {
      // Unique per run, same collision reasoning as the Plan 2 cases.
      const taskId = `it-egress-${Date.now()}`;
      const sbx = mkSbx(taskId);
      try {
        await sbx.provision();

        // curl -sS -m 8: 443 to an allowlisted host succeeds; a non-allowlisted
        // host must fail under the strict policy. Each `||`/`&&` branch keeps
        // the overall command exit 0 so we assert on stdout, not the pod's
        // exit code (a non-zero exit would throw before we get to inspect it).
        // The EVIL curl omits `-w "%{http_code}"`: on a blocked connection curl
        // prints "000" for that format before the shell hits `||`, which would
        // land between "evil=" and "BLOCKED" and break the toContain match. The
        // GITHUB curl keeps `-w` since its failure branch is an unexpected-error
        // case that should fail the test, not something this test massages.
        const script = [
          'echo -n "github="; curl -sS -m 8 -o /dev/null -w "%{http_code}" ' +
            'https://api.github.com/ || echo -n "ERR"',
          'echo; echo -n "evil="; curl -sS -m 8 -o /dev/null ' +
            'https://example.com/ && echo -n "OK" || echo -n "BLOCKED"',
        ].join("; ");
        const result = await sbx.runCommand(taskId, script, {
          cwd: "/home/agent/workspace",
          timeoutSeconds: 60,
        });

        // Skip enforcement assertions if the policy wasn't applied — no
        // CiliumNetworkPolicy RBAC yet (Plan 6), so the adapter's ensure path
        // 403'd and warned instead of failing the run.
        const present = await strictPolicyPresent(NAMESPACE);
        if (!present) {
          console.warn(
            "[IT] CiliumNetworkPolicy not applied (RBAC pending — Plan 6); " +
              "skipping enforcement assertions",
          );
          expect(result.stdout).toContain("github=200"); // works either way
          return;
        }

        expect(result.stdout).toContain("github=200"); // allowlisted → reachable
        expect(result.stdout).toContain("evil=BLOCKED"); // non-allowlisted → denied
      } finally {
        await sbx.dispose();
      }
    },
    180_000,
  );
});
