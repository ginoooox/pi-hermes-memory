#!/usr/bin/env node
// Exercise Pi's real jiti loader and completion SDK without package-local peers.
// npm access installs production dependencies; model traffic is loopback-only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "pi-hermes-production-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let requests = 0;
const server = createServer((req, res) => {
  let body="";req.setEncoding("utf8");req.on("data",chunk=>{body+=chunk;});
  req.on("end", () => {
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    requests++;
    const request=JSON.parse(body);const last=request.messages.at(-1).content;
    const input=typeof last==="string"?last:last.filter(x=>x.type==="text").map(x=>x.text).join("\n");
    let answer='{"operations":[]}';
    try{const data=JSON.parse(input);if(Array.isArray(data.drafts)){answer=JSON.stringify(request.messages[0].content.includes("DRAFT workspace")?{keep:data.drafts.map(d=>d.id),drop:[],merge:[],add:[]}:{decisions:data.drafts.map(d=>({id:d.id,action:"add"}))});}}catch{}
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason) => ({
      id: "smoke", object: "chat.completion.chunk", created: 0, model: "smoke",
      choices: [{ index: 0, delta, finish_reason }],
    });
    res.end([
      `data: ${JSON.stringify(chunk({ role: "assistant", content: answer }, null))}`,
      `data: ${JSON.stringify(chunk({}, "stop"))}`,
      "data: [DONE]", "",
    ].join("\n\n"));
  });
});

function npm(args, cwd) {
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "inherit"],
  });
}

try {
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  // npm <= 11 prints a one-element array; npm 12+ prints an object keyed by package name.
  const packOutput = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], repo));
  const [packed] = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  const install = join(root, "install");
  await mkdir(install);
  await writeFile(join(install, "package.json"), JSON.stringify({ name: "production-smoke", private: true }));
  npm(["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)], install);
  const installed = join(install, "node_modules", "pi-hermes-memory");
  const requireFromPackage = createRequire(join(installed, "package.json"));
  for (const specifier of ["@earendil-works/pi-ai/compat", "@earendil-works/pi-coding-agent"]) {
    assert.throws(() => requireFromPackage.resolve(specifier), { code: "MODULE_NOT_FOUND" });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const probe = join(installed, "production-probe.ts");
  await writeFile(probe, `
import { Type } from "typebox";
import { runDirectMemoryCompletion } from "./src/handlers/review-memory-ops.js";
import { CandidateStore } from "./src/store/candidate-store.js";
import { CandidateLifecycle } from "./src/handlers/candidate-lifecycle.js";
export default function (pi) {
  pi.registerTool({
    name: "production_probe", label: "Probe", description: "Synthetic direct completion", parameters: Type.Object({}),
    async execute(toolCallId) {
      const model = {
        provider: "openai", api: "openai-completions", id: "smoke", name: "Smoke", baseUrl: ${JSON.stringify(baseUrl)},
        reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      if(toolCallId === "candidate"){
        const queue=new CandidateStore(${JSON.stringify(join(root,'candidate-data'))});
        await queue.stage([{kind:"memory",target:"memory",project:null,action:"add",content:"Synthetic durable production fixture"}]);
        const ctx={model,modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"synthetic-smoke-key"})},sessionManager:{getSessionId:()=>"smoke",getBranch:()=>[]},ui:{notify:()=>{}}};
        const engine=new CandidateLifecycle({queue,config:{},nativeSkills:${JSON.stringify(join(root,'native'))},project:()=>({name:null,root:null}),ensureReady:async()=>{},synchronize:async()=>{}});
        const report=await engine.review(ctx,true);
        return {content:[{type:"text",text:JSON.stringify(report)}],details:report};
      }
      const result = await runDirectMemoryCompletion({
        model, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-smoke-key" }) },
      }, {}, null, { userPrompt: "Return no memory operations.", systemPrompt: "Synthetic test.", config: {}, timeoutMs: 10000 });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
`);

  // The host SDK is installed in the development checkout, not beside the
  // production package. Only Pi's loader can provide its aliases to the probe.
  const hostSdk = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", hostSdk).href);
  const loaded = await loadExtensions([join(installed, "src", "index.ts"), probe], install);
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions.find((extension) => extension.tools.has("production_probe"))
    ?.tools.get("production_probe").definition;
  assert.ok(tool, "production probe registered through Pi");
  for (const operation of ["review", "flush", "correction", "consolidation"]) {
    const result = await tool.execute(operation, {});
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    assert.equal(result.details.appliedCount, 0);
  }
  const candidateResult=await tool.execute("candidate",{});
  assert.equal(candidateResult.details.promoted,1);
  assert.equal(candidateResult.details.retained,0);
  assert.equal(requests, 6);
  console.log("Production install passed: no package-local SDK peers; Pi jiti load and four upstream completions plus real candidate cleanup/promotion loopback requests succeeded.");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
}
