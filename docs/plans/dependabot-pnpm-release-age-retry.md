# Requirement: auto-retry Dependabot PRs blocked by pnpm's minimum-release-age

Status: **idea / not yet planned** · Raised: 2026-07-25 · Origin: yo61/go-udap PR #176

## Problem

pnpm 11 enables a supply-chain policy by default: **`minimumReleaseAge: 1440`
(24h)**. `pnpm install --frozen-lockfile` in CI rejects any lockfile entry —
including **transitive** deps — whose version was published less than 24h ago
(`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`).

Dependabot regenerates the lockfile when it opens a PR and re-resolves the whole
tree to the newest matching versions. When an upstream ships a coordinated
release (e.g. `@radix-ui/*` publishes ~40 packages at once) within 24h of
Dependabot's run, those fresh transitive deps land in the lockfile and CI fails —
even though the direct deps Dependabot bumped are old enough.

Dependabot's own `cooldown` setting does **not** help: it gates only the packages
Dependabot explicitly bumps (direct deps), never the transitively re-resolved
tree. There is no Dependabot knob for transitive-dependency age.

The lockfile is not wrong — it is *early*. The identical bytes pass CI once the
offending packages cross the 24h mark. So the fix is purely temporal: wait, then
re-run.

### Canonical reproduction

go-udap PR #176 (docs/site npm group bump). The `build` job failed with 31
`@radix-ui/*` entries published `2026-07-24T23:51Z`, ~3h before the PR opened.
A re-run after `2026-07-25T23:51Z` passes unchanged. See
`decisions/2026-07-25-defer-dependabot-pnpm-retry-to-lastlight.md` in go-udap.

## Why lastlight

Last Light already ingests GitHub webhooks, routes events → skills
deterministically, operates across all its managed repos via one GitHub App, and
has cron scheduling. That makes it the natural, **cross-repo** home for this —
one skill covers every managed repo, current and future. This is why go-udap did
**not** add a per-repo GitHub Actions workflow: the concern is org-wide and
belongs in the shared control plane, not copied into each repo.

## Proposed skill (sketch — validate against the harness before building)

New skill under `apps/server/skills/dependabot-release-age-retry/SKILL.md`.

- **Trigger:** a CI-completion webhook (`workflow_run` / `check_run` /
  `check_suite`, `conclusion: failure`) on a PR authored by `dependabot[bot]`.
  Confirm which event the router already surfaces and carries the head PR.
- **Detect precisely:** fetch the failed job log(s) and confirm the failure is
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` **and nothing else failed for another
  reason**. Never re-run a genuinely broken build — that would mask real
  failures.
- **Compute the clear time:** the log lists each flagged package's publish time
  and the policy cutoff. Earliest safe re-run = `max(publish time of flagged
  packages) + minimumReleaseAge`. Parse it from the log rather than assuming 24h.
- **Act:** if the window has already cleared, re-run the failed jobs immediately
  (`gh run rerun <run-id> --failed`, or the Actions API — needs `actions: write`).
  Otherwise schedule the re-run for just after the clear time using lastlight's
  scheduler.
- **Guardrails:**
  - Only `dependabot[bot]` PRs.
  - Only when release-age is the *sole* failure cause.
  - Cap attempts (e.g. give up after N re-runs or M days) to avoid loops.
  - Leave a short PR comment / log line for visibility on why a re-run happened.

## Open questions

- Which webhook event is the cleanest trigger, and does the router already map it?
- How does lastlight schedule a *delayed* one-shot action (its cron is recurring)?
  Does it need a "wake at timestamp T" primitive, or is polling on the triage
  cron acceptable?
- Does the GitHub App installation grant `actions: write` on managed repos?
- Is there already a re-run / dispatch capability in the harness to reuse?

## Non-goals

- Changing pnpm's policy or opting out of `minimumReleaseAge` — the 24h window is
  wanted; we work *with* it.
- Touching Dependabot `cooldown` — proven not to reach the transitive deps.
