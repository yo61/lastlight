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
    const script = (c.command ?? []).join(" ") + " " + (c.args ?? []).join(" ");
    expect(script).toContain("github.com/acme/web");
    expect(script).toContain("feature/x");
  });
  it("delivers git auth from env (GIT_CONFIG_* via the creds Secret), never a URL token", () => {
    // The extraheader arrives via envFrom the creds Secret (agentGitIdentityEnv);
    // the script must not interpolate a token into the clone URL.
    const script = (c.args ?? []).join(" ");
    expect(script).not.toMatch(/x-access-token:/);
  });
  it("skips cloning when the PVC already holds a checkout (idempotent reuse)", () => {
    const script = (c.args ?? []).join(" ");
    expect(script).toContain(".git"); // guards on an existing checkout
  });
});
