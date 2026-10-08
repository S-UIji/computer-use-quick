import{beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,inject}from"vitest";import{Client}from"@modelcontextprotocol/sdk/client/index.js";import{StdioClientTransport}from"@modelcontextprotocol/sdk/client/stdio.js";import{mkdtemp,rm,writeFile}from"node:fs/promises";import{tmpdir}from"node:os";import{join,resolve}from"node:path";import puppeteer,{type Browser,type Page,type Target}from"puppeteer-core";
let browser:Browser,client:Client,work:string,page:Page;const owned=new Set<Page>();const id=(p:Page)=>(p.target() as Target&{_targetId:string})._targetId;const text=(r:any)=>r.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n");
beforeAll(async()=>{browser=await puppeteer.connect({browserURL:inject("browserURL"),defaultViewport:null})});afterAll(()=>browser?.disconnect());
beforeEach(async()=>{work=await mkdtemp(join(tmpdir(),"cuq-r11-mcp-"));page=await browser.newPage();owned.add(page);await page.goto(inject("fixtureURL")+"/form.html");client=new Client({name:"r11",version:"1"});const env=Object.fromEntries(Object.entries(process.env).filter((e):e is[string,string]=>e[1]!==undefined));await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve("dist/index.js")],cwd:work,env:{...env,CUQ_BROWSER_URL:inject("browserURL"),CUQ_WATCH:"on",CUQ_LAUNCH:"",R11_TOKEN:"r11-secret-"+"x".repeat(110)},stderr:"pipe"}))});
afterEach(async()=>{await client?.close();for(const p of owned){await p.close().catch(()=>{})}owned.clear();await rm(work,{recursive:true,force:true})});
async function ref(p:Page,label:string){const snap=await client.callTool({name:"snapshot",arguments:{pageId:id(p)}});const line=text(snap).split("\n").find((s:string)=>s.includes('textbox "'+label));return line!.match(/\[(e\d+)\]/)![1]}
describe("MCP可读动作说明",()=>{
it("环境值出现在标签时，角标、进度、台账在截断前脱敏",async()=>{
const secret="r11-secret-"+"x".repeat(110);await page.$eval("#user",(n,value)=>n.setAttribute("aria-label","账户 "+value),secret);const target=await ref(page,"账户 r11-secret-");const progress:any[]=[];
const running=client.callTool({name:"batch",arguments:{pageId:id(page),steps:[{action:"fill",target:{ref:target},value:"$"+"{R11_TOKEN}"}]}},undefined,{onprogress:p=>progress.push(p)});
await page.waitForFunction(()=>(window as any).__cuqOverlay?.badge.textContent.includes("填写"),{timeout:5000});
const badge=await page.evaluate(()=>(window as any).__cuqOverlay.badge.textContent);await running;
expect(badge).toContain("$"+"{R11_TOKEN}");expect(badge).not.toContain("r11-secret-");expect(progress.map(p=>p.message).join("\n")).toContain("$"+"{R11_TOKEN}");expect(progress.map(p=>p.message).join("\n")).not.toContain("r11-secret-");
await client.callTool({name:"save_trace",arguments:{pageId:id(page),name:"r11-redacted",baseUrl:inject("fixtureURL"),dir:work}});
const replay=await client.callTool({name:"replay",arguments:{pageId:id(page),tracePath:join(work,"r11-redacted.json")}});
expect(text(replay)).not.toContain("r11-secret-");
});
it("自愈演示刷新ref后同步标签",async()=>{
const css=(value:string)=>({descriptor:{strategies:[{kind:"css",value}],framePath:[]}});
const path=join(work,"r11-heal-labels.json");await writeFile(path,JSON.stringify({name:"r11-heal-labels",baseUrl:inject("fixtureURL"),steps:[{action:"navigate",url:"/form.html"},{action:"click",target:css("#missing")},{action:"assert",type:"visible",target:css("#user")}]},null,2));
await client.callTool({name:"replay",arguments:{pageId:id(page),tracePath:path}});
await page.$eval("#user",n=>n.addEventListener("input",()=>n.setAttribute("aria-label","演示后姓名")));const target=await ref(page,"用户名");
const heal=await client.callTool({name:"heal_step",arguments:{pageId:id(page),tracePath:path,stepIndex:1,actions:[{action:"fill",target:{ref:target},value:"demo"}]}});
expect(heal.isError,text(heal)).not.toBe(true);const progress:any[]=[];
const next=await client.callTool({name:"batch",arguments:{pageId:id(page),steps:[{action:"fill",target:{ref:target},value:"after"}]}},undefined,{onprogress:p=>progress.push(p)});
expect(next.isError).not.toBe(true);expect(await page.$eval("#user",n=>(n as HTMLInputElement).value)).toBe("after");expect(progress.map(p=>p.message).join("\n")).toContain("演示后姓名");
});
it("角标、进度和台账说明同一目标，并隐藏填写值",async()=>{
const target=await ref(page,"用户名");const progress:any[]=[];
const running=client.callTool({name:"batch",arguments:{pageId:id(page),steps:[{action:"fill",target:{ref:target},value:"r11-private-value"},{action:"sleep",ms:650}]}},undefined,{onprogress:p=>progress.push(p)});
await page.waitForFunction(()=>(window as any).__cuqOverlay?.badge.textContent.includes("填写"),{timeout:5000});
const badge=await page.evaluate(()=>(window as any).__cuqOverlay.badge.textContent);expect(badge).toContain("用户名");expect(badge).not.toContain("r11-private-value");await running;
expect(progress.some(p=>p.message?.includes("填写")&&p.message?.includes("用户名"))).toBe(true);expect(progress.map(p=>p.message).join("\n")).not.toContain("r11-private-value");
await client.callTool({name:"save_trace",arguments:{pageId:id(page),name:"r11-readable",baseUrl:inject("fixtureURL"),dir:work}});
const replay=await client.callTool({name:"replay",arguments:{pageId:id(page),tracePath:join(work,"r11-readable.json")}});
expect(text(replay)).toContain("填写");expect(text(replay)).toContain("用户名");expect(text(replay)).not.toContain("r11-private-value");
});
it("不同页面相同ref按各自名称说明",async()=>{
await page.$eval("#user",n=>n.setAttribute("aria-label","页面一姓名"));const first=await ref(page,"页面一姓名");
const other=await browser.newPage();owned.add(other);await other.goto(inject("fixtureURL")+"/form.html");await other.$eval("#user",n=>n.setAttribute("aria-label","页面二姓名"));const second=await ref(other,"页面二姓名");expect(second).toBe(first);
const one:any[]=[];await client.callTool({name:"batch",arguments:{pageId:id(page),steps:[{action:"fill",target:{ref:first},value:"one"}]}},undefined,{onprogress:p=>one.push(p)});
const two:any[]=[];await client.callTool({name:"batch",arguments:{pageId:id(other),steps:[{action:"fill",target:{ref:second},value:"two"}]}},undefined,{onprogress:p=>two.push(p)});
expect(one.map(p=>p.message).join("\n")).toContain("页面一姓名");expect(one.map(p=>p.message).join("\n")).not.toContain("页面二姓名");expect(two.map(p=>p.message).join("\n")).toContain("页面二姓名");
});
});
