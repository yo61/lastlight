import { ApiException } from "@kubernetes/client-node";
import type { V1Pod } from "@kubernetes/client-node";
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
import { buildPodManifest, WORKSPACE_DIR, PROMPT_FILE, type PodSpecInput } from "./pod.js";
import { buildSecretManifest, podOwnerReference, secretNameFor } from "./secret.js";
import { podNameFor } from "./naming.js";
import { streamPodLog } from "./log-stream.js";
import { buildPvcManifest, pvcNameFor } from "./pvc.js";
import { buildCloneInitContainer } from "./init-clone.js";

type Workspace = PodSpecInput["workspace"];

/** Bound on the post-stream status poll: ~15 × 500ms ≈ 8s before the coarse
 *  phase-based fallback, so a lagging kubelet status never hangs a command. */
const POD_STATUS_POLL_ATTEMPTS = 15;
const POD_STATUS_POLL_INTERVAL_MS = 500;

/** Bound on the pre-stream "container started" poll. Image pull can take a
 *  while on a cold node, so this budget (~60 × 1s ≈ 60s) is generous; a
 *  terminal pull/config error fails fast within it (see FATAL_WAITING_REASONS). */
const POD_START_POLL_ATTEMPTS = 60;
const POD_START_POLL_INTERVAL_MS = 1000;

/** Container `waiting.reason`s that will never resolve on their own — fail fast
 *  with the reason instead of waiting out the whole start budget. */
const FATAL_WAITING_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

/** Config the adapter needs. `storageClassName` / `workspaceSize` size and
 *  class the per-(repo,PR) PVC (Task 5); `runAsUser` is the pod and
 *  initContainer security-context UID. The factory (`sandbox.ts`) resolves
 *  and passes all five fields via `resolveKubernetesConfig()`. */
export interface K8sAdapterConfig {
  namespace: string;
  image: string;
  storageClassName: string;
  workspaceSize: string;
  runAsUser: number;
  /** Injectable fake `K8sApis` for tests; defaults to the real client. */
  apis?: K8sApis;
}

/**
 * The `kubernetes` {@link Sandbox} adapter — one pod per `runAgent`/
 * `runCommand` call. `provision` ensures a stable per-(repo,PR) RWO PVC when
 * handed a pre-clone descriptor (design B — the harness can't pre-clone
 * host-side, so an initContainer clones inside the pod) and falls back to an
 * ephemeral in-pod `emptyDir` otherwise. `runAgent` delivers the prompt via a
 * per-run prompt Secret mounted into the pod and piped to the agent's stdin.
 * Both the creds and prompt Secrets are created BEFORE the Pod (a Pod whose
 * `envFrom`/volume mount names a missing Secret fails to start); once the Pod
 * exists, each Secret's `ownerReferences` is patched to the Pod's uid so
 * deleting the Pod cascade-GCs them — `dispose` also best-effort deletes them
 * directly as a backstop. `stageSkills` is still a stub (Plan 3).
 */
export class KubernetesSandbox implements Sandbox {
  readonly backend: SandboxBackend = "kubernetes";
  private readonly apis: K8sApis;
  private readonly ns: string;
  private readonly image: string;
  private readonly runAsUser: number;
  private readonly storageClassName: string;
  private readonly workspaceSize: string;
  private activePod?: string;
  private activeCredsSecret?: string;
  private activePromptSecret?: string;
  /** Pre-clone descriptor from the last `provision()` call, if any — `runPod`
   *  needs the repo coordinates to build the clone initContainer. */
  private pre?: PrePopulateSpec;
  private workspace: Workspace = { kind: "emptyDir" };

  constructor(
    private readonly opts: SandboxFactoryOpts,
    cfg: K8sAdapterConfig,
  ) {
    this.apis = cfg.apis ?? makeK8sApis();
    this.ns = cfg.namespace;
    this.image = opts.imageName ?? cfg.image;
    this.runAsUser = cfg.runAsUser;
    this.storageClassName = cfg.storageClassName;
    this.workspaceSize = cfg.workspaceSize;
  }

  async provision(pre?: PrePopulateSpec): Promise<ProvisionResult> {
    this.pre = pre;
    if (!pre) {
      this.workspace = { kind: "emptyDir" };
      return { hostWorkspaceDir: WORKSPACE_DIR, agentCwd: WORKSPACE_DIR };
    }
    const claimName = pvcNameFor(this.opts.taskId);
    await this.ensurePvc(claimName);
    this.workspace = { kind: "pvc", claimName };
    return { hostWorkspaceDir: WORKSPACE_DIR, agentCwd: `${WORKSPACE_DIR}/${pre.repo}` };
  }

  /** Stable per-(repo,PR) PVC (design B, locked decision #2) — created once and
   *  reused across runs/phases, never recreated or resized here (Plan 4). */
  private async ensurePvc(name: string): Promise<void> {
    try {
      await this.apis.core.readNamespacedPersistentVolumeClaim({ name, namespace: this.ns });
      return;
    } catch (err) {
      if (!(err instanceof ApiException) || err.code !== 404) throw err;
    }
    await this.apis.core.createNamespacedPersistentVolumeClaim({
      namespace: this.ns,
      body: buildPvcManifest({
        name,
        namespace: this.ns,
        storageClassName: this.storageClassName,
        size: this.workspaceSize,
      }),
    });
  }

  stageSkills(_phaseKey: string, _skillPaths: string[] | undefined): string[] | undefined {
    return undefined; // Plan 3
  }

  sandboxPathFor(relPath: string): string {
    return `${WORKSPACE_DIR}/${relPath}`;
  }

  async runAgent(
    taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    // The prompt reaches the container via a mounted Secret file (see
    // `runPod`'s `promptText`), piped to stdin — never as a CLI arg (`ps`
    // -visible) or inline env. `opts.model` arrives as a positional arg to
    // `sh`, NOT interpolated into the script text — the same
    // command-injection class `init-clone.ts` guards against for
    // owner/repo/branch: `sh -c SCRIPT sh <model>` binds argv to `$1` at exec
    // time, immune to quote-breaking regardless of characters.
    const script = `exec agentic-pi run --model "$1" --sandbox none --no-session < ${PROMPT_FILE}`;
    await this.runPod({
      taskId,
      command: ["sh", "-c", script, "sh", opts.model],
      env: { ...this.opts.env, ...opts.sandboxEnv },
      cwd: opts.agentCwd,
      onLine: parseLine(onEvent),
      promptText: prompt,
    });
    return undefined; // orchestrator reconstructs the result from the streamed events
  }

  async runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    let stdout = "";
    await this.runPod({
      taskId,
      command: ["sh", "-c", command],
      env: { ...this.opts.env, ...(opts.sandboxEnv ?? {}) },
      cwd: opts.cwd,
      onLine: (line) => {
        stdout += line + "\n";
      },
      timeoutSeconds: opts.timeoutSeconds,
    });
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

  private async runPod(input: {
    taskId: string;
    command: string[];
    env: Record<string, string>;
    cwd: string;
    onLine: (line: string) => void;
    timeoutSeconds?: number;
    /** Prompt text for a `runAgent` call — creates a prompt Secret mounted
     *  into the pod. Omitted for `runCommand` (no prompt to deliver). */
    promptText?: string;
  }): Promise<void> {
    const { taskId, command, env, cwd, onLine, timeoutSeconds, promptText } = input;
    const name = podNameFor(taskId, "run");
    this.activePod = name;

    // Per-run creds travel in the pod's OWN Secret, never inline on the pod
    // spec (inline env is `kubectl get pod -o yaml`-visible — issue #223).
    // Must be created BEFORE the pod: a pod whose envFrom names a missing
    // Secret fails to start.
    const credsName = secretNameFor(name, "creds");
    this.activeCredsSecret = credsName;
    await this.apis.core.createNamespacedSecret({
      namespace: this.ns,
      body: buildSecretManifest({
        name: credsName,
        namespace: this.ns,
        data: env,
        labels: { "lastlight.io/pod": name },
      }),
    });

    // The prompt travels the same way — a per-run Secret mounted read-only
    // and piped to stdin by the command `runAgent` built. Same ordering rule:
    // created before the pod, whose volume mount would otherwise fail to start.
    let promptName: string | undefined;
    if (promptText !== undefined) {
      promptName = secretNameFor(name, "prompt");
      this.activePromptSecret = promptName;
      await this.apis.core.createNamespacedSecret({
        namespace: this.ns,
        body: buildSecretManifest({
          name: promptName,
          namespace: this.ns,
          data: { prompt: promptText },
          labels: { "lastlight.io/pod": name },
        }),
      });
    }

    // Minimal clone init (locked decision #2) — only when this run has a PVC
    // workspace AND a pre-clone descriptor (an ephemeral emptyDir run has
    // nothing to clone into). Cloned coordinates come from `this.pre`, stashed
    // by the last `provision()` call.
    const initContainers =
      this.workspace.kind === "pvc" && this.pre
        ? [
            buildCloneInitContainer(this.image, {
              owner: this.pre.owner,
              repo: this.pre.repo,
              branch: this.pre.branch,
              cwd: WORKSPACE_DIR,
              runAsUser: this.runAsUser,
            }),
          ]
        : undefined;

    // Wall-clock cap: activeDeadlineSeconds kills the pod at the per-call
    // budget (runCommand threads its RunCommandOpts.timeoutSeconds; runAgent
    // falls through to the factory timeout). streamPodLog resolves once the pod
    // (and its log stream) terminates, so no separate timeout is needed here.
    const manifest = buildPodManifest({
      name,
      namespace: this.ns,
      image: this.image,
      command,
      envFromSecret: credsName,
      promptSecret: promptName,
      cwd,
      activeDeadlineSeconds: timeoutSeconds ?? this.opts.timeoutSeconds ?? 1800,
      runAsUser: this.runAsUser,
      workspace: this.workspace,
      initContainers,
    });
    const created = await this.createPodOrCleanupSecrets(manifest, credsName, promptName);
    await this.patchSecretOwnerRefs(name, created, credsName, promptName);
    await this.waitForContainerStart(name);
    await streamPodLog(this.apis.log, this.ns, name, "agent", onLine);
  }

  /** Create the Pod; on failure, best-effort delete the Secret(s) already
   *  created for it (they exist before the Pod per the ordering rule above),
   *  so a failed create doesn't orphan them — then rethrow. */
  private async createPodOrCleanupSecrets(
    manifest: V1Pod,
    credsName: string,
    promptName: string | undefined,
  ): Promise<V1Pod> {
    try {
      return await this.apis.core.createNamespacedPod({ namespace: this.ns, body: manifest });
    } catch (err) {
      await this.deleteSecretBestEffort(credsName);
      if (promptName) await this.deleteSecretBestEffort(promptName);
      throw err;
    }
  }

  /**
   * Cascade-GC ref: patch each Secret's `ownerReferences` to the created
   * Pod's uid, so deleting the Pod GCs them too (`dispose` also best-effort
   * deletes them directly as a backstop). client-node 1.4.0's
   * `patchNamespacedSecret` always negotiates `Content-Type:
   * application/json-patch+json` — `ObjectSerializer.getPreferredMediaType`
   * walks its candidate list (json-patch, merge-patch, strategic-merge-patch,
   * apply-patch) and returns the first one matching "is JSON-like", which is
   * json-patch every time — so the body must be an RFC 6902 JSON Patch
   * document, not a partial merge object. `add` (not `replace`) because
   * `ownerReferences` doesn't exist on a freshly created Secret.
   */
  private async patchSecretOwnerRefs(
    podName: string,
    pod: V1Pod,
    credsName: string,
    promptName: string | undefined,
  ): Promise<void> {
    const uid = pod.metadata?.uid;
    if (!uid) throw new Error(`k8s sandbox pod ${podName} was created without a uid`);
    const patch = [
      { op: "add", path: "/metadata/ownerReferences", value: [podOwnerReference(podName, uid)] },
    ];
    const namespace = this.ns;
    await this.apis.core.patchNamespacedSecret({ name: credsName, namespace, body: patch });
    if (promptName) {
      await this.apis.core.patchNamespacedSecret({ name: promptName, namespace, body: patch });
    }
  }

  /** Best-effort Secret delete — used both by the pod-create failure path and
   *  `dispose`; swallows the error since the Secret may already be gone
   *  (cascade-GC'd with the pod, or the reclaim sweep). */
  private async deleteSecretBestEffort(name: string): Promise<void> {
    try {
      await this.apis.core.deleteNamespacedSecret({ name, namespace: this.ns });
    } catch {
      /* already gone */
    }
  }

  /**
   * Wait until the pod's container has started so the kubelet log endpoint is
   * available. `Log.log(follow)` returns HTTP 400 while the container is still
   * `waiting` (Pending / ContainerCreating / image pull), so streaming
   * immediately after create races the scheduler. "Started" means the container
   * is `running`/`terminated` OR the pod already reached a terminal phase (a
   * fast command can finish before the first poll). A terminal image/config
   * error (`ImagePullBackOff`, …) fails fast with its real reason rather than
   * waiting out the budget, so the failure is debuggable instead of a cryptic 400.
   */
  private async waitForContainerStart(name: string): Promise<void> {
    let lastReason = "";
    for (let attempt = 0; attempt < POD_START_POLL_ATTEMPTS; attempt++) {
      const pod = await this.apis.core.readNamespacedPodStatus({ name, namespace: this.ns });
      const state = pod.status?.containerStatuses?.[0]?.state;
      const phase = pod.status?.phase;
      if (state?.running || state?.terminated || phase === "Succeeded" || phase === "Failed") {
        return; // container has started (or already finished) — logs are available
      }
      const waiting = state?.waiting;
      lastReason = waiting?.reason ?? phase ?? "";
      if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
        throw new Error(
          `k8s sandbox pod ${name} cannot start: ${waiting.reason}` +
            (waiting.message ? ` — ${waiting.message}` : ""),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POD_START_POLL_INTERVAL_MS));
    }
    const budgetSeconds = (POD_START_POLL_ATTEMPTS * POD_START_POLL_INTERVAL_MS) / 1000;
    throw new Error(
      `k8s sandbox pod ${name} container did not start within ${budgetSeconds}s ` +
        `(last state: ${lastReason || "unknown"})`,
    );
  }

  async dispose(): Promise<void> {
    if (this.activePod) {
      try {
        await this.apis.core.deleteNamespacedPod({ name: this.activePod, namespace: this.ns });
      } catch {
        /* already gone — the reclaim sweep (Plan 4) is the backstop */
      }
      this.activePod = undefined;
    }
    if (this.activeCredsSecret) {
      await this.deleteSecretBestEffort(this.activeCredsSecret);
      this.activeCredsSecret = undefined;
    }
    if (this.activePromptSecret) {
      await this.deleteSecretBestEffort(this.activePromptSecret);
      this.activePromptSecret = undefined;
    }
  }
}
