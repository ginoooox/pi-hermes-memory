import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  CandidateStore,
  applyCleanup,
  thresholdReached,
  atomicText,
  readOptional,
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
} from "../../src/handlers/candidate-lifecycle.js";
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
      { keep: [], drop: visible.map((d) => d.id), merge: [], add: [] },
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
  it("triggers at 20 memories OR 3 skills after deduplication", async () => {
    await q.stage(Array.from({ length: 19 }, (_, i) => input("fact " + i)));
    assert.equal(thresholdReached((await q.read()).drafts), false);
    await q.stage([input("fact 19")]);
    assert.equal(thresholdReached((await q.read()).drafts), true);
    assert.equal(
      thresholdReached(
        [0, 1, 2].map((i) => ({
          ...skill("task-" + i),
          id: String(i),
          updatedAt: "now",
        })),
      ),
      true,
    );
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
    await q.stage([{ ...skill(), content: "Only notes" }]);
    let before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        [{ id: before.drafts[0].id, action: "add" }],
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
        return { ...keep([data.drafts[0].id]), drop: [data.drafts[1].id] };
      }),
    );
    const r = await engine.review(context());
    assert.equal(r.retained, 1);
    assert.equal(r.promoted, 0);
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
});
