import{beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,inject}from"vitest";
import{Client}from"@modelcontextprotocol/sdk/client/index.js";import{StdioClientTransport}from"@modelcontextprotocol/sdk/client/stdio.js";
import{mkdtemp,writeFile,readFile,rm}from"node:fs/promises";import{tmpdir}from"node:os";import{join,resolve}from"node:path";
import puppeteer,{type Browser,type Page,type Target}from"puppeteer-core";import type{Trace,Step}from"../../src/types.js";
let browser:Browser,client:Client,page:Page,work:string,id:string;
const css=(value:string)=>({descriptor:{strategies:[{kind:"css" as const,value}],framePath:[]}});
const text=(r:any)=>r.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n");
async function trace(name:string,steps:Step[]){const path=join(work,name+".json");const t:Trace={name,baseUrl:inject("fixtureURL"),createdAt:"",steps};await writeFile(path,JSON.stringify(t));return path}
async function call(name:string,args:Record<string,unknown>){return client.callTool({name,arguments:{pageId:id,...args}})}
const nav:Step={action:"navigate",url:"/form.html"};
beforeAll(async()=>{browser=await puppeteer.connect({browserURL:inject("browserURL"),defaultViewport:null})});
afterAll(()=>{browser?.disconnect()});
beforeEach(async()=>{work=await mkdtemp(join(tmpdir(),"cuq-r9-mcp-"));page=await browser.newPage();id=(page.target() as Target&{_targetId:string})._targetId;await page.goto(inject("fixtureURL")+"/form.html?sentinel");
client=new Client({name:"r9-mcp",version:"1"});const env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>e[1]!==undefined));delete env.R9_MISSING_A;delete env.R9_MISSING_B;delete env.R9_HEAL_MISSING;
await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve("dist/index.js")],cwd:work,env:{...env,CUQ_BROWSER_URL:inject("browserURL"),CUQ_WATCH:"off",CUQ_LAUNCH:"",PWD:"r9-system-path",R9_APP_SECRET:"r9-private-application-value",R9_SHORT_TOKEN:"abc"},stderr:"pipe"}));await call("snapshot",{});
});
afterEach(async()=>{await client?.close();await page?.close().catch(()=>{});await rm(work,{recursive:true,force:true})});
describe("MCP变量预检与来源",()=>{
it("系统PWD不能隐式用作值，显式PWD仍可正常回放",async()=>{
const path=await trace("pwd",[nav,{action:"fill",target:css("#user"),value:"${PWD}"}]);const before=page.url();const rejected=await call("replay",{tracePath:path});
expect(rejected.isError).toBe(true);expect(text(rejected)).toContain("PWD");expect(page.url()).toBe(before);
const accepted=await call("replay",{tracePath:path,vars:{PWD:"explicit-r9-value"}});expect(text(accepted)).toContain("回放成功");expect(await page.$eval("#user",n=>(n as HTMLInputElement).value)).toBe("explicit-r9-value");
});
it("普通应用环境值可用，来源只列名称且显式覆盖不误标环境",async()=>{
const path=await trace("env",[nav,{action:"fill",target:css("#user"),value:"${R9_APP_SECRET}"}]);
const result=await call("replay",{tracePath:path});expect(text(result)).toContain("R9_APP_SECRET");expect(text(result)).toContain("环境变量");expect(text(result)).not.toContain("r9-private-application-value");expect(await page.$eval("#user",n=>(n as HTMLInputElement).value)).toBe("r9-private-application-value");
const explicit=await call("replay",{tracePath:path,vars:{R9_APP_SECRET:"override"}});expect(text(explicit)).not.toContain("R9_APP_SECRET");expect(await page.$eval("#user",n=>(n as HTMLInputElement).value)).toBe("override");
});
it("列出全部缺失变量且不产生前序导航或输入",async()=>{
const path=await trace("missing",[nav,{action:"fill",target:css("#user"),value:"${R9_MISSING_A}"},{action:"press",key:"${R9_MISSING_B}"}]);const before=page.url();const r=await call("replay",{tracePath:path});
expect(r.isError).toBe(true);expect(text(r)).toContain("R9_MISSING_A");expect(text(r)).toContain("R9_MISSING_B");expect(page.url()).toBe(before);expect(await page.$eval("#user",n=>(n as HTMLInputElement).value)).toBe("");
});
it("suite任一用例缺变量时整批不创建页面，机读结果仍可判失败",async()=>{
const good=await trace("good",[nav,{action:"fill",target:css("#user"),value:"side-effect"}]);const bad=await trace("bad",[nav,{action:"fill",target:css("#user"),value:"${R9_MISSING_A}"}]);
const created:Target[]=[];const listener=(t:Target)=>{if(t.type()==="page")created.push(t)};browser.on("targetcreated",listener);
try{const r=await call("replay_suite",{tracePaths:[good,bad],concurrency:2});expect(text(r)).toContain("R9_MISSING_A");expect(text(r)).toContain("未执行");expect(text(r)).toContain("SUITE_RESULT ok=0 failed=2 total=2");expect(created).toHaveLength(0)}finally{browser.off("targetcreated",listener)}
});
it("自愈候选缺变量在资源创建前拒绝，不写回也不消耗预算",async()=>{
const path=await trace("heal",[nav,{action:"click",target:css("#r9-missing-target")},{action:"assert",type:"visible",target:css("#user")}]);await call("replay",{tracePath:path,resolveRetryMs:0});const before=await readFile(path,"utf8");const created:Target[]=[];const listener=(t:Target)=>{if(t.type()==="page")created.push(t)};browser.on("targetcreated",listener);
try{for(let i=0;i<3;i++){const r=await call("heal_step",{tracePath:path,repairs:[{stepIndex:1,steps:[{action:"fill",target:css("#user"),value:"${R9_HEAL_MISSING}"}]}]});expect(r.isError).toBe(true);expect(text(r)).toContain("R9_HEAL_MISSING");expect(await readFile(path,"utf8")).toBe(before)}expect(created).toHaveLength(0)}finally{browser.off("targetcreated",listener)}
const fixed=await call("heal_step",{tracePath:path,repairs:[{stepIndex:1,steps:[{action:"fill",target:css("#user"),value:"valid"}]}]});expect(fixed.isError,text(fixed)).not.toBe(true);expect(text(fixed)).toContain("自愈成功");
},45000);
it("合法前置extract输出可用于后续插值",async()=>{
const path=await trace("dynamic",[nav,{action:"extract",target:css("h1"),as:"R9_TITLE"},{action:"fill",target:css("#user"),value:"${R9_TITLE}"}]);const r=await call("replay",{tracePath:path});expect(text(r)).toContain("回放成功");expect(await page.$eval("#user",n=>(n as HTMLInputElement).value)).toBe("用户登录");
});
it("失败诊断也不回显引用的环境值，保留变量名称可定位",async()=>{
const path=await trace("env-failed",[nav,{action:"assert",type:"url-contains",expected:"${R9_APP_SECRET}"}]);
const r=await call("replay",{tracePath:path});
expect(text(r)).toContain("R9_APP_SECRET");expect(text(r)).toContain("assert-failed");
expect(text(r)).not.toContain("r9-private-application-value");
const suite=await call("replay_suite",{tracePaths:[path],concurrency:1});
expect(text(suite)).not.toContain("r9-private-application-value");expect(text(suite)).toContain("SUITE_RESULT ok=0 failed=1 total=1");
});

it("短环境值拼接在失败文本中也隐藏，不误改已有占位符",async()=>{
const path=await trace("short-env",[nav,{action:"assert",type:"url-contains",expected:"prefix${R9_SHORT_TOKEN}suffix"}]);
const r=await call("replay",{tracePath:path});
expect(text(r)).toContain("R9_SHORT_TOKEN");expect(text(r)).not.toContain("prefixabcsuffix");expect(text(r)).toContain("prefix${R9_SHORT_TOKEN}suffix");
});

});
