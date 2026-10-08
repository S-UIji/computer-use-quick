export interface WindowSlot { index: number; of: number; }
export interface WindowArea { left: number; top: number; width: number; height: number; }
/** Chrome 存在最小窗口尺寸；不足时由调用方回退，不让网格变成重叠窗口。 */
export function tileWindow(area: WindowArea, slot: WindowSlot): WindowArea | undefined {
  if (![area.left,area.top,area.width,area.height].every(Number.isFinite)
    || !Number.isInteger(slot.index) || !Number.isInteger(slot.of)
    || slot.of < 1 || slot.of > 8 || slot.index < 0 || slot.index >= slot.of) return undefined;
  const cols = Math.ceil(Math.sqrt(slot.of)), rows = Math.ceil(slot.of / cols), gap = 8;
  const width = Math.floor((area.width - gap * (cols - 1)) / cols);
  const height = Math.floor((area.height - gap * (rows - 1)) / rows);
  if (width < 500 || height < 200) return undefined;
  return { left: Math.floor(area.left) + (slot.index % cols) * (width + gap),
    top: Math.floor(area.top) + Math.floor(slot.index / cols) * (height + gap), width, height };
}
