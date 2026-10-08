import{describe,it,expect}from"vitest";import{describeStep}from"../../src/report/describeStep.js";import{render}from"../../src/perception/render.js";import{renderRunRecord}from"../../src/report/runRecord.js";import type{Step,PrunedNode,RunRecord}from"../../src/types.js";import{createVariableRedactor}from"../../src/report/variablePrivacy.js";
const descriptor={descriptor:{strategies:[{kind:"test-id" as const,value:"login-id"},{kind:"role-name" as const,role:"button",name:"登录"}],framePath:[]}};
describe("统一动作说明",()=>{
it("优先可读语义名称而非技术ID",()=>expect(describeStep({action:"click",target:descriptor})).toBe("点击「登录」"));
it("ref从调用页面的标签解析，缺标签保留ref",()=>{
expect(describeStep({action:"fill",target:{ref:"e1"},value:"private"},new Map([["e1","用户名"]]))).toBe("填写「用户名」");
expect(describeStep({action:"click",target:{ref:"e99"}})).toBe("点击「e99」");
});
it.each<Step>([{action:"fill",target:descriptor,value:"r11-private",promptText:"r11-private"},{action:"select",target:descriptor,value:"r11-private"},{action:"assert",type:"text-equals",target:descriptor,expected:"r11-private"}])("输入值不进入$action说明",step=>expect(describeStep(step)).not.toContain("r11-private"));
it("等待与导航说明目的，URL凭证仍隐藏",()=>{
expect(describeStep({action:"wait",until:{type:"visible",target:descriptor}})).toBe("等待「登录」出现");
const description=describeStep({action:"navigate",url:"https://example.com/app?token=r11-private"});expect(description).toContain("/app");expect(description).not.toContain("r11-private");
});
it("标签不从value属性取得",()=>{
const tree:PrunedNode={role:"RootWebArea",name:"",props:{},children:[{role:"textbox",name:"密码",props:{value:"r11-private"},backendNodeId:11,children:[]}]};
const labels=render(tree).refLabels;expect(labels.get("e1")).toBe("密码");expect([...labels.values()].join("")).not.toContain("r11-private");
});
it("旧记录中文回退而不伪造目标",()=>{
const rec:RunRecord={traceName:"old",startedAt:"",durationMs:10,ok:true,steps:[{index:0,action:"click",ok:true,durationMs:10}],drifts:[],healRequired:false};
expect(renderRunRecord(rec)).toContain("1. 点击 — 10ms");
});
it("长环境值在标签截断前脱敏",()=>{
const secret="r11-secret-"+ "x".repeat(110);const redact=createVariableRedactor({R11_TOKEN:secret},["R11_TOKEN"]);
expect(describeStep({action:"fill",target:{ref:"e1"},value:"$"+"{R11_TOKEN}"},new Map([["e1","账户 "+secret]]),redact)).toBe("填写「账户 "+"$"+"{R11_TOKEN}」");
});
it("畸形辅助信息不使观察描述抛错",()=>{
expect(()=>describeStep({action:"fill",target:null,value:"x"} as any)).not.toThrow();
expect(()=>describeStep({action:"press",key:42} as any)).not.toThrow();
expect(describeStep({action:"click",target:{descriptor:{strategies:[{kind:"row-role-name",role:"button",name:"确定",rowText:{toString:null}},{kind:"css",value:"#submit"}],framePath:[]}}} as any)).toBe("点击「确定」");
});
});
