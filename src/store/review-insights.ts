/** Bounded review projections. These are retrieval hints, never decisions or proof. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { similarity, fingerprint, type Candidate, type AdmissionEntry, type AdmissionSource } from "./write-admission.js";

export function sourceEvidence(sources: AdmissionSource[]) {
  const records = new Map<string, AdmissionSource>();
  let excluded = 0, repeated = 0;
  const inconsistent: string[] = [];
  for (const s of sources) {
    if (!["user", "toolResult"].includes(s.role) || !s.sessionId || !s.messageId) { excluded++; continue; }
    const key = JSON.stringify([s.sessionId, s.messageId, s.role]);
    const prior = records.get(key);
    if (prior) { repeated++; if (prior.text !== s.text) inconsistent.push(key); }
    else records.set(key, s);
  }
  const unique = [...records.values()];
  return { association_only: true, entailment: "not_verified", unique_messages: unique.length,
    user_messages: unique.filter(s => s.role === "user").length,
    tool_observations: unique.filter(s => s.role === "toolResult").length,
    repeated_messages: repeated, excluded_roles_or_missing_ids: excluded,
    inconsistent_message_ids: [...new Set(inconsistent)],
    sources: unique.slice(0, 12).map(s => ({ ...s, text: s.text.slice(0, 2500) })),
    truncated: unique.length > 12 };
}
const scope = (c: Candidate) => JSON.stringify(c.operations.map(o => o.project?.trim() || c.failureProject || null));
const body = (c: Candidate) => c.operations.map(o => o.content ?? o.oldText ?? "").join("\n");
const singleAdd = (c: Candidate) => c.operations.length === 1 && c.operations[0].action === "add";
export function candidateAssessment(c: Candidate, entries: AdmissionEntry[], raw: string[]) {
  const active = entries.filter(e => e.status === "active");
  const related = c.operations.flatMap(o => active.filter(e => e.project === (o.project?.trim() || c.failureProject || null))
    .map(e => ({ id: e.id, revision: e.revision, project: e.project, text: e.text.slice(0, 500),
      exact: e.text === o.content?.trim(), score: similarity(o.content ?? o.oldText ?? "", e.text) })))
    .filter(e => e.exact || e.score >= 0.22).sort((a,b) => Number(b.exact)-Number(a.exact) || b.score-a.score);
  return { stale: c.fingerprint !== fingerprint(raw), fingerprint: c.fingerprint,
    current_fingerprint: fingerprint(raw), related_active: related.slice(0, 5),
    exact_duplicate: singleAdd(c) && related.some(e => e.exact),
    warning: "Similarity is retrieval only. Check device, scope, negation, dates and conditions; source association does not prove the claim." };
}
export function candidateGroups(candidates: Candidate[], entries: AdmissionEntry[], raw: string[], limit: number, offset: number) {
  const pending = candidates.filter(c => c.status === "pending").slice().sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const groups: Candidate[][] = [];
  for (const c of pending) {
    // Complete-link grouping prevents A~B~C from silently grouping unrelated A and C.
    const group = singleAdd(c) && groups.find(g => g.every(other => singleAdd(other) && scope(c) === scope(other)
      && (body(c).trim() === body(other).trim() || similarity(body(c), body(other)) >= 0.48)));
    if (group) group.push(c); else groups.push([c]);
  }
  return { success: true, advisory_only: true, total_candidates: pending.length, total: groups.length, offset,
    groups: groups.slice(offset, offset+limit).map(g => ({ anchor_id: g[0].id, count: g.length,
      candidate_ids: g.map(c => c.id), truncated: g.length > 12, candidates: g.slice(0,12).map(c => {
        const assessment = candidateAssessment(c, entries, raw);
        return { id: c.id, operation_count: c.operations.length, operations_truncated: c.operations.length > 6, operations: c.operations.slice(0,6).map(o => ({ action: o.action, project: o.project ?? c.failureProject ?? null,
          content: o.content?.slice(0, 240), oldText: o.oldText?.slice(0, 240) })), stale: assessment.stale,
          exact_duplicate: assessment.exact_duplicate, related_active_ids: assessment.related_active.map(e => e.id) };
      }),
      evidence: (() => { const { sources, ...counts } = sourceEvidence(g.flatMap(c => c.sources));
        return { ...counts, source_ids: sources.map(({sessionId,messageId,role}) => ({sessionId,messageId,role})), excerpt_action:"evidence" }; })() })),
    warning: "Groups are proposals for inspection. No candidates were merged or approved. Evidence counts measure unique messages, not independent support or user confirmations." };
}
export function entryImpact(entry: AdmissionEntry, entries: AdmissionEntry[], candidates: Candidate[], limit: number, offset: number) {
  const references = entries.filter(e => e.status === "active" && e.id !== entry.id && e.text.includes(entry.id));
  const pending = candidates.filter(c => c.status === "pending" && c.operations.some(o =>
    (o.content ?? "").includes(entry.id) || (o.oldText && entry.text.includes(o.oldText) && (o.project?.trim() || c.failureProject || null) === entry.project)));
  return { success: true, advisory_only: true, entry_id: entry.id, revision: entry.revision, status: entry.status,
    total: references.length, offset, explicit_id_references: references.slice(offset,offset+limit).map(e => ({ id:e.id, revision:e.revision, project:e.project, text:e.text.slice(0,500) })),
    pending_operation_total: pending.length, pending_operations: pending.slice(0,limit).map(c => ({id:c.id, reason:c.reason})),
    warning: "Only explicit entry-ID references and pending operations in this ledger are checked. These are review leads, not a complete dependency graph. No automatic invalidation or deletion occurs." };
}

/** Scan only named skill roots, bounded files and bytes; never follow symlink children. */
export async function skillReferences(roots: string[], id: string) {
  const matches: Array<{file:string}> = []; const errors: string[] = []; let scanned = 0, truncated = false;
  for (const root of [...new Set(roots)]) {
    try {
      if (!(await fs.lstat(root)).isDirectory()) { errors.push(root); continue; }
      const names = await fs.readdir(root, {withFileTypes:true});
      const dirs = names.filter(d=>d.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name));
      if (dirs.length > 200) truncated = true;
      for (const d of dirs.slice(0,200)) {
        const dir = path.join(root,d.name); const file = path.join(dir,"SKILL.md");
        try {
          if (!(await fs.lstat(dir)).isDirectory()) { errors.push(file); continue; }
          const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > 65536) { truncated = true; continue; }
            const buffer = Buffer.alloc(65537); const {bytesRead} = await handle.read(buffer,0,buffer.length,0);
            if (bytesRead > 65536) { truncated = true; continue; }
            scanned++; if (buffer.toString("utf8",0,bytesRead).includes(id)) matches.push({file});
          } finally { await handle.close(); }
        } catch(e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") errors.push(file); }
      }
    } catch(e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") errors.push(root); }
  }
  return { explicit_id_references: matches.slice(0,100), scanned, truncated: truncated || matches.length > 100,
    total: matches.length, unreadable: errors.slice(0,20), incomplete: truncated || errors.length > 0,
    coverage: "Direct SKILL.md children of the reported roots only; text references are leads, not verified dependencies.", roots:[...new Set(roots)] };
}
