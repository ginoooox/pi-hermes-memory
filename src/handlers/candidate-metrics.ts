/** Bounded count-only review telemetry. Never stores bodies, plans, sources or session IDs. */
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  atomicText,
  readOptional,
  PROMOTION_THRESHOLDS,
  type AdmissionThresholds,
} from "../store/candidate-store.js";
import { withMarkdownMutationLock } from "../store/markdown-mutation-lock.js";
import {
  accumulatePublication,
  emptyPublicationTotals,
  type PublicationOutcome,
  type PublicationTotals,
} from "./candidate-publication-metrics.js";

export function reviewErrorCategory(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/cancel|abort/i.test(text)) return "cancelled";
  if (/changed|conflict|stale/i.test(text)) return "concurrency";
  if (/coverage incomplete/i.test(text)) return "coverage";
  if (/auth|api.key/i.test(text)) return "auth";
  if (/JSON|response|draft|merge|publication|reference|cleanup|promotion/i.test(text)) return "invalid_plan";
  return "runtime_or_provider";
}
export class ReviewMetrics {
  readonly id = randomUUID();
  readonly started = performance.now();
  readonly counts = { reviewed: 0, retained: 0, cleanupDropped: 0, cleanupMergedAway: 0,
    cleanupAdded: 0, cleanupDeduplicated: 0, cleanupInputSkipped: 0, promotionReviewed: 0,
    promoted: 0, promotionDiscarded: 0, cleanupContentRewrites: 0, formatBlocked: 0 };
  /** True only from an actual model output that changed nothing (never for input skips). */
  cleanupOutputUnchanged = false;
  private publication: PublicationOutcome | undefined;
  private stage = "prepare";
  private stageStart = this.started;
  private stages: Record<string, number> = {};
  private inputs: Record<string, number> = {};
  private models: Array<{ phase: string; provider: string; model: string; status: string; durationMs: number; errorCategory?: string }> = [];
  private trigger: Record<string, unknown> | undefined;
  constructor(
    readonly root: string,
    /** Actual admission thresholds in force; optional for backward-compatible tests. */
    readonly policy: AdmissionThresholds = PROMOTION_THRESHOLDS,
  ) {}
  /** Records why this review ran (force/fingerprint/pending age/thresholds). */
  setTrigger(trigger: Record<string, unknown>) { this.trigger = trigger; }
  /**
   * Records a publication ONLY after publisher.commit resolved successfully.
   * A commit with no formal changes still counts as a committed no-op; a
   * failed or never-attempted commit records nothing (stays null in reports).
   */
  recordPublication(outcome: PublicationOutcome) { this.publication = outcome; }
  phase(name: string) {
    const now = performance.now();
    this.stages[this.stage] = Math.round((this.stages[this.stage] ?? 0) + now - this.stageStart);
    this.stage = name; this.stageStart = now;
  }
  input(phase: string, data: unknown) { this.inputs[phase] = JSON.stringify(data).length; }
  model(phase: string, provider: string, model: string) {
    const start = performance.now();
    const attempt = { phase, provider: provider.slice(0, 128), model: model.slice(0, 256), status: "running", durationMs: 0 };
    this.models.push(attempt);
    return (status: "success" | "failed" | "cancelled", error?: unknown) => {
      attempt.status = status; attempt.durationMs = Math.round(performance.now() - start);
      if (error !== undefined) Object.assign(attempt, { errorCategory: status === "cancelled" ? "cancelled" : reviewErrorCategory(error) });
    };
  }
  async finish(status: "success" | "failed" | "cancelled", error?: unknown) {
    const endedStage = this.stage;
    this.phase(endedStage);
    const report = { schema: 3, requestId: this.id, at: new Date().toISOString(), status,
      phase: endedStage, durationMs: Math.round(performance.now() - this.started), stagesMs: this.stages,
      inputChars: this.inputs, models: this.models.slice(0, 4), ...this.counts,
      cleanupOutputUnchanged: this.cleanupOutputUnchanged,
      discarded: this.counts.promotionDiscarded,
      // null = no commit was attempted/reached; an object always reflects a
      // successful commit (possibly a committed no-op with zero counts).
      publication: this.publication ?? null,
      thresholds: { memory: this.policy.memory, skill: this.policy.skill },
      ...(this.trigger ? { trigger: this.trigger } : {}),
      ...(error === undefined ? {} : { errorCategory: status === "cancelled" ? "cancelled" : reviewErrorCategory(error) }) };
    const file = path.join(this.root, "candidate-metrics.json");
    await withMarkdownMutationLock(file, async () => {
      const raw = await readOptional(file);
      const previous = raw ? JSON.parse(raw) : {};
      if ((previous.recent ?? []).some((r: { requestId: string }) => r.requestId === this.id)) return;
      const totals = previous.totals ?? { runs: 0, success: 0, failed: 0, cancelled: 0, durationMs: 0,
        cleanupDropped: 0, cleanupMergedAway: 0, cleanupDeduplicated: 0, cleanupInputSkipped: 0,
        promoted: 0, promotionDiscarded: 0 };
      totals.runs++; totals[status]++; totals.durationMs += report.durationMs;
      // Legacy (schema-2) totals lack the newer keys; initialize each count so
      // accumulation never produces NaN (which serializes as JSON null).
      for (const key of ["cleanupDropped", "cleanupMergedAway", "cleanupDeduplicated", "cleanupInputSkipped", "promoted", "promotionDiscarded", "formatBlocked"] as const)
        totals[key] = (totals[key] ?? 0) + this.counts[key];
      totals.cleanupContentRewrites = (totals.cleanupContentRewrites ?? 0) + this.counts.cleanupContentRewrites;
      // Schema-3 migration: old totals never measured publications, so their
      // history is unknown, not zero; counters below cover commits since the
      // upgrade only. Fresh files measure everything.
      if (!totals.publications)
        totals.publications = emptyPublicationTotals(previous.totals === undefined);
      if (this.publication) accumulatePublication(totals.publications, this.publication);
      await atomicText(file, JSON.stringify({ schema: 1, totals, recent: [...(previous.recent ?? []), report].slice(-32) }, null, 2) + "\n");
      await atomicText(path.join(this.root, "candidate-status.json"), JSON.stringify(report, null, 2) + "\n");
    });
    return report;
  }
}
