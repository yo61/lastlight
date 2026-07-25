import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { RUN_ID_LABEL } from "./pod.js";

/** Stable per-(repo,PR) claim name — NO run/phase hash, so pods reuse it. */
export function pvcNameFor(taskId: string): string {
  const slug = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `ws-${slug}`.slice(0, 63).replace(/-+$/g, "");
}

export function buildPvcManifest(i: {
  name: string; namespace: string; storageClassName: string; size: string;
  /** Sanitized run id (see `kubernetes-sandbox.ts`); when set, stamped as the
   *  `RUN_ID_LABEL` so `reclaimSandbox` (Plan 5) can select this run's PVC. */
  runId?: string;
}): V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: i.name, namespace: i.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "lastlight",
        "lastlight.io/component": "workspace",
        ...(i.runId ? { [RUN_ID_LABEL]: i.runId } : {}),
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      storageClassName: i.storageClassName,
      resources: { requests: { storage: i.size } },
    },
  };
}
