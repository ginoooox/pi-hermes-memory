/**
 * Deterministic format validation for new candidate writes.
 *
 * Structural validation (validateDraft) checks shape and stays tolerant of
 * legacy drafts; this module additionally validates REQUIRED CONTENT FORMAT
 * for newly staged or published drafts only. Legacy queued drafts are never
 * rejected or rewritten by these checks: they stay inspectable and retained
 * until a cleanup merge or promotion decision supplies repaired content.
 * Issue lists are transient validation input; nothing here is persisted.
 */
import type { MemoryCategory } from "../types.js";

/** Must stay identical to the MemoryCategory union in src/types.ts. */
export const MEMORY_CATEGORIES = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
] as const;
const _categoryAlignment: readonly MemoryCategory[] = MEMORY_CATEGORIES;
void _categoryAlignment;

export const SKILL_REQUIRED_SECTIONS = [
  "When to Use",
  "Procedure",
  "Pitfalls",
  "Verification",
] as const;

/** Missing or empty `## Section` bodies for a skill draft body. */
export function skillFormatIssues(body: string): string[] {
  const issues: string[] = [];
  for (const section of SKILL_REQUIRED_SECTIONS) {
    const heading = new RegExp(`^## ${section}\\s*$`, "m").exec(body);
    if (!heading) {
      issues.push(`missing "## ${section}" section`);
      continue;
    }
    const rest = body.slice(heading.index + heading[0].length);
    const next = /^## /m.exec(rest);
    const content = (next ? rest.slice(0, next.index) : rest).trim();
    if (!content) issues.push(`"## ${section}" section is empty`);
  }
  return issues;
}

/**
 * Failure memories carry an optional leading `[category]` tag. A present tag
 * must use the allowed vocabulary (native failure parser behavior). The
 * category is never forced and never silently rewritten; `Failed: ...` and
 * other trailing segments are left untouched.
 */
export function failureFormatIssues(content: string): string[] {
  const text = content.trim();
  const match = /^\[([^\]]+)\]/.exec(text);
  if (!match) return [];
  const issues: string[] = [];
  if (!(MEMORY_CATEGORIES as readonly string[]).includes(match[1])) {
    issues.push(
      `unknown failure category tag "[${match[1]}]"; use one of: ${MEMORY_CATEGORIES.join(", ")} (or drop the tag)`,
    );
  }
  // The native parser only recognizes "[tag] " followed by nonempty text;
  // anything else would silently lose the category. Reject malformed tags
  // instead of normalizing them.
  const rest = text.slice(match[0].length);
  if (!/^\s/.test(rest) || !rest.trim()) {
    issues.push(
      `failure tag "[${match[1]}]" must be followed by whitespace and nonempty content`,
    );
  }
  return issues;
}

export interface FormatCheckableDraft {
  kind: "memory" | "skill";
  target: string;
  action: string;
  content: string;
}

/** Format issues for a draft; removals and ordinary memories have none. */
export function draftFormatIssues(draft: FormatCheckableDraft): string[] {
  if (draft.action === "remove") return [];
  if (draft.kind === "skill") return skillFormatIssues(draft.content);
  if (draft.target === "failure") return failureFormatIssues(draft.content);
  return [];
}

/** Transient, actionable repair text for a model or tool result. */
export function formatRepairHint(
  what: string,
  issues: string[],
): string {
  return `${what}: ${issues.join("; ")}. Repair the content and retry; the draft stays pending until then.`;
}
