import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MemoryStore } from "../../src/store/memory-store.js";
import { loadConfig } from "../../src/config.js";
import { withWriteContext, fingerprint, type Candidate, type AdmissionEntry } from "../../src/store/write-admission.js";
import { candidateGroups, candidateAssessment, sourceEvidence, entryImpact, skillReferences } from "../../src/store/review-insights.js";
const source={sessionId:"fixture",messageId:"u1",role:"user",text:"Remember the test conditions"};
function candidate(id:string,text:string,project:string|null=null):Candidate { return {id,key:id,status:"pending",operations:[{action:"add",content:text,project:project??undefined}],fingerprint:fingerprint([]),sources:[source],createdAt:"2026-10-24",similar:[],reason:"synthetic"}; }
const entry=(id:string,text:string,project:string|null=null):AdmissionEntry=>({id,text,raw:text,revision:1,project,status:"active",source:[],sourceStatus:"unlinked",observedAt:"2026-10-24"});
test("repeated source records do not inflate message counts or become support",()=>{
 const evidence=sourceEvidence([source,source,{...source,text:"changed quote"},{...source,role:"assistant"},{...source,role:"toolResult",messageId:"t1"}]);
 assert.equal(evidence.unique_messages,2);assert.equal(evidence.user_messages,1);assert.equal(evidence.tool_observations,1);assert.equal(evidence.repeated_messages,2);
 assert.equal(evidence.inconsistent_message_ids.length,1);assert.equal(evidence.excluded_roles_or_missing_ids,1);assert.equal(evidence.entailment,"not_verified");
});
test("groups retain every candidate id, preserve scopes and never mutate candidates",()=>{
 const items=[candidate("a","Windows S0 Bluetooth wake allowed","a"),candidate("b","Windows S0 Bluetooth wake allowed","a"),candidate("c","Windows S0 Bluetooth wake allowed","b")];
 const before=JSON.stringify(items);const r=candidateGroups(items,[],[],10,0);
 assert.equal(r.total,2);assert.equal(r.groups[0].count,2);assert.equal(r.groups[0].evidence.unique_messages,1);assert.equal(JSON.stringify(items),before);
});
test("S0 and S4/negative related claims remain separate operations requiring a decision",()=>{
 const items=[candidate("a","Windows 蓝牙允许 S0 唤醒笔记本"),candidate("b","Windows 蓝牙不能 S4 唤醒笔记本")];
 const r=candidateGroups(items,[],[],10,0);assert.equal(r.total_candidates,2);assert.equal(r.groups.flatMap(g=>g.candidate_ids).length,2);assert.equal(r.advisory_only,true);
 assert.equal(items.every(c=>c.status==="pending"),true);
});
test("complete-link groups cannot absorb a transitive-only match",()=>{
 const r=candidateGroups([candidate("a","alpha beta gamma"),candidate("b","alpha beta delta"),candidate("c","beta delta epsilon")],[],[],10,0);
 assert.equal(r.total,2);assert.equal(r.groups[0].count,2);
});
test("assessment recomputes exact active matches, scope and stale fingerprint",()=>{
 const c=candidate("a","exact fact","a");const e=entry("e","exact fact","a");
 assert.equal(candidateAssessment(c,[e],[e.raw]).exact_duplicate,true);assert.equal(candidateAssessment(c,[e],[e.raw]).stale,true);
 assert.equal(candidateAssessment(c,[entry("e","exact fact","b")],[]).exact_duplicate,false);
});
test("multi-operation plans are not grouped as single additions",()=>{
 const c=candidate("a","same");c.operations.push({action:"remove",oldText:"old"});
 assert.equal(candidateGroups([c,candidate("b","same")],[],[],10,0).total,2);
});
test("groups paginate and bound previews without dropping ids",()=>{
 const items=Array.from({length:20},(_,i)=>candidate(String(i),"same content"));
 const r=candidateGroups(items,[],[],1,0);assert.equal(r.groups[0].candidates.length,12);assert.equal(r.groups[0].candidate_ids.length,20);assert.equal(r.groups[0].truncated,true);
 assert.equal(candidateGroups(items,[],[],1,1).groups.length,0);
});
test("impact identifies explicit IDs and scoped pending operations without inferring dependence",()=>{
 const e=entry("basis-id","a full source fact","a");const c=candidate("c","new","a");c.operations=[{action:"remove",oldText:e.text,project:"a"}];
 const r=entryImpact(e,[e,entry("derived","Based on basis-id"),entry("lexical","a full source fact")],[c],10,0);
 assert.equal(r.explicit_id_references.length,1);assert.equal(r.pending_operation_total,1);assert.match(r.warning,/not a complete dependency graph/);
 c.operations[0].project="b";assert.equal(entryImpact(e,[e],[c],10,0).pending_operation_total,0);
});
test("skill scan bounds files and ignores symlink documents/directories",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"review-skills-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const name of ["real","large","link"])await fs.mkdir(path.join(dir,name));
 await fs.writeFile(path.join(dir,"real","SKILL.md"),"basis-id is a reference");
 await fs.writeFile(path.join(dir,"large","SKILL.md"),"x".repeat(65537));
 await fs.symlink(path.join(dir,"real","SKILL.md"),path.join(dir,"link","SKILL.md"));
 await fs.symlink(path.join(dir,"real"),path.join(dir,"linked-dir"));
 const r=await skillReferences([dir],"basis-id");assert.equal(r.total,1);assert.equal(r.scanned,1);assert.equal(r.truncated,true);assert.equal(r.incomplete,true);
});
test("new store projections leave Markdown, ledger and candidate status unchanged",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"review-projection-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new MemoryStore({...loadConfig(path.join(dir,"missing")),memoryDir:dir,memoryMode:"policy-only"});await store.loadFromDisk();store.setWriteAdmission();
 await withWriteContext({origin:"foreground",explicit:true,sources:[source]},()=>store.add("user","verified preference"));
 const c=await store.add("user","tentative preference");const e=(await store.reviewAdmission("user","active")).entries[0];
 const file=path.join(dir,"USER.md"),ledger=file+".admission.json";const before=[await fs.readFile(file,"utf8"),await fs.readFile(ledger,"utf8")];
 for(const action of ["groups","evidence","impact"] as const){const r=await store.reviewAdmission("user",action,action==="evidence"?c.candidate_id:e.id);assert.equal(r.success,true);}
 assert.deepEqual([await fs.readFile(file,"utf8"),await fs.readFile(ledger,"utf8")],before);assert.equal((await store.reviewAdmission("user","show",c.candidate_id)).candidate.status,"pending");
});
test("unlinked legacy evidence stays unlinked and unknown ids fail closed",async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"review-legacy-"));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const store=new MemoryStore({...loadConfig(path.join(dir,"missing")),memoryDir:dir,memoryMode:"policy-only"});await store.loadFromDisk();await store.add("memory","legacy");store.setWriteAdmission();
 const e=(await store.reviewAdmission("memory","active")).entries[0];const r=await store.reviewAdmission("memory","evidence",e.id);
 assert.equal(r.source_status,"unlinked");assert.equal(r.evidence.unique_messages,0);assert.equal((await store.reviewAdmission("memory","impact","unknown")).success,false);
});

test("group results retain source IDs without repeating long source excerpts",()=>{
 const c=candidate("a","short fact");c.sources=[{...source,text:"x".repeat(2500)}];
 const r=candidateGroups([c],[],[],10,0);assert.ok(JSON.stringify(r).length<3000);assert.equal(r.groups[0].evidence.source_ids[0].messageId,"u1");
});

test("runtime status reports the released package version",async()=>{
 const fs=await import("node:fs/promises");
 const pkg=JSON.parse(await fs.readFile(new URL("../../package.json",import.meta.url),"utf8"));
 const source=await fs.readFile(new URL("../../src/index.ts",import.meta.url),"utf8");
 assert.ok(source.includes(`version: "${pkg.version}"`));
});
