/** Real SDK lifecycle tests; entirely synthetic, no inference or private agent directory. */
import { it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CandidateLifecycle } from "../../src/handlers/candidate-lifecycle.js";
import { CandidateStore } from "../../src/store/candidate-store.js";

for (const reason of ["new", "resume", "reload"] as const) {
  it("real SDK registers and selectively enables candidates on " + reason, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "candidate-sdk-"));
    let session: any;
    try {
      const settingsManager = SettingsManager.inMemory({});
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
        noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
        extensionFactories: [(pi) => {
          new CandidateLifecycle({ queue: new CandidateStore(path.join(root, "memory")), config: {} as any,
            nativeSkills: path.join(root, "native"), project: () => ({ name: null, root: null }),
            ensureReady: async () => {}, synchronize: async () => {} }).register(pi);
          for (const name of ["memory_add", "unselected_extra"]) pi.registerTool({ name, label: name,
            description: "Synthetic fixture", parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }) });
          // Reproduce a legacy runtime's selected loadout before the candidate migration handler.
          pi.on("session_start", () => {});
        }],
      });
      await loader.reload();
      let manager = SessionManager.inMemory(root);
      if (reason === "resume") {
        const file = path.join(root, "synthetic-old-session.jsonl");
        await fs.writeFile(file, [
          { type: "session", version: 3, id: "synthetic-old-session", timestamp: new Date().toISOString(), cwd: root },
          { type: "message", id: "synthetic-user", parentId: null, timestamp: new Date().toISOString(),
            message: { role: "user", content: "Synthetic legacy session", timestamp: Date.now() } },
        ].map(e => JSON.stringify(e)).join("\n") + "\n");
        manager = SessionManager.open(file);
        assert.equal(manager.getBranch().length, 1);
      }
      session = (await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader,
        settingsManager, sessionManager: manager, sessionStartEvent: { type: "session_start", reason },
      })).session;
      session.setActiveToolsByName(["read", "memory_add"]);
      await session.bindExtensions({});
      assert.ok(session.getActiveToolNames().includes("memory_candidates"));
      assert.ok(!session.getActiveToolNames().includes("unselected_extra"));
      assert.ok(manager.getBranch().some((e: any) => e.type === "custom" && e.customType === "hermes-candidate-tools-v1"));
      await session.reload();
      assert.ok(session.getActiveToolNames().includes("memory_candidates"));
      assert.ok(!session.getActiveToolNames().includes("bash"));
    } finally { session?.dispose(); await fs.rm(root, { recursive: true, force: true }); }
  });
}
