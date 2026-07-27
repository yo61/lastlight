import { createHash } from "node:crypto";

/** Longest suffix `secretNameFor` (secret.ts) appends to a pod name:
 *  "-prompt" (7 chars). Reserve room for it (+1 margin) so a pod name at the
 *  cap never produces an invalid (>63-char) Secret name. */
const SECRET_SUFFIX_BUDGET = 8;

/** RFC-1123 label: lowercase alnum + '-', ≤63 chars, starts/ends alnum.
 *  We slug the taskId and append a short stable hash to guarantee uniqueness
 *  after truncation. Budget also reserves room for the creds/prompt Secret
 *  name suffix (see `SECRET_SUFFIX_BUDGET`), so the derived Secret name stays
 *  a valid RFC-1123 label too. */
export function podNameFor(taskId: string, phaseSuffix = "run"): string {
  const hash = createHash("sha1").update(`${taskId}/${phaseSuffix}`).digest("hex").slice(0, 8);
  const slug = `${taskId}-${phaseSuffix}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `ll-${slug}`
    .slice(0, 63 - 1 - hash.length - SECRET_SUFFIX_BUDGET)
    .replace(/-+$/g, "");
  return `${base}-${hash}`;
}

/** RFC-1123 label VALUE: `[a-zA-Z0-9._-]`, ≤63 chars. Unlike `podNameFor`'s
 *  label NAME rules this allows uppercase and `.` — but we lowercase anyway so
 *  the pod and PVC (and later the reclaim run-selector) compare byte-for-byte
 *  regardless of the source runId's casing. */
export function sanitizeLabelValue(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 63);
}
