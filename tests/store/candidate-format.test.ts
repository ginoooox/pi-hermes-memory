import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  CandidateStore,
  applyCleanup,
  atomicText,
  readOptional,
  type Draft,
  type DraftInput,
} from "../../src/store/candidate-store.js";
import { CandidatePublisher } from "../../src/store/candidate-publisher.js";
import {
  MEMORY_CATEGORIES,
  SKILL_REQUIRED_SECTIONS,
  draftFormatIssues,
  failureFormatIssues,
  skillFormatIssues,
} from "../../src/store/candidate-format.js";
import { CandidateLifecycle } from "../../src/handlers/candidate-lifecycle.js";
import { loadConfig } from "../../src/config.js";
import { ENTRY_DELIMITER } from "../../src/constants.js";
import { parseMarkdownMemoryEntry } from "../../src/store/sqlite-memory-store.js";

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
const memory = (content = "Permanent fact"): DraftInput => ({
  kind: "memory",
  target: "memory",
  project: null,
  action: "add",
  content,
});

let root: string, q: CandidateStore, pub: CandidatePublisher;
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
            content: [{ type: "text", text: "A completed task" }],
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

/** Inject a pre-format-gate (legacy) draft directly, as an old queue would hold it. */
const injectLegacy = async (d: Omit<Draft, "updatedAt"> & { updatedAt?: string }) => {
  await q.locked(async (qq) => {
    qq.drafts.push({
      ...d,
      updatedAt: d.updatedAt ?? new Date().toISOString(),
    } as Draft);
    await q.save(qq);
  });
};
const legacySkill = (): Omit<Draft, "updatedAt"> => ({
  id: "legacy-1",
  kind: "skill",
  target: "memory",
  project: null,
  action: "add",
  name: "legacy-skill",
  description: "Old draft without sections",
  content: "Free-form notes without any required sections",
  stagedAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
});

describe("candidate format validation", { concurrency: 1 }, () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-format-"));
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

  it("flags missing and empty required skill sections, including Pitfalls", () => {
    assert.deepEqual(skillFormatIssues(body), []);
    assert.deepEqual(
      SKILL_REQUIRED_SECTIONS,
      ["When to Use", "Procedure", "Pitfalls", "Verification"],
    );
    const missing = skillFormatIssues("## When to Use\nx\n\n## Procedure\ny");
    assert.ok(missing.some((i) => i.includes("Pitfalls")));
    assert.ok(missing.some((i) => i.includes("Verification")));
    const empty = skillFormatIssues(
      body.replace("## Pitfalls\n- Preserve conditions", "## Pitfalls"),
    );
    assert.deepEqual(empty, ['"## Pitfalls" section is empty']);
  });

  it("validates failure category tags against the MemoryCategory vocabulary only", () => {
    for (const c of MEMORY_CATEGORIES)
      assert.deepEqual(failureFormatIssues(`[${c}] Tried x — Failed: boom`), []);
    // reason metadata is preserved, never rewritten by the validator
    const ok = draftFormatIssues({
      kind: "memory",
      target: "failure",
      action: "add",
      content: "[tool-quirk] Flag X breaks — Failed: boom",
    });
    assert.deepEqual(ok, []);
    const bad = failureFormatIssues("[bug] Tried x — Failed: boom");
    assert.equal(bad.length, 1);
    assert.ok(bad[0].includes("failure, correction, insight"));
    // a present tag must match the native parser: whitespace + nonempty text
    const malformed = failureFormatIssues("[failure]no-space");
    assert.equal(malformed.length, 1);
    assert.ok(malformed[0].includes("whitespace and nonempty content"));
    assert.deepEqual(failureFormatIssues("[failure] Real text — Failed: boom"), []);
    // no tag and ordinary memories are never forced into a category
    assert.deepEqual(failureFormatIssues("Just an observation"), []);
    assert.deepEqual(
      draftFormatIssues({
        kind: "memory",
        target: "memory",
        action: "add",
        content: "[anything] free form",
      }),
      [],
    );
    // skill removals need no sections
    assert.deepEqual(
      draftFormatIssues({
        kind: "skill",
        target: "memory",
        action: "remove",
        content: "",
      }),
      [],
    );
  });

  it("matches the native failure parser exactly", () => {
    const ok = parseMarkdownMemoryEntry("[insight] Tried x — Failed: boom", "failure");
    assert.equal(ok.category, "insight");
    assert.equal(ok.failureReason, "boom");
    const noTag = parseMarkdownMemoryEntry("Just an observation", "failure");
    assert.equal(noTag.category, null);
    // malformed "[failure]no-space" silently loses its category natively, so
    // the validator rejects it upstream instead of normalizing text
    const malformed = parseMarkdownMemoryEntry("[failure]no-space", "failure");
    assert.equal(malformed.category, null);
    assert.equal(malformed.failureReason, null);
    // non-failure targets never expose category fields
    assert.equal(
      (parseMarkdownMemoryEntry("[failure] x", "memory") as any).category,
      undefined,
    );
  });

  it("staging rejects malformed new writes with actionable transient issues", async () => {
    await assert.rejects(
      q.stage([{ ...skill(), content: "## When to Use\nx" }]),
      /Pitfalls/,
    );
    await assert.rejects(
      q.stage([
        {
          kind: "memory",
          target: "failure",
          project: null,
          action: "add",
          content: "[bug] Tried x",
        },
      ]),
      /tool-quirk/,
    );
    // queue stayed untouched
    assert.equal((await q.read()).drafts.length, 0);
    await q.stage([skill()]);
    assert.equal((await q.read()).drafts.length, 1);
  });

  it("legacy malformed drafts stay inspectable and do not poison valid peers", async () => {
    await injectLegacy(legacySkill());
    // read never throws for old malformed content
    const q0 = await q.read();
    assert.equal(q0.drafts.length, 1);
    // staging a valid peer still works
    await q.stage([memory("Fresh valid fact")]);
    const q1 = await q.read();
    assert.equal(q1.drafts.length, 2);
    // current format issues are computed on inspection, not persisted
    const legacy = q1.drafts.find((d) => d.id === "legacy-1")!;
    assert.equal((legacy as any).formatIssues, undefined);
    assert.ok(draftFormatIssues(legacy).some((i) => i.includes("Pitfalls")));
    const queueRaw = JSON.parse((await fs.readFile(q.file, "utf8")));
    assert.equal(JSON.stringify(queueRaw).includes("formatIssues"), false);
  });

  it("cleanup keeps malformed legacy drafts without validating them", async () => {
    await injectLegacy(legacySkill());
    const before = await q.read();
    const after = applyCleanup(
      before,
      before.drafts,
      { keep: before.drafts.map((d) => d.id), drop: [], merge: [], add: [] },
      null,
    );
    assert.equal(after.drafts.length, 1);
  });

  it("cleanup merge repairs legacy with valid content; broken merge is rejected", async () => {
    await injectLegacy(legacySkill());
    const before = await q.read();
    const repaired = applyCleanup(
      before,
      before.drafts,
      {
        keep: [],
        drop: [],
        merge: [{ ids: ["legacy-1"], content: body }],
        add: [],
      },
      null,
    );
    assert.deepEqual(draftFormatIssues(repaired.drafts[0]), []);
    assert.throws(
      () =>
        applyCleanup(
          before,
          before.drafts,
          {
            keep: [],
            drop: [],
            merge: [{ ids: ["legacy-1"], content: "Still no sections" }],
            add: [],
          },
          null,
        ),
      /format-valid/i,
    );
    // the broken merge left the queue untouched
    assert.equal((await q.read()).drafts.length, 1);
  });

  it("promotion publishes repaired legacy and valid peers, retains unrepaired", async () => {
    await injectLegacy(legacySkill());
    await q.stage([memory("Fresh valid fact")]);
    const drafts = (await q.read()).drafts;
    const legacy = drafts.find((d) => d.id === "legacy-1")!;
    const fresh = drafts.find((d) => d.id !== "legacy-1")!;
    const report = await new CandidateLifecycle(
      options(async (phase: string, data: any) =>
        phase === "cleanup"
          ? { keep: data.drafts.map((d: any) => d.id), drop: [], merge: [], add: [] }
          : {
              decisions: [
                { id: legacy.id, action: "add" },
                { id: fresh.id, action: "add" },
              ],
            },
      ),
    ).review(context(), true);
    assert.equal(report.formatBlocked, 1);
    // valid peer published, unrepaired legacy retained pending
    const mem = await readOptional(path.join(q.root, "MEMORY.md"));
    assert.ok(mem!.includes("Fresh valid fact"));
    const after = await q.read();
    assert.equal(after.drafts.length, 1);
    assert.equal(after.drafts[0].id, "legacy-1");
  });

  it("promotion publishes a legacy draft the model repairs with valid content", async () => {
    await injectLegacy(legacySkill());
    const before = await q.read();
    await new CandidateLifecycle(
      options(async (phase: string, data: any) =>
        phase === "cleanup"
          ? { keep: data.drafts.map((d: any) => d.id), drop: [], merge: [], add: [] }
          : {
              decisions: [
                { id: before.drafts[0].id, action: "add", content: body },
              ],
            },
      ),
    ).review(context(), true);
    const skillFile = await readOptional(
      path.join(q.root, "skills", "legacy-skill", "SKILL.md"),
    );
    assert.ok(skillFile!.includes("## Pitfalls"));
    assert.equal((await q.read()).drafts.length, 0);
  });

  it("publisher still rejects malformed published failure content (defense in depth)", async () => {
    await q.stage([
      {
        kind: "memory",
        target: "failure",
        project: null,
        action: "add",
        content: "[tool-quirk] ok — Failed: known reason",
      },
    ]);
    const before = await q.read(),
      snapshot = await pub.snapshot();
    await assert.rejects(
      pub.plan(
        before.drafts,
        [
          {
            id: before.drafts[0].id,
            action: "add",
            content: "[bug] bad tag — Failed: x",
          },
        ],
        snapshot,
      ),
      /format validation/,
    );
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
    const failures = await readOptional(path.join(q.root, "failures.md"));
    assert.ok(failures!.includes("Failed: known reason"));
    assert.ok(failures!.split(ENTRY_DELIMITER)[0].startsWith("[tool-quirk]"));
  });

  it("destructive skill removal drafts need no sections end to end", async () => {
    await atomicText(
      path.join(q.root, "skills", "release-task", "SKILL.md"),
      "---\nname: release-task\ndescription: d\nversion: 1\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\n" +
        body,
    );
    const snapshot = await pub.snapshot();
    const formal = snapshot.items.find((i) => i.kind === "skill")!;
    const changes = await pub.plan(
      [
        {
          id: "rm",
          kind: "skill",
          target: "memory",
          project: null,
          action: "remove",
          name: "release-task",
          description: "d",
          content: "",
          oldText: formal.content,
          updatedAt: new Date().toISOString(),
        } as Draft,
      ],
      [{ id: "rm", action: "remove", existing: [formal.id] }],
      snapshot,
    );
    assert.equal(changes[0].after, null);
  });
});
