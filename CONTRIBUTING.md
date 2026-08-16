# Contributing

Thanks for wanting to contribute. This document covers how changes land.
Development setup lives in [DEVELOPMENT.md](./DEVELOPMENT.md); rules for AI agents live in [AGENTS.md](./AGENTS.md).

## Ground Rules

- Smallest coherent change that solves the requirement
- No unrelated cleanup mixed into feature changes
- No new dependencies without justification (see the guideline's dependency discipline)
- Architecture invariants and ADRs are binding — if a change conflicts with one, supersede the record explicitly in the PR rather than silently violating it

## Reporting a Bug

Issue-first: open an issue with a reproduction before opening a PR.

- Search existing issues first
- Include a minimal reproduction and what you expected instead
- Include log lines when available (structured JSON — redact tokens; never paste DM content)

## Proposing a Feature

Discuss before implementing: open an issue describing the use case and collect feedback before writing code. Changes that touch an invariant (see [ARCHITECTURE.md](./ARCHITECTURE.md)) or a wire-contract type should sketch the contract change in the issue.

## Pull Request Workflow

1. Branch from `main`
2. Implement; keep `mise run check` green
3. Commit messages follow Conventional Commits (validated by Cocogitto via the prek `commit-msg` hook locally, and again in CI)
4. Open a PR; CI (`ci.yml`) must pass
5. Review, then **squash-merge** — one commit per PR keeps history linear (squash-only is enforced by the repo settings and the default-branch ruleset; other merge methods are disabled)

The PR title must also follow Conventional Commits — CI validates it with `cog verify`, and it becomes the squash commit title on `main`. Expect review within a few days. The maintainer signs commits with SSH keys backed by 1Password; signing is welcome but not required.

## Review Expectations

Reviewers check:

- Correctness of the requested behavior
- No accidental scope creep, files, or dependencies
- Compatibility with architecture invariants and ADRs
- No sensitive information (tokens, keys, user content)

## Commit Conventions

Conventional Commits, enforced by Cocogitto locally and in CI:

```text
feat(chat): add streaming response rendering
fix(auth): handle expired sessions
docs(adr): amend ADR-003 for typing renewal
```

The squash commit that lands on `main` is titled with the PR title and detailed with the PR's commit messages — keep each commit message informative because together they form the squash body.

## AI-Assisted Pull Requests

AI-generated or AI-assisted PRs are welcome under the same standard.
The description must clearly include:

- **Purpose**: what the change is for
- **Impact**: what is affected
- **Context**: relevant background
- **Risks**: potential concerns
- **Testing**: validation performed and its results

Label AI-assisted PRs with the `ai-assisted` label.

Keep the GitHub pull request template synchronized with these five requirements.
