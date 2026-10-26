/**
 * Candidate.3 entrypoint wiring: the real extension entry point must report a
 * consistent runtime version and admission thresholds, and the injected
 * candidate policy must reflect the configured thresholds/hours (defaults and
 * overrides) through the shared `admissionPolicy` resolver — not hardcoded
 * 20/3 strings. Exercises actual `session_start` and `before_agent_start`
 * handlers against a synthetic SDK surface; no live Pi instance.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-candidate-wiring-"));
const previousRoot = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { default: registerExtension } = await import("../src/index.js");
const { EXTENSION_VERSION } = await import("../src/constants.js");
const globalDir = path.join(root, "pi-hermes-memory");
const cwd = path.join(root, "workspace");

function structuredOptions() {
  return {
    customPrompt: undefined,
    forceSystemPrompt: undefined,
    selectedTools: ["read"],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: "",
    sections: {},
    cwd,
    contextFiles: [],
    skills: [],
  };
}

let handlers: Record<string, Array<(event: any, ctx: any) => any>>;
let ctx: any;

async function registerWith(overrides: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(root, "hermes-memory-config.json"), JSON.stringify({
    memoryMode: "policy-only",
    memoryPolicyStyle: "full",
    lazyInitialization: true,
    reviewEnabled: false,
    correctionDetection: false,
    flushOnCompact: false,
    flushOnShutdown: false,
    ...overrides,
  }));
  handlers = {};
  registerExtension({
    on(event: string, handler: any) { (handlers[event] ??= []).push(handler); },
    registerTool() {},
    registerCommand() {},
  } as any);
  for (const handler of handlers["session_start"] ?? []) await handler({}, ctx);
}

beforeEach(async () => {
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    ui: { notify: () => {} },
  };
});

after(async () => {
  if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousRoot;
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("candidate.3 entrypoint wiring", () => {
  it("session_start writes runtime status from EXTENSION_VERSION with configured thresholds (defaults)", async () => {
    await registerWith();
    const status = JSON.parse(await fs.readFile(path.join(globalDir, "runtime-status.json"), "utf8"));
    assert.equal(status.version, "0.9.11-candidate.3");
    assert.equal(status.version, EXTENSION_VERSION);
    assert.equal(status.memoryThreshold, 10);
    assert.equal(status.skillThreshold, 2);
    assert.equal(status.pendingFallbackHours, 24);
  });

  it("injected candidate policy matches configured thresholds/hours (defaults)", async () => {
    await registerWith();
    const event = { systemPrompt: "base", systemPromptOptions: structuredOptions() };
    for (const handler of handlers["before_agent_start"] ?? []) await handler(event, ctx);
    const appended = event.systemPromptOptions.appendSystemPrompt;
    assert.match(appended, /10 retained memories or 2 retained skills/);
    assert.match(appended, /at least 24h old/);
    assert.doesNotMatch(appended, /20 retained memories or 3 retained skills/);
  });

  it("configured overrides reach runtime status and the injected policy", async () => {
    await registerWith({
      candidateMemoryThreshold: 7,
      candidateSkillThreshold: 5,
      candidatePendingFallbackHours: 48,
    });
    const status = JSON.parse(await fs.readFile(path.join(globalDir, "runtime-status.json"), "utf8"));
    assert.equal(status.memoryThreshold, 7);
    assert.equal(status.skillThreshold, 5);
    assert.equal(status.pendingFallbackHours, 48);
    const event = { systemPrompt: "base", systemPromptOptions: structuredOptions() };
    for (const handler of handlers["before_agent_start"] ?? []) await handler(event, ctx);
    const appended = event.systemPromptOptions.appendSystemPrompt;
    assert.match(appended, /7 retained memories or 5 retained skills/);
    assert.match(appended, /at least 48h old/);
  });
});
