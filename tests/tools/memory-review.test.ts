import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerMemoryReview } from "../../src/tools/memory-review-tool.js";
import { registerMemoryTool } from "../../src/tools/memory-tool.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { loadConfig } from "../../src/config.js";
import { withWriteContext } from "../../src/store/write-admission.js";
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-tools-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new MemoryStore({ ...loadConfig(path.join(dir,"missing")), memoryDir: path.join(dir,"memory"), memoryMode:"policy-only" });
  await store.loadFromDisk(); store.setWriteAdmission();
  const tools: Record<string,any> = {};
  const pi = { registerTool(d: any) { tools[d.name] = d; }, registerCommand() {}, on() {} } as any;
  registerMemoryTool(pi,store,null); registerMemoryReview(pi,store,()=>null,async()=>{});
  const ctx = (text: string) => ({ cwd:dir, sessionManager: { getSessionId:()=>"s",getBranch:()=>[{type:"message",id:"u",message:{role:"user",content:text}}] } });
  const call = async (name:string, params:any, text:string) => (await tools[name].execute("t",params,undefined,undefined,ctx(text))).details;
  return { store, tools, call };
}
test("review tool rejects model self-approval and quoted authorization", async t => {
  const { store, call }=await fixture(t);
  const c=await store.add("user","A proposed preference");
  assert.equal((await call("memory_review",{action:"approve",target:"user",id:c.candidate_id},"Continue working")).success,false);
  assert.equal((await call("memory_review",{action:"approve",target:"user",id:c.candidate_id},`What does 'approve ${c.candidate_id}' mean?`)).success,false);
  assert.deepEqual(store.getUserEntries(),[]);
  assert.equal((await call("memory_review",{action:"approve",target:"user",id:c.candidate_id},`approve ${c.candidate_id}`)).success,true);
});
test("stable ID mutation rejects stale revision and archives the old version", async t=>{
  const { store,call }=await fixture(t);
  await call("memory_add",{target:"memory",content:"Initial environment fact"},"Remember: Initial environment fact");
  const e=(await store.reviewAdmission("memory","active")).entries[0];
  assert.equal((await call("memory_replace",{target:"memory",entry_id:e.id,expected_revision:99,content:"wrong"},"Remember this update")).success,false);
  assert.equal((await call("memory_replace",{target:"memory",entry_id:e.id,expected_revision:1,content:"Updated environment fact"},"Remember this update")).success,true);
  const next=(await store.reviewAdmission("memory","active")).entries[0];assert.equal(next.id,e.id);assert.equal(next.revision,2);
});
test("semantic analysis cannot approve or mutate a proposal",async t=>{
  const {store,tools}=await fixture(t);const c=await store.add("memory","Tentative claim");
  const ctx={sessionManager:{getSessionId:()=>"s",getBranch:()=>[]},model:{id:"fake"},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"synthetic"}),streamSimple:()=>({result:async()=>({stopReason:"stop",content:[{type:"text",text:'{"relation":"unsupported"}'}]})})}};
  const r=await tools.memory_review.execute("a",{action:"analyze",target:"memory",id:c.candidate_id},undefined,undefined,ctx);
  assert.equal(r.details.advisory_only,true);assert.deepEqual(store.getMemoryEntries(),[]);
  assert.equal((await store.reviewAdmission("memory","show",c.candidate_id)).candidate.status,"pending");
});
test("dry-run tool persists neither a proposal nor active content",async t=>{
  const {store,call}=await fixture(t);
  const r=await call("memory_review",{action:"dry_run",target:"user",proposal:{action:"add",content:"Maybe preference"}},"Discuss the design");
  assert.equal(r.dry_run,true);assert.deepEqual(store.getUserEntries(),[]);
  assert.equal((await store.reviewAdmission("user","list")).candidates.length,0);
});
test("automatic project failure replacement cannot touch another project",async t=>{
  const {store}=await fixture(t);store.setWriteAdmission(false);
  await store.addFailure("shared instruction",{category:"insight",project:"a"});await store.addFailure("shared instruction",{category:"insight",project:"b"});store.setWriteAdmission();
  const c=await withWriteContext({origin:"automatic",sources:[],failureProject:"a"},()=>store.replace("failure","shared instruction","[insight] updated for a"));
  assert.equal((await store.reviewAdmission("failure","approve",c.candidate_id)).success,true);
  const active=(await store.reviewAdmission("failure","active")).entries;
  assert.equal(active.find((e:any)=>e.project==="b").text,"[insight] shared instruction");
  assert.equal(active.find((e:any)=>e.project==="a").text,"[insight] updated for a");
});

test("direct extraction links real branch sources and stages instead of publishing", async t=>{
  const { store } = await fixture(t);
  const { runDirectMemoryCompletion } = await import("../../src/handlers/review-memory-ops.js");
  const ctx = { model: { provider: "openai", id: "synthetic", reasoning: false },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic" }) },
    sessionManager: { getSessionId: () => "s", getBranch: () => [{ type: "message", id: "real-user-id", message: { role: "user", content: "A preference under discussion" } }] } } as any;
  const result = await runDirectMemoryCompletion(ctx,store,null,{systemPrompt:"synthetic",userPrompt:"synthetic",config:{}},null,null,{
    completeSimple: async () => ({stopReason:"stop",content:[{type:"text",text:JSON.stringify({operations:[{action:"add",target:"user",content:"A proposed preference"}]})}]}) as any,
  });
  assert.equal(result.ok,true);assert.equal(result.pendingCount,1);assert.equal(result.appliedCount,0);
  assert.deepEqual(store.getUserEntries(),[]);
  const c=(await store.reviewAdmission("user","list")).candidates[0];assert.equal(c.sources[0].messageId,"real-user-id");
});
test("automatic paths never fall back to a Pi child when admission is enabled",async t=>{
  const { store } = await fixture(t);
  const { setupCorrectionDetector } = await import("../../src/handlers/correction-detector.js");
  const { setupSessionFlush } = await import("../../src/handlers/session-flush.js");
  const { setupBackgroundReview } = await import("../../src/handlers/background-review.js");
  const config={...loadConfig("/nonexistent"),flushMinTurns:0,flushOnCompact:true,nudgeInterval:1};
  let children=0;const handlers:Record<string,Function[]>={};
  const pi={on:(n:string,fn:Function)=>(handlers[n]??=[]).push(fn),exec:async()=>{children++;return {code:0,stdout:"",stderr:""};}} as any;
  const fail=async()=>({ok:false,appliedCount:0,fallbackReason:"no_model" as const});
  const ctx={cwd:"/synthetic",ui:{notify(){}},sessionManager:{getBranch:()=>Array.from({length:6},(_,i)=>({type:"message",id:String(i),message:{role:i%2?"assistant":"user",content:"no, use pnpm"}}))}} as any;
  setupCorrectionDetector(pi,store,null,config,null,null,{runDirectMemoryCompletion:fail});
  setupSessionFlush(pi,store,null,config,null,null,{runDirectMemoryCompletion:fail});
  const settled=Promise.withResolvers<void>();
  setupBackgroundReview(pi,store,null,config,{deps:{runDirectReview:fail,execChildPrompt:async()=>{children++;return {code:0,stdout:"",stderr:""};},onReviewSettled:settled.resolve}});
  const emit=async(n:string,e:any={})=>{for(const fn of handlers[n]??[])await fn(e,ctx);};
  for(let i=0;i<3;i++)await emit("message_end",{message:{role:"user",content:"no, use pnpm"}});
  await emit("turn_end",{});await settled.promise;await emit("session_before_compact",{});
  assert.equal(children,0);
});

test("new review projections route read-only and cannot authorize a decision",async t=>{
 const {store,call,tools}=await fixture(t);const c=await store.add("user","Tentative fixture preference");
 for(const action of ["groups","evidence"]){const r=await call("memory_review",{action,target:"user",id:c.candidate_id},"Inspect the queue");assert.equal(r.success,true);assert.equal(r.advisory_only,true);}
 assert.equal((await call("memory_review",{action:"approve",target:"user",id:c.candidate_id},"Organize all pending memories")).success,false);
 assert.deepEqual(store.getUserEntries(),[]);assert.match(tools.memory_review.description,/not a complete dependency graph/);
});
