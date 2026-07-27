import { createReadStream, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { ArtifactBackend } from "./artifact-backend.js";

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const LASTLIGHT_PREFIX = `.lastlight${sep}`;

/** Thrown by `unpack` when the uploaded bundle exceeds `maxBundleBytes`. Route
 *  handlers should map this to HTTP 413. */
export class ArtifactTooLarge extends Error {
  constructor(maxBytes: number) {
    super(`artifact bundle exceeds the ${maxBytes}-byte cap`);
    this.name = "ArtifactTooLarge";
  }
}

/**
 * Harness-owned authority over a run's `.lastlight/` artifacts. Sits above the
 * `ArtifactBackend` (Task 1): it mints the per-run bearer token a sandbox pod
 * presents, enforces the upload size cap, and guards every extracted tar entry
 * before handing bytes to the backend.
 */
export interface ArtifactStore {
  /** Register a run's upload target; returns the per-run artifact token the pod
   *  presents. `runKey` keys the backend namespace. */
  register(runKey: string): string;
  /** Resolve a bearer token to its runKey (or undefined → the route 401s). */
  resolve(token: string): string | undefined;
  /** Stream a gzipped-tar upload body into the run's namespace via the backend,
   *  enforcing the size cap + per-entry traversal guards. Throws on cap/traversal. */
  unpack(token: string, body: Readable): Promise<void>;
  /** Drop a run's token (called on dispose) — the bytes are GC'd separately. */
  evict(token: string): void;
  /** GC a run's artifacts (backend.remove) — called on run completion. */
  gc(runKey: string): Promise<void>;
}

/**
 * In-memory token→runKey registry. Mirrors `SkillBundleRegistry`
 * (`k8s/skill-bundle.ts`): `randomUUID` token, lazy TTL (an expired entry is
 * only dropped the next time it's looked up), explicit `evict` as the primary
 * reclaim path.
 */
class TokenRegistry {
  private readonly entries = new Map<string, { runKey: string; expires: number }>();

  constructor(private readonly ttlMs: number) {}

  register(runKey: string): string {
    const token = randomUUID();
    this.entries.set(token, { runKey, expires: Date.now() + this.ttlMs });
    return token;
  }

  resolve(token: string): string | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.entries.delete(token);
      return undefined;
    }
    return entry.runKey;
  }

  evict(token: string): void {
    this.entries.delete(token);
  }
}

/** Read `body` into memory, throwing `ArtifactTooLarge` the moment the running
 *  total crosses `maxBytes` (stops reading immediately — the for-await loop's
 *  early exit destroys the underlying stream). */
async function readCapped(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) {
      throw new ArtifactTooLarge(maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Extract stderr text from an `execFileSync` failure, falling back to the
 *  error's own message. */
function execErrorDetail(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString("utf8").trim();
    if (typeof stderr === "string") return stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract a gzipped tar buffer into `destDir` via system `tar` (no npm dep —
 * matches `skill-bundle.ts`'s style). Both GNU tar and bsdtar refuse to
 * extract entries whose name contains `..` (or an absolute path), exiting
 * non-zero — that's the first traversal guard, before the store's own
 * `.lastlight/`-prefix check ever runs.
 */
function extractTar(tarBuffer: Buffer, destDir: string): void {
  try {
    execFileSync("tar", ["-xzf", "-", "-C", destDir], { input: tarBuffer });
  } catch (err) {
    throw new Error(`artifact bundle extraction failed: ${execErrorDetail(err)}`);
  }
}

/** Recursively collect file paths under `dir`, relative to `base`. */
function listExtractedFiles(base: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listExtractedFiles(base, abs));
    } else if (entry.isFile()) {
      out.push(relative(base, abs));
    }
  }
  return out;
}

/** Reject any extracted entry that doesn't land under `.lastlight/` — the only
 *  tree a bundle is allowed to contribute to a run's artifact namespace. */
function assertUnderLastlight(relPath: string): void {
  if (!relPath.startsWith(LASTLIGHT_PREFIX)) {
    throw new Error(`artifact bundle entry outside .lastlight/: ${relPath}`);
  }
}

/**
 * Unpack one upload: size-capped read → extract to a scratch dir → per-entry
 * `.lastlight/`-prefix guard → `backend.put` each file → scratch dir removed.
 * Validates every entry before `put`-ing any of them, so a bundle with one bad
 * entry lands nothing.
 */
async function unpackBundle(
  backend: ArtifactBackend,
  runKey: string,
  body: Readable,
  maxBundleBytes: number,
): Promise<void> {
  const tarBuffer = await readCapped(body, maxBundleBytes);
  const extractDir = mkdtempSync(join(tmpdir(), "ll-artifact-"));
  try {
    extractTar(tarBuffer, extractDir);
    const relPaths = listExtractedFiles(extractDir, extractDir);
    for (const relPath of relPaths) assertUnderLastlight(relPath);
    for (const relPath of relPaths) {
      await backend.put(runKey, relPath, createReadStream(join(extractDir, relPath)));
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

export function createArtifactStore(
  backend: ArtifactBackend,
  opts?: { maxBundleBytes?: number; ttlMs?: number },
): ArtifactStore {
  const maxBundleBytes = opts?.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES;
  const registry = new TokenRegistry(opts?.ttlMs ?? DEFAULT_TTL_MS);

  return {
    register(runKey) {
      return registry.register(runKey);
    },
    resolve(token) {
      return registry.resolve(token);
    },
    evict(token) {
      registry.evict(token);
    },
    async unpack(token, body) {
      const runKey = registry.resolve(token);
      if (!runKey) throw new Error(`unknown artifact token`);
      await unpackBundle(backend, runKey, body, maxBundleBytes);
    },
    async gc(runKey) {
      await backend.remove(runKey);
    },
  };
}
