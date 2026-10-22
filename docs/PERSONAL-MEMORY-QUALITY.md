# Personal memory quality — 0.9.11-personal.1

This release is based on upstream v0.9.11. It preserves the Markdown/SQLite storage layout and adds an admission ledger to extension-managed memory mutations. It introduces no resident service and no vector database.

## What changes

- All production MemoryStore add/addFailure/replace/remove/atomic-plan paths share admission inside the existing Markdown mutation lock.
- Automatic review, correction, compaction and shutdown extraction propose candidates. Pending candidates never enter active Markdown or SQLite recall. In-process completion is required; the personal fork does not start writing Pi subprocesses as fallback.
- Unverified foreground writes also propose candidates. A structurally verified, explicit user memory directive can save directly unless a similar add needs review. Source linking is not a guarantee of semantic entailment: inspect the evidence when reviewing a claim.
- Same-scope exact adds are no-ops. Ordinary/atomic replacements collapse exact collisions while retaining distinct project-attributed failure copies.
- Every observed active entry has a stable UUID; confirmed replacements retain it with a new revision. Prior versions and removed entries remain recoverable outside ordinary recall. Legacy entries are explicitly unlinked, not assigned fictional sources.
- Source session/message IDs, roles and observation time come from actual session records, excluding assistant claims. The model cannot set them through tool parameters. Source excerpts flagged by the content scanner are withheld; use the source IDs to inspect the original session.
- Operation keys are canonical and scoped. Repeating an identical same-source proposal returns its existing status, including rejection. A new user decision may create a new proposal. Paraphrases can still create separate pending proposals; they cannot silently become active.
- Approval checks the current target fingerprint again under its lock. A changed target makes the proposal stale and requires resubmission. Stable-id tools also accept expected_revision.
- CJK bigrams and literal identifiers retrieve a bounded set of similar entries. Similarity never authorizes merging: different conditions (S0/S4), devices, projects and negation must remain distinct.
- Optional semantic analysis uses one bounded request to the active model, returning advice only. No automatic semantic merge or silent supersession is enabled.
- Correction extraction has one proposal chain; no second raw correction append. Basic Chinese correction starters are recognized too.
- Automatic consolidation cannot rewrite active memory; manual direct consolidation stages an atomic shrink plan for review, with its shrink constraint checked again on approval.

## Tools and review

`memory_review` accepts target memory/user/project/failure and actions:

| Action | Purpose |
| --- | --- |
| list / show | Pending candidates / one candidate with source evidence |
| active / history | Active stable IDs / active and superseded revisions |
| analyze | Optional model advice; candidate remains pending |
| dry_run | Admission preview for a proposal without saving it |
| approve | Apply a reviewed candidate; optional replace_id merges a single add into an existing entry |
| duplicate | Discard an equivalent candidate using replace_id as the active reference |
| reject | Record rejection so the identical same-source operation does not recur |
| restore | Restore a superseded id/revision through the normal locked mutation path |

For approve/reject/duplicate/restore invoked as tools, the latest user message must explicitly request a decision and reference the exact candidate/entry UUID. The assistant cannot approve on the user's behalf. Direct TUI `/memory-review ACTION TARGET [ID] [REPLACE_ID]` is also supported.

Ordinary memory_replace/memory_remove keep old_text compatibility and support entry_id plus optional expected_revision. Prefer stable IDs when identical text exists in different scopes.

Example: inspect a pending candidate, compare its evidence and similar entries, then ask the user to approve UUID, reject UUID, or merge UUID into an active stable ID. Do not say a pending proposal was saved. A broad earlier development/deployment approval is not permission to approve future personal memory claims.

## Persistence and recovery

Each Markdown target has a sibling `<file>.admission.json` ledger, mode 0600. It is atomically renamed under the same target lock. Active Markdown remains authoritative and the existing mutation observer synchronizes SQLite. Admission snapshots are saved before mutation; after a crash/external edit, reconciliation archives disappeared entries and records newly observed entries as unlinked rather than inventing provenance. Markdown and ledger are separate files, not a cross-file transaction; a crash can lose the new write's source linkage, but it cannot make a stale approval overwrite a new target.

Pending queue is limited to 200 per target, providing backpressure without deleting valid rules. Entry/revision history and rejection records are retained. Current inspection returns bounded pages; session history remains available independently. Source evidence is private local data and must never be committed to GitHub.

## Build, deployment and rollback

All editing, tests, packaging and GitHub writes run on Windows WSL. Production peers are supplied by Pi; host SDK packages are not runtime dependencies. Runtime dependencies are unchanged: better-sqlite3 ^13.0.3 and strip-ansi 7.2.0.

Before deployment, back up settings, Markdown, ledgers and a consistent SQLite snapshot on OneCloud under /data. Stage the reviewed fork commit and compatible existing native dependencies before setting a pinned Git source. Never let an unprepared Pi package update build native modules on OneCloud. Keep the old npm installation intact for rollback.

Disk deployment and a running process loading it are separate checks. A package version alone is not evidence that the active Pi loaded the release. Reload at an appropriate session boundary, then verify memory_review is registered and use synthetic, isolated checks for the target platform. No second Pi/RPC process is permitted on OneCloud.

Rollback the package source to npm:pi-hermes-memory@0.9.11 and reload; admission ledgers can be kept for investigation because upstream ignores them. This restores the old extraction behavior, including automatic writes. Never restore an old database over newer user records merely to roll back code. Restore data only deliberately from the corresponding snapshot and reconcile Markdown/search afterward.
