import type { V1Secret, V1OwnerReference } from "@kubernetes/client-node";

export function buildSecretManifest(i: {
  name: string;
  namespace: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
}): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: { "app.kubernetes.io/managed-by": "lastlight", ...(i.labels ?? {}) },
    },
    // stringData: k8s base64-encodes on write; keeps the builder plaintext-simple.
    stringData: i.data,
  };
}

/** Cascade-GC ref: when the Pod is deleted, k8s GCs the owned Secret. */
export function podOwnerReference(podName: string, podUid: string): V1OwnerReference {
  return {
    apiVersion: "v1",
    kind: "Pod",
    name: podName,
    uid: podUid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

export function secretNameFor(podName: string, kind: "creds" | "prompt"): string {
  return `${podName}-${kind}`; // podNameFor reserves an 8-char budget for this suffix
}
