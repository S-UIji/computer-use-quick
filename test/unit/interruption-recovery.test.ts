import{describe,it,expect}from"vitest";
import{interruptionRecovery}from"../../src/report/interruptionRecovery.js";
import{renderRunRecord}from"../../src/report/runRecord.js";
import type{RunRecord,FailureKind}from"../../src/types.js";
const failure=(kind:FailureKind="user-interrupted")=>({failedIndex:2,failedStep:{action:"press" as const,key:"Tab"},kind,message:"停止",snapshot:"",consoleErrors:[],failedRequests:[]});
const record:RunRecord={traceName:"t",startedAt:"",durationMs:1,ok:false,steps:[],drifts:[],healRequired:false,failure:failure()};
describe("中断恢复指引",()=>{
it("batch 提示等待、刷新快照并复核当步，不假定没有副作用",()=>{
const message=interruptionRecovery(failure(),"batch");
expect(message).toContain("不要立即重试");expect(message).toContain("用户操作已完成");expect(message).toContain("snapshot");expect(message).toContain("第 3 步");expect(message).toContain("核实");expect(message).not.toContain("本步未执行");
});
it("回放报告指向原trace完整 replay",()=>{
const message=renderRunRecord(record);
expect(message).toContain("用户操作已完成");expect(message).toContain("重新完整 replay");expect(message).not.toContain("重新调用 heal_step");
});
it("自愈候选报告指向修复参数而非磁盘replay",()=>{
const message=renderRunRecord(record,"heal");
expect(message).toContain("原始修复步号");expect(message).toContain("重新调用 heal_step");expect(message).not.toContain("重新完整 replay");
});
it.each<FailureKind>(["page-closed","target-not-found","assert-failed"])("%s 不误报用户介入恢复",kind=>{
expect(interruptionRecovery(failure(kind),"batch")).toBe("");
expect(renderRunRecord({...record,failure:failure(kind)})).not.toContain("不要立即重试");
});
it("成功及无失败记录不产生恢复指引",()=>{
expect(interruptionRecovery(undefined)).toBe("");
expect(renderRunRecord({...record,ok:true,failure:undefined})).not.toContain("下一步");
});
});
