# Personal fork maintenance

## Repository and execution boundary

- Upstream: https://github.com/chandra447/pi-hermes-memory
- Intended personal fork: https://github.com/ginoooox/pi-hermes-memory
- WSL checkout: /home/zhujn/projects/pi-hermes-memory
- Baseline: v0.9.11, commit 71cf5ab7d909318a383bf52bb3ad3cf83a9efc03.
- Development branch: personal/memory-quality.
- All editing, dependency installation, build, tests and GitHub writes run on Windows WSL. OneCloud is only the deployment target; never compile or launch another Pi/RPC instance there.
- Personal memory, sessions, credentials and host data must never enter this repository. Use synthetic fixtures only.

## Branches and remotes

`upstream` fetches the original author; its push URL is disabled. `fork` is the personal publishing destination. Keep `main` as an upstream tracking branch; personal changes belong on `personal/memory-quality`. GitHub fork creation/push requires authenticated access and must be verified before reporting publication.

## Initial implementation scope

1. Fix exact-body duplicate creation through ordinary and atomic replacement; retain scope isolation and ambiguity protection.
2. Unify manual add/replace/remove and direct/subprocess background write paths behind one admission layer.
3. Add stable identities, verified message provenance, operation idempotency and concurrency checks. Do not let the model self-certify source roles.
4. Stage automatic review/flush/correction proposals for approval; remove correction double capture. Explicit evidence-backed foreground writes may pass admission without a second confirmation.
5. Add bounded candidate retrieval including CJK support. Similarity selects candidates, never directly authorizes merging. Preserve different device/project/conditional rules.
6. Add reversible supersession and rejection tracking; default recall excludes pending/superseded entries. Keep legacy entries as unlinked sources, without inventing provenance.

## Upstream updates

1. Fetch upstream tags and inspect release notes and the diff.
2. Advance clean tracking main to upstream/main without personal commits.
3. Merge the chosen upstream commit/tag into an integration branch based on personal/memory-quality; preserve published branch history (no routine force-push).
4. Resolve conflicts and run upstream checks plus personal regression fixtures. Review any upstream publish workflow before enabling it in the fork; do not publish to the author's npm package.
5. Publish reviewed commits to the personal fork. Cut explicit personal release tags; deploy only verified artifacts with backup and rollback, pinned by commit/tag.
6. On ARMv7 retain a compatible prebuilt better-sqlite3 module only when dependency and Node ABI compatibility are verified; build changed native dependencies on Windows WSL.

## Verification gates

Exact and paraphrased duplicates, correction double capture, S0/S4 conditional separation, tentative discussion versus confirmed decision, rejected-candidate recurrence, source-role validation, stale concurrent update, Markdown/SQLite consistency, legacy migration and restore must have regression coverage. A package version or direct API test alone does not prove a running Pi loaded the change.
