# Candidate lifecycle edition

This personal fork is rebuilt from upstream release 0.9.11, commit `71cf5ab7d909318a383bf52bb3ad3cf83a9efc03`. The subsequent upstream main change only concerns publishing CI/docs. This branch deliberately keeps released CI; cloud Actions are not required or claimed. Upstream Markdown, SQLite/FTS, project detection, secret scanner, skill format and search remain the foundation.

## Contract

1. All extension memory add/replace/remove/atomic-plan writes and skill create/patch/update/delete writes enter a separate draft workspace. Active files, SQLite recall and skill discovery do not include drafts. Existing skills stay active while edits wait.
2. After an agent run completes, wait two seconds of idle time. A new agent run cancels pending/in-flight review. Queued messages defer it. One review per completed user-message ID per process, or an explicit manual review. No model request runs on each tool result.
3. A model uses bounded recent task context, draft bodies, exact formal mutation/duplicate anchors and a compact skill discovery catalog. The routine formal input is explicitly partial; descriptions alone do not prove equivalent coverage. It aggressively removes transient, unsupported, uncertain, obsolete or low-value drafts and semantically merges compatible ones. New extraction is limited to eight strong items. Task plans and assistant explanations are not proof of success or durable user preferences. An earlier task may already have established a carried draft: failure to repeat its evidence in the latest bounded context is not a reason to drop it. Each drop must include a transient structured category and concrete basis; only transient, duplicate, superseded, contradicted, uncertain (a specific flaw), and low_value are accepted. Reasons are validated in memory and never saved as rejected history. This contract and structural validation cannot prove model semantic correctness.
4. After cleanup, 20 retained memory drafts OR three retained skill drafts trigger a second model request. The count includes global/current-project drafts only; other projects are neither exposed nor consumed. Either threshold admits both kinds in the accessible batch.
5. Equivalent without improvement: discard. Equivalent and better: replace. Compatible complementary information: merge. Clearly supported state update: replace. Unresolved conflict: discard the new draft. Strong independent knowledge: add. An explicit exact deletion draft is required for removing formal knowledge.
6. No per-claim source links, quality ledgers, rejected history or merge tombstones are retained. A draft stores its body, kind, scope, mutation anchor, skill fields and update time. Cleanup decisions judge evidential adequacy while the original task context is available, but later tasks must not reinterpret absent old context as evidence against a retained draft. Later admission cannot reconstruct lost evidence; no source ledger is introduced.

## Storage and migration

`<memoryDir>/.candidates/queue.json` is mode 0600 and outside contributed skill roots. Draft skill bodies live in this JSON, not discoverable SKILL.md files. A single editable draft per skill prevents patch piles. Identical memory drafts are idempotent regardless of source message.

On first use, old `.admission.json` pending operation bodies from the global/current-project scopes are imported once. Sources, semantic quality metadata, stable entry revisions and decisions are not imported. Unsafe/malformed individual drafts are discarded. Failure classification/project tags are retained. Existing formal Markdown, skill files and SQLite rows are preserved. Old sidecars remain unused compatibility material for the previous running version/rollback; they are not a second live admission system.

The queue contains only current drafts plus small revision/import markers. Cleanup physically removes rejected/merged-away drafts. The import markers identify already-consumed old files, not provenance of new knowledge.

## Publication and recovery

Model responses are plans, not tools or shell programs. Validate JSON, complete ID coverage, scope, allowed operations, scanned content, references and skill structure before writing. Every visible draft must be kept, dropped or merged exactly once; unseen drafts survive. Formal references cannot be readonly native skills or other projects. Concrete relative `scripts/*` references must exist; the reviewer never executes risky procedures to prove them.

Release locks during model requests. Reacquire the queue and ordered upstream canonical-file locks, compare snapshots, then publish. Concurrent queue/formal changes reject the stale plan. Each file uses an atomic rename; multiple files are **not** one filesystem-atomic operation. A private temporary transaction journal allows interruption recovery to finish the same batch. Unknown external edits halt recovery rather than overwriting them. The journal is removed after success. Markdown/SQLite scope reconciliation follows publication and runs before the next review to repair interrupted synchronization.

`.previous-formal.json` keeps only the previous contents and expected published hashes of the last changed formal batch. It has no candidate/source history. Rollback checks current hashes and project scope before replacing files. It does not resurrect deleted drafts. Upstream independent recovery files are unchanged by this implementation.

## Commands and tools

- `memory_add`, `memory_replace`, `memory_remove`: stage drafts, return `pending:true`; do not report these as active saved memory.
- `skill_manage`: stage skill writes; view can show an editable draft. Ordinary skill index/discovery remains formal-only.
- `memory_candidates` with list/show: inspect the draft workspace. This replaces the old personal `memory_review` tool.
- `/memory-candidates`: counts and thresholds.
- `/memory-candidates review`: explicitly run cleanup and admission early, even below threshold.
- `/memory-candidates rollback`: restore the last formal publication batch if hashes/project still match.
- `/memory-consolidate`: alias for early candidate review; does not sweep formal memory or spawn Pi.

Standing-instruction pinning is still an explicit user command, not generated learning. Direct filesystem edits have host-level authority and bypass tool staging; agents must not use them to save generated memory/skills. Installed native skills are consulted readonly, never automatically modified or shadowed. Script assets are not executed, copied or deleted by a model plan; referenced assets must already exist at the intended managed skill location.

## Bounds, failure behavior and cost

Review up to 80 accessible drafts/48,000 serialized characters, 24,000 task-context characters, routine cleanup formal anchors up to 16,000 serialized characters plus 6,000 characters of skill hints, and full admission formal input up to 256,000 characters (100 skill directories per root, 64KiB per skill). Unseen drafts remain for a later task. Incomplete formal coverage defers admission. Queue cap: 230 drafts. Normal tasks use one direct completion; threshold/manual admission adds another. Each phase may use up to two configured models, sharing a 120-second run deadline; output is capped at 8,192 tokens. Honor upstream model selection/auth headers/environment. No child Pi/RPC, embedding service or resident model worker.

Only completed text-channel JSON is accepted. Provider failure, timeout, cancellation, invalid JSON, incomplete ID coverage or concurrency conflict does not authorize deletions. Successfully completed cleanup can remain committed if subsequent admission fails; remaining drafts are retryable. Reports contain counts, timings, model identifiers and coarse error categories only. Task evidence exists transiently in the review request, not in extension-maintained source records.

Upstream periodic background review, correction auto-write, shutdown flush and subprocess auto-consolidation handlers are not registered. Their older interval/transport settings do not control this edition. Task interruption before the idle review can leave drafts until a later completed task. Skills already cached by Pi may require resource refresh/reload before their newly published version is discovered; publication does not falsely claim cache activation.

## Validation

Use Windows/WSL for TypeScript, full upstream tests plus candidate lifecycle tests, minimum-SDK checking and a production-only install probe. The production probe loads through Pi's actual jiti aliases and performs both actual candidate cleanup and admission against loopback SSE, in addition to upstream transport probes. No paid inference or private fixtures are required.

Deploy fixed commits/artifacts with checksums and reuse the existing compatible ARMv7 native dependency. Separately verify disk code, isolated ARMv7 execution, and the real running main PID/version/tool registry after a normal user reload. Never start another Pi instance to manufacture activation evidence.

## Runtime diagnostics and compatibility (candidate.2)

`candidate-status.json` schema 2 includes the latest outcome, stage, elapsed time and per-model attempt duration/outcome. `candidate-metrics.json` holds 32 recent count-only reports plus cumulative totals under its own native mutation lock. Neither file retains candidate IDs/bodies, drop explanations, task text, full requests, errors containing provider output, or session/source identity. `cleanupDropped` counts explicit cleanup drops; `cleanupMergedAway` counts inputs combined away; `cleanupDeduplicated` counts exact collapse after merge/extraction; `promotionDiscarded` counts admission discards. The legacy `discarded` field remains an alias for promotion discards only. Counts reflect committed phases, including cleanup that succeeded before admission failed or was cancelled. Repeated finalization is idempotent. Failure/cancellation reports do not turn an uncommitted plan into a successful update.

Every project Store created by session-CWD rebinding receives the candidate sink before use; scope is captured for that Store, including later switches. This fixes candidate.1's project-write bypass, which could return success and write formal files despite the global gate. Regression tests exercise actual extension tools, not just a standalone candidate-enabled Store.

On `session_start` (including new/resume/reload), a one-time session migration adds only `memory_candidates` if the selected tools already include a memory/skill write tool. An existing active inspection tool merely records the migration. Unrelated tools and read-only selections are preserved. A private custom session marker prevents the extension from repeatedly overriding later intentional deselection. Pi SDK loadout policy can independently affect tool selection; the extension does not bypass explicit SDK allow/deny restrictions. Real SDK tests restore synthetic old JSONL, bind selected tools, and exercise actual reload; these are separate from OneCloud main-instance activation.

The historical five-to-zero cleanup had no persisted drop reasons. The old `discarded=0` only measured promotion, so it could coexist with five cleanup deletions. That explains the count discrepancy but cannot establish whether each semantic decision was justified; no deleted drafts are resurrected automatically.
