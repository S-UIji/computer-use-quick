import { describe, it, expect } from "vitest";
import { PNG } from "pngjs";
import { decodePng, encodePng, diffPng, baselineHash } from "../../src/perception/pngDiff.js";

function solidPng(w: number, h: number, r: number, g: number, b: number): PNG {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) {
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255;
  }
  return p;
}

describe("pngDiff 像素比对", () => {
  it("编解码往返一致", () => {
    const p = solidPng(4, 4, 10, 20, 30);
    const rt = decodePng(encodePng(p));
    expect(rt.width).toBe(4);
    expect(Array.from(rt.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it("同图 ratio=0 且通过", () => {
    const p = solidPng(8, 8, 100, 100, 100);
    const r = diffPng(p, solidPng(8, 8, 100, 100, 100));
    expect(r.ratio).toBe(0);
    expect(r.exceeded).toBe(false);
  });

  it("已知差异：一半像素不同 → ratio 命中", () => {
    const a = solidPng(4, 4, 0, 0, 0);
    const b = solidPng(4, 4, 0, 0, 0);
    for (let y = 0; y < 4; y++) for (let x = 2; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      b.data[i] = 255; b.data[i + 1] = 255; b.data[i + 2] = 255;
    }
    const r = diffPng(a, b);
    expect(r.ratio).toBeCloseTo(0.5, 5);
    expect(r.exceeded).toBe(true);
  });

  it("通道容差吸收抗锯齿级抖动", () => {
    const a = solidPng(8, 8, 100, 100, 100);
    const b = solidPng(8, 8, 108, 100, 100); // Δ=8 < 容差 16
    const r = diffPng(a, b);
    expect(r.ratio).toBe(0);
  });

  it("阈值边界：ratio 恰等于阈值时不算超", () => {
    const a = solidPng(10, 10, 0, 0, 0);
    const b = solidPng(10, 10, 0, 0, 0);
    b.data[0] = 255; b.data[1] = 255; b.data[2] = 255; // 1/100 = 0.01
    const r = diffPng(a, b, { threshold: 0.01 });
    expect(r.ratio).toBeCloseTo(0.01, 5);
    expect(r.exceeded).toBe(false); // 严格大于才算超
    expect(diffPng(a, b, { threshold: 0.005 }).exceeded).toBe(true);
  });

  it("尺寸不一致直接判负并报告双方尺寸", () => {
    const r = diffPng(solidPng(4, 4, 0, 0, 0), solidPng(8, 8, 0, 0, 0));
    expect(r.exceeded).toBe(true);
    expect(r.sizeMismatch?.actual).toEqual({ w: 4, h: 4 });
  });

  it("diff 图：相同灰化、差异标红", () => {
    const a = solidPng(2, 2, 10, 10, 10);
    const b = solidPng(2, 2, 10, 10, 10);
    b.data[0] = 200;
    const d = diffPng(a, b).diff;
    expect(d.data[0]).toBe(255); expect(d.data[1]).toBe(0); // 差异像素标红
    expect(d.data[4]).toBe(10);  // 相同像素保留灰度
  });
});

describe("baselineHash", () => {
  it("相同 descriptor 相同哈希；fullPage 区分", () => {
    const t = { strategies: [{ kind: "css", value: "#a" }] };
    expect(baselineHash(t)).toBe(baselineHash(t));
    expect(baselineHash(t)).not.toBe(baselineHash(t, true));
  });
});
