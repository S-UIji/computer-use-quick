import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,inject} from "vitest";
import {BrowserSession,type PageHandle} from "../../src/session/browser.js";
import {showOverlay,removeOverlay,withOverlayHidden,type OverlayState,renderBadgeText} from "../../src/watch/overlay.js";
import {RunWatch} from "../../src/watch/runWatch.js";
let session:BrowserSession,handle:PageHandle;
beforeAll(async()=>{session=await BrowserSession.connect(inject("browserURL"))});
afterAll(async()=>{await session.close()});
beforeEach(async()=>{handle=await session.newPage();await handle.page.goto(inject("fixtureURL")+"/watch.html")});
afterEach(async()=>{await removeOverlay(handle);await handle.page.close().catch(()=>{})});
const state=async()=>handle.page.evaluate(()=>{const o=(window as any).__cuqOverlay;return o?{kind:o.wrap.dataset.state,text:o.badge.textContent,display:o.wrap.style.display}:null});
const restored=async(kind:string)=>{await handle.page.waitForFunction(k=>(window as any).__cuqOverlay?.wrap.dataset.state===k,{timeout:2000},kind)};
describe("导航标注恢复",()=>{
  it("执行中的新文档在下一步开始前恢复原执行状态",async()=>{
    const watch=new RunWatch({handle,label:"导航测试",watch:true});
    await watch.onRunStart(3);await watch.onStepStart(0,{action:"navigate",url:"/watch.html"});
    await handle.page.goto(inject("fixtureURL")+"/watch.html?active");
    await restored("active");
    expect((await state())?.text).toContain("第 1/3 步 导航到");
    await watch.onRunEnd({ok:true,interrupted:false});
  });
  it.each<OverlayState>([{kind:"idle"},{kind:"interrupted",stopStep:3}])("结束状态 $kind 在用户跳转后恢复",async(s)=>{
    await showOverlay(handle,s);await handle.page.goto(inject("fixtureURL")+"/watch.html?"+s.kind);
    await restored(s.kind);expect((await state())?.text).toBe(renderBadgeText(s));
  });
  it("重复更新去重，移除后导航不重建",async()=>{
    const before=handle.page.listenerCount("domcontentloaded");
    for(let i=0;i<5;i++)await showOverlay(handle,{kind:"idle"});
    expect(handle.page.listenerCount("domcontentloaded")).toBe(before+1);
    await removeOverlay(handle);
    expect(handle.page.listenerCount("domcontentloaded")).toBe(before);
    await handle.page.goto(inject("fixtureURL")+"/watch.html?removed");
    expect(await state()).toBeNull();
  });
  it("关闭页面注销恢复监听",async()=>{
    const before=handle.page.listenerCount("domcontentloaded");
    await showOverlay(handle,{kind:"idle"});await handle.page.close();
    expect(handle.page.listenerCount("domcontentloaded")).toBe(before);
  });
  it("截图期间导航和嵌套隐藏不重挂，结束恢复最新状态",async()=>{
    await showOverlay(handle,{kind:"idle"});
    const latest:OverlayState={kind:"active",label:"新状态",step:2,total:3,action:"click"};
    await withOverlayHidden(handle,async()=>{
      await handle.page.goto(inject("fixtureURL")+"/watch.html?capture");
      expect(await state()).toBeNull();
      await withOverlayHidden(handle,async()=>{
        await showOverlay(handle,latest);
        expect(await state()).toBeNull();
      });
      expect(await state()).toBeNull();
    });
    await restored("active");expect((await state())?.text).toBe(renderBadgeText(latest));
  });
  it("移除标注后不能被排队的恢复重新创建",async()=>{
    await showOverlay(handle,{kind:"idle"});
    const update=showOverlay(handle,{kind:"active",label:"待移除",step:1,total:1,action:"click"});
    const removal=removeOverlay(handle);await Promise.all([update,removal]);
    expect(await state()).toBeNull();
    await handle.page.goto(inject("fixtureURL")+"/watch.html?removed-queue");expect(await state()).toBeNull();
  });
  it("子框架加载不修改主页面标注或增加主页面恢复监听",async()=>{
    await showOverlay(handle,{kind:"idle"});const before=handle.page.listenerCount("domcontentloaded");
    await handle.page.evaluate(url=>new Promise<void>(resolve=>{const f=document.createElement("iframe");f.onload=()=>resolve();f.src=url;document.body.appendChild(f)}),inject("fixtureURL")+"/form.html");
    expect((await state())?.kind).toBe("idle");expect(handle.page.listenerCount("domcontentloaded")).toBe(before);
  });
});
