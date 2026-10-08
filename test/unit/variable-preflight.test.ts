import{describe,it,expect}from"vitest";
import{resolveVariables,inspectVariables,variableSourceNotice}from"../../src/executor/variables.js";import type{Step}from"../../src/types.js";
const fill=(value:string):Step=>({action:"fill",target:{ref:"e1"},value});
describe("变量预检策略",()=>{
it("大小写系统环境字段均不隐式注入，普通应用字段仍保留",()=>{
const r=resolveVariables({}, {pwd:"sys",Home:"sys",pAth:"sys",APP_TOKEN:"application"});
expect(Object.keys(r.values)).toEqual(["APP_TOKEN"]);expect(r.values.APP_TOKEN).toBe("application");
});
it("显式系统值和空字符串覆盖环境，来源不误标为环境",()=>{
const r=resolveVariables({PWD:"explicit",APP_TOKEN:""},{PWD:"sys",APP_TOKEN:"fallback"});
expect(r.values.PWD).toBe("explicit");expect(r.values.APP_TOKEN).toBe("");
expect(inspectVariables([fill("${PWD}-${APP_TOKEN}")],r.values,r.environmentNames)).toEqual({missing:[],environmentUsed:[]});
});
it("全部已有插值字段在执行前汇总并去重",()=>{
const steps:Step[]=[{action:"navigate",url:"${BASE_URL}/path"},{action:"press",key:"${KEY}",promptText:"${PIN}"},{action:"assert",type:"url-contains",expected:"${LABEL}"},fill("${PWD}-${PIN}")];
expect(inspectVariables(steps,{}).missing).toEqual(["BASE_URL","KEY","LABEL","PIN","PWD"]);
});
it("前置extract定义后续变量，但后置extract不掩盖前序缺失",()=>{
const extract:Step={action:"extract",target:{ref:"e1"},as:"TOKEN"};
expect(inspectVariables([extract,fill("${TOKEN}")],{}).missing).toEqual([]);
expect(inspectVariables([fill("${TOKEN}"),extract],{}).missing).toEqual(["TOKEN"]);
});
it("extract覆盖环境后，后续使用不再标记环境来源",()=>{
const r=resolveVariables({}, {TOKEN:"environment"});
expect(inspectVariables([{action:"extract",target:{ref:"e1"},as:"TOKEN"},fill("${TOKEN}")],r.values,r.environmentNames).environmentUsed).toEqual([]);
});
it("定位描述符中的字面量不是新支持的插值字段",()=>{
const step:Step={action:"click",target:{descriptor:{strategies:[{kind:"css",value:"[data-key='${LITERAL}']"}],framePath:[]}}};
expect(inspectVariables([step],{}).missing).toEqual([]);
});
it("环境来源提示仅接受并输出引用名称",()=>{
const r=resolveVariables({}, {APP_TOKEN:"private-test-value",UNUSED:"other"});
const checked=inspectVariables([fill("${APP_TOKEN}")],r.values,r.environmentNames);
expect(checked.environmentUsed).toEqual(["APP_TOKEN"]);
expect(variableSourceNotice(checked.environmentUsed)).toContain("APP_TOKEN");
expect(variableSourceNotice(checked.environmentUsed)).not.toContain("private-test-value");
expect(variableSourceNotice(checked.environmentUsed)).not.toContain("UNUSED");
});
});
