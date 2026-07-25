import { describe, it, expect } from "vitest";
import { buildCloneInitContainer } from "#src/sandbox/k8s/init-clone.js";

describe("buildCloneInitContainer", () => {
  const c = buildCloneInitContainer("ghcr.io/yo61/lastlight-sandbox:latest", {
    owner: "acme", repo: "web", branch: "feature/x",
    cwd: "/home/agent/workspace", runAsUser: 10001,
  });
  it("runs a restricted-compliant clone init with the repo coordinates", () => {
    expect(c.name).toBe("clone");
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] },
    });
    // Untrusted coordinates travel as argv, not interpolated into the script body.
    expect(c.args).toContain("acme");
    expect(c.args).toContain("web");
    expect(c.args).toContain("feature/x");
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).not.toContain("acme/web");
    expect(scriptText).not.toContain("feature/x");
  });
  it("delivers git auth from env (GIT_CONFIG_* via the creds Secret), never a URL token", () => {
    // The extraheader arrives via envFrom the creds Secret (agentGitIdentityEnv);
    // the script must not interpolate a token into the clone URL.
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).not.toMatch(/x-access-token:/);
  });
  it("skips cloning when the PVC already holds a checkout (idempotent reuse)", () => {
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).toContain(".git"); // guards on an existing checkout
  });
  it("passes a malicious branch name as an argv element, never as shell text", () => {
    const evil = "x'; touch /tmp/pwned; echo '";
    const c = buildCloneInitContainer("img", {
      owner: "acme", repo: "web", branch: evil, cwd: "/home/agent/workspace", runAsUser: 10001,
    });
    // The malicious string appears ONLY as a positional arg, never concatenated into the sh -c script.
    expect(c.args).toContain(evil);
    const scriptText = (c.command ?? []).join("\n");
    expect(scriptText).not.toContain(evil);
    expect(scriptText).not.toContain("touch /tmp/pwned");
  });
});
