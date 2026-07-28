import type { V1Container, V1Pod } from "@kubernetes/client-node";
import { EGRESS_POLICY_LABEL } from "./egress-policy.js";
import { SKILLS_MOUNT_DIR } from "./skill-bundle.js";

export const PROMPT_MOUNT_DIR = "/lastlight";
export const PROMPT_FILE = `${PROMPT_MOUNT_DIR}/prompt`;

/** Resolved agent-context (persona/hard-rules), delivered the same way as the
 *  prompt — an extra key on the same per-run prompt Secret, mounted alongside
 *  it. The `runAgent` script (`kubernetes-sandbox.ts`) copies this file into
 *  `<cwd>/AGENTS.md` before starting the agent — agentic-pi reads AGENTS.md
 *  from its cwd. Plan 8 Task 5: the k8s backend has no host-shared workspace
 *  for the harness to write AGENTS.md into directly (unlike docker/gondolin/
 *  none/smol), so it rides the pod instead. */
export const AGENT_CONTEXT_FILE = `${PROMPT_MOUNT_DIR}/AGENTS.md`;

/** Label stamping a sandbox Pod/PVC with the run that owns it — the selector
 *  `reclaimSandbox` (Plan 5) matches on to find a run's objects. `pvc.ts`
 *  reuses this same constant so both objects carry an identical key. */
export const RUN_ID_LABEL = "lastlight.io/run-id";

/** Fixed in-pod mount root for the "workspace" volume — always the PVC/emptyDir
 *  ROOT, independent of `cwd` (which may be a `<root>/<repo>` subdir once a
 *  pre-clone init container has populated it). The clone initContainer mounts
 *  the same volume at this same path (see `kubernetes-sandbox.ts`), so the
 *  checkout it writes at `<WORKSPACE_DIR>/<repo>` lands exactly where the main
 *  container's `workingDir` expects it — mounting the volume at `cwd` instead
 *  would nest the checkout one level too deep. */
export const WORKSPACE_DIR = "/home/agent/workspace";

export interface PodSpecInput {
  name: string;
  namespace: string;
  image: string;
  command: string[];
  /** Name of the per-run creds Secret (see `secret.ts`); env arrives via
   *  `envFrom`, never inline (inline env is `kubectl get pod -o yaml`-visible). */
  envFromSecret: string;
  cwd: string;
  activeDeadlineSeconds: number;
  runAsUser: number;
  /** Name of the per-run prompt Secret; when set, mounts its `prompt` key as a file at
   *  `PROMPT_FILE` so the entrypoint can pipe it into stdin (Task 6). */
  promptSecret?: string;
  /** When set alongside `promptSecret`, also projects that same Secret's `agents`
   *  key as `AGENT_CONTEXT_FILE` — the resolved agent-context (persona/hard-rules)
   *  the `runAgent` script copies into `<cwd>/AGENTS.md` (Plan 8 Task 5). */
  agentContextMount?: boolean;
  /** PVC-backed (per-(repo,PR), pre-cloned by an initContainer) or emptyDir
   *  (ephemeral, no pre-clone) workspace — design B (docs/plans/kubernetes-sandbox-backend). */
  workspace: { kind: "pvc"; claimName: string } | { kind: "emptyDir" };
  /** Runs before the "agent" container — currently just the minimal git clone
   *  (Task 5). Each gets the creds Secret's `envFrom` attached here so it
   *  shares the main container's `GIT_CONFIG_*` git auth. */
  initContainers?: V1Container[];
  /** Selects which CiliumNetworkPolicy governs this pod's egress — `strict`
   *  (the allowlist) or `open` (an `unrestricted_egress` phase). Stamped as the
   *  `egress-policy` label the policy's endpointSelector matches. */
  egressPolicy: "strict" | "open";
  /** When set, add a `skills` emptyDir shared with the skills initContainer and
   *  mount it at SKILLS_MOUNT_DIR in the agent container (the initContainer,
   *  passed in `initContainers`, unpacks the fetched bundle into it). */
  skillsMount?: boolean;
  /** Sanitized run id (see `kubernetes-sandbox.ts`); when set, stamped as the
   *  `RUN_ID_LABEL` so `reclaimSandbox` (Plan 5) can select this run's Pod. */
  runId?: string;
}

export function buildPodManifest(i: PodSpecInput): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "lastlight",
        "lastlight.io/component": "sandbox",
        [EGRESS_POLICY_LABEL]: i.egressPolicy,
        ...(i.runId ? { [RUN_ID_LABEL]: i.runId } : {}),
      },
    },
    spec: {
      restartPolicy: "Never",
      activeDeadlineSeconds: i.activeDeadlineSeconds,
      automountServiceAccountToken: false, // an agent needs no k8s API access
      securityContext: {
        runAsNonRoot: true,
        runAsUser: i.runAsUser,
        // Chown mounted volumes to this group and add the process to it, so a
        // non-root process can write the RWO PVC — which mounts root-owned, so
        // without this the clone initContainer fails to create the checkout dir
        // ("could not create work tree dir: Permission denied"). Reuses the
        // runAsUser value as the group id (a standard non-root idiom).
        fsGroup: i.runAsUser,
        // Skip the recursive chown when the volume's group already matches —
        // matters on a REUSED PVC (Plan 2 deferral): without it every run pays
        // a slow recursive chown over the whole checkout just to re-confirm
        // ownership it already has.
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        i.workspace.kind === "pvc"
          ? { name: "workspace", persistentVolumeClaim: { claimName: i.workspace.claimName } }
          : { name: "workspace", emptyDir: {} },
        ...(i.promptSecret
          ? [
              {
                name: "prompt",
                secret: {
                  secretName: i.promptSecret,
                  items: [
                    { key: "prompt", path: "prompt" },
                    ...(i.agentContextMount ? [{ key: "agents", path: "AGENTS.md" }] : []),
                  ],
                },
              },
            ]
          : []),
        ...(i.skillsMount ? [{ name: "skills", emptyDir: {} }] : []),
      ],
      ...(i.initContainers && i.initContainers.length
        ? {
            initContainers: i.initContainers.map((c) => ({
              ...c,
              envFrom: [{ secretRef: { name: i.envFromSecret } }],
            })),
          }
        : {}),
      containers: [
        {
          name: "agent",
          image: i.image,
          command: i.command,
          workingDir: i.cwd,
          // env now arrives from the per-run creds Secret — never inline (kubectl-visible).
          envFrom: [{ secretRef: { name: i.envFromSecret } }],
          volumeMounts: [
            { name: "workspace", mountPath: WORKSPACE_DIR },
            ...(i.promptSecret ? [{ name: "prompt", mountPath: PROMPT_MOUNT_DIR, readOnly: true }] : []),
            ...(i.skillsMount ? [{ name: "skills", mountPath: SKILLS_MOUNT_DIR }] : []),
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}
