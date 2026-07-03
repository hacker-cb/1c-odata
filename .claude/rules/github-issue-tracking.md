# GitHub issue tracking

Single source of truth for how deferred work is tracked. This body is identical
across repos — each repo's concrete labels and project-specific notes live in
`.github/labels.yml`, and the repo's milestones live in GitHub itself
(§ Milestones — phase ordering).

GitHub Issues track **deferred, forward-looking work** — bugs, tech-debt, and
follow-ups found in passing or consciously left for later. The backlog is a to-do
list, **not a log of everything shipped**: work conceived and finished in one effort
is already recorded by its PR and `git log`, so it gets no issue. Large, open-ended
architectural direction belongs in the project's roadmap, not the backlog.

## Classification — label families

Issues are classified by label families. This rule owns the family *policy* — what
each family means and when to apply it; `.github/labels.yml` owns each label's
literal name, color, description, and any project-specific notes.

- **`type:*`** — the kind of work, **exactly one** (epics included; an epic takes
  its children's dominant type):
  - `type:feature` — a capability that doesn't exist yet.
  - `type:bug` — shipped behaviour deviates from spec / docs / intent, including
    latent defects.
  - `type:tech-debt` — internal quality (refactor, dedup, hygiene); no new capability.

  Orthogonal to `awaits:*`: a deliberately deferred gap stays `type:bug`, and the
  deferral reason lives in `awaits:*`.
- **Component** — **at least one**, naming where the work lands. The labels' prefix
  and members live in `.github/labels.yml`; apply those whose directories the diff
  actually touches. Cross-component pairs are normal; three or more is a signal to
  decompose. Docs follow their subject.
- **`awaits:*`** — **at most one**; the value names the pending trigger that should
  reopen attention — a design decision, an upstream release, or a project-specific
  dependency — with the full set in `.github/labels.yml`. **Absence = ready to pick up.**
- **`priority:*`** — optional urgency lane (`high` / `low`); **at most one, absence =
  normal.** Orthogonal to `awaits:*` — a parked issue keeps its priority for when the
  trigger fires.
- **`security`** — optional property flag on top of any component (hardening, authz,
  supply-chain).

**Invariant** (review-enforced): exactly one `type:*` · at least one component label ·
at most one `awaits:*` · at most one `priority:*` · optional `security`.

Each label's literal color/description is applied by the label-sync workflow with
`skip-delete: true`, so labels outside these families stay untouched.

**Standing queries:** ready to pick up = open with no `awaits:*`; design agenda =
`label:"awaits:design"`.

## Milestones — phase ordering

Labels say what an issue *is*; a milestone says *when it lands* relative to the
project's next deliverable. Use milestones when the backlog needs an
ordering coarser than `priority:*` but firmer than a roadmap — a typical arc:
architecture rework → release features → pre-release hardening.

- **A milestone is a phase with an exit criterion, not a category.** Its
  description states that criterion — "what must be true to close this"; an issue
  joins a milestone only if the phase cannot close without it. Issues in no
  milestone are backlog-at-large — the default, not an anomaly.
- **Naming:** `M<n>[.<m>]: <phase>` — a sequence number for sort order plus a
  short phase name (e.g. `M1: Architecture`, `M2: Feature complete`). The number
  orders the lanes, the name carries the meaning; it is not a version and encodes
  no dates. The optional second level slots an emergent phase between existing
  lanes (`M1.5: Tooling catch-up`) without renumbering them.
- **Keep them few — 2–4 open.** More means the backlog is simulating a roadmap.
  When the exit criterion holds, close the milestone and re-triage leftovers into
  the next lane explicitly — no silent carry-over.
- **Orthogonal to labels:** `awaits:*` still names why an issue is parked and
  `priority:*` still orders work inside a lane; a milestone replaces neither.
- **Tooling:** the `gh` CLI has no first-class milestone command — create/edit via
  `gh api repos/{owner}/{repo}/milestones`; assign with
  `gh issue edit <n> --milestone "<title>"`.

## Issue shape

The agent creates issues via the API, so the convention lives here:

- **Title** — concise summary.
- **Body** — **what's deferred** (code IDs / paths verbatim) · **trigger** (the
  condition that should reopen attention) · **source** (`file:line` / PR `#N` /
  audit date).

Issue text — titles, bodies, comments — uses the project's preferred language for
issues; if no rule states it, match the language of the most recent issue. Code
identifiers and paths stay verbatim. GitHub assigns the number. Multi-part work
becomes a parent issue with native GitHub **sub-issues**, one per independent slice;
the parent carries its own ordinary `type:*`. Filter parents with `has:sub-issue`,
children with `parent-issue:owner/repo#N`, top-level with `no:parent-issue`.

## Surfacing deferred work

The backlog keeps work you're **not** doing now from being lost — a problem or
follow-up discovered mid-task, or pre-existing work someone chose to defer. First
search open issues — the finding may already be tracked. Then surface it at the end
of the response under `## Drive-by observations`:

- **Untracked** → `<component> — short description`; ask **OPEN / DEFER / DISMISS**.
- **Tracked, but the find adds something** (new facts, wider scope, changed trigger)
  → `#N — what changes`; ask **UPDATE #N / DEFER / DISMISS**.
- **Tracked as-is** → no list entry; mention it inline (`already tracked under #N`).

Surface each finding for the user to decide; their call opens or updates it, with the
label families above applied on **OPEN**. An issue tracks work left for later; work
finished in the same effort is recorded by its PR and `git log`.

At the natural end of a session — primary task done and shipped — re-surface any
still-undecided observations so they aren't lost with the session.

## Consulting open issues

Open issues are context, not just a to-do list — consult them at three moments:

- **Before a substantive task** — a multi-file change, new feature, or refactor (not
  typo fixes, single-file bugfixes, dep bumps, or quick factual questions): search for
  one that covers the work. **Covered** → reference it in the PR title/body and add
  `Closes #N`. **Not covered** → do the work; open an issue only if you defer something
  along the way (§ Surfacing deferred work).
- **When a discussion lands on a topic** — a design question, problem analysis,
  "should we X?": search that area and bring the relevant issues into the conversation
  (`this overlaps #N`) — they hold prior decisions, triggers, and deferred scope.
- **When the user asks what to tackle next** — surface open issues with reasoning
  instead of picking one; an `awaits:*` issue waits for its trigger to fire before it's
  started.

## Referencing issues & PRs

Cite by a bare `#N` — issues and PRs share one numbering and context disambiguates;
GitHub auto-links it. Where a bare `#N` would not auto-link (rustdoc, Markdown read
outside its issue/PR context), make it a link with `#N` as the visible text:
`[#N](<url>)`; external trackers use a full URL. GitHub-native text — commit and
PR/issue bodies — keeps the bare form (`Closes #N`).

## After shipping

`Closes #N` in the merged PR body closes the issue — the **closed-issue list is the
shipped journal**, so there is nothing to hand-maintain. For an umbrella, close each
sub-issue as its slice ships and the parent when the last one does. Follow-ups the PR
raised become new issues opened in the same effort.
