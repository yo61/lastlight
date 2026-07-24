import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

interface FakeOpts {
  /** The `V1Pod.status` object `readNamespacedPodStatus` returns. */
  status?: Record<string, unknown>;
  /** Make `deleteNamespacedPod` reject. */
  deleteThrows?: boolean;
}

function fakeApis(opts: FakeOpts = {}) {
  const status = opts.status ?? { phase: "Succeeded" };
  const created: any[] = [];
  const deleted: string[] = [];
  return {
    apis: {
      core: {
        createNamespacedPod: vi.fn(async ({ body }: any) => {
          created.push(body);
          return body;
        }),
        readNamespacedPodStatus: vi.fn(async () => ({ status })),
        deleteNamespacedPod: vi.fn(async ({ name }: any) => {
          if (opts.deleteThrows) throw new Error("boom");
          deleted.push(name);
          return {};
        }),
      },
      log: {
        log: vi.fn(async (_n: string, _p: string, _c: string, s: PassThrough) => {
          s.write('{"type":"agent_end"}\n');
          s.end();
          return { abort() {} };
        }),
      },
      kc: {} as any,
    } as any,
    created,
    deleted,
  };
}

const factoryOpts = {
  taskId: "t1",
  egress: { unrestricted: false, hosts: [] },
  env: {},
  stateDir: "/tmp",
  timeoutSeconds: 60,
} as any;

describe("KubernetesSandbox", () => {
  it("runAgent creates a pod, streams parsed events, and deletes the pod", async () => {
    const { apis, created, deleted } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, {
      namespace: "lastlight-sandboxes",
      image: "img",
      apis,
    });
    await sbx.provision();
    const events: any[] = [];
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
      (e) => events.push(e),
    );
    expect(created).toHaveLength(1);
    expect(events).toContainEqual({ type: "agent_end" });
    await sbx.dispose();
    expect(deleted).toHaveLength(1);
  });

  it("runCommand returns the container's real exit code (0)", async () => {
    const { apis } = fakeApis({
      status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
    });
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    await sbx.provision();
    const res = await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it("runCommand returns the container's real exit code (2)", async () => {
    const { apis } = fakeApis({
      status: { phase: "Failed", containerStatuses: [{ state: { terminated: { exitCode: 2 } } }] },
    });
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    await sbx.provision();
    const res = await sbx.runCommand("t1", "exit 2", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(res.exitCode).toBe(2);
    expect(res.timedOut).toBe(false);
  });

  it("runCommand flags a deadline kill as timedOut", async () => {
    const { apis } = fakeApis({
      status: { phase: "Failed", reason: "DeadlineExceeded" },
    });
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    await sbx.provision();
    const res = await sbx.runCommand("t1", "sleep 999", { cwd: "/w", timeoutSeconds: 1 } as any);
    expect(res.timedOut).toBe(true);
  });

  it("dispose swallows a delete failure", async () => {
    const { apis } = fakeApis({ deleteThrows: true });
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    await expect(sbx.dispose()).resolves.toBeUndefined();
  });
});
