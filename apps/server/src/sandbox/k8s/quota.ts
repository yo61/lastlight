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

/** True iff `err` is a k8s `403` whose message names an exceeded quota. */
export function isQuotaExceeded(err: unknown): boolean {
  if (!(err instanceof ApiException) || err.code !== 403) return false;
  const body = err.body as { message?: string } | undefined;
  const text = `${body?.message ?? ""} ${err.message ?? ""}`;
  return /exceeded quota/i.test(text);
}
