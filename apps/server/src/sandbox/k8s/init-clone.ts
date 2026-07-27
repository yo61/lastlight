import type { V1Container } from "@kubernetes/client-node";

export interface CloneSpec {
  owner: string;
  repo: string;
  branch: string;
  cwd: string; // workspace mount root; repo checkout lands at <cwd>/<repo>
  runAsUser: number;
}

// A fixed script — untrusted values (owner/repo/branch/cwd) arrive as
// positional args ($1..$4), NEVER interpolated into shell text, so a branch
// name containing shell metacharacters cannot break out. `--` before the
// URL/dir positionals blocks flag-smuggling on a value starting with `-`.
const CLONE_SCRIPT = [
  "set -eu",
  'owner="$1"; repo="$2"; branch="$3"; ws="$4"',
  'repo_dir="$ws/$repo"',
  'url="https://github.com/$owner/$repo.git"',
  'if [ -d "$repo_dir/.git" ]; then echo "[clone] existing checkout — skipping"; exit 0; fi',
  'if git clone --branch "$branch" --depth 50 -- "$url" "$repo_dir"; then',
  '  git -C "$repo_dir" remote set-url origin "$url"',
  "else",
  '  echo "[clone] branch not on remote — cloning default and cutting $branch"',
  '  git clone --depth 50 -- "$url" "$repo_dir"',
  '  git -C "$repo_dir" checkout -B "$branch"',
  '  git -C "$repo_dir" remote set-url origin "$url"',
  "fi",
].join("\n");

/**
 * Minimal clone init (locked decision #2): clone the branch shallow-ish; if the
 * branch isn't on the remote yet (build-style first run), clone the default
 * branch and cut the branch locally. Idempotent: if the PVC already holds a
 * checkout, do nothing (Plan 4 adds fetch+reset refresh + merge-base deepening).
 *
 * Auth is the github.com-scoped `http.extraheader` delivered as `GIT_CONFIG_*`
 * env from the creds Secret (agentGitIdentityEnv) — no token in any URL.
 *
 * owner/repo/branch/cwd are NOT validated upstream (branch is the PR head ref,
 * attacker-named for external pr-review/pr-fix PRs) — so they're passed as
 * positional args to a fixed script rather than interpolated into shell text.
 * `sh -c CLONE_SCRIPT sh <owner> <repo> <branch> <cwd>` binds argv to
 * `$1`..`$4` at exec time, immune to quote-breaking regardless of characters.
 */
export function buildCloneInitContainer(image: string, spec: CloneSpec): V1Container {
  return {
    name: "clone",
    image,
    command: ["sh", "-c", CLONE_SCRIPT],
    args: ["sh", spec.owner, spec.repo, spec.branch, spec.cwd],
    workingDir: spec.cwd,
    // Populated in the pod builder to share the creds Secret (GIT_CONFIG_* extraheader).
    envFrom: [],
    volumeMounts: [{ name: "workspace", mountPath: spec.cwd }],
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
  };
}
