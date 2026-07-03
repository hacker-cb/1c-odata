# Git Branches and PR Flow

Branch naming, the trunk merge model, and how multi-PR / stacked features land.
This rule owns the branch / PR-flow policy; the project's CI config owns the
literal trigger values that enforce it (§ Recommended CI triggers).

## Trunk model

- **`master ← dev`** — **merge commit** (release integration; preserves dev
  history on master).
- **`dev ← a standalone PR`** — **squash merge**: one self-contained change lands
  as one commit on `dev`.
- **`dev ← an umbrella branch`** — **merge commit**: a large multi-PR feature
  integrated atomically, preserving its per-slice commits on `dev`. The single
  exception to squash-per-PR — see § Multi-PR features.

## Branch naming

**Slices and standalone branches:** `<type>/[<issue>-]<slug>`, where `<type>` is
any [Conventional Commits](https://www.conventionalcommits.org) type — `feat`,
`fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, … — and
`<issue>` is the GitHub issue number when one exists. Examples:
`feat/420-presence-probe`, `refactor/cache-runtime-diagnostics-split`.

**Umbrella branches:** the reserved `umbrella/` prefix — `umbrella/<issue>-<slug>`
(e.g. `umbrella/417-presence-overhaul`). The parent-issue number is **mandatory**
(an umbrella always has one — § Multi-PR features). The distinct prefix is what
lets branch protection target every umbrella as a group (pattern `umbrella/**`)
with merge rules stricter than the trunk's — see § Branch protection. An umbrella
is exempt from the conventional-commit-type prefix because its branch name never
becomes a commit subject: it integrates into `dev` by merge commit, not squash.

Names stay **flat** otherwise: a slice keeps its ordinary `<type>/[<issue>-]<slug>`
name and is never nested under its umbrella's path; the parent→child link lives in
the PR base, not the branch path.

The PR title becomes its squash commit message — on `dev` for a standalone PR, on
the umbrella for a slice — so keep it conventional-commit shape:
`<type>(<scope>): summary (#NNN)`.

## Multi-PR features

A feature too large for one PR is **always** split through an **umbrella
branch** — never trickled into `dev` slice by slice. `dev` must never hold a
half-built feature, so a multi-PR feature integrates in one shot.

Two levels only — **`dev ← umbrella ← slice-PRs`**:

- The umbrella is a long-lived `umbrella/<issue>-<slug>` branch off `dev`, under
  a parent issue. It is the single `dev` integration point for the feature.
- Each slice branches off the **umbrella** and its PR targets the **umbrella**
  (override your PR tooling's default base, which defaults to the trunk). Slices
  are direct children of the umbrella — they do not stack on each other (that
  would be a third level).
- Each slice-PR **squash-merges into the umbrella** — one commit per slice.
- When the feature is complete, the umbrella **merges into `dev` with a merge
  commit**, landing every per-slice commit atomically.

A self-contained one-off still goes as a single standalone PR that squash-merges
straight into `dev` — the umbrella is only for one feature spread across PRs.

## Umbrella discipline

1. **Slices target the umbrella** — every slice-PR bases on and squash-merges
   into the umbrella, never into `dev`.
2. **A dependent slice starts from the umbrella after its dependency has merged**
   into it — slices never stack on one another. If a slice was opened before its
   dependency landed, rebase it onto the umbrella (`git rebase origin/<umbrella>`)
   rather than onto the sibling.
3. **Sync the umbrella with `dev` by merge, not rebase** — it is shared and
   published: `git merge origin/dev` absorbs trunk movement.
4. **One `dev` merge at the end** — when every slice is in, the umbrella merges
   into `dev` with a merge commit. That single merge is the only `dev` sync; no
   per-slice restack onto `dev`, ever.

## Cleanup

Enable auto-delete branch on merge: GitHub then retargets any PR still pointing
at a deleted branch to that branch's base.

## Branch protection

The naming split lets GitHub target each branch kind by pattern, but the merge
method differs by kind, so the rulesets are **not** uniform:

- **`dev`** takes both squash (standalone PRs) and merge commits (umbrella
  integration), so it **cannot** require linear history. Protect with: require a
  PR, required status checks (+ up-to-date before merge), block force-push.
- **`umbrella/**`** takes only squash merges from slices, so on top of the same
  PR + status-check rules it **also requires linear history** — making it stricter
  than `dev`, not equal to it. Squash merge must be enabled repo-wide; disable
  rebase repo-wide for true squash-only.
- **`master`** takes merge commits from `dev` — `dev`'s rules without the
  standalone-squash path.

These settings live in the repo's GitHub ruleset config, not a tracked file; this
section is the policy they encode.

## Recommended CI triggers

- **Gate every PR regardless of base** — no base-branch allow-list. A slice PR
  targets the umbrella branch, not the trunk, so a base filter would silently
  skip it.
- **Gate pushes to the trunk and umbrella branches** (`master`, `dev`,
  `umbrella/**`). An ordinary feature branch is already gated once its PR is open
  (the PR `synchronize` event), so it needs no push trigger — but an umbrella is
  long-lived and accumulates slice squash-merges while no umbrella→`dev` PR is
  open, so it gets an explicit push trigger to test each integrated state.
- **Expose `workflow_dispatch`** for manual re-runs (flaky CI / on-demand).
