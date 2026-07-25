import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { ApiException } from "@kubernetes/client-node";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";
import {
  STRICT_POLICY_NAME,
  OPEN_POLICY_NAME,
  EGRESS_POLICY_LABEL,
} from "#src/sandbox/k8s/egress-policy.js";
import { SkillBundleRegistry } from "#src/sandbox/k8s/skill-bundle.js";

interface FakeOpts {
  /** The `V1Pod.status` object `readNamespacedPodStatus` returns. */
  status?: Record<string, unknown>;
  /** Make `deleteNamespacedPod` reject. */
  deleteThrows?: boolean;
  /** Make `readNamespacedPersistentVolumeClaim` resolve (PVC already exists)
   *  instead of the default 404-reject (PVC missing, must be created). */
  pvcExists?: boolean;
  /** Make `createNamespacedPod` reject (pod-create failure path). */
  createPodThrows?: boolean;
  /** Override `custom.createNamespacedCustomObject` — defaults to a spy that
   *  resolves, so the egress-ensure call is a silent no-op in tests that
   *  don't care about it. */
  createNamespacedCustomObject?: ReturnType<typeof vi.fn>;
}

function fakeApis(opts: FakeOpts = {}) {
  const status = opts.status ?? { phase: "Succeeded" };
  const created: any[] = [];
  const deleted: string[] = [];
  const secretsCreated: any[] = [];
  const secretsDeleted: string[] = [];
  const secretsPatched: any[] = [];
  const pvcsRead: any[] = [];
  const pvcsCreated: any[] = [];
  const customCreated =
    opts.createNamespacedCustomObject ?? vi.fn(async () => ({}));
  return {
    apis: {
      core: {
        createNamespacedPod: vi.fn(async ({ body }: any) => {
          if (opts.createPodThrows) throw new Error("pod create failed");
          created.push(body);
          // Real createNamespacedPod echoes back the created object, with a
          // server-assigned uid — the ownerRef patch reads it off this return.
          return { ...body, metadata: { ...body.metadata, uid: "pod-uid-1" } };
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
        patchNamespacedSecret: vi.fn(async ({ name, body }: any) => {
          secretsPatched.push({ name, body });
          return {};
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
      custom: {
        createNamespacedCustomObject: customCreated,
      },
      kc: {} as any,
    } as any,
    created,
    deleted,
    secretsCreated,
    secretsDeleted,
    secretsPatched,
    pvcsRead,
    pvcsCreated,
    customCreated,
  };
}

const factoryOpts = {
  taskId: "t1",
  egress: { unrestricted: false, hosts: [] },
  env: {},
  stateDir: "/tmp",
  timeoutSeconds: 60,
} as any;

/** Full `K8sAdapterConfig` — `storageClassName`/`workspaceSize`/`runAsUser`
 *  are required as of Task 6, as are the three `harness*` fields. */
function cfg(apis: any, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    namespace: "ns",
    image: "img",
    storageClassName: "truenas-iscsi",
    workspaceSize: "5Gi",
    runAsUser: 10001,
    harnessEndpoint: "http://lastlight.lastlight.svc.cluster.local:8644",
    harnessNamespace: "lastlight",
    harnessPodLabels: { "app.kubernetes.io/name": "lastlight" },
    apis,
    ...overrides,
  };
}

describe("KubernetesSandbox", () => {
  it("runAgent creates a pod, streams parsed events, and deletes the pod", async () => {
    const { apis, created, deleted, secretsCreated, secretsDeleted, pvcsRead, pvcsCreated } =
      fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
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
    const credsSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(credsSecret.stringData).toMatchObject({ GITHUB_TOKEN: "ghs_abc" });
    const container = created[0].spec.containers[0];
    expect(container.env).toBeUndefined();
    expect(container.envFrom).toContainEqual({ secretRef: { name: credsSecret.metadata.name } });

    await sbx.dispose();
    expect(deleted).toHaveLength(1);
    expect(secretsDeleted.length).toBeGreaterThanOrEqual(1);
  });

  it("runCommand returns the container's real exit code (0)", async () => {
    const { apis } = fakeApis({
      status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    const res = await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it("runCommand returns the container's real exit code (2)", async () => {
    const { apis } = fakeApis({
      status: { phase: "Failed", containerStatuses: [{ state: { terminated: { exitCode: 2 } } }] },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    const res = await sbx.runCommand("t1", "exit 2", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(res.exitCode).toBe(2);
    expect(res.timedOut).toBe(false);
  });

  it("runCommand flags a deadline kill as timedOut", async () => {
    const { apis } = fakeApis({
      status: { phase: "Failed", reason: "DeadlineExceeded" },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
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
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { image: "nope" }));
    await sbx.provision();
    await expect(
      sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
    ).rejects.toThrow(/ImagePullBackOff/);
  });

  it("fails fast with the init container's reason when clone fails (git auth error)", async () => {
    const { apis } = fakeApis({
      status: {
        phase: "Pending",
        containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
        initContainerStatuses: [
          {
            name: "clone",
            state: {
              terminated: {
                exitCode: 128,
                reason: "Error",
                message: "fatal: could not read Username",
              },
            },
          },
        ],
      },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await expect(
      sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
    ).rejects.toThrow(/init container "clone" failed \(exit 128\): Error/);
    // Fails on the FIRST poll, not after the full ~60s start budget.
    expect(apis.core.readNamespacedPodStatus).toHaveBeenCalledTimes(1);
  });

  it("appends the init container's logs so the real git error is visible", async () => {
    const { apis } = fakeApis({
      status: {
        phase: "Pending",
        containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
        initContainerStatuses: [
          { name: "clone", state: { terminated: { exitCode: 128, reason: "Error" } } },
        ],
      },
    });
    apis.core.readNamespacedPodLog = vi.fn(
      async () =>
        "Cloning into '/home/agent/workspace/Hello-World'...\n" +
        "fatal: could not create work tree dir: Permission denied",
    ) as any;
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await expect(
      sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
    ).rejects.toThrow(/Permission denied/);
    expect(apis.core.readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ container: "clone" }),
    );
  });

  it("dispose swallows a delete failure", async () => {
    const { apis } = fakeApis({ deleteThrows: true });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    await expect(sbx.dispose()).resolves.toBeUndefined();
  });
});

describe("KubernetesSandbox egress policy", () => {
  // Each test uses its OWN namespace: the adapter's ensure-once cache is keyed
  // by namespace and persists for the whole test-file run, so a shared "ns"
  // would let an earlier test's cached ensure shadow this one's assertions.
  it(
    "applies the egress policy pair and labels the pod strict for a restricted phase",
    async () => {
      const { apis, created, customCreated } = fakeApis();
      const sbx = new KubernetesSandbox(
        { taskId: "t1", egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp",
          timeoutSeconds: 60 } as any,
        cfg(apis, { namespace: "ns-strict" }),
      );
      await sbx.provision();
      await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);

      const applied = customCreated.mock.calls.map((c: any) => c[0].body.metadata.name);
      expect(applied).toEqual(expect.arrayContaining([STRICT_POLICY_NAME, OPEN_POLICY_NAME]));
      expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("strict");
    },
  );

  it("labels the pod open for an unrestricted phase", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(
      { taskId: "t2", egress: { unrestricted: true, hosts: [] }, env: {}, stateDir: "/tmp",
        timeoutSeconds: 60 } as any,
      cfg(apis, { namespace: "ns-open" }),
    );
    await sbx.provision();
    await sbx.runCommand("t2", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("open");
  });

  it(
    "a 403 (RBAC not yet granted) warns once and still runs the pod on default-allow",
    async () => {
      const create = vi.fn(async () => {
        throw new ApiException(403, "Forbidden", {}, {});
      });
      const { apis, created } = fakeApis({ createNamespacedCustomObject: create });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "ns-403" }));
        await sbx.provision();
        await expect(
          sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
        ).resolves.toMatchObject({ exitCode: 0 });
        expect(created).toHaveLength(1);
        expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("strict");
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it(
    "warns only once across two runs in the same namespace (ensure-once cache)",
    async () => {
      const create = vi.fn(async () => {
        throw new ApiException(403, "Forbidden", {}, {});
      });
      const { apis } = fakeApis({ createNamespacedCustomObject: create });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "ns-warn-once" }));
        await sbx.provision();
        await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
        await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it(
    "a non-403 error fails the run and clears the cache so a later run retries the apply",
    async () => {
      const create = vi
        .fn()
        .mockRejectedValueOnce(new ApiException(500, "Server Error", {}, {}))
        .mockResolvedValue({});
      const { apis } = fakeApis({ createNamespacedCustomObject: create });
      const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "ns-500" }));
      await sbx.provision();

      await expect(
        sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
      ).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);

      await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
      expect(create.mock.calls.length).toBeGreaterThan(1);
    },
  );
});

describe("KubernetesSandbox PVC workspace (pre-clone)", () => {
  const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_abc" };

  it("ensures the PVC (created on 404) and returns the repo subdir as agentCwd", async () => {
    const { apis, pvcsRead, pvcsCreated } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    const result = await sbx.provision(pre as any);

    expect(pvcsRead).toHaveLength(1); // existence check first
    expect(pvcsCreated).toHaveLength(1); // 404 → create
    expect(pvcsCreated[0].spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(result.hostWorkspaceDir).toBe("/home/agent/workspace");
    expect(result.agentCwd).toBe("/home/agent/workspace/web");
  });

  it("reuses an existing PVC without re-creating it", async () => {
    const { apis, pvcsRead, pvcsCreated } = fakeApis({ pvcExists: true });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision(pre as any);

    expect(pvcsRead).toHaveLength(1);
    expect(pvcsCreated).toHaveLength(0);
  });

  it("stages a PVC-backed pod with a clone initContainer sharing the creds Secret", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
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

describe("KubernetesSandbox (creds + workspace + prompt)", () => {
  const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" };

  it(
    "runAgent: ensures a PVC, writes creds+prompt Secrets, delivers the prompt, " +
      "patches ownerRefs, streams, reaps",
    async () => {
      const { apis, created, deleted, secretsCreated, secretsPatched, pvcsCreated } = fakeApis();
      const sbx = new KubernetesSandbox(
        {
          taskId: "acme-web-pr12",
          egress: { unrestricted: false, hosts: [] },
          env: { ANTHROPIC_API_KEY: "sk-1", GITHUB_TOKEN: "ghs_x" },
          stateDir: "/tmp",
          timeoutSeconds: 120,
        } as any,
        cfg(apis),
      );
      await sbx.provision(pre as any);
      expect(pvcsCreated).toHaveLength(1);

      const events: any[] = [];
      await sbx.runAgent(
        "acme-web-pr12",
        "REVIEW THIS PR",
        {
          model: "anthropic/claude-sonnet-4-6",
          sandboxEnv: {},
          agentCwd: "/home/agent/workspace/web",
        } as any,
        (e) => events.push(e),
      );

      // creds + prompt Secrets created before the pod; prompt carries the text.
      const promptSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt"));
      expect(promptSecret.stringData.prompt).toBe("REVIEW THIS PR");
      const credsSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
      expect(credsSecret.stringData.ANTHROPIC_API_KEY).toBe("sk-1");

      // pod created with envFrom the creds Secret + prompt piped to stdin, model
      // passed as a positional arg (not interpolated into the script text).
      const pod = created[0];
      expect(pod.spec.containers[0].envFrom).toContainEqual({
        secretRef: { name: credsSecret.metadata.name },
      });
      const command: string[] = pod.spec.containers[0].command;
      expect(command.join(" ")).toContain("< /lastlight/prompt");
      // Model is its own trailing argv element, bound to `$1` at exec time —
      // NOT interpolated into the script string (command[2]).
      expect(command.at(-1)).toBe("anthropic/claude-sonnet-4-6");
      expect(command[2]).not.toContain("claude-sonnet-4-6");

      // ownerRefs patched (both secrets), each as a JSON-Patch "add" op.
      expect(secretsPatched).toHaveLength(2);
      const patchedNames = secretsPatched.map((p: any) => p.name);
      expect(patchedNames).toEqual(
        expect.arrayContaining([credsSecret.metadata.name, promptSecret.metadata.name]),
      );
      for (const { body } of secretsPatched) {
        expect(body).toEqual([
          {
            op: "add",
            path: "/metadata/ownerReferences",
            value: [
              expect.objectContaining({ kind: "Pod", name: pod.metadata.name, uid: "pod-uid-1" }),
            ],
          },
        ]);
      }

      expect(events).toContainEqual({ type: "agent_end" });

      await sbx.dispose();
      expect(deleted).toContain(pod.metadata.name);
    },
  );

  it("runCommand: no prompt Secret, no `< /lastlight/prompt`, creds via envFrom", async () => {
    const { apis, created, secretsCreated } = fakeApis();
    const sbx = new KubernetesSandbox(
      {
        taskId: "acme-web-pr12",
        egress: { unrestricted: false, hosts: [] },
        env: { GITHUB_TOKEN: "ghs_x" },
        stateDir: "/tmp",
        timeoutSeconds: 60,
      } as any,
      cfg(apis),
    );
    await sbx.provision(pre as any);
    const res = await sbx.runCommand("acme-web-pr12", "echo hi", {
      cwd: "/home/agent/workspace/web",
      timeoutSeconds: 60,
    });
    expect(res.exitCode).toBe(0);
    expect(secretsCreated.some((s: any) => s.metadata.name.endsWith("-prompt"))).toBe(false);
    expect(created[0].spec.containers[0].command.join(" ")).not.toContain("/lastlight/prompt");
  });

  it("ephemeral provision (no pre-clone) uses emptyDir, no PVC", async () => {
    const { apis, created, pvcsCreated } = fakeApis();
    const sbx = new KubernetesSandbox(
      {
        taskId: "cron-health-1",
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 60,
      } as any,
      cfg(apis),
    );
    await sbx.provision(); // no PrePopulateSpec
    await sbx.runCommand("cron-health-1", "echo hi", {
      cwd: "/home/agent/workspace",
      timeoutSeconds: 60,
    });
    expect(pvcsCreated).toHaveLength(0);
    expect(created[0].spec.volumes.find((v: any) => v.name === "workspace").emptyDir).toBeDefined();
  });

  it("pod-create failure best-effort deletes the creds+prompt Secrets, then rethrows", async () => {
    const { apis, secretsCreated, secretsDeleted } = fakeApis({ createPodThrows: true });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await expect(
      sbx.runAgent(
        "t1",
        "hello",
        { model: "anthropic/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
        () => {},
      ),
    ).rejects.toThrow(/pod create failed/);

    const credsName = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds")).metadata
      .name;
    const promptName = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt")).metadata
      .name;
    expect(secretsDeleted).toEqual(expect.arrayContaining([credsName, promptName]));
  });
});

describe("KubernetesSandbox skills staging", () => {
  it("stages a bundle, wires init + token + --skill, evicts on dispose", async () => {
    const src = mkdtempSync(join(tmpdir(), "skills-src-"));
    const skillSrc = join(src, "pr-review");
    mkdirSync(skillSrc, { recursive: true });
    writeFileSync(join(skillSrc, "SKILL.md"), "# pr-review");

    try {
      const { apis, created, secretsCreated } = fakeApis();
      const skillRegistry = new SkillBundleRegistry();
      const sbx = new KubernetesSandbox(
        {
          taskId: "t-skills",
          egress: { unrestricted: false, hosts: [] },
          env: {},
          stateDir: "/tmp",
          timeoutSeconds: 60,
        } as any,
        cfg(apis, { namespace: "ns-skills", skillRegistry }),
      );
      await sbx.provision();
      const dirs = sbx.stageSkills("pr-review", [skillSrc]);
      expect(dirs).toEqual(["/lastlight-skills/pr-review"]);

      await sbx.runAgent(
        "t-skills",
        "hello",
        {
          model: "anthropic/x",
          sandboxEnv: {},
          agentCwd: "/home/agent/workspace",
          skillDirs: dirs,
        } as any,
        () => {},
      );

      const pod = created[0];
      expect(pod.spec.initContainers.some((c: any) => c.name === "skills")).toBe(true);
      expect(pod.spec.volumes.some((v: any) => v.name === "skills")).toBe(true);
      const cmd = pod.spec.containers[0].command.join(" ");
      expect(cmd).toContain("--skill /lastlight-skills/pr-review");
      const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
      const token = creds.stringData.LASTLIGHT_SKILL_TOKEN;
      expect(token).toBeTruthy();
      expect(skillRegistry.get(token)).toBeDefined();

      await sbx.dispose();
      expect(skillRegistry.get(token)).toBeUndefined();
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("runCommand stages no skills: no init, no token, no --skill", async () => {
    const { apis, created, secretsCreated } = fakeApis();
    const skillRegistry = new SkillBundleRegistry();
    const overrides = { namespace: "ns-no-skills", skillRegistry };
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, overrides));
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);

    const pod = created[0];
    expect(pod.spec.initContainers ?? []).toHaveLength(0);
    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(creds.stringData.LASTLIGHT_SKILL_TOKEN).toBeUndefined();
    expect(pod.spec.containers[0].command.join(" ")).not.toContain("--skill");
  });
});
