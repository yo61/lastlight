import { createHash } from "node:crypto";

/** RFC-1123 label: lowercase alnum + '-', ≤63 chars, starts/ends alnum.
 *  We slug the taskId and append a short stable hash to guarantee uniqueness
 *  after truncation. */
export function podNameFor(taskId: string, phaseSuffix = "run"): string {
  const hash = createHash("sha1").update(`${taskId}/${phaseSuffix}`).digest("hex").slice(0, 8);
  const slug = `${taskId}-${phaseSuffix}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `ll-${slug}`.slice(0, 63 - 1 - hash.length).replace(/-+$/g, "");
  return `${base}-${hash}`;
}
