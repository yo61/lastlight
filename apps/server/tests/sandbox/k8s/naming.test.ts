import { describe, it, expect } from "vitest";
import { podNameFor } from "#src/sandbox/k8s/naming.js";

describe("podNameFor", () => {
  it("produces an RFC-1123 label ≤63 chars", () => {
    const name = podNameFor("MyRepo/PR#12_build-ABCDEF", "run");
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith("ll-")).toBe(true);
  });
  it("is deterministic for the same input", () => {
    expect(podNameFor("t", "run")).toBe(podNameFor("t", "run"));
  });
  it.each([
    ["empty string", ""],
    ["symbol-only", "###/@@@"],
    ["over-63-char taskId", "x".repeat(200)],
  ])("produces a valid RFC-1123 label for %s", (_label, taskId) => {
    const name = podNameFor(taskId, "run");
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});
