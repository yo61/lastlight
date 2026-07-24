import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

function fakeApis() {
  const created: any[] = [];
  const deleted: string[] = [];
  return {
    apis: {
      core: {
        createNamespacedPod: vi.fn(async ({ body }: any) => {
          created.push(body);
          return body;
        }),
        readNamespacedPodStatus: vi.fn(async () => ({ status: { phase: "Succeeded" } })),
        deleteNamespacedPod: vi.fn(async ({ name }: any) => {
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

describe("KubernetesSandbox", () => {
  it("runAgent creates a pod, streams parsed events, and deletes the pod", async () => {
    const { apis, created, deleted } = fakeApis();
    const sbx = new KubernetesSandbox(
      { taskId: "t1", egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp", timeoutSeconds: 60 } as any,
      { namespace: "lastlight-sandboxes", image: "img", apis: apis },
    );
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
});
