import type { V1Container } from "@kubernetes/client-node";

export interface CloneSpec {
  owner: string;
  repo: string;
  branch: string;
  cwd: string; // workspace mount root; repo checkout lands at <cwd>/<repo>
  runAsUser: number;
}

/**
 * Minimal clone init (locked decision #2): clone the branch shallow-ish; if the
 * branch isn't on the remote yet (build-style first run), clone the default
 * branch and cut the branch locally. Idempotent: if the PVC already holds a
 * checkout, do nothing (Plan 4 adds fetch+reset refresh + merge-base deepening).
 *
 * Auth is the github.com-scoped `http.extraheader` delivered as `GIT_CONFIG_*`
 * env from the creds Secret (agentGitIdentityEnv) — no token in any URL.
 */
export function buildCloneInitContainer(image: string, spec: CloneSpec): V1Container {
  const url = `https://github.com/${spec.owner}/${spec.repo}.git`;
  const repoDir = `${spec.cwd}/${spec.repo}`;
  // Single-quoted heredoc-free script; values are validated backend-side
  // (owner/repo/branch come from the trigger, asserted upstream). Keep it POSIX sh.
  const script = [
    "set -eu",
    `if [ -d '${repoDir}/.git' ]; then echo '[clone] existing checkout — skipping'; exit 0; fi`,
    `if git clone --branch '${spec.branch}' --depth 50 '${url}' '${repoDir}'; then`,
    `  git -C '${repoDir}' remote set-url origin '${url}'`,
    "else",
    `  echo '[clone] branch not on remote — cloning default and cutting ${spec.branch}'`,
    `  git clone --depth 50 '${url}' '${repoDir}'`,
    `  git -C '${repoDir}' checkout -B '${spec.branch}'`,
    `  git -C '${repoDir}' remote set-url origin '${url}'`,
    "fi",
  ].join("\n");
  return {
    name: "clone",
    image,
    command: ["sh", "-c"],
    args: [script],
    workingDir: spec.cwd,
    // Populated in the pod builder to share the creds Secret (GIT_CONFIG_* extraheader).
    envFrom: [],
    volumeMounts: [{ name: "workspace", mountPath: spec.cwd }],
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
  };
}
