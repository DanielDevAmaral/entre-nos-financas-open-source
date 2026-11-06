import { test } from "node:test";
import assert from "node:assert/strict";
import { tourLayout } from "../src/domain/tour-layout.ts";
test("tour stays inside both phone sizes, landscape and shortened visual viewport without covering the highlighted control", () => {
  for (const [width, height] of [
    [390, 844],
    [402, 874],
    [844, 390],
    [874, 402],
    [390, 400],
    [402, 320],
  ])
    for (const offset of [0, 80])
      for (const y of [12, 56, 116, height / 2, height - 76])
        for (const bh of [180, 230, 320]) {
          const v = { left: 0, top: offset, width, height },
            t = { left: 16, top: y + offset, width: width - 32, height: 58 },
            p = tourLayout(t, v, bh),
            h = Math.min(bh, p.maxHeight);
          assert.ok(p.maxHeight > 0);
          assert.ok(p.left >= v.left && p.left + p.width <= width);
          assert.ok(p.top >= v.top && p.top + h <= v.top + height + 0.001);
          const overlap =
            p.left < p.x + p.w &&
            p.left + p.width > p.x &&
            p.top < p.y + p.h &&
            p.top + h > p.y;
          assert.equal(overlap, false, JSON.stringify({ v, t, p }));
        }
});
