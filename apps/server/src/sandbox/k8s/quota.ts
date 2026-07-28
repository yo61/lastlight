import { ApiException } from "@kubernetes/client-node";

/**
 * Thrown by the pod-create path when the namespace `ResourceQuota` rejects the
 * Pod (`403 ... exceeded quota ...`). Distinct from every other create failure
 * so the orchestrator can stamp a `stopReason: "error_quota"` and the workflow
 * layer can treat it as BACKPRESSURE (requeue + retry) instead of a hard fail.
 * design.md §8: the cluster's quota is the concurrency authority.
 */
export class QuotaExceededError extends Error {
  override readonly name = "QuotaExceededError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * True iff `err` is a k8s `403` produced by the ResourceQuota admission plugin.
 * That plugin emits two phrasings, both of which are the quota rejecting the
 * create and both of which we treat as backpressure:
 *  - over the limit — `... is forbidden: exceeded quota: <name>, requested: ...`
 *  - missing a metered field — `... is forbidden: failed quota: <name>: must
 *    specify requests.cpu, ...` (fires when a compute quota exists but the pod
 *    declares no request/limit for a tracked resource). Sandbox pods now set
 *    resource requests (`pod.ts`), so this form shouldn't originate from us —
 *    matching it is defence-in-depth so such a rejection re-queues (bounded by
 *    the queue TTL) rather than hard-failing the run.
 */
export function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof ApiException) || err.code !== 403) return false;
  const body = err.body as { message?: string } | undefined;
  const text = `${body?.message ?? ""} ${err.message ?? ""}`;
  return /(?:exceeded|failed) quota/i.test(text);
}
