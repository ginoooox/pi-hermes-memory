/** Draft workspace. No provenance, rejected history, embeddings or approval ledger. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withMarkdownMutationLock } from "./markdown-mutation-lock.js";
import { scanContent } from "./content-scanner.js";

export type DraftTarget = "memory" | "user" | "project" | "failure";
export interface Draft {
  id: string;
  kind: "memory" | "skill";
  target: DraftTarget;
  project: string | null;
  action: "add" | "replace" | "remove";
  content: string;
  oldText?: string;
  name?: string;
  description?: string;
  updatedAt: string;
}
export type DraftInput = Omit<Draft, "id" | "updatedAt">;
export interface DraftQueue {
  schema: 1;
  revision: number;
  drafts: Draft[];
  imports: string[];
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const sameScope = (
  a: Pick<Draft, "kind" | "target" | "project">,
  b: Pick<Draft, "kind" | "target" | "project">,
) => a.kind === b.kind && a.target === b.target && a.project === b.project;
export async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function atomicText(
  file: string,
  text: string | null,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (text === null) {
    await fs.rm(file, { force: true });
    return;
  }
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export function validateDraft(value: unknown): DraftInput {
  if (!value || typeof value !== "object") throw new Error("Invalid draft");
  const v = value as DraftInput;
  if (
    !["memory", "skill"].includes(v.kind) ||
    !["memory", "user", "project", "failure"].includes(v.target) ||
    !["add", "replace", "remove"].includes(v.action)
  )
    throw new Error("Invalid draft type");
  const project =
    typeof v.project === "string" ? v.project.trim() || null : null;
  if (
    (v.target === "project" && !project) ||
    (v.target === "user" && project) ||
    (v.target === "memory" && project)
  )
    throw new Error("Invalid draft scope");
  const content = typeof v.content === "string" ? v.content.trim() : "";
  const oldText = typeof v.oldText === "string" ? v.oldText.trim() : undefined;
  if (v.action !== "remove" && !content) throw new Error("Empty draft content");
  if (v.action !== "add" && !oldText)
    throw new Error("Draft edit/delete requires its original text");
  if (content.length > (v.kind === "skill" ? 24000 : 6000))
    throw new Error("Draft too large");
  const name = typeof v.name === "string" ? v.name.trim() : undefined;
  const description =
    typeof v.description === "string" ? v.description.trim() : undefined;
  if (
    v.kind === "skill" &&
    (!name ||
      !/^[-a-z0-9]+$/.test(name) ||
      !description ||
      description.length > 1024 ||
      !["memory", "project"].includes(v.target))
  )
    throw new Error("Invalid skill draft");
  const unsafe = scanContent(
    [content, oldText ?? "", name ?? "", description ?? ""].join("\n"),
  );
  if (unsafe) throw new Error(unsafe);
  return {
    kind: v.kind,
    target: v.target,
    project,
    action: v.action,
    content,
    ...(oldText ? { oldText } : {}),
    ...(v.kind === "skill" ? { name, description } : {}),
  };
}
export class CandidateStore {
  readonly file: string;
  constructor(readonly root: string) {
    this.file = path.join(root, ".candidates", "queue.json");
  }
  async read(): Promise<DraftQueue> {
    const text = await readOptional(this.file);
    if (text === null)
      return { schema: 1, revision: 0, drafts: [], imports: [] };
    const q = JSON.parse(text) as DraftQueue;
    if (
      q.schema !== 1 ||
      !Number.isInteger(q.revision) ||
      !Array.isArray(q.drafts) ||
      !Array.isArray(q.imports)
    )
      throw new Error("Invalid candidate workspace");
    return q;
  }
  async locked<T>(work: (q: DraftQueue) => Promise<T>): Promise<T> {
    return withMarkdownMutationLock(this.file, async () =>
      work(await this.read()),
    );
  }
  async save(q: DraftQueue): Promise<void> {
    await atomicText(this.file, JSON.stringify(q, null, 2) + "\n");
  }
  async stage(
    inputs: DraftInput[],
  ): Promise<{
    success: false;
    pending: true;
    candidate_ids: string[];
    message: string;
  }> {
    const normalized = inputs.map(validateDraft);
    return this.locked(async (q) => {
      const ids: string[] = [];
      let changed = false;
      for (const input of normalized) {
        const exact = q.drafts.find(
          (d) => JSON.stringify(validateDraft(d)) === JSON.stringify(input),
        );
        if (exact) {
          ids.push(exact.id);
          continue;
        }
        // One editable version of each skill, rather than a stack of patch drafts.
        const index =
          input.kind === "skill"
            ? q.drafts.findIndex(
                (d) => sameScope(d, input) && d.name === input.name,
              )
            : -1;
        const d: Draft = {
          ...input,
          id: index >= 0 ? q.drafts[index].id : randomUUID(),
          updatedAt: new Date().toISOString(),
        };
        if (index >= 0) q.drafts[index] = d;
        else q.drafts.push(d);
        ids.push(d.id);
        changed = true;
      }
      if (q.drafts.length > 230)
        throw new Error(
          "Candidate workspace full; run /memory-candidates review",
        );
      if (changed) {
        q.revision++;
        await this.save(q);
      }
      return {
        success: false,
        pending: true,
        candidate_ids: ids,
        message:
          "Staged in the candidate workspace. Not active memory or a discoverable skill; task-end review will prune and merge it.",
      };
    });
  }
  async findSkill(
    name: string,
    project: string | null,
  ): Promise<Draft | undefined> {
    return (await this.read()).drafts.find(
      (d) => d.kind === "skill" && d.name === name && d.project === project,
    );
  }
  /** Import only old pending bodies. Existing formal files and old ledgers are untouched. */
  async importLegacy(
    file: string,
    target: DraftTarget,
    project: string | null,
  ): Promise<void> {
    const raw = await readOptional(file);
    if (!raw) return;
    const marker = digest(file);
    await this.locked(async (q) => {
      if (q.imports.includes(marker)) return;
      const data = JSON.parse(raw);
      for (const c of data.candidates ?? []) {
        if (c.status !== "pending") continue;
        for (const o of c.operations ?? []) {
          const p =
            target === "failure"
              ? (o.project ?? c.failureProject ?? null)
              : project;
          let content = o.content ?? "";
          if (
            target === "failure" &&
            o.category &&
            !/^\[(?:failure|correction|insight|preference|convention|tool-quirk)\]/.test(
              content,
            )
          )
            content = `[${o.category}] ${content}${o.failureReason ? " — Failed: " + o.failureReason : ""}`;
          let input: DraftInput;
          try {
            input = validateDraft({
              kind: "memory",
              target,
              project: p,
              action: o.action,
              content,
              oldText: o.oldText,
            });
          } catch {
            continue;
          }
          if (
            !q.drafts.some(
              (d) => JSON.stringify(validateDraft(d)) === JSON.stringify(input),
            )
          )
            q.drafts.push({
              ...input,
              id: randomUUID(),
              updatedAt: new Date().toISOString(),
            });
        }
      }
      q.imports = [...q.imports, marker].slice(-32);
      q.revision++;
      await this.save(q);
    });
  }
}

export interface CleanupPlan {
  keep: string[];
  drop: string[];
  merge: Array<{ ids: string[]; content: string; description?: string }>;
  add: DraftInput[];
}
/** Every reviewed item gets exactly one disposition; omitted/unseen items never disappear. */
export function applyCleanup(
  q: DraftQueue,
  visible: Draft[],
  plan: CleanupPlan,
  project: string | null,
): DraftQueue {
  if (
    !Array.isArray(plan.keep) ||
    !Array.isArray(plan.drop) ||
    !Array.isArray(plan.merge) ||
    !Array.isArray(plan.add)
  )
    throw new Error("Incomplete cleanup response");
  const byId = new Map(visible.map((d) => [d.id, d]));
  const used = new Set<string>();
  const claim = (id: string) => {
    if (!byId.has(id) || used.has(id))
      throw new Error("Unknown or repeated draft id");
    used.add(id);
    return byId.get(id)!;
  };
  const next = plan.keep.map((id) => claim(id));
  for (const id of plan.drop) claim(id);
  for (const group of plan.merge) {
    if (!Array.isArray(group.ids) || !group.ids.length)
      throw new Error("Empty merge");
    const items = group.ids.map(claim),
      first = items[0];
    if (
      !items.every(
        (d) =>
          sameScope(d, first) &&
          d.action === first.action &&
          d.oldText === first.oldText,
      )
    )
      throw new Error("Cross-scope or incompatible merge");
    const input = validateDraft({
      ...first,
      content: group.content,
      description: group.description ?? first.description,
    });
    next.push({ ...input, id: first.id, updatedAt: new Date().toISOString() });
  }
  if (used.size !== visible.length)
    throw new Error("Cleanup did not cover all reviewed drafts");
  if (plan.add.length > 8) throw new Error("Too many extracted drafts");
  for (const value of plan.add) {
    const d = validateDraft(value);
    if (d.project && d.project !== project)
      throw new Error("Extraction crossed project scope");
    next.push({ ...d, id: randomUUID(), updatedAt: new Date().toISOString() });
  }
  const untouched = q.drafts.filter((d) => !byId.has(d.id));
  const unique: Draft[] = [];
  for (const d of [...untouched, ...next])
    if (
      !unique.some(
        (x) =>
          JSON.stringify(validateDraft(x)) === JSON.stringify(validateDraft(d)),
      )
    )
      unique.push(d);
  return { ...q, revision: q.revision + 1, drafts: unique };
}
export function thresholdReached(drafts: Draft[]): boolean {
  return (
    drafts.filter((d) => d.kind === "memory").length >= 20 ||
    drafts.filter((d) => d.kind === "skill").length >= 3
  );
}
