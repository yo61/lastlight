# Dependabot pnpm release-age retry — implementation plan index

**A dependency PR fails CI, nothing is broken, and the same lockfile passes
untouched a few hours later.** pnpm 11 enforces `minimumReleaseAge` (default
1440 min) on `pnpm install --frozen-lockfile`, rejecting any lockfile entry —
including transitive ones — published inside that window. Dependabot
regenerates the lockfile on every bump, so it routinely pulls in a package
published minutes earlier.

Every retry path Last Light has today is **event-driven**: attempt N+1 happens
when `pr.checks_failed` fires again after our push. Nothing pushes here, and no
event fires when a clock passes. That is the gap this plan fills.

Requirement deferred here by
[`yo61/go-udap` decision 2026-07-25](https://github.com/yo61/go-udap/blob/main/decisions/2026-07-25-defer-dependabot-pnpm-retry-to-lastlight.md),
which chose Last Light over a per-repo workflow because the concern is
fleet-wide and event-driven. That decision recorded this document's path; the
document had not been written, and `go-udap#187` hit the same wall on
2026-08-04 as a result.

## The failure

From `go-udap#187`, run `30897608148`:

```
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 2 lockfile entries failed verification:
  baseline-browser-mapping@2.11.12 was published at 2026-08-03T16:28:56.000Z,
    within the minimumReleaseAge cutoff (2026-08-03T09:44:20.214Z)
  nanoid@3.3.17 was published at 2026-08-03T10:25:17.000Z,
    within the minimumReleaseAge cutoff (2026-08-03T09:44:20.214Z)
```

The exit is a plain `exit code 1` on the install step. The PR's other checks
pass; only `build` (and anything else running an install) fails.

## Why Dependabot's own cooldown does not prevent it

`cooldown` in `dependabot.yml` gates the **direct** bump targets. These failures
come from **transitively re-resolved** dependencies, which `cooldown` does not
govern. On `go-udap#176` the direct deps Dependabot bumped were 8–10 days old
and correctly gated; the breakage was a coordinated `@radix-ui/*` release
(~31 packages) published about three hours earlier and pulled in by
re-resolution. Raising `cooldown` cannot reach them.

## No existing diagnosis class fits

`DIAGNOSIS_CLASSES` (`packages/shared/src/config-types.ts:43`):

| Class | Why it is wrong here |
|---|---|
| `reproducible` | It *is* reproducible, but the class means "a real defect to fix" and routes the agent at the lockfile — the one action that makes it worse |
| `env-mismatch` | Not an environment difference; CI and local agree exactly |
| `flaky` | Perfectly deterministic, and `flaky` retries immediately, which fails again |
| `infra-dependent` | Costs an attempt and escalates to a human, who can only wait |
| `upstream-broken` | Closest semantically — not this PR's fault, self-heals, attempt-free — but it is detected from `baseChecksState` (base is red), which is false here, and it waits for a base-goes-green event that never fires |

`ATTEMPT_FREE_CLASSES` (`apps/server/src/engine/fix-markers.ts:69`) currently
holds `flaky` and `upstream-broken`. Whatever class this becomes belongs there
too: waiting for a clock must not consume a fix attempt.

## The clear time is computable — do not guess or poll

The error prints both the publish timestamp and the cutoff, and the cutoff is
`runStartedAt - minimumReleaseAge`. So the window is derivable from the log
alone, with no npm registry query:

```
minimumReleaseAge = runStartedAt - cutoff
retryAt           = max(published_at over all violating entries) + minimumReleaseAge
```

Worked from the run above:

```
runStartedAt      = 2026-08-04T09:44:20Z
cutoff            = 2026-08-03T09:44:20Z   ->  minimumReleaseAge = 24h
max(published_at) = 2026-08-03T16:28:56Z   (baseline-browser-mapping)
retryAt           = 2026-08-04T16:28:56Z
```

One scheduled retry at `retryAt` + a small margin. Not a fixed backoff, not a
daily sweep, not polling — the answer is in the log.

## Proposal

1. **Detect** `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` in the failed job log and
   parse the entry lines into `{name, version, publishedAt, cutoff}`.
2. **Classify** as a new attempt-free class — `time-gated` — carrying `retryAt`.
   It is distinct from every existing class in exactly one way that matters: the
   wake-up is *scheduled*, not awaited.
3. **Schedule** a single wake-up at `retryAt + margin`.
4. **Act** with `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`.
   That needs `actions: write`, which the go-udap decision already anticipated.

No commit, no push, no sandbox.

## What must not happen

- **Do not regenerate the lockfile.** Re-resolution pulls whatever is newest,
  which can be younger than what failed — restarting the clock instead of
  clearing it. `go-udap#185` → `#187` demonstrates this: `@dependabot recreate`
  discarded a fully green run and produced one failing on two *different*
  fresh packages.
- **Do not merge the base branch.** It creates an unsigned commit, which is
  terminal on the 22 yo61 repos enforcing `required_signatures`. See
  [signed-branch-updates](../signed-branch-updates/README.md).
- **Do not set `minimumReleaseAge: 0` in CI.** It discards pnpm 11's
  supply-chain protection to work around a delay that resolves itself. Rejected
  explicitly in the go-udap decision.

## Open questions

1. **Where does the scheduled wake-up live?** The existing retry loop is
   webhook-driven and the crons are fixed-schedule sweeps. A one-shot timer at
   an arbitrary computed timestamp is a shape neither provides today. Reusing
   the daily `fix-red-dependency-prs` cron would work with up to ~24h of extra
   latency and no new machinery — probably the right first version.
2. **What margin?** `retryAt` is exact, but the runner's clock and npm's
   publish timestamp are not the same source. A few minutes is likely enough.
3. **What bounds it?** If a rerun at `retryAt` fails again on a *different*
   fresh package the PR could ping-pong. A cap on consecutive `time-gated`
   reruns, after which it escalates normally, keeps that finite.
4. **Does this generalise?** npm's `minimumReleaseAge` is pnpm-specific today,
   but the shape — deterministic failure with a computable expiry — is not.
   Worth naming the class for the shape rather than the tool.
