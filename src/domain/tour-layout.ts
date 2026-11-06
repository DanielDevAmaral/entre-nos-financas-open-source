export type TourRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));
export function tourLayout(
  target: TourRect,
  viewport: TourRect,
  bubbleHeight: number,
) {
  const margin = 12,
    gap = 18,
    leftBound = viewport.left + margin,
    rightBound = viewport.left + viewport.width - margin,
    topBound = viewport.top + margin,
    bottomBound = viewport.top + viewport.height - margin;
  const x = clamp(target.left - 6, leftBound, rightBound - 1),
    y = clamp(target.top - 6, topBound, bottomBound - 1),
    right = clamp(target.left + target.width + 6, x + 1, rightBound),
    bottom = clamp(target.top + target.height + 6, y + 1, bottomBound),
    w = right - x,
    h = bottom - y;
  const width = Math.min(340, viewport.width - 32),
    cx = x + w / 2,
    aboveSpace = Math.max(0, y - gap - topBound),
    belowSpace = Math.max(0, bottomBound - bottom - gap),
    above = belowSpace < bubbleHeight && aboveSpace > belowSpace,
    maxHeight = above ? aboveSpace : belowSpace,
    height = Math.min(Math.max(1, bubbleHeight), maxHeight),
    left = clamp(
      cx - width / 2,
      viewport.left + 16,
      viewport.left + viewport.width - width - 16,
    ),
    top = above ? y - gap - height : bottom + gap;
  const sx = clamp(cx, left + 24, left + width - 24),
    sy = above ? top + height : top,
    ey = above ? y - 2 : bottom + 2;
  return {
    x,
    y,
    w,
    h,
    left,
    top,
    width,
    maxHeight,
    arrow: `M ${sx} ${sy} Q ${sx + 12} ${(sy + ey) / 2} ${cx} ${ey}`,
    vw: viewport.width,
    vh: viewport.height,
  };
}
