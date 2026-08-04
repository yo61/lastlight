# Signed branch updates — implementation plan index

**Every commit Last Light creates with `git` in a sandbox is unsigned, and 22
of the yo61 repos reject unsigned commits on `main`.** On those repos a fix run
that merges the base branch does not unblock the PR — it blocks it permanently,
in a way no subsequent fix run can clear.

This is the mirror image of [stuck-pr-recovery](../stuck-pr-recovery/README.md).
That plan made a stuck PR recoverable and less frequent. This one covers a case
where the recovery mechanism *is itself* what gets the PR stuck.

## The case that produced this plan

`yo61/go-udap#185`, a Dependabot docs-site bump.

| Time (UTC) | Actor | Event |
|---|---|---|
| 2026-08-01 02:45:49 | `dependabot[bot]` | PR opened. Commit `505b88ae`, `verified: true` |
| 2026-08-01 15:00:48 | `yo61-lastlight[bot]` | merge commit `747b1c08` authored |
| 2026-08-01 15:02:49 | `yo61-lastlight[bot]` | pushed `747b1c08` |
| 2026-08-01 15:04:33 | `yo61-lastlight[bot]` | labelled |
| 2026-08-01 15:04:38 | `yo61-lastlight[bot]` | auto-squash-merge enabled |

The PR then sat at `mergeStateStatus: BLOCKED` with **all eight required checks
green**, `mergeable: MERGEABLE`, and zero required approvals. The blocker was
`747b1c08`:

```
verification: { verified: false, reason: "unsigned" }
author:       yo61-lastlight[bot] <yo61-lastlight[bot]@users.noreply.github.com>
committer:    yo61-lastlight[bot] <yo61-lastlight[bot]@users.noreply.github.com>
```

Dependabot's own commit on the same branch was `verified: true` — everything
Dependabot pushes goes through GitHub's API and is signed with the `web-flow`
key automatically. Only ours was unsigned.

Enabling auto-merge at 15:04:38 could never have fired. The rule that blocks is
evaluated over **every commit reachable in the PR**, not just the head, so one
unsigned commit anywhere in the branch is terminal. Recovery required
`@dependabot recreate`, which discarded the branch, opened `#187` in its place,
threw away a fully green CI run and produced a red one — the regenerated
lockfile pulled in transitive deps inside pnpm's 24h `minimumReleaseAge` window.

## Why the App token does not help

The two mechanisms are unrelated and it is easy to conflate them:

| | What it does | Where it comes from |
|---|---|---|
| **Token** | authenticates the *push* | GitHub App installation |
| **Signing key** | signs the *commit object* | `commit.gpgsign` + a private key on the machine |

A sandbox has the first and not the second. No amount of write permission makes
a locally-built commit signed. Last Light configures signing nowhere — the only
`gpgsign` settings in this repo are `tag.gpgsign` for releases.

## Where it happens

`workflows/prompts/dependabot-ci-fix.md:71` instructs the agent to run
`git fetch origin <base>` then `git merge --no-edit FETCH_HEAD` and push. Every
commit that path produces is unsigned by construction.

Note the merge itself is correct and deliberate: it makes a `behind` PR current
and regenerates lockfiles on a `dirty` conflict. The defect is the *mechanism*,
not the intent.

## Blast radius

22 repos in the `yo61` org enforce `required_signatures` on `main`, measured
live against `GET /repos/{owner}/{repo}/rules/branches/main`:

```
agent-team-topologies    civi-mcp                 claude-plugin-contributory-factors
claude-plugin-reportlab-pdf  claude-skills        choria-compose
CiviCRM_Stripe_Allow_Promotional_Codes            appbuilder
flux-homelab             gh-release-stats         github-repos
go-udap                  homebrew-tap             homelab-docs
jobhound                 kuard                    nats.py
openapi-python-client    pipx                     unifi-mcp
unifictl                 ycst-website-testing
```

Do not infer this from `github-repos` Terraform data files — `required_signatures`
arrives via the `default_branch` builtin ruleset, and the per-repo
`additional_rulesets` block sets `required_signatures: false` for its *own*
ruleset, which reads as the opposite of the truth. Query the live API.

## The fix

**Use `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` instead of a
sandbox `git merge` whenever the goal is only "make this PR current".** GitHub
performs the merge server-side, so the commit is committed by
`GitHub <noreply@github.com>` and signed with the `web-flow` key — the same path
as the UI's "Update branch" button. No key management.

**Where the goal is only to re-run CI after a transient failure, create no
commit at all:** `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`.
On `go-udap#185` the underlying failure was pnpm's `minimumReleaseAge` rejecting
a lockfile entry published within 24h — a failure that clears on its own and
needs no merge whatsoever.

## What this does not cover

`update-branch` cannot resolve conflicts; it fails on a `dirty` PR. Lockfile
regeneration still needs a sandbox, and any commit produced there is still
unsigned. On the 22 signature-enforcing repos those PRs cannot be landed by
Last Light at all — they need `@dependabot recreate` or a human. That is a
narrower gap than today's (where *every* base merge is terminal, not just the
conflicted ones), but it is not zero.

## Open question

**Should Last Light hold a signing key?** An SSH or GPG key in the sandbox with
`commit.gpgsign` would make every path work, including conflict resolution. The
cost is a key to mint, store and rotate, and a signing identity that must be
registered against the App's account for GitHub to mark it verified. Deferred
here because `update-branch` solves the common case with no key at all — but if
the `dirty`-PR gap proves to bite in practice, this is the answer.

## Verification

GitHub's REST reference for `update-branch` does not explicitly document the
signing behaviour of the commit it creates, so it was verified directly rather
than assumed. Run against `go-udap#189` and `#190` on 2026-08-04:

```
cbe3309c committer=GitHub <noreply@github.com> verified=true reason=valid
f64c7c62 committer=GitHub <noreply@github.com> verified=true reason=valid
```

Both landed as `Merge branch 'main' into <branch>`. Worth noting for anyone
auditing history later: a sandbox merge writes `Merge remote-tracking branch
'origin/main' into <branch>` instead, because `git merge origin/<base>` names
the remote-tracking ref in its default message. The two mechanisms are
distinguishable from the commit message alone.
