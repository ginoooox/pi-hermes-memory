import {test} from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {selectProposalSources,relatedSkills,pendingQuality,QUALITY_REVIEW_POLICY,compactQualityContext} from "../../src/store/proposal-quality.js";
import {MemoryStore} from "../../src/store/memory-store.js";
import {loadConfig} from "../../src/config.js";
import {contextFromSession,withWriteContext,fingerprint,type Candidate,type AdmissionSource} from "../../src/store/write-admission.js";
const source=(messageId:string,text:string,role="toolResult",timestamp="2026-10-24T01:00:00Z"):AdmissionSource=>({sessionId:"synthetic",messageId,role,text,timestamp});
const candidate=(text:string):Candidate=>({id:"c",key:"c",status:"pending",reason:"test",fingerprint:fingerprint([]),operations:[{action:"add",content:text}],sources:[source("u","Please inspect Windows S0 WiFi","user")],createdAt:"2026-10-24T02:00:00Z",similar:[]});
async function fixture(t:any){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"quality-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const store=new MemoryStore({...loadConfig(path.join(dir,"missing")),memoryMode:"policy-only",memoryDir:dir});await store.loadFromDisk();store.setWriteAdmission();return{dir,store};}
const emptySkills={matches:[],scanned:0,bytes:0,roots:[],incomplete:false,truncated:false,unreadable:[],coverage:"synthetic"};
test("per-operation retrieval finds older log beyond last three tool results, excludes boilerplate",()=>{
 const pool=[source("u","Check Windows S0 WiFi","user"),source("log","Windows S0 WiFi connected; SSH unresponsive"),source("a","Successfully replaced Windows S0 WiFi block"),source("b","---\nname: Windows S0 WiFi\n"),source("c","Tool call bash was not executed"),source("d","cleanup done")];
 const r=selectProposalSources([{action:"add",content:"Windows S0 WiFi connected; SSH unresponsive"}],pool);
 assert.ok(r.selection.by_operation[0].source_ids.some(s=>s.messageId==="log"));
 assert.ok(!r.selection.by_operation[0].source_ids.some(s=>["a","b","c","d"].includes(s.messageId)));
 assert.equal(r.selection.by_operation[0].entailment,"not_verified");
});
test("multi-operation batches do not assign every source to every claim",()=>{
 const r=selectProposalSources([{action:"add",content:"Windows S0 WiFi connected"},{action:"add",content:"LiteAPI quota endpoint 404"}],[source("win","Windows S0 WiFi connected"),source("api","LiteAPI quota endpoint 404")]);
 assert.deepEqual(r.selection.by_operation.map(o=>o.source_ids.map(s=>s.messageId)),[["win"],["api"]]);
});
test("download observation cannot certify notification success; uncovered claims show gaps",()=>{
 const r=selectProposalSources([{action:"add",content:"Swiftgram 已下载。通知问题已经解决。"}],[source("u","Swiftgram 已下载","user")]);
 assert.equal(r.selection.by_operation[0].claims[1].source_ids.length,0);
 assert.equal(r.selection.by_operation[0].claims[0].entailment,"not_verified");
 assert.match(QUALITY_REVIEW_POLICY,/downloads.*do not prove/);
});
test("source roles cannot be supplied by assistant text or anonymous model fields",()=>{
 const r=selectProposalSources([{action:"add",content:"WiFi connected"}],[source("a","WiFi connected","assistant"),{...source("","WiFi connected")},source("t","WiFi connected")]);
 assert.deepEqual(r.sources.map(s=>s.messageId),["t"]);
});
test("real authorization and contextual user references remain separate from supporting leads",()=>{
 const u=source("u","Approve candidate UUID","user");const r=selectProposalSources([{action:"add",content:"actual endpoint log"}],[source("t","actual endpoint log"),u],[u]);
 assert.equal(r.selection.authorization_sources[0].messageId,"u");assert.ok(!r.selection.by_operation[0].source_ids.some(s=>s.messageId==="u"));
});
test("later related user/tool messages request a recheck without claiming supersession",()=>{
 const c=candidate("Windows S0 WiFi connected");const before=JSON.stringify(c);
 const q=pendingQuality(c,[],[source("new","Windows S0 WiFi disconnected","toolResult","2026-10-24T03:00:00Z"),{...source("other","Windows S0 WiFi connected","user","2026-10-24T04:00:00Z"),sessionId:"another-session"}],emptySkills);
 assert.equal(q.needs_recheck,true);assert.equal(q.later_related_messages.length,1);assert.equal(q.later_related_messages[0].messageId,"new");assert.equal(JSON.stringify(c),before);
});
test("older messages and unrelated administrative logs do not become later conclusions",()=>{
 const q=pendingQuality(candidate("Windows S0 WiFi connected"),[],[source("old","Windows S0 WiFi connected"),source("new","Successfully replaced Windows S0 WiFi", "toolResult","2026-10-24T03:00:00Z")],emptySkills);
 assert.equal(q.later_related_messages.length,0);
});
test("skill retrieval returns digest and actual body, bounds large files and ignores symlinks",async t=>{
 const{dir}=await fixture(t);for(const name of ["real","large","link"])await fs.mkdir(path.join(dir,"skills",name),{recursive:true});
 await fs.writeFile(path.join(dir,"skills/real/SKILL.md"),"---\nname: s0-wake\n---\n## Procedure\nWindows S0 WiFi Bluetooth wake only. Never S4.");
 await fs.writeFile(path.join(dir,"skills/large/SKILL.md"),"x".repeat(65537));await fs.symlink(path.join(dir,"skills/real/SKILL.md"),path.join(dir,"skills/link/SKILL.md"));
 const r=await relatedSkills([path.join(dir,"skills")],"Windows S0 WiFi Bluetooth wake");assert.equal(r.matches.length,1);assert.equal(r.matches[0].digest.length,64);assert.match(r.matches[0].excerpt,/Never S4/);assert.equal(r.incomplete,true);
});
test("task-end recheck persists only advisory metadata, preserves status/operations/key/sources/fingerprint and Markdown",async t=>{
 const{dir,store}=await fixture(t);const u=source("u","Windows S0 WiFi connected","user");const r=await withWriteContext({origin:"automatic",sources:[u]},()=>store.add("memory","Windows S0 WiFi connected"));
 const file=path.join(dir,"MEMORY.md.admission.json"),before=JSON.parse(await fs.readFile(file,"utf8"));const c=before.candidates[0];c.createdAt="2026-10-24T02:00:00Z";await fs.writeFile(file,JSON.stringify(before));
 const checked=await store.recheckPendingQuality([u,source("new","Windows S0 WiFi disconnected","toolResult","2026-10-24T03:00:00Z")]);assert.equal(checked,1);
 const after=JSON.parse(await fs.readFile(file,"utf8"));for(const field of ["status","operations","key","sources","fingerprint","id","createdAt"])assert.deepEqual(after.candidates[0][field],c[field]);
 assert.equal(after.candidates[0].quality.needs_recheck,true);assert.deepEqual(store.getMemoryEntries(),[]);assert.equal(after.entries.length,0);
 const current=await fs.readFile(file,"utf8");await store.reviewAdmission("memory","evidence",r.candidate_id,{sources:[u]});assert.equal(await fs.readFile(file,"utf8"),current);
});
test("recheck never edits other-session candidates or decided candidates",async t=>{
 const{dir,store}=await fixture(t);const u=source("u","Windows S0 WiFi connected","user");const r=await withWriteContext({origin:"automatic",sources:[u]},()=>store.add("memory","Windows S0 WiFi connected"));
 const file=path.join(dir,"MEMORY.md.admission.json"),before=await fs.readFile(file,"utf8");assert.equal(await store.recheckPendingQuality([{...u,sessionId:"other"}]),0);assert.equal(await fs.readFile(file,"utf8"),before);
 await store.reviewAdmission("memory","reject",r.candidate_id);const rejected=await fs.readFile(file,"utf8");assert.equal(await store.recheckPendingQuality([u]),0);assert.equal(await fs.readFile(file,"utf8"),rejected);
});
test("recheck adds a skill lead but cannot merge S0 and S4 or change active memory",async t=>{
 const{dir,store}=await fixture(t);await fs.mkdir(path.join(dir,"skills/wake"),{recursive:true});await fs.writeFile(path.join(dir,"skills/wake/SKILL.md"),"Windows S0 Bluetooth wake only; S4 cannot wake");
 const u=source("u","Windows S4 Bluetooth wake unavailable","user");const r=await withWriteContext({origin:"automatic",sources:[u]},()=>store.add("memory","Windows S4 Bluetooth wake unavailable"));
 const e=await store.reviewAdmission("memory","evidence",r.candidate_id);assert.equal(e.quality.skills.matches.length>=1,true);assert.equal(e.quality.advisory_only,true);assert.equal((await store.reviewAdmission("memory","show",r.candidate_id)).candidate.status,"pending");assert.deepEqual(store.getMemoryEntries(),[]);
});
test("context retains bounded old evidence pool without trusting assistant messages",()=>{
 const entries=Array.from({length:120},(_,i)=>({id:String(i),type:"message",message:{role:i%3===0?"assistant":"toolResult",content:"WiFi "+"x".repeat(5990)}}));
 entries.push({id:"u",type:"message",message:{role:"user",content:"记住 WiFi"}});
 const ctx=contextFromSession({sessionManager:{getSessionId:()=>"s",getBranch:()=>entries}});assert.ok(ctx.sourcePool!.reduce((n,s)=>n+s.text.length,0)<=96000);assert.ok(ctx.sourcePool!.every(s=>s.role!=="assistant"));assert.equal(ctx.explicit,true);
});

test("direct extraction compares skills in its one existing request and flags later corrections",async t=>{
 const{dir,store}=await fixture(t);await fs.mkdir(path.join(dir,"skills/wake"),{recursive:true});await fs.writeFile(path.join(dir,"skills/wake/SKILL.md"),"Windows S0 WiFi Bluetooth wake only; S4 cannot wake");
 const {runDirectMemoryCompletion}=await import("../../src/handlers/review-memory-ops.js");
 const u=source("u","Check Windows S0 WiFi connected","user");
 const branch:any[]=[{type:"message",id:u.messageId,timestamp:u.timestamp,message:{role:u.role,content:u.text}}];
 let requests=0;const ctx:any={model:{id:"fixture",provider:"fixture",reasoning:false,api:"openai-completions"},sessionManager:{getSessionId:()=>"synthetic",getBranch:()=>branch},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true,apiKey:"synthetic"})}};
 const result=await runDirectMemoryCompletion(ctx,store,null,{userPrompt:"Review Windows S0 WiFi connected",systemPrompt:"synthetic",config:{}},null,null,{completeSimple:async(_model:any,request:any)=>{
   requests++;const text=request.messages[0].content[0].text;assert.match(text,/compare.*claim semantically/i);assert.match(text,/S4 cannot wake/);assert.match(text,/source_leads/);
   branch.push({type:"message",id:"late",timestamp:new Date(Date.now()+2000).toISOString(),message:{role:"toolResult",content:"Windows S0 WiFi disconnected"}});
   return {stopReason:"stop",content:[{type:"text",text:JSON.stringify({operations:[{action:"add",target:"memory",content:"Windows S0 WiFi connected"}]})}]} as any;
 }});
 assert.equal(requests,1);assert.equal(result.pendingCount,1,JSON.stringify(result));assert.deepEqual(store.getMemoryEntries(),[]);
 const c=(await store.reviewAdmission("memory","list")).candidates[0];assert.ok(!c.sources.some((s:any)=>s.messageId==="late"));assert.ok(c.quality.later_related_messages.some((s:any)=>s.messageId==="late"));assert.equal(c.status,"pending");
});

test("global failure review includes current project skills and clears them on scope switch",async t=>{
 const {dir,store}=await fixture(t);const current=path.join(dir,"workspace-skills");await fs.mkdir(path.join(current,"wake"),{recursive:true});await fs.writeFile(path.join(current,"wake/SKILL.md"),"Windows S0 WiFi Bluetooth wake only; S4 cannot wake");
 store.setReviewSkillRoots([current]);const u=source("u","Windows S0 WiFi Bluetooth wake","user");
 const r=await withWriteContext({origin:"automatic",sources:[u]},()=>store.addFailure("Windows S0 WiFi Bluetooth wake",{category:"insight",project:"workspace"}));
 const e=await store.reviewAdmission("failure","evidence",r.candidate_id);assert.ok(e.quality.skills.matches.some((s:any)=>s.file===path.join(current,"wake/SKILL.md")));
 store.setReviewSkillRoots([]);const cleared=await store.reviewAdmission("failure","evidence",r.candidate_id);assert.ok(!cleared.quality.skills.roots.includes(current));
});

test("global semantic context never includes other-project failure facts",async t=>{
 const {store}=await fixture(t);store.setWriteAdmission(false);
 await store.addFailure("Windows S0 WiFi Bluetooth wake for allowed project",{category:"insight",project:"allowed"});
 await store.addFailure("Windows S0 WiFi Bluetooth wake OTHER_PRIVATE_PROJECT",{category:"insight",project:"other"});store.setWriteAdmission(true);
 const r=await store.proposalReviewContext("Windows S0 WiFi Bluetooth wake","allowed");assert.ok(r.active.some((e:any)=>e.project==="allowed"));assert.ok(!JSON.stringify(r).includes("OTHER_PRIVATE_PROJECT"));
});

test("extra semantic-review prompt has a shared budget and preserves valid structured JSON",()=>{
 const context={active:Array.from({length:40},(_,i)=>({text:"x".repeat(8000),score:i})),skills:{matches:Array.from({length:30},(_,i)=>({file:"/synthetic/"+i,digest:"d".repeat(64),score:i,excerpt:"s".repeat(10000)})),roots:["/synthetic"]}};
 const r=compactQualityContext(context,context,Array.from({length:96},(_,i)=>source(String(i),"z".repeat(6000))));assert.ok(JSON.stringify(r).length<=24000);assert.ok(r.skills.length<=6);assert.ok(r.active.length<=8);assert.ok(r.source_leads.length<=6);assert.equal(new Set(r.skills.map(s=>s.file)).size,r.skills.length);
});

test("English clauses also expose an unsupported success claim",()=>{
 const r=selectProposalSources([{action:"add",content:"Swiftgram downloaded. Notifications fixed."}],[source("u","Swiftgram downloaded","user")]);assert.equal(r.selection.by_operation[0].claims.length,2);assert.equal(r.selection.by_operation[0].claims[1].source_ids.length,0);assert.equal(r.selection.by_operation[0].needs_evidence,true);
});
