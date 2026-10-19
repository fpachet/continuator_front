import test from "node:test";
import assert from "node:assert/strict";
import { createApiFetch } from "../auth-transport.js";
import { createSessionController } from "../session-controller.js";

test("embedded API fetches add the auth header and preserve request options", async (context) => {
  let request;
  context.mock.method(globalThis, "fetch", async (url, options) => {
    request = { url, ...options };
    return Response.json({});
  });
  const signal = new AbortController().signal;
  await createApiFetch(() => true)("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  assert.equal(request.headers.get("X-Continuator-Embedded"), "1");
  assert.equal(request.headers.get("Content-Type"), "application/json");
  assert.equal(request.credentials, "same-origin");
  assert.equal(request.signal, signal);
  assert.equal(request.method, "POST");
});

test("first-party API fetches keep the ordinary cookie context", async (context) => {
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.has("X-Continuator-Embedded"), false);
    return Response.json({});
  });
  await createApiFetch(() => false)("/api/my/sessions");
});

test("blocked sign-in cookies preserve the guest session and show a useful error", async () => {
  const phrase = [{ note: 60 }];
  const state = {
    authUser: null,
    sessionId: "guest",
    sessionIsOwned: false,
    lastCapturedPhrase: phrase,
  };
  const urls = [];
  const api = createSessionController({
    state,
    validateAuthCredentials: () => ({
      username: "user",
      password: "test-password",
    }),
    fetchApi: async (url) => {
      urls.push(url);
      return Response.json(
        url.endsWith("/login") ? { user: { id: "user" } } : { user: null },
      );
    },
  });
  await assert.rejects(
    api.submitAuth("login"),
    /did not retain the sign-in cookie/,
  );
  assert.deepEqual(urls, ["/api/auth/login", "/api/auth/me"]);
  assert.equal(state.authUser, null);
  assert.equal(state.sessionId, "guest");
  assert.equal(state.lastCapturedPhrase, phrase);
});
