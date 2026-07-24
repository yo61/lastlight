import type { V1Pod } from "@kubernetes/client-node";

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
        seccompProfile: { type: "RuntimeDefault" },
      },
      volumes: [{ name: "workspace", emptyDir: {} }],
      containers: [
        {
          name: "agent",
          image: i.image,
          command: i.command,
          workingDir: i.cwd,
          // env now arrives from the per-run creds Secret — never inline (kubectl-visible).
          envFrom: [{ secretRef: { name: i.envFromSecret } }],
          volumeMounts: [{ name: "workspace", mountPath: i.cwd }],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
        },
      ],
    },
  };
}
