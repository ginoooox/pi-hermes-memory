/**
 * Truthful publication metrics. Counts are derived ONLY from a successfully
 * committed publisher.commit: semantic per-decision operations (gated on the
 * commit resolving) plus native formal-memory parsing of the actual planned
 * file changes (before/after/net). Bounded numbers; never bodies or IDs.
 */
import * as path from "node:path";
import { ENTRY_DELIMITER } from "../constants.js";
import type { FileChange, Publication } from "../store/candidate-publisher.js";
import type { Draft } from "../store/candidate-store.js";

export interface MemoryOpCounts {
  add: number;
  replace: number;
  merge: number;
  remove: number;
}
export interface SkillOpCounts {
  add: number;
  update: number;
  merge: number;
  remove: number;
}
export interface FormalCounts {
  before: number;
  after: number;
  net: number;
  /** Provenance: full read snapshot (production) or changed files only (legacy helpers). */
  coverage: "snapshot_files" | "changed_files";
}
export interface PublicationOutcome {
  committed: true;
  /** True when the commit produced no formal file change (all-discards or no-op). */
  noop: boolean;
  memory: MemoryOpCounts;
  skill: SkillOpCounts;
  /** Native parsed entry counts over changed memory files; null when none changed. */
  formalMemory: FormalCounts | null;
  /** Native parsed skill-file counts over changed skill files; null when none changed. */
  formalSkills: FormalCounts | null;
}

const MEMORY_BASENAMES = new Set(["MEMORY.md", "USER.md", "failures.md"]);
const isMemoryFile = (file: string) => MEMORY_BASENAMES.has(path.basename(file));

/** Parsed entry count of a native memory file version. */
export const parseMemoryEntries = (raw: string | null): number =>
  (raw ?? "").split(ENTRY_DELIMITER).filter((s) => s.trim()).length;
/** Parsed skill count of a native SKILL.md version (null file = absent). */
export const parseSkillCount = (raw: string | null): number => (raw === null ? 0 : 1);

const emptyMemory = (): MemoryOpCounts => ({ add: 0, replace: 0, merge: 0, remove: 0 });
const emptySkill = (): SkillOpCounts => ({ add: 0, update: 0, merge: 0, remove: 0 });

/**
 * Derives the publication outcome from planned file changes and promotion
 * decisions for the drafts in that batch. Callers must invoke this only after
 * publisher.commit resolved; an uncommitted or failed plan yields nothing.
 */
export function publicationOutcome(
  changes: FileChange[],
  decisions: Publication[],
  draftsById: Map<string, Draft>,
  /** Full read formal snapshot (production). Omitted counts changed files only. */
  snapshot?: { files: Record<string, string | null> },
): PublicationOutcome {
  const memory = emptyMemory();
  const skill = emptySkill();
  for (const decision of decisions) {
    if (decision.action === "discard") continue;
    const kind = draftsById.get(decision.id)?.kind;
    if (kind === "skill") {
      if (decision.action === "add") skill.add++;
      else if (decision.action === "replace") skill.update++;
      else if (decision.action === "merge") skill.merge++;
      else if (decision.action === "remove") skill.remove++;
    } else if (kind === "memory") {
      memory[decision.action as keyof MemoryOpCounts]++;
    }
  }
  // Before/after file states. With a snapshot, before/after cover the whole
  // read snapshot (unaffected files included) and the planned changes overlay
  // their files; without one, only the changed files are known (legacy scope).
  const beforeFiles: Record<string, string | null> = { ...(snapshot?.files ?? {}) };
  const afterFiles: Record<string, string | null> = { ...(snapshot?.files ?? {}) };
  for (const change of changes) {
    beforeFiles[change.file] = change.before;
    afterFiles[change.file] = change.after;
  }
  let memBefore = 0, memAfter = 0, memFiles = 0;
  let skBefore = 0, skAfter = 0, skFiles = 0;
  for (const [file, raw] of Object.entries(beforeFiles)) {
    if (isMemoryFile(file)) memBefore += parseMemoryEntries(raw);
    else skBefore += parseSkillCount(raw);
  }
  for (const [file, raw] of Object.entries(afterFiles)) {
    if (isMemoryFile(file)) memAfter += parseMemoryEntries(raw);
    else skAfter += parseSkillCount(raw);
  }
  for (const change of changes) {
    if (isMemoryFile(change.file)) memFiles++;
    else skFiles++;
  }
  const coverage = snapshot ? "snapshot_files" as const : "changed_files" as const;
  return {
    committed: true,
    noop: changes.length === 0,
    memory,
    skill,
    formalMemory: snapshot || memFiles
      ? { before: memBefore, after: memAfter, net: memAfter - memBefore, coverage }
      : null,
    formalSkills: snapshot || skFiles
      ? { before: skBefore, after: skAfter, net: skAfter - skBefore, coverage }
      : null,
  };
}

/** Cumulative publication counters; only measured commits are ever summed. */
export interface PublicationTotals {
  /** False when migrated from an older schema that never measured these ops. */
  historyKnown: boolean;
  commits: number;
  memoryAdd: number;
  memoryReplace: number;
  memoryMerge: number;
  memoryRemove: number;
  skillAdd: number;
  skillUpdate: number;
  skillMerge: number;
  skillRemove: number;
  /** Sum of per-commit native parsed net over changed memory files only. */
  formalMemoryNet: number;
  formalSkillsNet: number;
}

export const emptyPublicationTotals = (historyKnown: boolean): PublicationTotals => ({
  historyKnown,
  commits: 0,
  memoryAdd: 0,
  memoryReplace: 0,
  memoryMerge: 0,
  memoryRemove: 0,
  skillAdd: 0,
  skillUpdate: 0,
  skillMerge: 0,
  skillRemove: 0,
  formalMemoryNet: 0,
  formalSkillsNet: 0,
});

export function accumulatePublication(
  totals: PublicationTotals,
  outcome: PublicationOutcome,
): void {
  totals.commits++;
  totals.memoryAdd += outcome.memory.add;
  totals.memoryReplace += outcome.memory.replace;
  totals.memoryMerge += outcome.memory.merge;
  totals.memoryRemove += outcome.memory.remove;
  totals.skillAdd += outcome.skill.add;
  totals.skillUpdate += outcome.skill.update;
  totals.skillMerge += outcome.skill.merge;
  totals.skillRemove += outcome.skill.remove;
  if (outcome.formalMemory) totals.formalMemoryNet += outcome.formalMemory.net;
  if (outcome.formalSkills) totals.formalSkillsNet += outcome.formalSkills.net;
}
