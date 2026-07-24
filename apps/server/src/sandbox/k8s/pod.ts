import type { V1Pod } from "@kubernetes/client-node";

export interface PodSpecInput {
  name: string;
  namespace: string;
  image: string;
  command: string[];
  env: Record<string, string>;
  cwd: string;
  activeDeadlineSeconds: number;
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
      volumes: [{ name: "workspace", emptyDir: {} }],
      containers: [
        {
          name: "agent",
          image: i.image,
          command: i.command,
          workingDir: i.cwd,
          env: Object.entries(i.env).map(([name, value]) => ({ name, value })),
          volumeMounts: [{ name: "workspace", mountPath: i.cwd }],
        },
      ],
    },
  };
}
