import { PNG } from "pngjs";
import { createHash } from "node:crypto";

/**
 * PNG 像素比对：通道容差抗抗锯齿抖动，占比阈值判定，diff 高亮图辅助人工判读。
 * pngjs 零传递依赖、纯 JS（design.md D1 供应链评估）。
 */

export interface DiffOptions {
  /** 每通道容差（0-255），默认 16 */
  channelTolerance?: number;
  /** 差异像素占比阈值（0-1），默认 0.001（0.1%） */
  threshold?: number;
}

export interface DiffResult {
  /** 差异像素占比（0-1） */
  ratio: number;
  exceeded: boolean;
  /** 差异高亮图：相同像素灰化、差异像素标红 */
  diff: PNG;
  /** 尺寸不一致时给出双方尺寸（无法比对） */
  sizeMismatch?: { actual: { w: number; h: number }; expected: { w: number; h: number } };
}

export function decodePng(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

export function encodePng(png: PNG): Buffer {
  return PNG.sync.write(png);
}

export function diffPng(actual: PNG, expected: PNG, opts: DiffOptions = {}): DiffResult {
  const tol = opts.channelTolerance ?? 16;
  const threshold = opts.threshold ?? 0.001;

  if (actual.width !== expected.width || actual.height !== expected.height) {
    return {
      ratio: 1,
      exceeded: true,
      diff: actual,
      sizeMismatch: {
        actual: { w: actual.width, h: actual.height },
        expected: { w: expected.width, h: expected.height }
      }
    };
  }

  const diff = new PNG({ width: actual.width, height: actual.height });
  let diffCount = 0;
  const total = actual.width * actual.height;

  for (let i = 0; i < actual.data.length; i += 4) {
    const same =
      Math.abs(actual.data[i] - expected.data[i]) <= tol &&
      Math.abs(actual.data[i + 1] - expected.data[i + 1]) <= tol &&
      Math.abs(actual.data[i + 2] - expected.data[i + 2]) <= tol;

    if (same) {
      const gray = Math.round((actual.data[i] + actual.data[i + 1] + actual.data[i + 2]) / 3);
      diff.data[i] = gray; diff.data[i + 1] = gray; diff.data[i + 2] = gray;
    } else {
      diff.data[i] = 255; diff.data[i + 1] = 0; diff.data[i + 2] = 0;
      diffCount++;
    }
    diff.data[i + 3] = 255;
  }

  const ratio = diffCount / total;
  return { ratio, exceeded: ratio > threshold, diff };
}

/** 基线文件名哈希：descriptor 内容 + fullPage 标志（heal 换步不移位，design.md D2） */
export function baselineHash(target: unknown, fullPage?: boolean): string {
  return createHash("sha1")
    .update(JSON.stringify(target ?? null) + (fullPage ? ":full" : ""))
    .digest("hex")
    .slice(0, 8);
}
