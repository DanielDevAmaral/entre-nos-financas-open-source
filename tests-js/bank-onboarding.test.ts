import { test } from "node:test";
import assert from "node:assert/strict";
import { pluggyItemId, bankSetupStage } from "../src/domain/bank-onboarding.ts";

test("bank setup accepts a copied Pluggy item or dashboard link, rejecting lookalikes and ambiguous links", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(pluggyItemId("  " + id.toUpperCase() + "  "), id);
  const path =
    "/applications/22222222-2222-4222-8222-222222222222/demo?itemId=" + id;
  assert.equal(pluggyItemId("https://dashboard.pluggy.ai" + path), id);
  for (const value of [
    "https://dashboard.pluggy.ai.attacker.invalid" + path,
    "http://dashboard.pluggy.ai" + path,
    "https://dashboard.pluggy.ai:444" + path,
    "https://user:secret@dashboard.pluggy.ai" + path,
    "https://dashboard.pluggy.ai" + path + "&itemId=" + id,
    "https://dashboard.pluggy.ai" + path + "#" + id,
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://127.0.0.1" + path,
    "https://dashboard.pluggy.ai/overview",
    "not-an-item",
    "a".repeat(2049),
  ])
    assert.throws(() => pluggyItemId(value), /Cole o itemId/);
});

test("setup resumes from saved state of the current titular, never the partner's credentials or mapping", () => {
  const spouse = { id: "spouse", own: false, enabled: true };
  const own = { id: "own", own: true, enabled: true };
  const unmapped = {
    connection_id: "own",
    currency: "BRL",
    local_account_id: null,
  };
  assert.equal(
    bankSetupStage({
      hasCredentials: false,
      connections: [spouse],
      accounts: [],
    }),
    1,
  );
  assert.equal(
    bankSetupStage({
      hasCredentials: true,
      connections: [spouse],
      accounts: [],
    }),
    3,
  );
  assert.equal(
    bankSetupStage({
      hasCredentials: true,
      connections: [own],
      accounts: [unmapped],
    }),
    4,
  );
  assert.equal(
    bankSetupStage({
      hasCredentials: true,
      connections: [own, spouse],
      accounts: [
        { ...unmapped, local_account_id: "existing-account" },
        { ...unmapped, connection_id: "spouse" },
        { ...unmapped, currency: "USD" },
      ],
    }),
    5,
  );
  assert.equal(
    bankSetupStage({
      hasCredentials: true,
      connections: [{ ...own, enabled: false }],
      accounts: [unmapped],
    }),
    3,
  );
});

test("a connected item without supported accounts must not look ready to read", () => {
  assert.equal(
    bankSetupStage({
      hasCredentials: true,
      connections: [{ id: "own", own: true, enabled: true }],
      accounts: [
        { connection_id: "own", currency: "USD", local_account_id: null },
      ],
    }),
    4,
  );
});
