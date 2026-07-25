import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ApiException } from "@kubernetes/client-node";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";

interface FakeOpts {
  /** The `V1Pod.status` object `readNamespacedPodStatus` returns. */
  status?: Record<string, unknown>;
  /** Make `deleteNamespacedPod` reject. */
  deleteThrows?: boolean;
  /** Make `readNamespacedPersistentVolumeClaim` resolve (PVC already exists)
   *  instead of the default 404-reject (PVC missing, must be created). */
  pvcExists?: boolean;
}

function fakeApis(opts: FakeOpts = {}) {
  const status = opts.status ?? { phase: "Succeeded" };
  const created: any[] = [];
  const deleted: string[] = [];
  const secretsCreated: any[] = [];
  const secretsDeleted: string[] = [];
  const pvcsRead: any[] = [];
  const pvcsCreated: any[] = [];
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
        createNamespacedSecret: vi.fn(async ({ body }: any) => {
          secretsCreated.push(body);
          return body;
        }),
        deleteNamespacedSecret: vi.fn(async ({ name }: any) => {
          secretsDeleted.push(name);
          return {};
        }),
        readNamespacedPersistentVolumeClaim: vi.fn(async ({ name, namespace }: any) => {
          pvcsRead.push({ name, namespace });
          if (opts.pvcExists) return { metadata: { name, namespace } };
          throw new ApiException(404, "Not Found", {}, {});
        }),
        createNamespacedPersistentVolumeClaim: vi.fn(async ({ body }: any) => {
          pvcsCreated.push(body);
          return body;
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
    secretsCreated,
    secretsDeleted,
    pvcsRead,
    pvcsCreated,
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
    const { apis, created, deleted, secretsCreated, secretsDeleted, pvcsRead, pvcsCreated } =
      fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, {
      namespace: "lastlight-sandboxes",
      image: "img",
      apis,
    });
    await sbx.provision();
    // No pre-clone descriptor — ephemeral emptyDir workspace, no PVC touched.
    expect(pvcsRead).toHaveLength(0);
    expect(pvcsCreated).toHaveLength(0);
    const events: any[] = [];
    await sbx.runAgent(
      "t1",
      "hello",
      {
        model: "openai/x",
        sandboxEnv: { GITHUB_TOKEN: "ghs_abc" },
        agentCwd: "/home/agent/workspace",
      } as any,
      (e) => events.push(e),
    );
    expect(created).toHaveLength(1);
    expect(events).toContainEqual({ type: "agent_end" });

    // Per-run creds arrive via the pod's own Secret, never as inline env
    // (kubectl-visible) on the pod spec.
    expect(secretsCreated).toHaveLength(1);
    expect(secretsCreated[0].stringData).toMatchObject({ GITHUB_TOKEN: "ghs_abc" });
    const container = created[0].spec.containers[0];
    expect(container.env).toBeUndefined();
    expect(container.envFrom).toContainEqual({ secretRef: { name: secretsCreated[0].metadata.name } });

    await sbx.dispose();
    expect(deleted).toHaveLength(1);
    expect(secretsDeleted).toHaveLength(1);
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

  it("fails fast with the real reason when the container can't start (ImagePullBackOff)", async () => {
    const { apis } = fakeApis({
      status: {
        phase: "Pending",
        containerStatuses: [
          { state: { waiting: { reason: "ImagePullBackOff", message: 'back-off pulling image "nope"' } } },
        ],
      },
    });
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "nope", apis });
    await sbx.provision();
    await expect(
      sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
    ).rejects.toThrow(/ImagePullBackOff/);
  });

  it("dispose swallows a delete failure", async () => {
    const { apis } = fakeApis({ deleteThrows: true });
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    await expect(sbx.dispose()).resolves.toBeUndefined();
  });
});

describe("KubernetesSandbox PVC workspace (pre-clone)", () => {
  const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_abc" };

  it("ensures the PVC (created on 404) and returns the repo subdir as agentCwd", async () => {
    const { apis, pvcsRead, pvcsCreated } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    const result = await sbx.provision(pre as any);

    expect(pvcsRead).toHaveLength(1); // existence check first
    expect(pvcsCreated).toHaveLength(1); // 404 → create
    expect(pvcsCreated[0].spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(result.hostWorkspaceDir).toBe("/home/agent/workspace");
    expect(result.agentCwd).toBe("/home/agent/workspace/web");
  });

  it("reuses an existing PVC without re-creating it", async () => {
    const { apis, pvcsRead, pvcsCreated } = fakeApis({ pvcExists: true });
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    await sbx.provision(pre as any);

    expect(pvcsRead).toHaveLength(1);
    expect(pvcsCreated).toHaveLength(0);
  });

  it("stages a PVC-backed pod with a clone initContainer sharing the creds Secret", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, { namespace: "ns", image: "img", apis });
    const result = await sbx.provision(pre as any);
    await sbx.runCommand("t1", "true", { cwd: result.agentCwd, timeoutSeconds: 30 } as any);

    expect(created).toHaveLength(1);
    const pod = created[0];
    const vol = pod.spec.volumes.find((v: any) => v.name === "workspace");
    expect(vol.persistentVolumeClaim?.claimName).toMatch(/^ws-/);
    expect(pod.spec.initContainers).toHaveLength(1);
    expect(pod.spec.initContainers[0].name).toBe("clone");
    const credsSecretName = pod.spec.containers[0].envFrom[0].secretRef.name;
    expect(pod.spec.initContainers[0].envFrom).toContainEqual({
      secretRef: { name: credsSecretName },
    });
  });
});
