import { ApiException } from "@kubernetes/client-node";
import type { V1Container, V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
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
import { artifactStore, type ArtifactStore } from "../artifact-store.js";
import { loadAgentContext } from "../../workflows/loader.js";
import { makeK8sApis, type K8sApis } from "./client.js";
import { buildPodManifest, WORKSPACE_DIR, PROMPT_FILE, AGENT_CONTEXT_FILE, type PodSpecInput } from "./pod.js";
import { podNameFor, sanitizeLabelValue } from "./naming.js";
import { buildSecretManifest, podOwnerReference, secretNameFor } from "./secret.js";
import { streamPodLog } from "./log-stream.js";
import { buildPvcManifest, pvcNameFor } from "./pvc.js";
import { buildCloneInitContainer } from "./init-clone.js";
import { buildSkillsInitContainer } from "./init-skills.js";
import { applyEgressPolicies } from "./egress-apply.js";
import { DEFAULT_ALLOWLIST, mergeAllowlist } from "../egress-allowlist.js";
import type { HarnessSelector } from "./egress-policy.js";
import {
  buildSkillTar,
  skillBundleRegistry,
  SKILLS_MOUNT_DIR,
  type SkillBundleRegistry,
} from "./skill-bundle.js";
import { QuotaExceededError, isQuotaExceeded } from "./quota.js";

type Workspace = PodSpecInput["workspace"];

/** Bound on the post-stream status poll: ~15 × 500ms ≈ 8s before the coarse
 *  phase-based fallback, so a lagging kubelet status never hangs a command. */
const POD_STATUS_POLL_ATTEMPTS = 15;
const POD_STATUS_POLL_INTERVAL_MS = 500;

/** Bound on the pre-stream "container started" poll. A cold node pulling the
 *  ~400 MB sandbox image straight from GHCR takes ~30s, and a burst of reviews
 *  lands pods on several cold nodes at once (plus scheduling + iSCSI attach) —
 *  60s wasn't enough and pods were reaped mid-pull. ~180 × 1s ≈ 180s absorbs a
 *  cold first-node pull; a terminal pull/config error still fails fast within it
 *  (see FATAL_WAITING_REASONS), so the extra budget only helps a progressing
 *  pull. A cluster image mirror (Spegel) makes subsequent nodes pull from a LAN
 *  peer, so this budget is the fallback for the one node that pulls from GHCR. */
const POD_START_POLL_ATTEMPTS = 180;
const POD_START_POLL_INTERVAL_MS = 1000;

/** Bound on the post-delete "pod actually gone" poll (RWO Multi-Attach fix):
 *  a Pod deleted via the API isn't detached from its RWO PVC until it's
 *  truly gone, so a sequential next-phase pod on the same PVC (possibly a
 *  different node) can hit Multi-Attach if `dispose` returns too early.
 *  Budget ~30 × 1s ≈ 30s; on exhaustion `waitForPodGone` warns and returns
 *  anyway — never hang the run (the reclaim sweep, Plan 4, is the backstop). */
const POD_DELETE_POLL_ATTEMPTS = 30;
const POD_DELETE_POLL_INTERVAL_MS = 1000;

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
 *  initContainer security-context UID. `harnessEndpoint` / `harnessNamespace`
 *  / `harnessPodLabels` locate the harness Pod the skills-init fetches the
 *  bundle from (Task 3/6). The factory (`sandbox.ts`) resolves and passes all
 *  of these via `resolveKubernetesConfig()`. */
export interface K8sAdapterConfig {
  namespace: string;
  image: string;
  storageClassName: string;
  workspaceSize: string;
  runAsUser: number;
  harnessEndpoint: string;
  harnessNamespace: string;
  harnessPodLabels: Record<string, string>;
  /** Injectable fake `K8sApis` for tests; defaults to the real client. */
  apis?: K8sApis;
  /** Injectable registry for tests; defaults to the module singleton skillBundleRegistry. */
  skillRegistry?: SkillBundleRegistry;
  /** Injectable artifact store (tests only). Defaults to the module-wide
   *  `artifactStore` singleton (`../artifact-store.js`) — the same instance
   *  the `/internal/sandbox-artifacts` route resolves tokens against, so a
   *  token this adapter registers is always resolvable by that route. */
  artifactStore?: ArtifactStore;
}

/** Ensure the egress policy pair once per namespace per process. Keyed by
 *  namespace; a 403 (RBAC not yet granted — Plan 6) resolves after warning so
 *  we don't re-attempt (and re-log) every run. A genuine error clears the entry
 *  so a later run can retry. */
const egressEnsured = new Map<string, Promise<void>>();

/**
 * The `kubernetes` {@link Sandbox} adapter — one pod per `runAgent`/
 * `runCommand` call. `provision` ensures a stable per-(repo,PR) RWO PVC when
 * handed a pre-clone descriptor (design B — the harness can't pre-clone
 * host-side, so an initContainer clones inside the pod) and falls back to an
 * ephemeral in-pod `emptyDir` otherwise. `runAgent` delivers the prompt via a
 * per-run prompt Secret mounted into the pod and piped to the agent's stdin;
 * the resolved agent-context (persona/hard-rules) rides the same Secret as an
 * `agents` key (Plan 8 Task 5 — the harness has no host-shared workspace to
 * write AGENTS.md into on this backend), and the `runAgent` script copies it
 * to `<cwd>/AGENTS.md` before the agent starts.
 * Both the creds and prompt Secrets are created BEFORE the Pod (a Pod whose
 * `envFrom`/volume mount names a missing Secret fails to start); once the Pod
 * exists, each Secret's `ownerReferences` is patched to the Pod's uid so
 * deleting the Pod cascade-GCs them — `dispose` also best-effort deletes them
 * directly as a backstop. `stageSkills` tars the resolved skill dirs and
 * registers the bundle with the (injectable) skill registry; `runPod` then
 * carries the fetch token into the creds Secret and adds a skills initContainer
 * that pulls it from the harness's `/internal/skill-bundle` route. `runAgent`
 * additionally mints a per-run token from the (injectable) artifact store and
 * carries it into the same creds Secret; the in-pod script tars `.lastlight/`
 * after the agent finishes and uploads it to the harness's
 * `/internal/sandbox-artifacts` route, best-effort so an upload hiccup never
 * masks the agent's real exit code — `dispose` evicts the token afterward.
 */
export class KubernetesSandbox implements Sandbox {
  readonly backend: SandboxBackend = "kubernetes";
  private readonly apis: K8sApis;
  private readonly ns: string;
  private readonly image: string;
  private readonly runAsUser: number;
  private readonly storageClassName: string;
  private readonly workspaceSize: string;
  private readonly harnessEndpoint: string;
  private readonly harnessNamespace: string;
  private readonly harnessPodLabels: Record<string, string>;
  private readonly skillRegistry: SkillBundleRegistry;
  private activePod?: string;
  private activeCredsSecret?: string;
  private activePromptSecret?: string;
  /** Pre-clone descriptor from the last `provision()` call, if any — `runPod`
   *  needs the repo coordinates to build the clone initContainer. */
  private pre?: PrePopulateSpec;
  private workspace: Workspace = { kind: "emptyDir" };
  /** Fetch token for the bundle staged by the last `stageSkills()` call, if
   *  any — `runPod` needs it for the creds Secret + skills-init; `dispose`
   *  evicts it from the registry. */
  private skillToken?: string;
  private readonly artifactStore: ArtifactStore;
  /** Artifact-upload token minted by the last `runAgent()` call, if any —
   *  `runPod` needs it for the creds Secret; the in-pod script reads it back
   *  via env to authenticate the `.lastlight/` upload; `dispose` evicts it
   *  from the store. Never minted for `runCommand` (nothing to upload). */
  private artifactToken?: string;

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
    this.harnessEndpoint = cfg.harnessEndpoint;
    this.harnessNamespace = cfg.harnessNamespace;
    this.harnessPodLabels = cfg.harnessPodLabels;
    this.skillRegistry = cfg.skillRegistry ?? skillBundleRegistry;
    this.artifactStore = cfg.artifactStore ?? artifactStore;
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
        runId: this.sanitizedRunId(),
      }),
    });
  }

  /**
   * Package `skillPaths` into a tar, register it in the (injectable) skill
   * registry, and return the in-pod dirs the agent should `--skill` against.
   * `runPod` reads `this.skillToken` back off the instance to wire the creds
   * Secret + skills-init; the orchestrator also threads the returned dirs
   * back in as `opts.skillDirs` for the `runAgent` command (Task 6 brief).
   * Deduped: `buildSkillTar` doesn't dedupe sanitized-name collisions
   * (two skill dirs whose basenames sanitize equal merge in the tar), so a
   * `Set` here at least keeps the returned `--skill` list free of repeats.
   */
  stageSkills(_phaseKey: string, skillPaths: string[] | undefined): string[] | undefined {
    const { tar, names } = buildSkillTar(skillPaths ?? []);
    if (!names.length) return undefined;
    this.skillToken = this.skillRegistry.register(tar);
    return [...new Set(names)].map((n) => `${SKILLS_MOUNT_DIR}/${n}`);
  }

  /** Hosts the strict policy allows — the shared allowlist plus OTEL collector
   *  hosts when sandbox OTEL forwarding is on (mirrors `egressPolicyFor`). */
  private strictHosts(): string[] {
    const otel = this.opts.otel;
    const extra = otel?.enabled && otel.forwardToSandbox ? otel.collectorHosts : [];
    return mergeAllowlist(DEFAULT_ALLOWLIST, extra);
  }

  /** Apply the egress policy pair once per namespace. Best-effort in Plan 3:
   *  a 403 means the CiliumNetworkPolicy RBAC verb isn't granted yet (Plan 6),
   *  so we warn ONCE and run on Cilium's default-allow — no regression to the
   *  validated flows; the same code enforces the moment RBAC lands. */
  private ensureEgress(): Promise<void> {
    let pending = egressEnsured.get(this.ns);
    if (pending) return pending;
    const port = Number(new URL(this.harnessEndpoint).port) || 8644;
    const harness: HarnessSelector = {
      namespace: this.harnessNamespace,
      labels: this.harnessPodLabels,
      port,
    };
    const opts = { namespace: this.ns, hosts: this.strictHosts(), harness };
    pending = applyEgressPolicies(this.apis.custom, opts).catch(
      (err) => {
        if (err instanceof ApiException && err.code === 403) {
          console.warn(
            `[k8s] egress policies not applied in ${this.ns}: RBAC for ` +
              `CiliumNetworkPolicy is not granted (Plan 6). Running WITHOUT egress ` +
              `enforcement (Cilium default-allow).`,
          );
          return; // resolve — don't retry/re-log every run
        }
        egressEnsured.delete(this.ns); // real error: allow a later run to retry
        throw err;
      },
    );
    egressEnsured.set(this.ns, pending);
    return pending;
  }

  sandboxPathFor(relPath: string): string {
    return `${WORKSPACE_DIR}/${relPath}`;
  }

  /** Sanitized `this.pre.runId` — stamped identically onto the Pod (`runPod`)
   *  and the PVC (`ensurePvc`) as `RUN_ID_LABEL` so the reclaim run-selector
   *  (Plan 5) matches both. Undefined when `provision()` had no pre-clone
   *  descriptor, or the descriptor carried no runId. */
  private sanitizedRunId(): string | undefined {
    return this.pre?.runId ? sanitizeLabelValue(this.pre.runId) : undefined;
  }

  async runAgent(
    taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    // The prompt reaches the container via a mounted Secret file (see
    // `runPod`'s `promptText`), piped to stdin — never as a CLI arg (`ps`
    // -visible) or inline env. `opts.model` and the harness endpoint arrive
    // as positional args to `sh`, NOT interpolated into the script text — the
    // same command-injection class `init-clone.ts` guards against for
    // owner/repo/branch: `sh -c SCRIPT sh <model> <endpoint>` binds argv to
    // `$1`/`$2` at exec time, immune to quote-breaking regardless of
    // characters. Each skill dir is already
    // `${SKILLS_MOUNT_DIR}/<sanitized-name>` (stageSkills), so splicing it
    // into the script text is safe.
    //
    // No longer a bare `exec`: the agent's real exit code is captured (`rc`)
    // so a post-run step — a best-effort tar+upload of `.lastlight/` — can run
    // AFTER the agent finishes, then `exit $rc` preserves the agent's own
    // result. The upload never masks that result (`|| true`): a hiccup
    // uploading artifacts must not turn a successful agent run into a
    // reported failure. The token travels via env (`LASTLIGHT_ARTIFACT_TOKEN`,
    // injected into the creds Secret below), never as a CLI arg.
    //
    // AGENTS.md (Plan 8 Task 5): the harness has no host-shared workspace to
    // write it into on k8s (`writeAgentsMd` is skipped for this backend — see
    // orchestrator.ts), so the resolved agent-context rides the same per-run
    // prompt Secret as an `agents` key, mounted at AGENT_CONTEXT_FILE. The
    // leading `cp` — a fixed, no-op-when-absent step — materializes it at
    // `WORKSPACE_DIR/AGENTS.md`, the workspace ROOT, NOT cwd-relative: for a
    // pre-cloned run `cwd` is `WORKSPACE_DIR/<repo>` (the checkout root), so a
    // cwd-relative `AGENTS.md` would land INSIDE the repo tree and a
    // repo-write phase's `git add -A && git commit` would commit the bot's
    // AGENTS.md into the customer's PR (and clobber a repo that ships its
    // own). Writing to the workspace root instead mirrors the host-shared
    // backends exactly (`writeAgentsMd` writes to `prov.hostWorkspaceDir`, a
    // sibling of the repo checkout, never inside it) — agentic-pi still finds
    // it via its upward AGENTS.md walk from cwd. `WORKSPACE_DIR` is a fixed
    // constant (not untrusted content), so interpolating it into the script
    // text is safe.
    this.artifactToken = this.artifactStore.register(this.opts.taskId);
    const agentContext = loadAgentContext();
    const skillFlags = (opts.skillDirs ?? []).map((d) => `--skill ${d}`).join(" ");
    const script =
      `if [ -f ${AGENT_CONTEXT_FILE} ]; then cp ${AGENT_CONTEXT_FILE} ${WORKSPACE_DIR}/AGENTS.md; fi\n` +
      `agentic-pi run --model "$1" --sandbox none --no-session ${skillFlags} ` +
      `< ${PROMPT_FILE} ; rc=$?\n` +
      `if [ -d .lastlight ]; then\n` +
      `  tar -czf - .lastlight | curl -sf -X POST ` +
      `-H "Authorization: Bearer $LASTLIGHT_ARTIFACT_TOKEN" ` +
      `--data-binary @- "$2/internal/sandbox-artifacts" || true\n` +
      `fi\n` +
      `exit $rc`;
    await this.runPod({
      taskId,
      command: ["sh", "-c", script, "sh", opts.model, this.harnessEndpoint],
      env: { ...this.opts.env, ...opts.sandboxEnv },
      cwd: opts.agentCwd,
      onLine: parseLine(onEvent),
      promptText: prompt,
      agentContext,
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
    /** Resolved agent-context for a `runAgent` call — rides the same prompt
     *  Secret as an `agents` key (see AGENT_CONTEXT_FILE). Empty/omitted →
     *  no key, no extra mount item; never set for `runCommand`. */
    agentContext?: string;
  }): Promise<void> {
    const { taskId, command, env, cwd, onLine, timeoutSeconds, promptText, agentContext } = input;
    const name = podNameFor(taskId, "run");
    this.activePod = name;
    await this.ensureEgress();

    // Per-run creds travel in the pod's OWN Secret, never inline on the pod
    // spec (inline env is `kubectl get pod -o yaml`-visible — issue #223).
    // Must be created BEFORE the pod: a pod whose envFrom names a missing
    // Secret fails to start. When `stageSkills` staged a bundle, its fetch
    // token rides along in the same map so the skills-init reads it via the
    // same `envFrom` the main container gets. Likewise the artifact-upload
    // token minted by `runAgent` (never set for `runCommand` — nothing to
    // upload) rides along so the in-pod script's post-run upload can
    // authenticate.
    const credsName = secretNameFor(name, "creds");
    this.activeCredsSecret = credsName;
    const credsData = {
      ...env,
      ...(this.skillToken && { LASTLIGHT_SKILL_TOKEN: this.skillToken }),
      ...(this.artifactToken && { LASTLIGHT_ARTIFACT_TOKEN: this.artifactToken }),
    };
    await this.apis.core.createNamespacedSecret({
      namespace: this.ns,
      body: buildSecretManifest({
        name: credsName,
        namespace: this.ns,
        data: credsData,
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
          data: { prompt: promptText, ...(agentContext ? { agents: agentContext } : {}) },
          labels: { "lastlight.io/pod": name },
        }),
      });
    }

    // Minimal clone init (locked decision #2) — only when this run has a PVC
    // workspace AND a pre-clone descriptor (an ephemeral emptyDir run has
    // nothing to clone into). Cloned coordinates come from `this.pre`, stashed
    // by the last `provision()` call. The skills init runs alongside it
    // whenever `stageSkills` staged a bundle for this run — both coexist,
    // and `buildPodManifest` attaches the creds Secret's `envFrom` to each.
    const initContainers: V1Container[] = [];
    if (this.workspace.kind === "pvc" && this.pre) {
      initContainers.push(
        buildCloneInitContainer(this.image, {
          owner: this.pre.owner,
          repo: this.pre.repo,
          branch: this.pre.branch,
          cwd: WORKSPACE_DIR,
          runAsUser: this.runAsUser,
        }),
      );
    }
    if (this.skillToken) {
      initContainers.push(
        buildSkillsInitContainer(this.image, {
          endpoint: this.harnessEndpoint,
          runAsUser: this.runAsUser,
        }),
      );
    }

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
      agentContextMount: Boolean(agentContext),
      cwd,
      activeDeadlineSeconds: timeoutSeconds ?? this.opts.timeoutSeconds ?? 1800,
      runAsUser: this.runAsUser,
      workspace: this.workspace,
      initContainers,
      egressPolicy: this.opts.egress.unrestricted ? "open" : "strict",
      skillsMount: this.skillToken !== undefined,
      runId: this.sanitizedRunId(),
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
      // A ResourceQuota rejection is backpressure, not a failure: rethrow a
      // typed error so the orchestrator stamps `error_quota` and the run
      // requeues (design.md §8). Every other create error propagates as-is.
      if (isQuotaExceeded(err)) {
        const body = (err as { body?: { message?: string } }).body;
        throw new QuotaExceededError(body?.message ?? "pod create rejected by ResourceQuota");
      }
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
   * A failed clone initContainer is checked on every poll too — otherwise the
   * main container just sits at `PodInitializing` for the whole budget while
   * the real `git clone` failure sits unreported in `initContainerStatuses`.
   */
  private async waitForContainerStart(name: string): Promise<void> {
    let lastReason = "";
    for (let attempt = 0; attempt < POD_START_POLL_ATTEMPTS; attempt++) {
      const pod = await this.apis.core.readNamespacedPodStatus({ name, namespace: this.ns });
      await this.checkInitContainerFailure(name, pod.status?.initContainerStatuses);
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

  /**
   * Fail fast when the clone initContainer has failed or is stuck on a fatal
   * pull/config error, instead of leaving the caller to wait out the full
   * `waitForContainerStart` budget while the main container reports the
   * uninformative `PodInitializing` (which is the NORMAL state while an
   * initContainer is still running — not itself a failure).
   */
  private async checkInitContainerFailure(
    podName: string,
    initStatuses: V1ContainerStatus[] | undefined,
  ): Promise<void> {
    for (const init of initStatuses ?? []) {
      const terminated = init.state?.terminated;
      if (terminated && terminated.exitCode !== 0) {
        const logs = await this.initContainerLogs(podName, init.name);
        throw new Error(
          `k8s sandbox pod ${podName} init container "${init.name}" failed ` +
            `(exit ${terminated.exitCode}): ${terminated.reason ?? "unknown"}` +
            (terminated.message ? ` — ${terminated.message}` : "") +
            (logs ? `\n--- ${init.name} logs (tail) ---\n${logs}` : ""),
        );
      }
      const waiting = init.state?.waiting;
      if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
        throw new Error(
          `k8s sandbox pod ${podName} init container "${init.name}" cannot start: ` +
            `${waiting.reason}` + (waiting.message ? ` — ${waiting.message}` : ""),
        );
      }
    }
  }

  /**
   * Best-effort tail of a terminated init container's logs, appended to the
   * thrown error so the REAL failure (a git clone error — DNS, egress, PVC
   * permission, auth) is visible instead of a bare `exit 128`. Never throws:
   * a log-fetch failure just yields no extra detail.
   */
  private async initContainerLogs(podName: string, container: string): Promise<string> {
    try {
      const raw = await this.apis.core.readNamespacedPodLog({
        name: podName,
        namespace: this.ns,
        container,
      });
      const text = typeof raw === "string" ? raw.trim() : "";
      const MAX = 2000;
      return text.length > MAX ? `…${text.slice(-MAX)}` : text;
    } catch {
      return "";
    }
  }

  /**
   * Poll after a successful pod delete until the API 404s it, so the RWO PVC
   * (truenas-iscsi allows only one attached node) is actually released
   * before `dispose` returns — a sequential next-phase pod reusing the same
   * PVC on a different node would otherwise race the still-attaching volume
   * and hit Multi-Attach. A 404 on the very first poll (pod already gone)
   * succeeds immediately. Best-effort like the delete above: any non-404
   * read error is treated as "not yet confirmed gone" and just retried
   * within the budget, never failing the caller's `dispose()`.
   */
  private async waitForPodGone(name: string): Promise<void> {
    for (let attempt = 0; attempt < POD_DELETE_POLL_ATTEMPTS; attempt++) {
      try {
        await this.apis.core.readNamespacedPodStatus({ name, namespace: this.ns });
      } catch (err) {
        if (err instanceof ApiException && err.code === 404) return; // gone
      }
      await new Promise((resolve) => setTimeout(resolve, POD_DELETE_POLL_INTERVAL_MS));
    }
    const budgetSeconds = (POD_DELETE_POLL_ATTEMPTS * POD_DELETE_POLL_INTERVAL_MS) / 1000;
    console.warn(
      `[k8s] pod ${name} still present ${budgetSeconds}s after delete — proceeding anyway ` +
        `(a sequential pod on the same PVC may race the volume release).`,
    );
  }

  async dispose(): Promise<void> {
    if (this.activePod) {
      const name = this.activePod;
      let deleteSucceeded = false;
      try {
        await this.apis.core.deleteNamespacedPod({ name, namespace: this.ns });
        deleteSucceeded = true;
      } catch {
        /* already gone — the reclaim sweep (Plan 4) is the backstop */
      }
      this.activePod = undefined;
      if (deleteSucceeded) await this.waitForPodGone(name);
    }
    if (this.activeCredsSecret) {
      await this.deleteSecretBestEffort(this.activeCredsSecret);
      this.activeCredsSecret = undefined;
    }
    if (this.activePromptSecret) {
      await this.deleteSecretBestEffort(this.activePromptSecret);
      this.activePromptSecret = undefined;
    }
    if (this.skillToken) {
      this.skillRegistry.evict(this.skillToken);
      this.skillToken = undefined;
    }
    if (this.artifactToken) {
      this.artifactStore.evict(this.artifactToken);
      this.artifactToken = undefined;
    }
  }
}
