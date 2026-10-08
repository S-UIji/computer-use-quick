import{it,expect,describe,inject}from"vitest";import{BrowserSession}from"../../src/session/browser.js";import puppeteer from"puppeteer";
describe("无头窗口兼容",()=>{
it.each([false,true])("无headless启动参数的独立shell仍不布局，fallback=%s",async fallback=>{
const browser=await puppeteer.launch({headless:"shell",ignoreDefaultArgs:["--headless","--headless=new",...(fallback?["--enable-automation"]:[])],args:["--remote-debugging-port=0","--user-agent=Mozilla/5.0 Chrome/145.0.0.0"]});let session:BrowserSession|undefined;
try{const cdp=await browser.target().createCDPSession();expect(browser.process()!.spawnargs.some(arg=>arg==="--headless"||arg.startsWith("--headless="))).toBe(false);
if(fallback)await expect(cdp.send("Browser.getBrowserCommandLine")).rejects.toThrow();
await cdp.detach();
session=await BrowserSession.connect("http://127.0.0.1:"+new URL(browser.wsEndpoint()).port,{watch:true});const plain=await session.newIsolatedPage();const slotted=await session.newIsolatedPage({index:0,of:1});
try{const a=await plain.handle.cdp.send("Browser.getWindowForTarget",{targetId:plain.handle.pageId});const b=await slotted.handle.cdp.send("Browser.getWindowForTarget",{targetId:slotted.handle.pageId});expect(b.bounds.width).toBe(a.bounds.width);expect(b.bounds.height).toBe(a.bounds.height);}finally{await slotted.release();await plain.release()}
}finally{await session?.close();await browser.close()}
});

it("自定义普通UA的headless在watch开启时仍不布局",async()=>{
const browser=await puppeteer.launch({headless:true,args:["--remote-debugging-port=0","--user-agent=Mozilla/5.0 Chrome/145.0.0.0"]});let session:BrowserSession|undefined;
try{session=await BrowserSession.connect("http://127.0.0.1:"+new URL(browser.wsEndpoint()).port,{watch:true});const plain=await session.newIsolatedPage();const slotted=await session.newIsolatedPage({index:0,of:1});
try{const a=await plain.handle.cdp.send("Browser.getWindowForTarget",{targetId:plain.handle.pageId});const b=await slotted.handle.cdp.send("Browser.getWindowForTarget",{targetId:slotted.handle.pageId});expect(b.bounds.width).toBe(a.bounds.width);expect(b.bounds.height).toBe(a.bounds.height);}finally{await slotted.release();await plain.release()}
}finally{await session?.close();await browser.close()}
});
it.each([true,false])("watch=%s时指定槽位也不改变窗口与视口",async watch=>{
const session=await BrowserSession.connect(inject("browserURL"),{watch});const plain=await session.newIsolatedPage();const slotted=await session.newIsolatedPage({index:0,of:3});
try{const a=await plain.handle.cdp.send("Browser.getWindowForTarget",{targetId:plain.handle.pageId});const b=await slotted.handle.cdp.send("Browser.getWindowForTarget",{targetId:slotted.handle.pageId});
expect(b.bounds.width).toBe(a.bounds.width);expect(b.bounds.height).toBe(a.bounds.height);
const viewport=(h:any)=>h.page.evaluate(()=>({width:innerWidth,height:innerHeight}));expect(await viewport(slotted.handle)).toEqual(await viewport(plain.handle));
}finally{await slotted.release();await plain.release();await session.close()}
});
});
