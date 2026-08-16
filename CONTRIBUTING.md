# Contributing

## Contribution Expectations

- Smallest coherent change that solves the requirement
- No unrelated cleanup mixed into feature changes
- No new dependencies without justification (see the guideline's dependency discipline)
- Architecture invariants and ADRs are binding — if a change conflicts with one, say so in the PR and update the record explicitly rather than silently violating it (see [ARCHITECTURE.md](./ARCHITECTURE.md))

## Issue Workflow

Issues are optional for this project: open one for anything non-trivial or ambiguous, and link it from the PR description. Small changes may go straight to a PR with the rationale in the description.

## Pull Request Workflow

1. Branch from `main`
2. Implement; keep `mise run check` green
3. Commit messages follow Conventional Commits (validated by Cocogitto via the prek `commit-msg` hook locally, and again in CI)
4. Open a PR; CI (`ci.yml` check) must pass
5. Review, then **rebase-merge** — the repository keeps linear history; every commit on `main` is conventional and individually valid

The maintainer signs commits with SSH keys backed by 1Password; signing is welcome but not required from contributors.

## Review Expectations

Reviewers check:

- Correctness of the requested behavior
- No accidental scope creep, files, or dependencies
- Compatibility with architecture invariants and ADRs
- No sensitive information (tokens, keys, user content)

## Required Validation

```bash
mise run check
```

Until the mise tasks are merged, the equivalent direct commands: `pnpm lint && pnpm exec tsc -b --noEmit && pnpm test && pnpm format:check`.

## Commit Conventions

Conventional Commits, enforced by Cocogitto locally (prek hook) and in CI:

```text
feat(chat): add streaming response rendering
fix(auth): handle expired sessions
docs(adr): amend ADR-003 for typing renewal
```

Every rebased commit must pass `cog verify` on its own — squash fixups before merging, not after.

## AI-Assisted Pull Requests

For AI-generated or AI-assisted PRs, the description must clearly include the five fields from the [pull request template](.github/PULL_REQUEST_TEMPLATE.md):

- **Purpose**: what the change is for
- **Impact**: what is affected
- **Context**: relevant background
- **Risks**: potential concerns
- **Testing**: validation performed and its results

The GitHub pull request template stays synchronized with these five requirements.
