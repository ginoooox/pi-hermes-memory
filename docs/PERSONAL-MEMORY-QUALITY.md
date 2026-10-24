# Personal memory quality — 0.9.11-personal.2

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

## Live runtime evidence (personal.2)

`runtime-status.json` in the global memory directory is written atomically by the actual session_start hook. It records the literal loaded release version, import source URL, namespace PID, loadedAt and readiness flags, with mode 0600 and no memory/message content. Validate its freshness, source path and still-running main Pi process before treating it as proof. A factory-only load does not create it; a failed status write warns without breaking memory tools. The marker may survive a process exit, so a stale file alone is not proof of a running version.

## personal.3: bounded review assistance

- `groups`: complete-link lexical/CJK retrieval groups for single-add candidates only, with project isolation. Every candidate ID remains separate. Current active relations, exact duplicate flags and fingerprints are recomputed; creation-time similarity is not authoritative. Limits paginate groups, previews show at most twelve candidates per group and preserve all IDs.
- `evidence`: source message associations deduplicate by session/message/role; inconsistent excerpts and excluded roles are reported. Counts are not independent support, confidence or user confirmation. Legacy unlinked records stay unlinked. Evidence source previews are capped at twelve excerpts of 2,500 characters; group pages contain only source IDs/counts and 240-character candidate summaries, avoiding repeated long excerpts.
- `impact`: explicit entry-ID references and pending operations in the chosen ledger, plus direct SKILL.md children of that ledger's skills directory and the configured agent's native skills directory. Each root is limited to 200 child directories, documents to 64 KiB, matches to 100; unreadable/oversized files are reported as incomplete. Symlink child entries are not intentionally followed. Other ledgers/projects and implicit semantic dependencies are not scanned. A textual ID mention is a review lead, not a proven derivation edge.
- The three projections do not save the ledger, change candidate status, publish to Markdown, or touch SQLite. Semantic `analyze` now receives refreshed active relations and deduplicated source associations, and remains advisory. No additional model request is needed for the projections.
- Approve/reject/duplicate/restore authorization, optimistic fingerprints, mutation locking, search isolation and learning settings are unchanged. Existing candidates still need an exact-ID user decision. No background consolidation, migration, automatic invalidation or automatic skill creation is added.


## personal.5: proposal quality across a task

Source selection now has a separate bounded branch pool (up to 96 verified user/tool messages, 96,000 characters, 6,000 per excerpt). It retrieves up to four source messages per operation and three per sentence-like claim. Actual session IDs and roles remain authoritative. Recent context, real authorization and claim retrieval are reported separately; unsupported clauses stay visible as gaps. Routine skill reads, write acknowledgements and unexecuted tool calls are excluded from support retrieval. Window matching helps find relevant lines in long logs. These are lexical leads with `entailment: not_verified`, never proof of success or user preference. Sources omitted by the budget are not evidence of absence.

Automatic extraction compares proposed facts with bounded active-memory and skill excerpts in the existing completion request. No extra automatic model call is added. Additional structured review data shares a 24,000-character budget across global/project stores: at most eight memory leads, six deduplicated skill leads and six source leads. Existing model requests therefore have bounded extra input cost, not zero cost. The prompt asks for semantic comparison, final observed task state, preservation of independent devices/scopes/conditions, and omission of redundant or unsupported additions. A model may still miss paraphrases or infer too much; admission continues to keep automatic proposals pending. Foreground proposals get retrieval leads too. `memory_review analyze` receives these skill excerpts, source selection and later observations for optional per-claim advice, never an automatic decision.

At `agent_end`, warm sessions recheck their own pending candidates. Direct completion also rechecks after staging, covering a late background response after the agent run ended. The existing Markdown lock serializes advisory `quality` metadata updates. Original sources, operations, UUIDs, keys, fingerprints, creation time, statuses, formal Markdown and SQLite recall are unchanged. Later related user/tool messages flag `needs_recheck`; they do not declare a candidate superseded. Active-memory changes are flagged independently. Another session's candidates and decided candidates are left alone. Cold lazy sessions do not open the database for this hook. Each examination is bounded to the current ledger's pending limit. Model requests and automatic approval/deletion are not introduced.

Skill retrieval scans only the current store's skill root, the currently bound project's root, and global Hermes/native roots: at most four roots, 100 direct directories per root, 64 KiB per document, 2 MiB total, six matches with 2,800-character excerpts and content digests. Symlink roots, children and documents are excluded. Coverage and read failures are reported; a zero result does not prove no semantic duplicate. Skills outside those roots and other projects are not scanned. The separate `skill_manage` mutation policy is unchanged; this release does not claim unified skill admission.

The new fields are optional additions to the schema-1 ledger, readable by personal.4. Code rollback can retain them. Existing candidate decisions still require the exact-ID user authorization and current fingerprint. Existing candidates are neither retrospectively rewritten nor automatically decided; evidence inspection computes fresh advisory hints, and only same-session task-end checks persist them.
