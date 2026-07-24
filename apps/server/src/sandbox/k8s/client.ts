import { KubeConfig, CoreV1Api, Log } from "@kubernetes/client-node";

export interface K8sApis {
  core: CoreV1Api;
  log: Log;
  kc: KubeConfig;
}

/** Build the k8s clients. In-cluster by default (mounted SA token); falls back
 *  to the local kubeconfig for dev. Pass an explicit `kc` in tests. */
export function makeK8sApis(kc?: KubeConfig): K8sApis {
  const config = kc ?? loadInClusterOrDefault();
  return { core: config.makeApiClient(CoreV1Api), log: new Log(config), kc: config };
}

function loadInClusterOrDefault(): KubeConfig {
  const kc = new KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  return kc;
}
