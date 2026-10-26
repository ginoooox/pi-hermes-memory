import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  CandidateStore,
  applyCleanup,
  thresholdReached,
  contentDigest,
  pendingSince,
  atomicText,
  readOptional,
  boundedFingerprints,
  FORMAL_FINGERPRINT_CAP,
  type DraftInput,
} from "../../src/store/candidate-store.js";
import {
  CandidatePublisher,
  type Publication,
} from "../../src/store/candidate-publisher.js";
import {
  CandidateLifecycle,
  CLEANUP_POLICY,
  PROMOTION_POLICY,
  reviewBatch,
  cleanupFormalData,
} from "../../src/handlers/candidate-lifecycle.js";
import { publicationOutcome } from "../../src/handlers/candidate-publication-metrics.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { loadConfig } from "../../src/config.js";
import { formatFrontmatter, today } from "../../src/store/skill-utils.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";
let root: string, q: CandidateStore, pub: CandidatePublisher;
const input = (
  content = "Permanent fact",
  project: string | null = null,
): DraftInput => ({
  kind: "memory",
  target: project ? "project" : "memory",
  project,
  action: "add",
  content,
});
const body =
  "## When to Use\nReusable release task\n\n## Procedure\n1. Inspect result\n\n## Pitfalls\n- Preserve conditions\n\n## Verification\n1. Read back state";
const skill = (name = "release-task"): DraftInput => ({
  kind: "skill",
  target: "memory",
  project: null,
  action: "add",
  name,
  description: "Release reusable task",
  content: body,
});
const keep = (ids: string[]) => ({ keep: ids, drop: [], merge: [], add: [] });
const context = () =>
  ({
    cwd: root,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "s",
      getBranch: () => [
        {
          type: "message",
          id: "u1",
          message: {
            role: "user",
            content: [
              { type: "text", text: "A completed task with real observations" },
            ],
          },
        },
        {
          type: "message",
          id: "t1",
          message: {
            role: "toolResult",
            content: [{ type: "text", text: "verified=true" }],
          },
        },
      ],
    },
    ui: { notify: () => {} },
  }) as any;
const options = (call: any) => ({
  queue: q,
  config: loadConfig(path.join(root, "none")),
  nativeSkills: path.join(root, "native"),
  project: () => ({ name: "demo", root: path.join(root, "project") }),
  ensureReady: async () => {},
  synchronize: async () => {},
  call,
});
describe("candidate lifecycle", { concurrency: 1 }, () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-v2-"));
    q = new CandidateStore(path.join(root, "global"));
    pub = new CandidatePublisher(
      q,
      path.join(root, "project"),
      "demo",
      path.join(root, "native"),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it("stages without active files or provenance/history", async () => {
    const r = await q.stage([input()]);
    assert.equal(r.pending, true);
    assert.equal(await readOptional(path.join(q.root, "MEMORY.md")), null);
    const d = (await q.read()).drafts[0];
    assert.equal((d as any).sources, undefined);
    assert.equal((d as any).quality, undefined);
    assert.equal((await fs.stat(q.file)).mode & 0o777, 0o600);
  });
  it("deduplicates identical drafts regardless of task message", async () => {
    await q.stage([input(), input()]);
    await q.stage([input()]);
    assert.equal((await q.read()).drafts.length, 1);
  });
  it("keeps separate scope copies", async () => {
    await q.stage([input(), input("Permanent fact", "demo")]);
    assert.equal((await q.read()).drafts.length, 2);
  });
  it("rejects secrets before staging", async () => {
    await assert.rejects(q.stage([input("sk-" + "x".repeat(30))]));
    assert.equal((await q.read()).drafts.length, 0);
  });
  it("keeps one editable skill draft", async () => {
    await q.stage([skill()]);
    await q.stage([{ ...skill(), content: body + "\n2. More validation" }]);
    assert.equal((await q.read()).drafts.length, 1);
  });
  it("destructively merges and deletes drafts without tombstones", async () => {
    await q.stage([
      input("One fact"),
      input("Same fact differently"),
      input("Uncertain"),
    ]);
    const before = await q.read(),
      [a, b, c] = before.drafts;
    const after = applyCleanup(
      before,
      before.drafts,
      {
        keep: [],
        drop: [c.id],
      dropReasons: { [c.id]: { category: "uncertain", basis: "Fixture explicitly describes an unresolved diagnosis" } },
        merge: [{ ids: [a.id, b.id], content: "One complete fact" }],
        add: [],
      },
      "demo",
    );
    await pub.commit(before, after, []);
    assert.equal((await q.read()).drafts.length, 1);
    assert.equal((await q.read()).drafts[0].content, "One complete fact");
    assert.equal(
      await readOptional(path.join(q.root, ".previous-formal.json")),
      null,
    );
  });
  for (const bad of ["missing", "repeated", "unknown", "cross-scope"]) {
    it("rejects " + bad + " cleanup disposition", async () => {
      await q.stage([input(), input("Project fact", "demo")]);
      const before = await q.read(),
        [a, b] = before.drafts;
      const plan: any =
        bad === "missing"
          ? keep([a.id])
          : bad === "repeated"
            ? { ...keep([a.id, b.id]), drop: [a.id] }
            : bad === "unknown"
              ? keep([a.id, "bogus"])
              : {
                  keep: [],
                  drop: [],
                  merge: [{ ids: [a.id, b.id], content: "Merged" }],
                  add: [],
                };
      assert.throws(() => applyCleanup(before, before.drafts, plan, "demo"));
      assert.deepEqual(await q.read(), before);
    });
  }
  it("does not delete unseen or other-project drafts", async () => {
    await q.stage([input(), input("Other", "elsewhere")]);
    const before = await q.read(),
      visible = reviewBatch(before.drafts, "demo");
    const after = applyCleanup(
      before,
      visible,
      { keep: [], drop: visible.map((d) => d.id), dropReasons: Object.fromEntries(visible.map(d => [d.id, { category: "transient" as const, basis: "Synthetic temporary fact" }])), merge: [], add: [] },
      "demo",
    );
    assert.equal(after.drafts[0].project, "elsewhere");
  });
  it("rejects extracted cross-project knowledge", async () => {
    assert.throws(() =>
      applyCleanup(
        { schema: 1, revision: 0, drafts: [], imports: [] },
        [],
        { ...keep([]), add: [input("Wrong", "elsewhere")] },
        "demo",
      ),
    );
  });
  it("triggers at 10 memories OR 2 skills after deduplication", async () => {
    await q.stage(Array.from({ length: 9 }, (_, i) => input("fact " + i)));
    assert.equal(thresholdReached((await q.read()).drafts), false);
    await q.stage([input("fact 9")]);
    assert.equal(thresholdReached((await q.read()).drafts), true);
    assert.equal(
      thresholdReached(
        [0, 1].map((i) => ({
          ...skill("task-" + i),
          id: String(i),
          updatedAt: "now",
        })),
      ),
      true,
    );
  });
  it("routine cleanup resends only new or changed drafts and still extracts from fresh context", async () => {
    await q.stage([input("Established fact")]);
    const batches: string[][] = [];
    const call = async (phase: string, data: any) => {
      if (phase === "cleanup") {
        batches.push(data.drafts.map((d: any) => d.content));
        return {
          ...keep(data.drafts.map((d: any) => d.id)),
          ...(batches.length === 2
            ? { add: [input("Extracted from fresh context")] }
            : {}),
        };
      }
      return {
        decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })),
      };
    };
    const engine = new CandidateLifecycle(options(call));
    await engine.review(context());
    assert.deepEqual(batches, [["Established fact"]]);
    let drafts = (await q.read()).drafts;
    assert.equal(drafts[0].reviewedDigest, contentDigest(drafts[0]));
    // Another project's draft is never exposed; the reviewed, unchanged draft
    // is not resent, yet the fresh task context is still model-extracted.
    await q.stage([input("Unrelated other-project fact", "other")]);
    const branch = (id: string, text: string) => [
      { type: "message", id, message: { role: "user", content: [{ type: "text", text }] } },
    ];
    const ctx2 = context();
    ctx2.sessionManager.getBranch = () => branch("u2", "Another completed task");
    const r2 = await engine.review(ctx2);
    assert.deepEqual(batches, [["Established fact"], []]);
    assert.equal(r2.promoted, 0);
    drafts = (await q.read()).drafts;
    assert.equal(drafts.length, 3);
    assert.equal(drafts.find((d) => d.project === "other")!.reviewedDigest, undefined);
    assert.equal(
      drafts.find((d) => d.content === "Extracted from fresh context")!.reviewedDigest,
      contentDigest(drafts.find((d) => d.content === "Extracted from fresh context")!),
    );
    await assert.rejects(fs.readFile(path.join(q.root, "MEMORY.md"), "utf8"));
  });
  it("a single-ID rewrite re-enters routine cleanup with its original pending time", async () => {
    await q.stage([skill()]);
    const batches: string[][] = [];
    const call = async (phase: string, data: any) => {
      if (phase !== "cleanup") return { decisions: [] };
      batches.push(data.drafts.map((d: any) => d.name));
      return keep(data.drafts.map((d: any) => d.id));
    };
    const engine = new CandidateLifecycle(options(call));
    await engine.review(context());
    assert.deepEqual(batches, [["release-task"]]);
    await q.stage([{ ...skill(), content: body + "\n2. Extra step" }]);
    const rewritten = (await q.read()).drafts[0];
    // Restaging drops the stale review marker, so the changed body re-enters.
    assert.equal(rewritten.reviewedDigest, undefined);
    assert.notEqual(rewritten.reviewedDigest, contentDigest(rewritten));
    const ctx2 = context();
    ctx2.sessionManager.getBranch = () => [
      { type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "Second completed task" }] } },
    ];
    await engine.review(ctx2);
    assert.deepEqual(batches, [["release-task"], ["release-task"]]);
    const kept = (await q.read()).drafts[0];
    assert.equal(kept.id, rewritten.id);
    assert.equal(kept.reviewedDigest, contentDigest(kept));
    assert.equal(kept.stagedAt, rewritten.stagedAt);
  });
  it("a failed cleanup call does not stamp its input receipt", async () => {
    await q.stage([input("Retry me")]);
    let calls = 0;
    const call = async (phase: string, data: any) => {
      if (phase !== "cleanup") return { decisions: [] };
      if (++calls === 1) throw new Error("provider down");
      return keep(data.drafts.map((d: any) => d.id));
    };
    await assert.rejects(
      new CandidateLifecycle(options(call)).review(context()),
      /provider down/,
    );
    let queue = await q.read();
    assert.equal(queue.drafts.length, 1);
    assert.equal(Object.keys(queue.cleanupInputs ?? {}).length, 0);
    assert.equal(queue.drafts[0].reviewedDigest, undefined);
    await new CandidateLifecycle(options(call)).review(context());
    assert.equal(calls, 2);
    queue = await q.read();
    assert.equal(Object.keys(queue.cleanupInputs ?? {}).length, 1);
    assert.equal(queue.drafts[0].reviewedDigest, contentDigest(queue.drafts[0]));
  });
  it("24h pending fallback triggers full admission at task end", async () => {
    await q.stage([input("Old waiting fact")]);
    await q.locked(async (qr) => {
      qr.drafts[0].stagedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      await q.save(qr);
    });
    const phases: string[] = [];
    const r = await new CandidateLifecycle(
      options(async (phase: string, data: any) => {
        phases.push(phase);
        return phase === "cleanup"
          ? keep(data.drafts.map((d: any) => d.id))
          : { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })) };
      }),
    ).review(context());
    assert.deepEqual(phases, ["cleanup", "promotion"]);
    assert.equal(r.promoted, 1);
    assert.deepEqual(r.thresholds, { memory: 10, skill: 2 });
    assert.ok(
      (await fs.readFile(path.join(q.root, "MEMORY.md"), "utf8")).includes("Old waiting fact"),
    );
  });
  it("exact repeated reviewed inputs skip the cleanup model call across reload", async () => {
    await q.stage([input("Once judged")]);
    let cleanupCalls = 0;
    const call = async (phase: string, data: any) =>
      phase === "cleanup"
        ? (cleanupCalls++, keep(data.drafts.map((d: any) => d.id)))
        : { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })) };
    await new CandidateLifecycle(options(call)).review(context());
    assert.equal(cleanupCalls, 1);
    // A fresh engine stands in for a reloaded process. The unchanged draft is
    // excluded from the delta batch, so the repeated empty-delta input with
    // the same task context and formal fingerprint skips the model call.
    await new CandidateLifecycle(options(call)).review(context());
    assert.equal(cleanupCalls, 2);
    const r = await new CandidateLifecycle(options(call)).review(context());
    assert.equal(cleanupCalls, 2);
    assert.equal(r.cleanupInputSkipped, 1);
    assert.equal((await q.read()).drafts.length, 1);
    // Manual review always runs the actual model call and full admission.
    await new CandidateLifecycle(options(call)).review(context(), true);
    assert.equal(cleanupCalls, 3);
    assert.equal((await q.read()).drafts.length, 0);
  });
  it("keeps oldest pending time stable across rewrites and merges", async () => {
    await q.stage([skill()]);
    const original = (await q.read()).drafts[0].stagedAt!;
    assert.ok(original);
    await q.stage([{ ...skill(), content: body + "\n2. Extra step" }]);
    assert.equal((await q.read()).drafts[0].stagedAt, original);
    await q.stage([input("A fact"), input("A similar fact")]);
    const before = await q.read();
    const skillId = before.drafts.find((d) => d.kind === "skill")!.id;
    const [a, b] = before.drafts.filter((d) => d.kind === "memory");
    const after = applyCleanup(
      before,
      before.drafts,
      {
        keep: [skillId],
        drop: [],
        merge: [{ ids: [a.id, b.id], content: "One merged fact" }],
        add: [input("Extracted fact")],
      },
      "demo",
    );
    assert.equal(after.drafts.find((d) => d.id === a.id)!.stagedAt, a.stagedAt);
    assert.ok(after.drafts.find((d) => d.content === "Extracted fact")!.stagedAt);
    // Legacy drafts without a staging time fall back to their honest update time.
    const legacy = { ...input("Legacy"), id: "legacy", updatedAt: "2020-01-01T00:00:00.000Z" } as any;
    delete legacy.stagedAt;
    assert.equal(pendingSince(legacy), "2020-01-01T00:00:00.000Z");
    assert.notEqual(contentDigest(legacy as any), contentDigest(input("Legacy different")));
  });
  it("imports only legacy pending operations once, without sources or decisions", async () => {
    const file = path.join(root, "legacy.json");
    await atomicText(
      file,
      JSON.stringify({
        candidates: [
          {
            status: "pending",
            operations: [{ action: "add", content: "Imported" }],
            sources: [{ text: "do not persist" }],
          },
          {
            status: "approved",
            operations: [{ action: "add", content: "Ignore" }],
          },
        ],
      }),
    );
    await q.importLegacy(file, "memory", null);
    let before = await q.read();
    assert.equal(before.drafts.length, 1);
    assert.ok(!JSON.stringify(before).includes("do not persist"));
    await pub.commit(
      before,
      { ...before, revision: before.revision + 1, drafts: [] },
      [],
    );
    await q.importLegacy(file, "memory", null);
    assert.equal((await q.read()).drafts.length, 0);
  });
  it("stages all MemoryStore entry points without observer/SQLite writes", async () => {
    const store = new MemoryStore({
      ...loadConfig(path.join(root, "none")),
      memoryDir: q.root,
    });
    await store.loadFromDisk();
    let observed = 0;
    store.setMutationObserver(async () => {
      observed++;
      return null;
    });
    new CandidateLifecycle(options(async () => ({}))).attach(store);
    assert.equal((await store.add("memory", "a")).success, false);
    await store.replace("memory", "old", "new");
    await store.remove("memory", "old");
    await store.addFailure("A failure", {
      category: "failure",
      project: "demo",
    });
    await store.applyMutationPlan("user", [
      { action: "add", content: "A preference" },
    ]);
    assert.equal((await q.read()).drafts.length, 5);
    assert.equal(store.getMemoryEntries().length, 0);
    assert.equal(observed, 0);
    assert.equal(await readOptional(path.join(q.root, "MEMORY.md")), null);
  });
  it("new skills are invisible to discovery but editable through draft view", async () => {
    const store = new SkillStore({
      globalSkillsDir: path.join(q.root, "skills"),
      piGlobalSkillsDir: path.join(root, "native"),
    });
    store.setCandidateWorkspace(q);
    const r = await store.create(
      "Release Task",
      "Reusable release",
      body,
      "global",
    );
    assert.equal((r as any).pending, true);
    assert.equal((await store.loadIndex()).length, 0);
    assert.equal(
      await readOptional(
        path.join(q.root, "skills", "release-task", "SKILL.md"),
      ),
      null,
    );
    await store.patch(
      "global:release-task",
      "Verification",
      "1. Read back final state",
    );
    const d = await store.loadSkill("global:release-task");
    assert.ok(d!.body.includes("Read back final state"));
    assert.equal((await q.read()).drafts.length, 1);
  });
  it("skill patch and deletion preserve the active file", async () => {
    const store = new SkillStore({
      globalSkillsDir: path.join(q.root, "skills"),
      piGlobalSkillsDir: path.join(root, "native"),
    });
    await store.create("Release Task", "Reusable release", body, "global");
    const file = path.join(q.root, "skills", "release-task", "SKILL.md"),
      old = await fs.readFile(file, "utf8");
    store.setCandidateWorkspace(q);
    await store.patch("global:release-task", "Procedure", "1. Improved step");
    await store.delete("global:release-task");
    assert.equal(await fs.readFile(file, "utf8"), old);
    assert.equal((await q.read()).drafts[0].action, "remove");
  });
  it("publishes memory and consumes drafts in one recoverable transaction", async () => {
    await q.stage([input()]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    const changes = await pub.plan(
      before.drafts,
      [{ id: before.drafts[0].id, action: "add" }],
      snapshot,
    );
    await pub.commit(
      before,
      { ...before, revision: before.revision + 1, drafts: [] },
      changes,
      snapshot,
    );
    assert.ok(
      (await fs.readFile(path.join(q.root, "MEMORY.md"), "utf8")).includes(
        "Permanent fact",
      ),
    );
    assert.equal((await q.read()).drafts.length, 0);
    assert.ok(await readOptional(path.join(q.root, ".previous-formal.json")));
    assert.equal(
      await readOptional(path.join(q.root, ".candidates", "transaction.json")),
      null,
    );
  });
  it("merges compatible formal entries preserving creation date", async () => {
    await atomicText(
      path.join(q.root, "MEMORY.md"),
      "Old A <!-- created=2020-01-01, last=2020-01-01 -->" +
        ENTRY_DELIMITER +
        "Old B",
    );
    await q.stage([input("A and B")]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    const changes = await pub.plan(
      before.drafts,
      [
        {
          id: before.drafts[0].id,
          action: "merge",
          existing: snapshot.items.map((i) => i.id),
          content: "A and B",
        },
      ],
      snapshot,
    );
    assert.ok(changes[0].after!.includes("created=2020-01-01"));
    assert.equal(changes[0].after!.split(ENTRY_DELIMITER).length, 1);
  });
  it("publishes a valid skill without exposing the draft beforehand", async () => {
    await q.stage([skill()]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    const changes = await pub.plan(
      before.drafts,
      [{ id: before.drafts[0].id, action: "add" }],
      snapshot,
    );
    await pub.commit(
      before,
      { ...before, revision: before.revision + 1, drafts: [] },
      changes,
      snapshot,
    );
    assert.ok(
      await readOptional(
        path.join(q.root, "skills", "release-task", "SKILL.md"),
      ),
    );
  });
  it("rejects incomplete skills and missing script references", async () => {
    // Staging itself already blocks section-less skill bodies; the publisher
    // must equally reject incomplete RESULTING content (e.g. an unrepaired
    // decision content) for the still-valid staged draft.
    await q.stage([skill()]);
    let before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        [{ id: before.drafts[0].id, action: "add", content: "Only notes" }],
        snapshot,
      ),
    );
    await q.stage([
      { ...skill(), content: body + "\nCall `scripts/missing.py`" },
    ]);
    before = await q.read();
    await assert.rejects(
      pub.plan(
        before.drafts,
        [{ id: before.drafts[0].id, action: "add" }],
        snapshot,
      ),
    );
  });
  it("never mutates native skills or other scopes", async () => {
    const file = path.join(root, "native", "release-task", "SKILL.md");
    await atomicText(
      file,
      formatFrontmatter({
        name: "release-task",
        description: "Native release",
        version: 1,
        created: today(),
        updated: today(),
        body,
      }),
    );
    await q.stage([skill("another-task")]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        [
          {
            id: before.drafts[0].id,
            action: "replace",
            existing: [snapshot.items[0].id],
          },
        ],
        snapshot,
      ),
    );
    assert.ok(await readOptional(file));
  });
  it("rejects implicit formal deletion from an ordinary candidate", async () => {
    await atomicText(path.join(q.root, "MEMORY.md"), "Old");
    await q.stage([input()]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        [
          {
            id: before.drafts[0].id,
            action: "remove",
            existing: [snapshot.items[0].id],
          },
        ],
        snapshot,
      ),
    );
  });
  it("rejects symlinked publication destinations", async () => {
    await fs.mkdir(path.join(q.root, "skills"), { recursive: true });
    await fs.mkdir(path.join(root, "outside"));
    await fs.symlink(
      path.join(root, "outside"),
      path.join(q.root, "skills", "release-task"),
    );
    await q.stage([skill()]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        [{ id: before.drafts[0].id, action: "add" }],
        snapshot,
      ),
    );
  });
  it("rejects repeated formal references and duplicate new destinations", async () => {
    await atomicText(path.join(q.root, "MEMORY.md"), "Old");
    await q.stage([input("New A"), input("New B")]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        before.drafts.map((d) => ({
          id: d.id,
          action: "replace",
          existing: [snapshot.items[0].id],
        })),
        snapshot,
      ),
    );
  });
  it("does not overwrite concurrent candidate or formal changes", async () => {
    await q.stage([input()]);
    const before = await q.read(),
      snapshot = await pub.snapshot(),
      changes = await pub.plan(
        before.drafts,
        [{ id: before.drafts[0].id, action: "add" }],
        snapshot,
      );
    await q.stage([input("Concurrent")]);
    await assert.rejects(
      pub.commit(
        before,
        { ...before, revision: before.revision + 1, drafts: [] },
        changes,
        snapshot,
      ),
    );
    assert.equal(await readOptional(path.join(q.root, "MEMORY.md")), null);
    const now = await q.read();
    await atomicText(path.join(q.root, "MEMORY.md"), "External");
    await assert.rejects(
      pub.commit(
        now,
        { ...now, revision: now.revision + 1, drafts: [] },
        changes,
        snapshot,
      ),
    );
    assert.equal(
      await readOptional(path.join(q.root, "MEMORY.md")),
      "External",
    );
  });
  it("recovers a partially published transaction exactly once", async () => {
    await q.stage([input()]);
    const before = await q.read(),
      after = { ...before, revision: before.revision + 1, drafts: [] };
    const file = path.join(q.root, "MEMORY.md"),
      file2 = path.join(q.root, "USER.md");
    const changes = [
      { file, before: null, after: "New formal" },
      { file: file2, before: null, after: "New user" },
    ];
    await atomicText(
      path.join(q.root, ".candidates", "transaction.json"),
      JSON.stringify({ before, after, changes }),
    );
    await atomicText(file, "New formal");
    await pub.recover();
    await pub.recover();
    assert.equal(await readOptional(file2), "New user");
    assert.equal((await q.read()).drafts.length, 0);
  });
  it("recovery refuses to erase an external edit", async () => {
    const before = await q.read(),
      file = path.join(q.root, "MEMORY.md");
    await atomicText(
      path.join(q.root, ".candidates", "transaction.json"),
      JSON.stringify({
        before,
        after: { ...before, revision: 1 },
        changes: [{ file, before: null, after: "New" }],
      }),
    );
    await atomicText(file, "External edit");
    await assert.rejects(pub.recover());
    assert.equal(await readOptional(file), "External edit");
  });
  it("task-end pruning below threshold never writes formal data", async () => {
    await q.stage([input("Useful"), input("Uncertain")]);
    const engine = new CandidateLifecycle(
      options(async (phase: string, data: any) => {
        assert.equal(phase, "cleanup");
        assert.ok(data.task_context.includes("toolResult"));
        return { ...keep([data.drafts[0].id]), drop: [data.drafts[1].id], dropReasons: { [data.drafts[1].id]: { category: "uncertain", basis: "Fixture explicitly uncertain" } } };
      }),
    );
    const r = await engine.review(context());
    assert.equal(r.retained, 1);
    assert.equal(r.promoted, 0);
    assert.equal(r.cleanupDropped, 1);
    assert.equal(r.promotionDiscarded, 0);
    assert.equal(await readOptional(path.join(q.root, "MEMORY.md")), null);
    assert.equal((await engine.review(context())).skipped, "no new task");
  });
  it("a model promotion consumes reviewed candidates, not unseen projects", async () => {
    await q.stage([
      ...Array.from({ length: 20 }, (_, i) => input("Durable " + i)),
      input("Other project", "elsewhere"),
    ]);
    const phases: string[] = [];
    const engine = new CandidateLifecycle(
      options(async (phase: string, data: any) => {
        phases.push(phase);
        return phase === "cleanup"
          ? keep(data.drafts.map((d: any) => d.id))
          : {
              decisions: data.drafts.map((d: any) => ({
                id: d.id,
                action: "add",
              })),
            };
      }),
    );
    const r = await engine.review(context());
    assert.deepEqual(phases, ["cleanup", "promotion"]);
    assert.equal(r.promoted, 20);
    assert.equal((await q.read()).drafts.length, 1);
    assert.equal((await q.read()).drafts[0].project, "elsewhere");
  });
  it("invalid cleanup fails closed without deleting drafts", async () => {
    await q.stage([input()]);
    const before = await q.read(),
      engine = new CandidateLifecycle(
        options(async () => ({ keep: [], drop: [], merge: [], add: [] })),
      );
    await assert.rejects(engine.review(context()));
    assert.deepEqual(await q.read(), before);
  });
  it("invalid promotion leaves already-cleaned drafts available", async () => {
    await q.stage(Array.from({ length: 20 }, (_, i) => input("Fact " + i)));
    const engine = new CandidateLifecycle(
      options(async (phase: string, data: any) =>
        phase === "cleanup"
          ? keep(data.drafts.map((d: any) => d.id))
          : { decisions: [] },
      ),
    );
    await assert.rejects(engine.review(context()));
    assert.equal((await q.read()).drafts.length, 20);
    assert.equal(await readOptional(path.join(q.root, "MEMORY.md")), null);
  });
  it("cancelling an in-flight review prevents its plan from committing", async () => {
    await q.stage([input()]);
    let start!: () => void;
    const started = new Promise<void>((r) => (start = r));
    let finish!: (v: any) => void;
    const engine = new CandidateLifecycle(
      options(async (_phase: string, data: any) => {
        start();
        return new Promise((r) => {
          finish = r;
        });
      }),
    );
    const run = engine.review(context());
    await started;
    engine.cancel();
    finish(keep((await q.read()).drafts.map((d) => d.id)));
    await assert.rejects(run);
    assert.equal((await q.read()).drafts.length, 1);
  });
  it("rolls back formal publication without resurrecting deleted candidates", async () => {
    await q.stage([input()]);
    const before = await q.read(),
      snapshot = await pub.snapshot(),
      changes = await pub.plan(
        before.drafts,
        [{ id: before.drafts[0].id, action: "add" }],
        snapshot,
      );
    await pub.commit(
      before,
      { ...before, revision: before.revision + 1, drafts: [] },
      changes,
      snapshot,
    );
    await pub.rollback();
    assert.equal(await readOptional(path.join(q.root, "MEMORY.md")), null);
    assert.equal((await q.read()).drafts.length, 0);
  });
  it("rollback refuses to erase subsequent external changes", async () => {
    await q.stage([input()]);
    const before = await q.read(),
      snapshot = await pub.snapshot(),
      changes = await pub.plan(
        before.drafts,
        [{ id: before.drafts[0].id, action: "add" }],
        snapshot,
      );
    await pub.commit(
      before,
      { ...before, revision: before.revision + 1, drafts: [] },
      changes,
      snapshot,
    );
    await atomicText(path.join(q.root, "MEMORY.md"), "Later edit");
    await assert.rejects(pub.rollback());
    assert.equal(
      await readOptional(path.join(q.root, "MEMORY.md")),
      "Later edit",
    );
  });
  it("preserves failure classification and skips unsafe legacy drafts", async () => {
    const f = path.join(root, "failures.legacy");
    await atomicText(
      f,
      JSON.stringify({
        candidates: [
          {
            status: "pending",
            failureProject: "demo",
            operations: [
              {
                action: "add",
                category: "tool-quirk",
                content: "A classified fact",
              },
              { action: "add", content: "sk-" + "x".repeat(30) },
            ],
          },
        ],
      }),
    );
    await q.importLegacy(f, "failure", null);
    const drafts = (await q.read()).drafts;
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].project, "demo");
    assert.equal(drafts[0].content, "[tool-quirk] A classified fact");
  });
  it("refuses identical formal additions from distinct edit drafts", async () => {
    await q.stage([
      input("Same"),
      { ...input("Same"), action: "replace", oldText: "Old" },
    ]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        before.drafts.map((d) => ({ id: d.id, action: "add" })),
        snapshot,
      ),
    );
  });
  it("failure promotion retains the project metadata used by SQLite reconciliation", async () => {
    await q.stage([
      {
        ...input("[insight] A scoped fact"),
        target: "failure",
        project: "demo",
      },
    ]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    const changes = await pub.plan(
      before.drafts,
      [{ id: before.drafts[0].id, action: "add" }],
      snapshot,
    );
    assert.ok(
      changes[0].after!.includes(
        "project64=" + Buffer.from("demo").toString("base64url"),
      ),
    );
  });
  it("a shutdown aborts and joins review before further synchronization", async () => {
    await q.stage([input()]);
    let signalStart!: () => void;
    const started = new Promise<void>((r) => (signalStart = r));
    const opts = options(
      async (_p: string, _d: any, _c: any, signal: AbortSignal) => {
        signalStart();
        return new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          }),
        );
      },
    );
    const engine = new CandidateLifecycle(opts);
    const handlers: Record<string, any> = {};
    engine.register({
      on: (name: string, fn: any) => {
        handlers[name] = fn;
      },
      registerTool: () => {},
      registerCommand: () => {},
    } as any);
    const run = engine.review(context()).catch(() => {});
    await started;
    await handlers.session_shutdown();
    await run;
    assert.equal(
      (await engine.review(context(), true)).skipped,
      "session shutting down",
    );
    assert.equal((await q.read()).drafts.length, 1);
  });
  it("review policies explicitly preserve conditions and discard uncertainty", () => {
    assert.match(CLEANUP_POLICY, /S0\/S4/);
    assert.match(CLEANUP_POLICY, /unsupported\/uncertain/);
    assert.match(
      PROMOTION_POLICY,
      /Recent does NOT automatically mean correct/,
    );
    assert.match(PROMOTION_POLICY, /readonly/);
  });

  it("retains established carry-over knowledge with unrelated task context", async () => {
    await q.stage([input("Device A supports S0 wake; S4 is unsupported")]);
    const engine = new CandidateLifecycle(options(async (_phase: string, data: any) => {
      assert.equal(data.formal.complete, false);
      assert.match(CLEANUP_POLICY, /Absence of repeated evidence.*NEVER/);
      return keep(data.drafts.map((d: any) => d.id));
    }));
    await engine.review(context());
    const ctx = context(); ctx.sessionManager.getSessionId = () => "other-session";
    ctx.sessionManager.getBranch = () => [{ type: "message", id: "unrelated", message: { role: "user", content: "Discuss a different device" } }];
    const result = await engine.review(ctx);
    assert.equal(result.retained, 1);
    assert.equal(result.cleanupDropped, 0);
    assert.match((await q.read()).drafts[0].content, /S0.*S4/);
  });
  it("rejects absence-of-context as a cleanup reason without deleting drafts", async () => {
    await q.stage([input("Established durable fixture")]);
    const before = await q.read();
    const engine = new CandidateLifecycle(options(async (_phase: string, data: any) => ({
      ...keep([]), drop: [data.drafts[0].id],
      dropReasons: { [data.drafts[0].id]: { category: "missing_current_evidence", basis: "Not repeated this task" } },
    })));
    await assert.rejects(engine.review(context()), /concrete allowed reason/);
    assert.deepEqual(await q.read(), before);
    const status = JSON.parse((await readOptional(path.join(q.root, "candidate-status.json")))!);
    assert.equal(status.status, "failed");
    assert.equal(status.errorCategory, "invalid_plan");
  });
  it("reports five cleanup deletions separately from zero promotion discards", async () => {
    await q.stage(Array.from({ length: 5 }, (_, i) => input("Temporary task step " + i)));
    const result = await new CandidateLifecycle(options(async (_phase: string, data: any) => ({
      ...keep([]), drop: data.drafts.map((d: any) => d.id),
      dropReasons: Object.fromEntries(data.drafts.map((d: any) => [d.id, { category: "transient", basis: "Synthetic completed task step" }])),
    }))).review(context());
    assert.equal(result.reviewed, 5); assert.equal(result.retained, 0);
    assert.equal(result.cleanupDropped, 5); assert.equal(result.promotionDiscarded, 0);
    assert.equal(result.discarded, 0);
    const metrics = JSON.parse((await readOptional(path.join(q.root, "candidate-metrics.json")))!);
    assert.equal(metrics.totals.cleanupDropped, 5);
    assert.ok(!JSON.stringify(metrics).includes("Temporary task step"));
    assert.ok(!JSON.stringify(metrics).includes("Synthetic completed"));
  });
  it("preserves cleanup counts when promotion fails", async () => {
    await q.stage([input("Temporary fixture"), ...Array.from({ length: 20 }, (_, i) => input("Fact " + i))]);
    const engine = new CandidateLifecycle(options(async (phase: string, data: any) => phase === "cleanup" ? {
      ...keep(data.drafts.slice(1).map((d: any) => d.id)), drop: [data.drafts[0].id],
      dropReasons: { [data.drafts[0].id]: { category: "transient", basis: "Explicitly temporary fixture" } },
    } : { decisions: [] }));
    await assert.rejects(engine.review(context()));
    const status = JSON.parse((await readOptional(path.join(q.root, "candidate-status.json")))!);
    assert.equal(status.cleanupDropped, 1); assert.equal(status.promoted, 0);
    assert.equal(status.phase, "promotion"); assert.equal(status.status, "failed");
    assert.equal((await q.read()).drafts.length, 20);
  });
  it("uses compact cleanup input but full formal bodies for admission", async () => {
    const largeSkill = body + "\n" + "Long synthetic reference. ".repeat(700);
    await atomicText(path.join(q.root, "skills", "other-task", "SKILL.md"), formatFrontmatter({ name: "other-task", description: "Other synthetic procedure", body: largeSkill, version: 1, created: today(), updated: today() }));
    await q.stage([input()]);
    let cleanupChars = 0, promotionChars = 0;
    await new CandidateLifecycle(options(async (phase: string, data: any) => {
      if (phase === "cleanup") {
        assert.equal(data.formal.complete, false);
        assert.ok(!JSON.stringify(data.formal).includes("Long synthetic reference"));
        cleanupChars = JSON.stringify(data.formal).length;
        return keep(data.drafts.map((d: any) => d.id));
      }
      assert.equal(data.formal.complete, true);
      assert.ok(JSON.stringify(data.formal).includes("Long synthetic reference"));
      promotionChars = JSON.stringify(data.formal).length;
      return { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })) };
    })).review(context(), true);
    assert.ok(cleanupChars < promotionChars / 5);
  });
  it("rejects concurrent formal changes even during cleanup", async () => {
    const file = path.join(q.root, "MEMORY.md");
    await atomicText(file, "Original formal"); await q.stage([input()]);
    const before = await q.read();
    const engine = new CandidateLifecycle(options(async (_phase: string, data: any) => {
      await atomicText(file, "External replacement"); return keep(data.drafts.map((d: any) => d.id));
    }));
    await assert.rejects(engine.review(context()), /changed during review/);
    assert.deepEqual(await q.read(), before);
    assert.equal(await readOptional(file), "External replacement");
  });
  it("records cancellation without retaining context or error text", async () => {
    await q.stage([input()]);
    let signalStart!: () => void;
    const started = new Promise<void>(r => { signalStart = r; });
    const engine = new CandidateLifecycle(options(async (_p: string, _d: any, _c: any, signal: AbortSignal) => {
      signalStart(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Synthetic sensitive error text")), { once: true }));
    }));
    const run = engine.review(context()); await started; engine.cancel(); await assert.rejects(run);
    const raw = (await readOptional(path.join(q.root, "candidate-metrics.json")))!;
    assert.equal(JSON.parse(raw).recent[0].status, "cancelled");
    assert.ok(!raw.includes("sensitive")); assert.equal((await q.read()).drafts.length, 1);
  });
  it("bounds telemetry history while preserving cumulative counts", async () => {
    const { ReviewMetrics } = await import("../../src/handlers/candidate-metrics.js");
    for (let i = 0; i < 35; i++) await new ReviewMetrics(q.root).finish("success");
    const data = JSON.parse((await readOptional(path.join(q.root, "candidate-metrics.json")))!);
    assert.equal(data.recent.length, 32); assert.equal(data.totals.runs, 35);
  });
  for (const reason of ["new", "resume", "reload"]) {
    it("repairs only the inspection tool on " + reason + " and respects later deselection", async () => {
      let active = ["read", "memory_add", "custom_other"];
      const branch: any[] = []; const handlers: Record<string, any> = {};
      const engine = new CandidateLifecycle(options(async () => ({})));
      engine.register({
        on: (name: string, fn: any) => { handlers[name] = fn; },
        registerTool: () => {}, registerCommand: () => {},
        getActiveTools: () => active,
        getAllTools: () => [{ name: "memory_candidates" }, { name: "unselected_tool" }],
        setActiveTools: (names: string[]) => { active = names; },
        appendEntry: (customType: string, data: any) => branch.push({ type: "custom", customType, data }),
      } as any);
      const ctx = context(); ctx.sessionManager.getBranch = () => branch;
      await handlers.session_start({ reason }, ctx);
      assert.deepEqual(active, ["read", "memory_add", "custom_other", "memory_candidates"]);
      active = ["read", "memory_add", "custom_other"];
      await handlers.session_start({ reason: "reload" }, ctx);
      assert.deepEqual(active, ["read", "memory_add", "custom_other"]);
    });
  }
  it("does not add inspection to a deliberately read-only tool selection", async () => {
    let active = ["read", "memory_search"];
    const handlers: Record<string, any> = {};
    new CandidateLifecycle(options(async () => ({}))).register({ on: (n: string, f: any) => { handlers[n] = f; },
      registerTool: () => {}, registerCommand: () => {}, getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; }, appendEntry: () => {} } as any);
    await handlers.session_start({ reason: "resume" }, context());
    assert.deepEqual(active, ["read", "memory_search"]);
  });

  it("thresholdReached honors configured thresholds, default 10/2 with OR counts", () => {
    const mem = (n: number) => Array.from({ length: n }, (_, i) => input("m" + i) as any);
    const skl = (n: number) => Array.from({ length: n }, () => skill() as any);
    // Defaults: 10 memories OR 2 skills.
    assert.equal(thresholdReached(mem(9)), false);
    assert.equal(thresholdReached(mem(10)), true);
    assert.equal(thresholdReached(skl(1)), false);
    assert.equal(thresholdReached([...mem(9), ...skl(1)]), false);
    assert.equal(thresholdReached(skl(2)), true);
    // Overrides change the boundary; counts stay independent (OR).
    const low = { memory: 3, skill: 1 };
    assert.equal(thresholdReached(mem(2), low), false);
    assert.equal(thresholdReached(mem(3), low), true);
    assert.equal(thresholdReached(skl(1), low), true);
    assert.equal(thresholdReached([...mem(2), ...skl(1)], low), true);
  });

  it("runtime admission uses configured thresholds from config", async () => {
    const cfgPath = path.join(root, "cfg.json");
    await fs.writeFile(cfgPath, JSON.stringify({ candidateMemoryThreshold: 2 }));
    const run = (call: any) =>
      new CandidateLifecycle({ ...options(call), config: loadConfig(cfgPath) });
    const call = async (phase: string, data: any) =>
      phase === "cleanup"
        ? keep(data.drafts.map((d: any) => d.id))
        : { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })) };
    await q.stage([input("One"), input("Two")]);
    const phases: string[] = [];
    await run(async (phase: string, data: any) => {
      phases.push(phase);
      return call(phase, data);
    }).review(context());
    assert.deepEqual(phases, ["cleanup", "promotion"]);
    await q.stage([input("Three")]);
    await q.locked(async (qr) => {
      for (const d of qr.drafts) d.stagedAt = new Date().toISOString();
      await q.save(qr);
    });
    const r = await run(async (phase: string, data: any) => {
      assert.notEqual(phase, "promotion");
      return keep(data.drafts.map((d: any) => d.id));
    }).review(context());
    assert.ok(r.trigger.thresholdsReached === false);
  });

  it("exact 24h pending age triggers the fallback (>=) with an injectable clock", async () => {
    const fixedNow = Date.parse("2025-06-01T12:00:00.000Z");
    const atAge = (hours: number) =>
      new Date(fixedNow - hours * 3600000).toISOString();
    const run = (call: any) =>
      new CandidateLifecycle({ ...options(call), now: () => fixedNow });
    const call = async (phase: string, data: any) =>
      phase === "cleanup"
        ? keep(data.drafts.map((d: any) => d.id))
        : { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })) };
    // Exactly 24h: >= boundary triggers full cleanup and promotion.
    await q.stage([input("Boundary fact")]);
    await q.locked(async (qr) => {
      qr.drafts[0].stagedAt = atAge(24);
      await q.save(qr);
    });
    const phases: string[] = [];
    const r = await run(async (phase: string, data: any) => {
      phases.push(phase);
      return call(phase, data);
    }).review(context());
    assert.deepEqual(phases, ["cleanup", "promotion"]);
    assert.equal(r.trigger.pendingOverdue, true);
    assert.equal(r.trigger.mode, "full");
    assert.ok(r.trigger.oldestPendingMs >= 24 * 3600000);
    // Just under 24h: no time fallback, below threshold 10, no promotion.
    await q.stage([input("Fresh fact")]);
    await q.locked(async (qr) => {
      for (const d of qr.drafts) d.stagedAt = atAge(24 - 0.01);
      await q.save(qr);
    });
    const phases2: string[] = [];
    await run(async (phase: string, data: any) => {
      phases2.push(phase);
      return keep(data.drafts.map((d: any) => d.id));
    }).review(context());
    assert.deepEqual(phases2, ["cleanup"]);
    // Unparseable staging times are treated honestly as overdue.
    await q.locked(async (qr) => {
      qr.drafts[0].stagedAt = "not-a-date";
      await q.save(qr);
    });
    const phases3: string[] = [];
    const ctxBad = context();
    ctxBad.sessionManager.getBranch = () => [
      { type: "message", id: "u9", message: { role: "user", content: [{ type: "text", text: "Bad clock task" }] } },
    ];
    const r3 = await run(async (phase: string, data: any) => {
      phases3.push(phase);
      return call(phase, data);
    }).review(ctxBad);
    assert.deepEqual(phases3, ["cleanup", "promotion"]);
    assert.equal(r3.trigger.pendingOverdue, true);
  });

  it("cross-project pending drafts neither force full review nor trigger promotion", async () => {
    await q.stage([input("Other project", "other")]);
    await q.locked(async (qr) => {
      qr.drafts[0].stagedAt = new Date(Date.now() - 30 * 3600000).toISOString();
      await q.save(qr);
    });
    const phases: string[] = [];
    const r = await new CandidateLifecycle(
      options(async (phase: string) => {
        phases.push(phase);
        return keep([]);
      }),
    ).review(context());
    assert.deepEqual(phases, ["cleanup"]);
    assert.equal(r.trigger.pendingOverdue, false);
    assert.equal((await q.read()).drafts.length, 1);
  });

  it("skill upsert freezes the legacy pending time before rewriting", async () => {
    const legacyUpdated = "2024-01-01T00:00:00.000Z";
    await q.locked(async (qr) => {
      qr.drafts.push({
        ...skill(),
        id: "legacy-skill",
        updatedAt: legacyUpdated,
      } as any);
      qr.revision++;
      await q.save(qr);
    });
    await q.stage([{ ...skill(), content: body + "\n2. Extra step" }]);
    const d = (await q.read()).drafts[0];
    assert.equal(d.id, "legacy-skill");
    assert.equal(d.updatedAt > legacyUpdated, true);
    // pendingSince falls back to the frozen legacy updatedAt, never now().
    assert.equal(d.stagedAt, legacyUpdated);
    assert.equal(pendingSince(d), legacyUpdated);
  });

  it("merge freezes the earliest pendingSince across ALL merged drafts", async () => {
    const t1 = "2024-03-01T00:00:00.000Z";
    const t2 = "2024-02-01T00:00:00.000Z";
    const t3 = "2024-01-01T00:00:00.000Z";
    await q.stage([input("A"), input("B"), input("C")]);
    await q.locked(async (qr) => {
      qr.drafts[0].stagedAt = t1;
      qr.drafts[1].stagedAt = t2;
      qr.drafts[2].stagedAt = t3;
      await q.save(qr);
    });
    const before = await q.read();
    // first is the newest draft; the merge must still pick the OLDEST time.
    const [c, b, a] = before.drafts;
    const after = applyCleanup(
      before,
      before.drafts,
      { keep: [], drop: [], merge: [{ ids: [c.id, a.id, b.id], content: "Merged" }], add: [] },
      "demo",
    );
    assert.equal(after.drafts.length, 1);
    assert.equal(after.drafts[0].stagedAt, t3);
    // A legacy merged draft freezes its honest updatedAt, not the merge time.
    const legacy = { ...input("L"), id: "legacy", updatedAt: t1 } as any;
    delete legacy.stagedAt;
    const q2: any = { ...before, drafts: [legacy] };
    const after2 = applyCleanup(
      q2,
      q2.drafts,
      { keep: [], drop: [], merge: [{ ids: ["legacy"], content: "Rewritten legacy" }], add: [] },
      "demo",
    );
    assert.equal(after2.drafts[0].stagedAt, t1);
    assert.equal(after2.drafts[0].updatedAt > t1, true);
  });

  it("dedup preserves the oldest pending instance", async () => {
    const old = "2024-01-01T00:00:00.000Z";
    await q.stage([input("Duplicated fact")]);
    await q.locked(async (qr) => {
      qr.drafts[0].stagedAt = old;
      await q.save(qr);
    });
    const before = await q.read();
    const after = applyCleanup(
      before,
      before.drafts,
      {
        keep: before.drafts.map((d) => d.id),
        drop: [],
        merge: [],
        add: [input("Duplicated fact")],
      },
      "demo",
    );
    assert.equal(after.drafts.length, 1);
    assert.equal(after.drafts[0].stagedAt, old);
  });

  it("staging rejects untrusted internal state in DraftInput", async () => {
    await q.stage([{ ...input("Injected"), stagedAt: "1999-01-01T00:00:00.000Z", reviewedDigest: "x" } as any]);
    const d = (await q.read()).drafts[0];
    assert.notEqual(d.stagedAt, "1999-01-01T00:00:00.000Z");
    assert.equal(d.reviewedDigest, undefined);
  });

  it("an unknown formal fingerprint forces a full cleanup review", async () => {
    const call = async (phase: string, data: any) =>
      phase === "cleanup"
        ? (cleanupBatches.push(data.drafts.map((d: any) => d.content)), keep(data.drafts.map((d: any) => d.id)))
        : { decisions: [] };
    const cleanupBatches: string[][] = [];
    await q.stage([input("Reviewed once")]);
    await new CandidateLifecycle(options(call)).review(context());
    assert.deepEqual(cleanupBatches, [["Reviewed once"]]);
    // Same content, fingerprint preserved: delta skips the reviewed draft.
    const ctx2 = context();
    ctx2.sessionManager.getBranch = () => [
      { type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "Second task" }] } },
    ];
    await new CandidateLifecycle(options(call)).review(ctx2);
    assert.deepEqual(cleanupBatches, [["Reviewed once"], []]);
    // Fingerprint lost (cap eviction, new install): conservative full review.
    await q.locked(async (qr) => {
      qr.formalHashes = {};
      await q.save(qr);
    });
    const ctx3 = context();
    ctx3.sessionManager.getBranch = () => [
      { type: "message", id: "u3", message: { role: "user", content: [{ type: "text", text: "Third task" }] } },
    ];
    const r = await new CandidateLifecycle(options(call)).review(ctx3);
    assert.deepEqual(cleanupBatches, [["Reviewed once"], [], ["Reviewed once"]]);
    assert.equal(r.trigger.fingerprintUnknown, true);
    assert.equal(r.trigger.mode, "full");
  });

  it("formal fingerprints are capped, always preserving the current project", () => {
    let map: Record<string, string> = {};
    for (let i = 0; i < 40; i++) map = boundedFingerprints(map, "p" + i, "h" + i);
    assert.equal(Object.keys(map).length, FORMAL_FINGERPRINT_CAP);
    assert.equal(map.p39, "h39");
    assert.equal(map.p0, "h0");
    // Evicted keys lose their fingerprint: their next review runs conservative full.
    assert.equal(map.p31, undefined);
    assert.equal(map.p24, undefined);
  });

  it("report reflects actual thresholds and trigger reason; metrics policy stays optional", async () => {
    const { ReviewMetrics } = await import("../../src/handlers/candidate-metrics.js");
    const m = new ReviewMetrics(q.root);
    assert.deepEqual(m.policy, { memory: 10, skill: 2 });
    const custom = new ReviewMetrics(q.root, { memory: 3, skill: 1 });
    custom.setTrigger({ mode: "full", pendingOverdue: true });
    const report = await custom.finish("success");
    assert.deepEqual(report.thresholds, { memory: 3, skill: 1 });
    assert.deepEqual(report.trigger.pendingOverdue, true);
    await fs.rm(path.join(q.root, "candidate-metrics.json"), { force: true });
    const r2 = await new ReviewMetrics(q.root).finish("success");
    assert.deepEqual(r2.thresholds, { memory: 10, skill: 2 });
  });


  it("publication counts committed memory add/replace and parsed formal net", async () => {
    await atomicText(path.join(q.root, "MEMORY.md"), ["Old formal a", "Old formal b"].join(ENTRY_DELIMITER));
    await q.stage([input("Fresh independent fact"), input("Stale formal a")]);
    const result = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) : {
        decisions: [
          { id: data.drafts.find((d: any) => d.content === "Fresh independent fact").id, action: "add", content: "Fresh independent fact" },
          { id: data.drafts.find((d: any) => d.content === "Stale formal a").id, action: "replace",
            existing: [data.formal.entries.find((e: any) => e.content === "Old formal a").id], content: "Newer state of a" },
        ],
      })).review(context(), true);
    assert.equal(result.publication.committed, true);
    assert.equal(result.publication.noop, false);
    assert.deepEqual(result.publication.memory, { add: 1, replace: 1, merge: 0, remove: 0 });
    assert.deepEqual(result.publication.skill, { add: 0, update: 0, merge: 0, remove: 0 });
    assert.deepEqual(result.publication.formalMemory, { before: 2, after: 3, net: 1, coverage: "snapshot_files" });
    assert.deepEqual(result.publication.formalSkills, { before: 0, after: 0, net: 0, coverage: "snapshot_files" });
    const metrics = JSON.parse((await readOptional(path.join(q.root, "candidate-metrics.json")))!);
    assert.equal(metrics.totals.publications.historyKnown, true);
    assert.equal(metrics.totals.publications.commits, 1);
    assert.equal(metrics.totals.publications.memoryAdd, 1);
    assert.equal(metrics.totals.publications.memoryReplace, 1);
  });

  it("publication counts committed skill add/replace against native skill files", async () => {
    await atomicText(path.join(q.root, "skills", "existing-skill", "SKILL.md"),
      formatFrontmatter({ name: "existing-skill", description: "Existing synthetic procedure", body, version: 1, created: today(), updated: today() }));
    await q.stage([skill("new-skill"), skill("existing-skill")]);
    const result = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) : {
        decisions: [
          { id: data.drafts.find((d: any) => d.name === "new-skill").id, action: "add", content: body, description: "New synthetic procedure" },
          { id: data.drafts.find((d: any) => d.name === "existing-skill").id, action: "replace",
            existing: [data.formal.entries.find((e: any) => e.name === "existing-skill").id],
            content: body + "\n2. Extra verification", description: "Updated synthetic procedure" },
        ],
      })).review(context(), true);
    assert.deepEqual(result.publication.skill, { add: 1, update: 1, merge: 0, remove: 0 });
    assert.deepEqual(result.publication.memory, { add: 0, replace: 0, merge: 0, remove: 0 });
    assert.deepEqual(result.publication.formalSkills, { before: 1, after: 2, net: 1, coverage: "snapshot_files" });
    assert.deepEqual(result.publication.formalMemory, { before: 0, after: 0, net: 0, coverage: "snapshot_files" });
  });

  it("an all-discard promotion publishes a committed no-op distinct from no publication", async () => {
    await q.stage([input("Doomed synthetic draft")]);
    const result = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) :
        { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "discard" })) })).review(context(), true);
    assert.deepEqual(result.publication, { committed: true, noop: true,
      memory: { add: 0, replace: 0, merge: 0, remove: 0 }, skill: { add: 0, update: 0, merge: 0, remove: 0 },
      formalMemory: { before: 0, after: 0, net: 0, coverage: "snapshot_files" },
      formalSkills: { before: 0, after: 0, net: 0, coverage: "snapshot_files" } });
  });

  it("a failed promotion publishes nothing and never counts uncommitted plans", async () => {
    await q.stage(Array.from({ length: 20 }, (_, i) => input("Fact " + i)));
    await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) : { decisions: [] }))
      .review(context(), true).catch(() => {});
    const status = JSON.parse((await readOptional(path.join(q.root, "candidate-status.json")))!);
    assert.equal(status.publication, null);
    const metrics = JSON.parse((await readOptional(path.join(q.root, "candidate-metrics.json")))!);
    assert.equal(metrics.totals.publications.commits, 0);
    assert.equal(metrics.totals.publications.memoryAdd, 0);
  });

  it("a CAS-rejected commit publishes nothing and counts no commits", async () => {
    await atomicText(path.join(q.root, "MEMORY.md"), "Old formal fact");
    await q.stage([input("Concurrent synthetic fact")]);
    await new CandidateLifecycle(options(async (phase: string, data: any) => {
      if (phase === "cleanup") return keep(data.drafts.map((d: any) => d.id));
      // Mutate the formal file after the snapshot was read: the commit's
      // compare-and-swap must reject the stale plan.
      await atomicText(path.join(q.root, "MEMORY.md"), "Externally replaced fact");
      return { decisions: [{ id: data.drafts[0].id, action: "add", content: "Concurrent synthetic fact" }] };
    })).review(context(), true).catch(() => {});
    const status = JSON.parse((await readOptional(path.join(q.root, "candidate-status.json")))!);
    assert.equal(status.publication, null);
    const metrics = JSON.parse((await readOptional(path.join(q.root, "candidate-metrics.json")))!);
    assert.equal(metrics.totals.publications.commits, 0);
    assert.equal(metrics.totals.publications.memoryAdd, 0);
    const memory = await readOptional(path.join(q.root, "MEMORY.md"));
    assert.equal(memory, "Externally replaced fact");
  });

  it("snapshot-based formal counts include unaffected memory files", async () => {
    await atomicText(path.join(q.root, "MEMORY.md"), "Old formal a");
    await atomicText(path.join(q.root, "USER.md"), "User profile fact");
    await q.stage([input("Stale formal a")]);
    const result = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) : {
        decisions: [
          { id: data.drafts[0].id, action: "replace",
            existing: [data.formal.entries.find((e: any) => e.content === "Old formal a").id], content: "Newer state of a" },
        ],
      })).review(context(), true);
    // One entry replaced in MEMORY.md while the unaffected USER.md entry is
    // still counted: before and after both see the full snapshot (two entries).
    assert.deepEqual(result.publication.formalMemory, { before: 2, after: 2, net: 0, coverage: "snapshot_files" });
  });

  it("helper without a snapshot keeps changed-files scope for legacy callers", () => {
    const draft = { id: "d1", kind: "memory" } as any;
    const withChange = publicationOutcome(
      [{ file: "/r/MEMORY.md", before: "A", after: ["A", "B"].join(ENTRY_DELIMITER) }],
      [{ id: "d1", action: "add" }],
      new Map([["d1", draft]]),
    );
    assert.deepEqual(withChange.formalMemory, { before: 1, after: 2, net: 1, coverage: "changed_files" });
    assert.equal(withChange.formalSkills, null);
    const noChange = publicationOutcome([], [{ id: "d1", action: "discard" }], new Map([["d1", draft]]));
    assert.equal(noChange.formalMemory, null);
    assert.equal(noChange.formalSkills, null);
    const withSnapshot = publicationOutcome([], [], new Map(), { files: { "/r/MEMORY.md": "A", "/r/skills/x/SKILL.md": "body" } });
    assert.deepEqual(withSnapshot.formalMemory, { before: 1, after: 1, net: 0, coverage: "snapshot_files" });
    assert.deepEqual(withSnapshot.formalSkills, { before: 1, after: 1, net: 0, coverage: "snapshot_files" });
  });

  it("legacy schema-2 totals without new keys stay finite across persist", async () => {
    const { ReviewMetrics } = await import("../../src/handlers/candidate-metrics.js");
    await atomicText(path.join(q.root, "candidate-metrics.json"), JSON.stringify({
      schema: 1,
      totals: { runs: 2, success: 2, failed: 0, cancelled: 0, durationMs: 9,
        cleanupDropped: 1, cleanupMergedAway: 2, promoted: 1, promotionDiscarded: 3 },
      recent: [],
    }));
    const m = new ReviewMetrics(q.root);
    m.counts.cleanupInputSkipped = 1;
    m.counts.cleanupDeduplicated = 2;
    await m.finish("success");
    const metrics = JSON.parse((await readOptional(path.join(q.root, "candidate-metrics.json")))!);
    assert.equal(metrics.totals.cleanupInputSkipped, 1);
    assert.equal(metrics.totals.cleanupDeduplicated, 2);
    // Untouched legacy keys pass through unchanged, never NaN.
    assert.equal(metrics.totals.cleanupDropped, 1);
    assert.equal(metrics.totals.promoted, 1);
    assert.equal(metrics.totals.promotionDiscarded, 3);
    for (const key of ["cleanupInputSkipped", "cleanupDeduplicated", "cleanupDropped", "cleanupMergedAway", "promoted", "promotionDiscarded", "cleanupContentRewrites"])
      assert.ok(Number.isFinite(metrics.totals[key]), key + " must be finite, got " + metrics.totals[key]);
  });

  it("schema-3 migration keeps unknown publication history for old totals", async () => {
    await atomicText(path.join(q.root, "candidate-metrics.json"), JSON.stringify({
      schema: 1, totals: { runs: 4, success: 4, failed: 0, cancelled: 0, durationMs: 10, promoted: 2 }, recent: [],
    }));
    await q.stage([input("Migrating synthetic fact")]);
    await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) :
        { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })) })).review(context(), true);
    const metrics = JSON.parse((await readOptional(path.join(q.root, "candidate-metrics.json")))!);
    assert.equal(metrics.totals.runs, 5);
    assert.equal(metrics.totals.promoted, 3);
    assert.equal(metrics.totals.publications.historyKnown, false);
    assert.equal(metrics.totals.publications.commits, 1);
    assert.equal(metrics.totals.publications.memoryAdd, 1);
  });

  it("counts merge rewrites separately from merged-away drafts and flags model no-ops", async () => {
    await q.stage([input("Draft one"), input("Draft two")]);
    const result = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? { keep: [], drop: [], merge: [{ ids: data.drafts.map((d: any) => d.id), content: "Merged synthetic content" }], add: [] } :
        { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "discard" })) })).review(context(), true);
    assert.equal(result.cleanupMergedAway, 1);
    assert.equal(result.cleanupContentRewrites, 1);
    assert.equal(result.cleanupOutputUnchanged, false);
    await q.stage([input("Rewritable synthetic draft")]);
    const result2 = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? { keep: [], drop: [], merge: [{ ids: [data.drafts[0].id], content: "Rewritten synthetic content" }], add: [] } :
        { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "discard" })) })).review(context(), true);
    assert.equal(result2.cleanupMergedAway, 0);
    assert.equal(result2.cleanupContentRewrites, 1);
    const result3 = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) :
        { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "discard" })) })).review(context(), true);
    assert.equal(result3.cleanupOutputUnchanged, true);
  });

  it("flags invalid pending ages instead of fabricating one", async () => {
    await q.stage([input("Backdated synthetic fact")]);
    const queue = await q.read();
    queue.drafts[0].stagedAt = "not-a-date";
    await q.save(queue);
    const result = await new CandidateLifecycle(options(async (phase: string, data: any) =>
      phase === "cleanup" ? keep(data.drafts.map((d: any) => d.id)) :
        { decisions: data.drafts.map((d: any) => ({ id: d.id, action: "discard" })) })).review(context(), true);
    assert.equal(result.trigger.pendingAgeUnknown, true);
    assert.equal(result.trigger.oldestPendingMs, 0);
    assert.ok(!JSON.stringify(result).includes("Infinity"));
  });


  it("repurposed removal draft cannot bypass skill format validation", async () => {
    await atomicText(
      path.join(q.root, "skills", "release-task", "SKILL.md"),
      "---\nname: release-task\ndescription: d\nversion: 1\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n" +
        body,
    );
    await q.stage([
      ...Array.from({ length: 20 }, (_, i) => input("Durable " + i)),
      {
        kind: "skill",
        target: "memory",
        project: null,
        action: "remove",
        name: "release-task",
        description: "Release reusable task",
        content: "",
        oldText: body,
      } as DraftInput,
    ]);
    const engine = new CandidateLifecycle(
      options(async (phase: string, data: any) =>
        phase === "cleanup"
          ? keep(data.drafts.map((d: any) => d.id))
          : {
              decisions: data.drafts.map((d: any) => ({ id: d.id, action: "add" })),
            },
      ),
    );
    const r = await engine.review(context());
    // The removal draft repurposed as add lacks all skill sections; with
    // decision.action it is format-blocked and retained, valid peers publish.
    assert.equal(r.promoted, 20);
    const left = (await q.read()).drafts;
    assert.equal(left.length, 1);
    assert.equal(left[0].action, "remove");
    assert.ok(await readOptional(path.join(q.root, "skills", "release-task", "SKILL.md")));
    // a genuine remove decision still publishes end to end
    const formal = (await pub.snapshot()).items.find((i) => i.kind === "skill")!;
    const o2: any = options(async (phase: string, data: any) =>
      phase === "cleanup"
        ? keep(data.drafts.map((d: any) => d.id))
        : {
            decisions: [
              { id: data.drafts[0].id, action: "remove", existing: [formal.id] },
            ],
          },
    );
    o2.config = { ...o2.config, candidateSkillThreshold: 1 };
    const r2 = await new CandidateLifecycle(o2).review(context());
    assert.equal(r2.promoted, 1);
    assert.equal((await q.read()).drafts.length, 0);
  });
});
