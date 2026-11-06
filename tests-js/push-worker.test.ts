import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

test("push worker displays only fixed private text, handles malformed payloads and never follows supplied URLs", async () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const shown: { title: string; body: string; tag: string }[] = [];
  const navigated: string[] = [];
  runInNewContext(
    await readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    {
      URL,
      self: {
        location: { origin: "https://family.invalid" },
        addEventListener: (name: string, handler: (event: unknown) => void) => {
          handlers[name] = handler;
        },
        registration: {
          showNotification: (
            title: string,
            options: { body: string; tag: string },
          ) => {
            shown.push({ title, body: options.body, tag: options.tag });
            return Promise.resolve();
          },
        },
      },
      clients: {
        matchAll: async () => [
          {
            url: "https://family.invalid/",
            navigate: async (url: string) => {
              navigated.push(url);
            },
            focus: async () => {},
          },
        ],
      },
    },
  );
  let pending = Promise.resolve();
  const waitUntil = (p: Promise<void>) => {
    pending = p;
  };
  handlers.push({
    data: {
      json: () => ({
        type: "test",
        title: "SECRET",
        body: "Bank balance 999",
        url: "https://evil.invalid",
      }),
    },
    waitUntil,
  });
  await pending;
  assert.equal(shown[0].title, "Entre Nós");
  assert.equal(shown[0].tag, "entre-nos-teste");
  assert.ok(!JSON.stringify(shown).includes("999"));
  handlers.push({
    data: {
      json: () => {
        throw new Error("invalid JSON");
      },
    },
    waitUntil,
  });
  await pending;
  assert.equal(shown[1].tag, "entre-nos-contas");
  handlers.notificationclick({
    notification: { data: { url: "https://evil.invalid" }, close: () => {} },
    waitUntil,
  });
  await pending;
  assert.deepEqual(navigated, ["/?view=month"]);
});
