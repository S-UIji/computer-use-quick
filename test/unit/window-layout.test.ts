import { describe,it,expect } from "vitest";
import { tileWindow } from "../../src/session/windowLayout.js";
const screen={left:0,top:0,width:1920,height:1080};
const overlap=(a:any,b:any)=>a.left<b.left+b.width&&b.left<a.left+a.width&&a.top<b.top+b.height&&b.top<a.top+a.height;
describe("隔离窗口槽位",()=>{
it.each([1,2,3,8])("%s个窗口不重叠且处于可用区域",of=>{
const bounds=Array.from({length:of},(_,index)=>tileWindow(screen,{index,of})!);
for(const a of bounds){expect(a).toBeDefined();expect(a.left).toBeGreaterThanOrEqual(0);expect(a.top).toBeGreaterThanOrEqual(0);expect(a.left+a.width).toBeLessThanOrEqual(screen.width);expect(a.top+a.height).toBeLessThanOrEqual(screen.height)}
for(let i=0;i<of;i++)for(let j=i+1;j<of;j++)expect(overlap(bounds[i],bounds[j])).toBe(false);
});
it("自愈槽位在右半屏，保持多屏负坐标",()=>{
const b=tileWindow({...screen,left:-1920,top:25},{index:1,of:2})!;expect(b.left).toBeGreaterThanOrEqual(-960);expect(b.top).toBe(25);
});
it.each([{index:-1,of:3},{index:3,of:3},{index:0,of:0},{index:0,of:9},{index:0.5,of:3}])("无效槽位安全跳过",slot=>expect(tileWindow(screen,slot)).toBeUndefined());
it("小屏和无效屏幕安全跳过",()=>{
expect(tileWindow({left:0,top:0,width:900,height:600},{index:0,of:3})).toBeUndefined();
expect(tileWindow({...screen,width:NaN},{index:0,of:1})).toBeUndefined();
});
});
