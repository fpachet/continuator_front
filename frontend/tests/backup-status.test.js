import test from "node:test";
import assert from "node:assert/strict";
import { createBackupStatus } from "../backup-status.js";
import { createSessionController } from "../session-controller.js";

test("a pending write cannot be reported as cloud saved by an older poll", async () => {
  const element = { dataset: {} };
  const replies = [];
  const status = createBackupStatus(
    element,
    () => new Promise((resolve) => replies.push(resolve)),
  );
  const baseline = status.refresh();
  replies.shift()(Response.json({ enabled: true, status: "saved" }));
  await baseline;
  assert.equal(element.textContent, "Cloud saved");
  const stale = status.refresh();
  status.beginWrite();
  replies.shift()(Response.json({ enabled: true, status: "saved" }));
  await stale;
  assert.equal(element.textContent, "Saving to cloud…");
  status.endWrite();
  replies.shift()(Response.json({ enabled: true, status: "saving" }));
  const confirmed = status.refresh();
  replies.shift()(Response.json({ enabled: true, status: "saved" }));
  await confirmed;
  assert.equal(element.textContent, "Cloud saved");
});

test("local-only storage and unavailable cloud status are explicit", async () => {
  const element = { dataset: {} };
  let failed = false;
  const status = createBackupStatus(element, async () => {
    if (failed) throw new Error("offline");
    return Response.json({ enabled: false, status: "local" });
  });
  await status.refresh();
  assert.match(element.textContent, /Local storage only/);
  failed = true;
  await status.refresh();
  assert.equal(element.textContent, "Cloud save status unavailable");
});

test("saving a guest session preserves its captured phrase and session identity", async (context) => {
  const phrase = [{ type: "note_on", note: 60 }];
  const state = {
    authUser: { id: "owner" },
    sessionId: "guest",
    sessionIsOwned: false,
    lastCapturedPhrase: phrase,
  };
  const requests = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push([url, options?.method]);
    return Response.json(
      url.includes("/claim") ? { session_id: "guest" } : { items: [] },
    );
  });
  const api = createSessionController({
    state,
    elements: { claimSessionButton: {} },
    syncAuthUI() {},
    renderSavedSessions() {},
    setAuthMessage() {},
    setPhraseMessage() {},
  });
  await api.claimCurrentSession();
  assert.equal(state.sessionId, "guest");
  assert.equal(state.sessionIsOwned, true);
  assert.equal(state.lastCapturedPhrase, phrase);
  assert.deepEqual(requests[0], ["/api/my/sessions/guest/claim", "POST"]);
});
