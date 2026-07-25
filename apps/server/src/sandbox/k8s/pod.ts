import type { V1Container, V1Pod } from "@kubernetes/client-node";

export const PROMPT_MOUNT_DIR = "/lastlight";
export const PROMPT_FILE = `${PROMPT_MOUNT_DIR}/prompt`;

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
  /** PVC-backed (per-(repo,PR), pre-cloned by an initContainer) or emptyDir
   *  (ephemeral, no pre-clone) workspace — design B (docs/plans/kubernetes-sandbox-backend). */
  workspace: { kind: "pvc"; claimName: string } | { kind: "emptyDir" };
  /** Runs before the "agent" container — currently just the minimal git clone
   *  (Task 5). Each gets the creds Secret's `envFrom` attached here so it
   *  shares the main container's `GIT_CONFIG_*` git auth. */
  initContainers?: V1Container[];
}

export function buildPodManifest(i: PodSpecInput): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: { "app.kubernetes.io/managed-by": "lastlight", "lastlight.io/component": "sandbox" },
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
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [
        i.workspace.kind === "pvc"
          ? { name: "workspace", persistentVolumeClaim: { claimName: i.workspace.claimName } }
          : { name: "workspace", emptyDir: {} },
        ...(i.promptSecret
          ? [{ name: "prompt", secret: { secretName: i.promptSecret, items: [{ key: "prompt", path: "prompt" }] } }]
          : []),
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
