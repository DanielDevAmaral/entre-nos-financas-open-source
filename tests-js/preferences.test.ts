import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import {
  readPreferences,
  savePreferences,
  readProfilePhoto,
  completeOnboarding,
} from "../src/server/preferences.ts";
import {
  defaultPreferences,
  accentForeground,
} from "../src/domain/preferences.ts";
test("personal preferences isolate spouses and readers, reject stale updates, sanitize private photos and complete overview once without changing money", async () => {
  const db = await openDatabase();
  try {
    const ownerId = await createFamily(db, {
      name: "Teste",
      familyName: "Casa",
      email: "prefs@example.invalid",
      password: "Sintetica!2026abcd",
    });
    const familyId = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [ownerId],
      )
    ).rows[0].household_id;
    const u = {
      userId: ownerId,
      familyId,
      name: "Teste",
      email: "prefs@example.invalid",
      role: "owner",
    } as Identity;
    const spouseId = randomUUID();
    await db.query(
      `INSERT INTO users(id,name,email,password_hash) VALUES($1,'Outra','prefs-spouse@example.invalid','synthetic')`,
      [spouseId],
    );
    await db.query(
      `INSERT INTO members(household_id,user_id,role) VALUES($1,$2,'reader')`,
      [familyId, spouseId],
    );
    const spouse = { ...u, userId: spouseId, role: "reader" } as Identity;
    assert.deepEqual(await readPreferences(db, u), defaultPreferences);
    assert.equal(
      (await db.query("SELECT * FROM user_preferences")).rows.length,
      0,
    );
    let p = await savePreferences(db, u, {
      revision: 0,
      accent: "#112233",
      theme: "dark",
      card_order: [...defaultPreferences.card_order].reverse(),
      hidden_cards: ["cards", "fixed"],
    });
    assert.equal(p.revision, 1);
    assert.equal(p.card_order[0], "categories");
    assert.equal(p.onboarding_done, false);
    assert.deepEqual(await readPreferences(db, spouse), defaultPreferences);
    await savePreferences(db, spouse, { revision: 0, accent: "#fefefe" });
    assert.equal((await readPreferences(db, u)).accent, "#112233");
    await assert.rejects(
      savePreferences(db, u, { revision: 0, theme: "light" }),
    );
    await assert.rejects(
      savePreferences(db, u, { revision: 1, user_id: spouseId }),
    );
    await assert.rejects(
      savePreferences(db, u, {
        revision: 1,
        accent: "red;url(https://invalid)",
      }),
    );
    await assert.rejects(
      savePreferences(db, u, { revision: 1, card_order: ["summary"] }),
    );
    await assert.rejects(
      savePreferences(db, u, { revision: 1, hidden_cards: ["cards", "cards"] }),
    );
    assert.equal(
      (
        await asUser(db, spouseId, (tx) =>
          tx.query("SELECT * FROM user_preferences"),
        )
      ).rows.length,
      1,
    );
    await assert.rejects(
      asUser(db, spouseId, (tx) =>
        tx.query("UPDATE user_preferences SET user_id=$1 WHERE user_id=$2", [
          ownerId,
          spouseId,
        ]),
      ),
    );
    const photo = await sharp({
      create: { width: 300, height: 200, channels: 3, background: "#aa9988" },
    })
      .png()
      .withMetadata({ exif: { IFD0: { Artist: "private-metadata" } } })
      .toBuffer();
    p = await savePreferences(db, u, {
      revision: 1,
      photo: photo.toString("base64"),
    });
    assert.equal(p.has_photo, true);
    const saved = await readProfilePhoto(db, u);
    assert.ok(saved);
    const meta = await sharp(Buffer.from(saved)).metadata();
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 256);
    assert.equal(meta.exif, undefined);
    assert.equal(await readProfilePhoto(db, spouse), null);
    await assert.rejects(
      savePreferences(db, u, {
        revision: p.revision,
        photo: Buffer.from('<svg onload="alert(1)"></svg>').toString("base64"),
      }),
    );
    await assert.rejects(
      savePreferences(db, u, {
        revision: p.revision,
        photo: "a".repeat(150000),
      }),
    );
    const before = await readPreferences(db, u);
    await completeOnboarding(db, u);
    const first = (
      await db.query<{ onboarding_completed_at: string }>(
        "SELECT onboarding_completed_at::text FROM user_preferences WHERE user_id=$1",
        [ownerId],
      )
    ).rows[0].onboarding_completed_at;
    await completeOnboarding(db, u);
    assert.equal((await readPreferences(db, u)).onboarding_done, true);
    assert.equal((await readPreferences(db, u)).revision, before.revision);
    assert.equal((await readPreferences(db, spouse)).onboarding_done, false);
    assert.equal(
      (
        await db.query<{ onboarding_completed_at: string }>(
          "SELECT onboarding_completed_at::text FROM user_preferences WHERE user_id=$1",
          [ownerId],
        )
      ).rows[0].onboarding_completed_at,
      first,
    );
    p = await savePreferences(db, u, { revision: p.revision, photo: null });
    assert.equal(p.has_photo, false);
    assert.equal(await readProfilePhoto(db, u), null);
    for (const t of ["economic_events", "ledger_entries", "monthly_items"])
      assert.equal((await db.query(`SELECT * FROM ${t}`)).rows.length, 0);
    assert.equal(accentForeground("#ffffff"), "#161616");
    assert.equal(accentForeground("#000000"), "#ffffff");
  } finally {
    await db.close();
  }
});

test("home editing moves only visible cards and retains hidden cards without losing or duplicating widgets", async () => {
  const { moveVisibleCard, reorderCard } =
    await import("../src/domain/preferences.ts");
  const base = defaultPreferences.card_order;
  const moved = moveVisibleCard(base, ["receipts", "alerts"], "summary", 1);
  assert.ok(moved.indexOf("summary") > moved.indexOf("cards"));
  assert.deepEqual(
    moved.filter((x) => ["receipts", "alerts"].includes(x)),
    ["receipts", "alerts"],
  );
  assert.equal(new Set(moved).size, base.length);
  assert.deepEqual(base, defaultPreferences.card_order);
  assert.equal(moveVisibleCard(base, [], "summary", -1), base);
  const last = reorderCard(base, "summary", "categories", true);
  assert.equal(last.at(-1), "summary");
  assert.deepEqual([...last].sort(), [...base].sort());
  assert.equal(reorderCard(base, "summary", "summary"), base);
});
