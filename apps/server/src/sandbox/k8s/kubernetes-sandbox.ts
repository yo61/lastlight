import type { RunResult } from "agentic-pi";
import type {
  Sandbox,
  SandboxFactoryOpts,
  PrePopulateSpec,
  ProvisionResult,
  RunAgentOpts,
  RunCommandOpts,
  RawCommandResult,
  SandboxEvent,
} from "../sandbox.js";
import { parseLine } from "../sandbox.js";
import type { SandboxBackend } from "../../config/config.js";
import { makeK8sApis, type K8sApis } from "./client.js";
import { buildPodManifest } from "./pod.js";
import { podNameFor } from "./naming.js";
import { streamPodLog } from "./log-stream.js";

const WORKSPACE_DIR = "/home/agent/workspace";

/** Bound on the post-stream status poll: ~15 × 500ms ≈ 8s before the coarse
 *  phase-based fallback, so a lagging kubelet status never hangs a command. */
const POD_STATUS_POLL_ATTEMPTS = 15;
const POD_STATUS_POLL_INTERVAL_MS = 500;

/** Skeleton config the adapter needs; grows in later plans (namespace/image
 *  stay fixed here — the PVC, skill staging, and stdin/attach wiring land in
 *  Plans 2-3). */
export interface K8sAdapterConfig {
  namespace: string;
  image: string;
  /** Injectable fake `K8sApis` for tests; defaults to the real client. */
  apis?: K8sApis;
}

/**
 * The `kubernetes` {@link Sandbox} adapter — one pod per `runAgent`/
 * `runCommand` call. Plan 1 walking skeleton: `provision` hands back a fixed
 * in-pod `emptyDir` workspace path (no PVC yet, so nothing persists between
 * phases), `stageSkills`/`sandboxPathFor` are stubs, and `runAgent` does not
 * yet deliver the prompt to the container (see the comment on `runAgent`
 * below) — Plan 2 adds the PVC and the stdin/attach wiring, Plan 3 adds
 * skill staging.
 */
export class KubernetesSandbox implements Sandbox {
  readonly backend: SandboxBackend = "kubernetes";
  private readonly apis: K8sApis;
  private readonly ns: string;
  private readonly image: string;
  private activePod?: string;

  constructor(
    private readonly opts: SandboxFactoryOpts,
    cfg: K8sAdapterConfig,
  ) {
    this.apis = cfg.apis ?? makeK8sApis();
    this.ns = cfg.namespace;
    this.image = opts.imageName ?? cfg.image;
  }

  async provision(_pre?: PrePopulateSpec): Promise<ProvisionResult> {
    // Plan 1: emptyDir workspace inside the pod; nothing to pre-clone yet.
    return { hostWorkspaceDir: WORKSPACE_DIR, agentCwd: WORKSPACE_DIR };
  }

  stageSkills(_phaseKey: string, _skillPaths: string[] | undefined): string[] | undefined {
    return undefined; // Plan 3
  }

  sandboxPathFor(relPath: string): string {
    return `${WORKSPACE_DIR}/${relPath}`;
  }

  async runAgent(
    taskId: string,
    _prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    // Plan 1 decision A: prompt delivery is intentionally NOT wired here.
    // Delivering `_prompt` needs a stdin attach into the container, which
    // Plan 2 adds; for now this only exercises the create -> stream -> delete
    // pod mechanism (verified by the unit test's fake log stream).
    const cmd = ["agentic-pi", "run", "--model", opts.model, "--sandbox", "none", "--no-session"];
    await this.runPod(
      taskId,
      cmd,
      { ...this.opts.env, ...opts.sandboxEnv },
      opts.agentCwd,
      parseLine(onEvent),
    );
    return undefined; // orchestrator reconstructs the result from the streamed events
  }

  async runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    let stdout = "";
    await this.runPod(
      taskId,
      ["sh", "-c", command],
      { ...this.opts.env, ...(opts.sandboxEnv ?? {}) },
      opts.cwd,
      (line) => {
        stdout += line + "\n";
      },
      opts.timeoutSeconds,
    );
    const { exitCode, timedOut } = await this.awaitPodResult(this.activePod!);
    return { exitCode, stdout, stderr: "", timedOut };
  }

  /**
   * Resolve a finished pod to its real exit code + deadline flag. The log
   * stream closing does not guarantee the API-visible status has left
   * `Running` (kubelet status-sync lag), so we poll `readNamespacedPodStatus`
   * until the pod is terminal, then read the container's `terminated.exitCode`.
   * The loop is bounded (~15 × 500ms ≈ 8s) so a stuck status never hangs the
   * command; on exhaustion we fall back to the coarse phase-based result.
   */
  private async awaitPodResult(name: string): Promise<{ exitCode: number; timedOut: boolean }> {
    for (let attempt = 0; attempt < POD_STATUS_POLL_ATTEMPTS; attempt++) {
      const pod = await this.apis.core.readNamespacedPodStatus({ name, namespace: this.ns });
      const status = pod.status;
      const terminated = status?.containerStatuses?.[0]?.state?.terminated;
      const phase = status?.phase;
      const isTerminal = terminated !== undefined || phase === "Succeeded" || phase === "Failed";
      if (isTerminal) {
        const timedOut =
          status?.reason === "DeadlineExceeded" || terminated?.reason === "DeadlineExceeded";
        const exitCode = terminated ? terminated.exitCode : phase === "Succeeded" ? 0 : 1;
        return { exitCode, timedOut };
      }
      await new Promise((resolve) => setTimeout(resolve, POD_STATUS_POLL_INTERVAL_MS));
    }
    // Status never went terminal within the budget — coarse phase fallback.
    const pod = await this.apis.core.readNamespacedPodStatus({ name, namespace: this.ns });
    return { exitCode: pod.status?.phase === "Succeeded" ? 0 : 1, timedOut: false };
  }

  private async runPod(
    taskId: string,
    command: string[],
    env: Record<string, string>,
    cwd: string,
    onLine: (line: string) => void,
    timeoutSeconds?: number,
  ): Promise<void> {
    const name = podNameFor(taskId, "run");
    this.activePod = name;
    // Wall-clock cap: activeDeadlineSeconds kills the pod at the per-call
    // budget (runCommand threads its RunCommandOpts.timeoutSeconds; runAgent
    // falls through to the factory timeout). streamPodLog resolves once the pod
    // (and its log stream) terminates, so no separate timeout is needed here.
    const manifest = buildPodManifest({
      name,
      namespace: this.ns,
      image: this.image,
      command,
      env,
      cwd,
      activeDeadlineSeconds: timeoutSeconds ?? this.opts.timeoutSeconds ?? 1800,
    });
    await this.apis.core.createNamespacedPod({ namespace: this.ns, body: manifest });
    await streamPodLog(this.apis.log, this.ns, name, "agent", onLine);
  }

  async dispose(): Promise<void> {
    if (!this.activePod) return;
    try {
      await this.apis.core.deleteNamespacedPod({ name: this.activePod, namespace: this.ns });
    } catch {
      /* already gone — the reclaim sweep (Plan 4) is the backstop */
    }
    this.activePod = undefined;
  }
}
