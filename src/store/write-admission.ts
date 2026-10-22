import { scanContent } from "./content-scanner.js";
/** Personal fork admission ledger. Markdown remains the active source of truth.
 * Each ledger is serialized by the SAME lock as its Markdown target. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import type { MemoryMutationOperation, MemoryResult } from "../types.js";

export type AdmissionSource = {
  sessionId: string; messageId: string; role: string; timestamp?: string;
  text: string;
};
export type WriteContext = {
  origin: "foreground" | "automatic" | "approval";
  sources: AdmissionSource[];
  explicit?: boolean;
  candidateId?: string;
  expectedFingerprint?: string;
  matchRaw?: string;
  dryRun?: boolean;
  requireShrink?: boolean;
  failureProject?: string | null;
};
const context = new AsyncLocalStorage<WriteContext>();
export const withWriteContext = <T>(value: WriteContext, fn: () => T): T => context.run(value, fn);
export const currentWriteContext = (): WriteContext | undefined => context.getStore();

/** Only actual session records can establish source role/id, never model fields.
 * The injected context is a source link, NOT a claim that content is entailed. */
export function contextFromSession(ctx: any, origin: WriteContext["origin"] = "foreground"): WriteContext {
  const sources: AdmissionSource[] = [];
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionId) return { origin, sources: [], explicit: false };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || !entry.id || !entry.message) continue;
      const m = entry.message;
      if (!["user", "toolResult"].includes(m.role)) continue;
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content)
        ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
      if (text.trim()) sources.push({ sessionId, messageId: entry.id, role: m.role,
        timestamp: entry.timestamp, text: text.slice(0, 2500) });
    }
  } catch { /* Missing branch means unverified; writes must stay pending. */ }
  const recent = [...sources.filter(s => s.role === "user").slice(-3), ...sources.filter(s => s.role === "toolResult").slice(-3)];
  const user = recent.filter(s => s.role === "user").at(-1)?.text ?? "";
  const explicit = /^(?:\[telegram\]\s*)?(?:(?:请|帮我|替我|你要|以后要|please|can you)\s*)?(?:记住|记下来|保存.{0,12}(?:记忆|偏好)|更新.{0,12}记忆|删除.{0,12}记忆|整理.{0,12}记忆|remember\b|save (?:this|that|my).{0,20}(?:memory|preference)|update.{0,12}memor|forget\b)/iu.test(user.trim());
  return { origin, sources: recent, explicit };
}
export function explicitReviewRequest(ctx: any, id: string): boolean {
  const user = contextFromSession(ctx).sources.filter(s => s.role === "user").at(-1)?.text ?? "";
  return !!id && user.includes(id) && /^(?:\[telegram\]\s*)?(?:(?:请|帮我|替我|please)\s*)*(?:批准|同意|通过|拒绝|驳回|恢复|合并|approve|reject|restore|merge)/iu.test(user.trim());
}

export type AdmissionEntry = { id: string; revision: number; raw: string; text: string;
  project: string | null; status: "active" | "superseded"; source: AdmissionSource[];
  sourceStatus: "linked" | "unlinked"; observedAt: string; supersededAt?: string };
export type Candidate = { id: string; key: string; operations: MemoryMutationOperation[];
  status: "pending" | "approved" | "rejected" | "duplicate";
  reason: string; fingerprint: string; sources: AdmissionSource[]; createdAt: string;
  similar: Array<{ id: string; text: string; score: number; project: string | null }>;
  result?: string; matchRaw?: string; requireShrink?: boolean; failureProject?: string | null };
type Ledger = { schema: 1; entries: AdmissionEntry[]; candidates: Candidate[] };
export type Decoded = { raw: string; text: string; project: string | null };
export const fingerprint = (raw: string[]): string => createHash("sha256").update(JSON.stringify(raw)).digest("hex");
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const hash = (x: unknown): string => createHash("sha256").update(JSON.stringify(canonical(x))).digest("hex");

/** CJK bigrams + literal identifiers; similarity retrieves, it never merges. */
export function similarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> => {
    const result = new Set(s.toLowerCase().match(/[a-z0-9_./:@-]+/g) ?? []);
    for (const run of s.match(/[\p{Script=Han}]+/gu) ?? []) {
      for (let i = 0; i < run.length - 1; i++) result.add(run.slice(i, i + 2));
    }
    return result;
  };
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  return 2 * [...x].filter(t => y.has(t)).length / (x.size + y.size);
}
export class WriteAdmission {
  private data: Ledger = { schema: 1, entries: [], candidates: [] };
  constructor(private file: string) {}
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (parsed.schema !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.candidates)) throw new Error("Unsupported admission ledger");
      this.data = parsed;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  async save(): Promise<void> {
    const tmp = this.file + "." + randomUUID() + ".tmp";
    try { await fs.writeFile(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 }); await fs.rename(tmp, this.file); }
    finally { await fs.rm(tmp, { force: true }); }
  }
  get entries(): AdmissionEntry[] { return this.data.entries; }
  get candidates(): Candidate[] { return this.data.candidates; }
  /** Reconcile crash/external-edit recovery. Unlinked means no invented source. */
  reconcile(entries: Decoded[], source?: AdmissionSource[]): void {
    const now = new Date().toISOString();
    for (const e of this.entries.filter(e => e.status === "active")) {
      if (!entries.some(x => x.raw === e.raw)) { e.status = "superseded"; e.supersededAt = now; }
    }
    for (const e of entries) {
      if (this.entries.some(x => x.status === "active" && x.raw === e.raw)) continue;
      this.entries.push({ ...e, id: randomUUID(), revision: 1, status: "active", source: (source ?? []).map(s => ({ ...s, text: scanContent(s.text) ? "[Source excerpt withheld by content scanner]" : s.text })),
        sourceStatus: source?.length ? "linked" : "unlinked", observedAt: now });
    }
  }
  /** Preserve identity across confirmed replacements; old revisions are recoverable. */
  commit(before: Decoded[], after: Decoded[], operations: MemoryMutationOperation[], source: AdmissionSource[]): void {
    const removed = this.entries.filter(e => e.status === "active" && !after.some(x => x.raw === e.raw));
    this.reconcile(after, source);
    if (operations.length === 1 && operations[0].action === "replace" && removed.length === 1) {
      const added = this.entries.filter(e => e.status === "active" && !before.some(x => x.raw === e.raw));
      if (added.length === 1) { added[0].id = removed[0].id; added[0].revision = removed[0].revision + 1; }
    }
  }
  preflight(entries: Decoded[], operations: MemoryMutationOperation[]): MemoryResult | null {
    const ctx = currentWriteContext();
    const fp = fingerprint(entries.map(e => e.raw));
    if (ctx?.expectedFingerprint && ctx.expectedFingerprint !== fp) return { success: false, error: "Stale memory revision. Inspect current entries and resubmit; nothing was overwritten." };
    if (!operations.length) return null;
    // Never persist secrets/malicious payloads as pending candidates either.
    // Content scanner is applied by the store before this method.
    operations = operations.map(o => ({ ...o, content: o.content?.trim(), oldText: o.oldText?.trim() }));
    const key = hash({ operations, failureProject: ctx?.failureProject, matchRaw: ctx?.matchRaw, requireShrink: ctx?.requireShrink, source: ctx?.sources.filter(s => s.role === "user").slice(-1).map(s => [s.sessionId, s.messageId]) ?? [] });
    const previous = this.candidates.find(c => c.key === key);
    if (previous && ctx?.origin !== "approval") return this.result(previous);
    const adds = operations.every(o => o.action === "add");
    if (adds && operations.every(o => entries.some(e => e.text === o.content?.trim() && e.project === (o.project?.trim() || null)))) {
      return { success: true, message: "Exact duplicate skipped in the same scope.", duplicate: true };
    }
    const similar = operations.filter(o => o.content).flatMap(o => entries
      .filter(e => e.project === (o.project?.trim() || null))
      .map(e => ({ id: this.entries.find(x => x.raw === e.raw && x.status === "active")!.id,
        text: e.text, project: e.project, score: similarity(o.content!, e.text) }))
      .filter(e => e.score >= 0.22)).sort((a,b) => b.score-a.score).slice(0, 8);
    // Only a structurally verified user directive can bypass initial approval.
    // Similar adds always wait; conditions such as S0 versus S4 need review.
    if (ctx?.origin === "approval" || (ctx?.origin === "foreground" && ctx.explicit && ctx.sources.some(s => s.role === "user") && !(adds && similar.length))) return null;
    if (this.candidates.filter(c => c.status === "pending").length >= 200) return { success: false, error: "Pending review limit (200) reached; review existing candidates before proposing more." };
    const candidate: Candidate = { id: randomUUID(), key, operations: structuredClone(operations),
      status: "pending", fingerprint: fp, sources: (ctx?.sources ?? []).map(s => ({ ...s, text: scanContent(s.text) ? "[Source excerpt withheld by content scanner; follow session/message id for evidence]" : s.text })), createdAt: new Date().toISOString(), similar,
      matchRaw: ctx?.matchRaw, requireShrink: ctx?.requireShrink, failureProject: ctx?.failureProject, reason: ctx?.origin === "automatic" ? "Automatic proposal requires review" : similar.length ? "Possible semantic relation; check conditions and scope" : "No explicit verified memory directive" };
    if (ctx?.dryRun) return { success: true, dry_run: true, message: "Dry run: would stage a proposal. Nothing was saved.", preview: candidate };
    this.candidates.push(candidate);
    return this.result(candidate);
  }
  private result(c: Candidate): MemoryResult {
    return { success: false, pending: c.status === "pending", candidate_id: c.id,
      message: `Candidate ${c.id}: ${c.status}. Active memory unchanged.`,
      error: c.status === "pending" ? "Awaiting user review; do not report this as saved." : `Same-source proposal already ${c.status}; do not propose it again.` };
  }
}
