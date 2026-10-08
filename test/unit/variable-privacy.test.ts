import{describe,it,expect}from"vitest";
import{createVariableRedactor,redactVariableRecord}from"../../src/report/variablePrivacy.js";
import{renderRunRecord}from"../../src/report/runRecord.js";import type{RunRecord}from"../../src/types.js";
const token="$"+"{TOKEN}";
describe("环境诊断文本脱敏",()=>{
it("正则特殊字符按字面值匹配，已插入占位符不再次改写",()=>{
const redact=createVariableRedactor({TOKEN:"a.$(x)"},["TOKEN"]);
expect(redact("期望「a.$(x)」，实际「safe」")).toBe("期望「"+token+"」，实际「safe」");
});
it("URL编码变体也隐藏",()=>{
const redact=createVariableRedactor({TOKEN:"private/path?x=1"},["TOKEN"]);
expect(redact("raw private/path?x=1 encoded private%2Fpath%3Fx%3D1")).toBe("raw "+token+" encoded "+token);
});
it("短值不会从大数字中截取，数值台账和原始步骤保持不变",()=>{
const redact=createVariableRedactor({TOKEN:"1"},["TOKEN"]);
const rec:RunRecord={traceName:"test",startedAt:"",durationMs:1110,ok:false,healRequired:false,drifts:[],steps:[{index:0,action:"assert",ok:false,durationMs:1110,error:"expected 1, candidates 10"}],failure:{failedIndex:0,failedStep:{action:"assert",type:"url-contains",expected:token},kind:"assert-failed",message:"expected 1, candidates 10",snapshot:"snap",consoleErrors:[],failedRequests:[]}};
const safe=redactVariableRecord(rec,redact);expect(safe.steps[0].error).toBe("expected "+token+", candidates 10");expect(safe.durationMs).toBe(1110);expect(safe.failure?.failedIndex).toBe(0);expect(safe.failure?.failedStep).toEqual({action:"assert",type:"url-contains",expected:token});expect(rec.failure?.message).toBe("expected 1, candidates 10");expect(renderRunRecord(safe)).toContain("1110ms");
});
it("空值或未引用的环境字段不改写文本",()=>{
const redact=createVariableRedactor({TOKEN:"",UNUSED:"private"},["TOKEN"]);expect(redact("private text")).toBe("private text");
});
it("已有占位符和数值字段映射不会再被值替换误改",()=>{
const redact=createVariableRedactor({TOKEN:"TOKEN"},["TOKEN"]);expect(redact("expected "+token)).toBe("expected "+token);
const numeric=createVariableRedactor({TOKEN:"1"},["TOKEN"],[{value:"1",source:token}]);
expect(numeric("expected 1, candidates 10")).toBe("expected "+token+", candidates 10");
});
it("快照ref元数据保留，正文同值仍隐藏",()=>{
const redact=createVariableRedactor({TOKEN:"e1"},["TOKEN"],[{value:"e1",source:"e"+"$"+"{NUMBER}"}]);
const rec:RunRecord={traceName:"test",startedAt:"",durationMs:1,ok:false,steps:[],drifts:[],healRequired:false,failure:{failedIndex:0,failedStep:{action:"press",key:"Tab"},kind:"action-failed",message:"value e1",snapshot:'[e1] textbox "name" value=e1',consoleErrors:[],failedRequests:[]}};
expect(redactVariableRecord(rec,redact).failure?.snapshot).toBe('[e1] textbox "name" value=e'+"$"+"{NUMBER}");
});

});
