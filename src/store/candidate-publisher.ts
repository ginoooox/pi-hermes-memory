/** Crash-recoverable publication. Individual file renames, CAS, ordered upstream locks. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import {
  CandidateStore,
  type Draft,
  type DraftQueue,
  digest,
  atomicText,
  readOptional,
  sameScope,
} from "./candidate-store.js";
import { withMarkdownMutationLock } from "./markdown-mutation-lock.js";
import { ENTRY_DELIMITER } from "../constants.js";
import { parseFrontmatter, formatFrontmatter, today } from "./skill-utils.js";
import { scanContent } from "./content-scanner.js";

export interface FormalItem {
  id: string;
  kind: "memory" | "skill";
  target: Draft["target"];
  project: string | null;
  content: string;
  name?: string;
  description?: string;
  readonly?: boolean;
  file: string;
  raw: string;
}
export interface FormalSnapshot {
  items: FormalItem[];
  files: Record<string, string | null>;
  complete: boolean;
}
export interface Publication {
  id: string;
  action: "discard" | "add" | "replace" | "merge" | "remove";
  existing?: string[];
  content?: string;
  description?: string;
}
export interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
}
const decode = (raw: string) => {
  const m = raw.match(
    /^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/s,
  );
  return {
    text: m ? m[1].trim() : raw.trim(),
    created: m ? m[2].trim() : today(),
    project: m?.[4] ? Buffer.from(m[4], "base64url").toString("utf8") : null,
  };
};
const encode = (text: string, created: string, project: string | null) =>
  `${text} <!-- created=${created}, last=${today()}${project ? ", project64=" + Buffer.from(project).toString("base64url") : ""} -->`;
export class CandidatePublisher {
  constructor(
    readonly queue: CandidateStore,
    readonly projectRoot: string | null,
    readonly project: string | null,
    readonly nativeSkills: string,
  ) {}
  private memoryFile(target: Draft["target"]): string {
    if (target === "project") {
      if (!this.projectRoot) throw new Error("Missing project root");
      return path.join(this.projectRoot, "MEMORY.md");
    }
    return path.join(
      this.queue.root,
      target === "user"
        ? "USER.md"
        : target === "failure"
          ? "failures.md"
          : "MEMORY.md",
    );
  }
  private skillRoot(project: string | null): string {
    if (project) {
      if (project !== this.project || !this.projectRoot)
        throw new Error("Wrong skill project");
      return path.join(this.projectRoot, "skills");
    }
    return path.join(this.queue.root, "skills");
  }
  async snapshot(): Promise<FormalSnapshot> {
    const snapshot: FormalSnapshot = { items: [], files: {}, complete: true };
    let bytes = 0;
    for (const target of [
      "user",
      "memory",
      "failure",
      ...(this.projectRoot ? ["project"] : []),
    ] as Draft["target"][]) {
      const file = this.memoryFile(target),
        raw = await readOptional(file);
      snapshot.files[file] = raw;
      for (const [index, entry] of (raw ?? "")
        .split(ENTRY_DELIMITER)
        .filter((s) => s.trim())
        .entries()) {
        const d = decode(entry),
          project =
            target === "project"
              ? this.project
              : target === "failure"
                ? d.project
                : null;
        if (project && project !== this.project) continue;
        snapshot.items.push({
          id: digest(file + index + entry),
          kind: "memory",
          target,
          project,
          content: d.text,
          file,
          raw: entry,
        });
        bytes += entry.length;
      }
    }
    const roots = [
      { root: this.skillRoot(null), project: null, readonly: false },
      { root: this.nativeSkills, project: null, readonly: true },
      ...(this.projectRoot
        ? [
            {
              root: this.skillRoot(this.project),
              project: this.project,
              readonly: false,
            },
          ]
        : []),
    ];
    for (const r of roots) {
      let dirs;
      try {
        dirs = await fs.readdir(r.root, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      const children = dirs
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      if (children.length > 100) snapshot.complete = false;
      for (const child of children.slice(0, 100)) {
        const file = path.join(r.root, child.name, "SKILL.md");
        let raw: string;
        try {
          const h = await fs.open(
            file,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const stat = await h.stat();
            if (
              !stat.isFile() ||
              stat.size > 65536 ||
              bytes + stat.size > 256000
            ) {
              snapshot.complete = false;
              continue;
            }
            raw = await h.readFile("utf8");
          } finally {
            await h.close();
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        snapshot.files[file] = raw;
        const parsed = parseFrontmatter(raw);
        snapshot.items.push({
          id: digest(file + raw),
          kind: "skill",
          target: r.project ? "project" : "memory",
          project: r.project,
          content: parsed.body,
          description: parsed.meta.description,
          name: child.name,
          readonly: r.readonly,
          file,
          raw,
        });
        bytes += raw.length;
      }
    }
    if (bytes > 256000) snapshot.complete = false;
    return snapshot;
  }
  async plan(
    drafts: Draft[],
    decisions: Publication[],
    snapshot: FormalSnapshot,
  ): Promise<FileChange[]> {
    if (!snapshot.complete)
      throw new Error("Formal coverage incomplete; promotion deferred");
    if (!Array.isArray(decisions) || decisions.length !== drafts.length)
      throw new Error("Promotion must decide every draft");
    const candidates = new Map(drafts.map((d) => [d.id, d])),
      used = new Set<string>(),
      referenced = new Set<string>();
    const items = new Map(snapshot.items.map((e) => [e.id, e]));
    const edits = new Map<string, { remove: Set<string>; add: string[] }>();
    const changes = new Map<string, FileChange>();
    for (const decision of decisions) {
      const d = candidates.get(decision.id);
      if (!d || used.has(d.id))
        throw new Error("Unknown or duplicate promotion id");
      used.add(d.id);
      if (decision.action === "discard") continue;
      if (!["add", "replace", "merge", "remove"].includes(decision.action))
        throw new Error("Invalid publication action");
      const refs = (decision.existing ?? []).map((id) => {
        const e = items.get(id);
        if (!e || e.readonly || !sameScope(e, d) || referenced.has(id))
          throw new Error(
            "Invalid, readonly, cross-scope or reused formal reference",
          );
        referenced.add(id);
        return e;
      });
      if (decision.action === "add" && refs.length)
        throw new Error("Add cannot overwrite formal entries");
      if (decision.action !== "add" && !refs.length)
        throw new Error("Replacement requires a formal reference");
      if (
        decision.action === "remove" &&
        (d.action !== "remove" || refs.some((e) => e.content !== d.oldText))
      )
        throw new Error("Formal deletion requires an exact deletion draft");
      if (d.action === "remove" && decision.action !== "remove")
        throw new Error("Deletion draft cannot become new knowledge");
      const content = (decision.content ?? d.content).trim();
      if (
        decision.action !== "remove" &&
        (!content ||
          content.length > (d.kind === "skill" ? 24000 : 6000) ||
          scanContent(content))
      )
        throw new Error("Invalid publication content");
      if (d.kind === "memory") {
        const file = this.memoryFile(d.target);
        let edit = edits.get(file);
        if (!edit) {
          edit = { remove: new Set(), add: [] };
          edits.set(file, edit);
        }
        for (const ref of refs) edit.remove.add(ref.raw);
        if (decision.action !== "remove") {
          const existing = snapshot.items.some(
            (e) =>
              sameScope(e, d) &&
              e.content === content &&
              !refs.some((r) => r.id === e.id),
          );
          if (existing || edit.add.some((raw) => decode(raw).text === content))
            throw new Error("Exact formal duplicate");
          edit.add.push(
            encode(
              content,
              refs.length ? decode(refs[0].raw).created : today(),
              d.target === "failure" ? d.project : null,
            ),
          );
        }
      } else {
        const primary = refs[0];
        const file =
          primary?.file ??
          path.join(this.skillRoot(d.project), d.name!, "SKILL.md");
        if (
          !primary &&
          snapshot.items.some((e) => e.kind === "skill" && e.name === d.name)
        )
          throw new Error("Skill name already discoverable");
        if (changes.has(file)) throw new Error("Repeated skill destination");
        await this.checkDestination(file);
        if (!primary && (await readOptional(file)) !== null)
          throw new Error("New skill appeared during review");
        let after: string | null = null;
        if (decision.action !== "remove") {
          for (const section of ["When to Use", "Procedure", "Verification"])
            if (!new RegExp("^## " + section + "\\s*$", "m").test(content))
              throw new Error("Skill lacks required sections");
          const description = decision.description ?? d.description!;
          if (
            !description ||
            description.length > 1024 ||
            scanContent(description)
          )
            throw new Error("Invalid skill description");
          // Validate concrete relative script references, without executing any action.
          const scriptRefs = [
            ...content.matchAll(
              /`((?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.(?:[cm]?js|py|sh|ps1))`/g,
            ),
          ];
          for (const ref of scriptRefs) {
            if (ref[1].split("/").includes(".."))
              throw new Error("Unsafe script reference");
            await fs.access(path.join(path.dirname(file), ref[1]));
          }
          const old = primary ? parseFrontmatter(primary.raw).meta : {};
          after = formatFrontmatter({
            name: primary?.name ?? d.name!,
            description,
            version: parseInt(old.version ?? "0", 10) + 1,
            created: old.created ?? today(),
            updated: today(),
            body: content,
          });
        }
        changes.set(file, {
          file,
          before: snapshot.files[file] ?? null,
          after,
        });
        for (const ref of refs.slice(1)) {
          if (changes.has(ref.file)) throw new Error("Overlapping skill merge");
          changes.set(ref.file, {
            file: ref.file,
            before: ref.raw,
            after: null,
          });
        }
      }
    }
    for (const [file, edit] of edits) {
      const before = snapshot.files[file] ?? null;
      const entries = (before ?? "")
        .split(ENTRY_DELIMITER)
        .filter((e) => e.trim() && !edit.remove.has(e));
      const after = [...entries, ...edit.add].join(ENTRY_DELIMITER);
      changes.set(file, { file, before, after });
    }
    return [...changes.values()].filter((c) => c.before !== c.after);
  }
  private async checkDestination(file: string): Promise<void> {
    const roots = [
      this.skillRoot(null),
      ...(this.projectRoot ? [this.skillRoot(this.project)] : []),
    ];
    if (!roots.some((root) => file.startsWith(root + path.sep)))
      throw new Error("Skill outside managed roots");
    let dir = path.dirname(file);
    while (dir !== path.dirname(dir)) {
      try {
        const stat = await fs.lstat(dir);
        if (stat.isSymbolicLink()) throw new Error("Symlink skill destination");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (roots.includes(dir)) break;
      dir = path.dirname(dir);
    }
    try {
      if ((await fs.lstat(file)).isSymbolicLink())
        throw new Error("Symlink skill file");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  private async fileLocks<T>(
    files: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const sorted = [...new Set(files)].sort();
    const step = (i: number): Promise<T> =>
      i === sorted.length
        ? fn()
        : withMarkdownMutationLock(sorted[i], () => step(i + 1));
    return step(0);
  }
  async commit(
    before: DraftQueue,
    after: DraftQueue,
    changes: FileChange[],
    formal?: FormalSnapshot,
  ): Promise<void> {
    await this.queue.locked(async (current) => {
      if (JSON.stringify(current) !== JSON.stringify(before))
        throw new Error("Candidate workspace changed during review");
      await this.fileLocks(
        Object.keys(formal?.files ?? {}).concat(changes.map((c) => c.file)),
        async () => {
          for (const [file, text] of Object.entries(formal?.files ?? {}))
            if ((await readOptional(file)) !== text)
              throw new Error("Formal knowledge changed during review");
          for (const c of changes)
            if ((await readOptional(c.file)) !== c.before)
              throw new Error("Publication destination changed");
          if (!changes.length) {
            await this.queue.save(after);
            return;
          }
          const tx = { before, after, changes };
          const journal = path.join(
            this.queue.root,
            ".candidates",
            "transaction.json",
          );
          await atomicText(journal, JSON.stringify(tx));
          await this.finish(tx, journal);
        },
      );
    });
  }
  private async finish(
    tx: { before: DraftQueue; after: DraftQueue; changes: FileChange[] },
    journal: string,
  ): Promise<void> {
    await atomicText(
      path.join(this.queue.root, ".previous-formal.json"),
      JSON.stringify({
        schema: 1,
        at: new Date().toISOString(),
        files: tx.changes.map((c) => ({
          file: c.file,
          content: c.before,
          afterHash: digest(c.after ?? "[missing]"),
        })),
      }),
    );
    for (const c of tx.changes) await atomicText(c.file, c.after);
    await this.queue.save(tx.after);
    await fs.rm(journal, { force: true });
  }
  async rollback(): Promise<void> {
    const raw = await readOptional(
      path.join(this.queue.root, ".previous-formal.json"),
    );
    if (!raw) throw new Error("No previous formal version");
    const previous = JSON.parse(raw) as {
      files: Array<{ file: string; content: string | null; afterHash: string }>;
    };
    const changes: FileChange[] = [];
    for (const old of previous.files) {
      const allowed =
        [
          "user",
          "memory",
          "failure",
          ...(this.projectRoot ? ["project"] : []),
        ].some((t) => this.memoryFile(t as Draft["target"]) === old.file) ||
        [
          this.skillRoot(null),
          ...(this.projectRoot ? [this.skillRoot(this.project)] : []),
        ].some(
          (r) =>
            old.file.startsWith(r + path.sep) &&
            path.basename(old.file) === "SKILL.md",
        );
      if (!allowed)
        throw new Error(
          "Rollback belongs to a different project or unmanaged path",
        );
      const before = await readOptional(old.file);
      if (digest(before ?? "[missing]") !== old.afterHash)
        throw new Error(
          "Formal knowledge changed since publication; rollback refused",
        );
      changes.push({ file: old.file, before, after: old.content });
    }
    const q = await this.queue.read();
    await this.commit(q, { ...q, revision: q.revision + 1 }, changes);
  }
  async recover(): Promise<void> {
    const journal = path.join(
      this.queue.root,
      ".candidates",
      "transaction.json",
    );
    await this.queue.locked(async (current) => {
      const raw = await readOptional(journal);
      if (!raw) return;
      const tx = JSON.parse(raw) as {
        before: DraftQueue;
        after: DraftQueue;
        changes: FileChange[];
      };
      if (
        JSON.stringify(current) !== JSON.stringify(tx.before) &&
        JSON.stringify(current) !== JSON.stringify(tx.after)
      )
        throw new Error("Recovery candidate conflict");
      await this.fileLocks(
        tx.changes.map((c) => c.file),
        async () => {
          for (const c of tx.changes) {
            const now = await readOptional(c.file);
            if (now !== c.before && now !== c.after)
              throw new Error("Recovery conflicts with an external edit");
          }
          await this.finish(tx, journal);
        },
      );
    });
  }
}
