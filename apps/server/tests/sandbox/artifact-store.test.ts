import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalArtifactBackend } from "#src/sandbox/artifact-backend.js";
import { ArtifactTooLarge, createArtifactStore } from "#src/sandbox/artifact-store.js";

/** Stage `entries` (relPath → content) under a scratch dir and tar up the
 *  `.lastlight` subtree via system `tar` — mirrors the brief's sketch. */
function buildGzTar(entries: Record<string, string>): string {
  const staging = mkdtempSync(join(tmpdir(), "ll-artifact-tar-"));
  for (const [relPath, content] of Object.entries(entries)) {
    const dest = join(staging, relPath);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, content);
  }
  const tarPath = join(staging, "bundle.tar.gz");
  execFileSync("tar", ["-czf", tarPath, "-C", staging, ".lastlight"]);
  return tarPath;
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "ll-artifacts-"));
}

describe("ArtifactStore", () => {
  it("register/resolve round-trips a token; an unknown token resolves undefined", () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend);

    const token = store.register("run-1");

    expect(store.resolve(token)).toBe("run-1");
    expect(store.resolve("not-a-real-token")).toBeUndefined();
  });

  it("unpacks a gzipped tar's .lastlight/ entries via the backend", async () => {
    const root = freshRoot();
    const backend = new LocalArtifactBackend(() => root);
    const store = createArtifactStore(backend);
    const token = store.register("run-2");

    const tarPath = buildGzTar({
      ".lastlight/pr-review/findings.json": '{"summary":"ok"}',
    });

    await store.unpack(token, createReadStream(tarPath));

    expect(readFileSync(join(root, ".lastlight/pr-review/findings.json"), "utf8")).toBe(
      '{"summary":"ok"}',
    );
  });

  it("rejects a tar entry that escapes .lastlight/ via ../", async () => {
    const root = freshRoot();
    const backend = new LocalArtifactBackend(() => root);
    const store = createArtifactStore(backend);
    const token = store.register("run-3");

    // Build an archive whose one entry is literally named "../escape.txt" —
    // tar -C into a nested dir and reference a sibling file one level above it.
    const base = mkdtempSync(join(tmpdir(), "ll-artifact-escape-"));
    const outer = join(base, "outer");
    const inner = join(outer, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, "escape.txt"), "evil");
    const tarPath = join(base, "escape.tar.gz");
    execFileSync("tar", ["-czf", tarPath, "-C", inner, "../escape.txt"]);

    await expect(store.unpack(token, createReadStream(tarPath))).rejects.toThrow();
  });

  it("throws ArtifactTooLarge when the upload body exceeds the cap", async () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend, { maxBundleBytes: 16 });
    const token = store.register("run-4");

    await expect(
      store.unpack(token, Readable.from([Buffer.alloc(1024, "a")])),
    ).rejects.toThrow(ArtifactTooLarge);
  });

  it("evict drops the token so a later resolve is undefined", () => {
    const backend = new LocalArtifactBackend(freshRoot);
    const store = createArtifactStore(backend);
    const token = store.register("run-5");

    store.evict(token);

    expect(store.resolve(token)).toBeUndefined();
  });
});
