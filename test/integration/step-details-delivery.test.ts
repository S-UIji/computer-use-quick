import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { BrowserSession, type PageHandle } from "../../src/session/browser.js";
import { NetworkTracker } from "../../src/waiter/stability.js";
import { DiagnosticsCollector } from "../../src/diagnostics/collector.js";
import { runBatch } from "../../src/executor/batch.js";
import { replayTrace } from "../../src/trace/replay.js";
import { runSuite } from "../../src/trace/suite.js";
import { RunWatch } from "../../src/watch/runWatch.js";
import type { StepObserver } from "../../src/executor/observer.js";
import type { Trace } from "../../src/types.js";
let session:BrowserSession, work:string;
beforeAll(async()=>{session=await BrowserSession.connect(inject("browserURL"));work=await mkdtemp(join(tmpdir(),"cuq-details-delivery-"));});
afterAll(async()=>{await session?.close();await rm(work,{recursive:true,force:true});});
const owned:PageHandle[]=[]; afterEach(async()=>{for(const h of owned.splice(0))await h.page.close();});
const secret="private-"+"x".repeat(100);
const trace=(name:string):Trace=>({name,baseUrl:inject("fixtureURL"),createdAt:new Date().toISOString(),steps:[
  {action:"navigate",url:"/form.html?route="+"segment/".repeat(50)+"FINAL_ROUTE_END&token=${TOKEN}"},
  {action:"assert",type:"visible",target:{descriptor:{strategies:[{kind:"css",value:"#user"}],framePath:[]}}}
]});
function observe(handle:PageHandle, received:any[]):StepObserver {
  const w=new RunWatch({handle,label:"完整详情",watch:true});
  return {onRunStart:t=>w.onRunStart(t),onStepStart:async(i,s,d,full)=>{
    await w.onStepStart(i,s,d,full);
    if(s.action==="navigate"||s.action==="fill")received.push({index:i,short:d,full,rendered:await handle.page.evaluate(()=>(window as any).__cuqOverlay.details.textContent)});
  },onStepEnd:r=>w.onStepEnd(r),onRunEnd:o=>w.onRunEnd(o),takeInterruption:()=>w.takeInterruption(),takeScrollCount:()=>w.takeScrollCount(),inputGate:w.inputGate};
}
function check(received:any[],count:number){
  expect(received).toHaveLength(count);
  for(const r of received){expect(r.index).toBe(0);expect(r.short).not.toContain("FINAL_ROUTE_END");
    expect(r.full).toContain("FINAL_ROUTE_END");expect(r.rendered).toContain("FINAL_ROUTE_END");
    expect(r.rendered).not.toContain(secret);}
}
describe("回放适配器完整详情",()=>{
  it.each([0,10])("replay slowMo=%i 保留真实序号、完整详情和脱敏",async slowMoMs=>{
    const handle=await session.newPage();owned.push(handle);const received:any[]=[];
    const record=await replayTrace({handle,tracker:await NetworkTracker.attach(handle),collector:await DiagnosticsCollector.attach(handle),
      trace:trace("delivery"),vars:{TOKEN:secret},slowMoMs,observer:observe(handle,received)});
    expect(record.ok).toBe(true);check(received,1);
  });
  it("完整详情隐藏本次显式引用变量，保留长目标末尾", async()=>{
    const handle=await session.newPage();owned.push(handle);
    await handle.page.goto(inject("fixtureURL")+"/form.html");
    const label="长客户名称".repeat(30)+secret+"FINAL_TARGET_END";
    await handle.page.$eval("#user",(node,value)=>node.setAttribute("aria-label",value),label);
    const received:any[]=[];
    const result=await runBatch({handle,tracker:await NetworkTracker.attach(handle),collector:await DiagnosticsCollector.attach(handle),
      refs:new Map(),vars:{TOKEN:secret},captureDescriptors:false,
      steps:[{action:"fill",target:{descriptor:{strategies:[{kind:"role-name",role:"textbox",name:label}],framePath:[]}},value:"$"+"{TOKEN}"}],
      observer:observe(handle,received)});
    expect(result.ok).toBe(true);
    expect(received[0].rendered).toContain("FINAL_TARGET_END");
    expect(received[0].rendered).not.toContain(secret);
    expect(received[0].rendered).toContain("$"+"{TOKEN}");
  });
  it("组合字段与extract改写后仍隐藏旧变量裸值", async()=>{
    const handle=await session.newPage();owned.push(handle);await handle.page.goto(inject("fixtureURL")+"/form.html");
    const label="长客户名称".repeat(30)+secret+"FINAL_TARGET_END";
    await handle.page.$eval("#user",(node,value)=>{node.setAttribute("aria-label",value);(node as HTMLInputElement).value="replacement";},label);
    const css=(value:string)=>({descriptor:{strategies:[{kind:"css" as const,value}],framePath:[]}});
    const received:any[]=[];
    const result=await runBatch({handle,tracker:await NetworkTracker.attach(handle),collector:await DiagnosticsCollector.attach(handle),
      refs:new Map(),vars:{TOKEN:secret},captureDescriptors:false,observer:observe(handle,received),steps:[
        {action:"fill",target:css("#pwd"),value:"prefix-$"+"{TOKEN}-suffix"},
        {action:"extract",target:css("#user"),as:"TOKEN",from:"value"},
        {action:"fill",target:{descriptor:{strategies:[{kind:"role-name",role:"textbox",name:label}],framePath:[]}},value:"$"+"{TOKEN}"}
      ]});
    expect(result.ok).toBe(true);const last=received.at(-1);
    expect(last.rendered).toContain("FINAL_TARGET_END");expect(last.rendered).not.toContain(secret);
    expect(last.rendered).toContain("$"+"{TOKEN}");
  });
  it("suite进度观察包装器不丢失完整详情",async()=>{
    const paths:string[]=[];for(const name of ["one","two"]){const p=join(work,name+".json");await writeFile(p,JSON.stringify(trace(name)));paths.push(p);}
    const received:any[]=[];
    const result=await runSuite({session,paths,vars:{TOKEN:secret},concurrency:2,runsDir:join(work,"runs"),onTraceEvent:()=>{},
      observerFor:handle=>observe(handle,received)});
    expect(result.failed).toBe(0);check(received,2);
  });
});
