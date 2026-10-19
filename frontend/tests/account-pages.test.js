import test from "node:test";
import assert from "node:assert/strict";
import { isEmbeddedView } from "../auth-transport.js";
import { accountRequest, jsonPost } from "../account-pages.js";

test("account pages recognize a cross-origin embedded view", () => {
  const top = {};
  Object.defineProperty(top, "location", {
    get() {
      throw new Error("Cross-origin access");
    },
  });
  assert.equal(isEmbeddedView({ self: {}, top }), true);
  const windowLike = {};
  windowLike.self = windowLike;
  windowLike.top = windowLike;
  assert.equal(isEmbeddedView(windowLike), false);
});

test("account API requests carry embedded authentication and preserve access errors", async (context) => {
  const top = {};
  Object.defineProperty(top, "location", {
    get() {
      throw new Error("Cross-origin access");
    },
  });
  Object.defineProperty(globalThis, "window", {
    value: { self: {}, top },
    configurable: true,
  });
  context.after(() => {
    delete globalThis.window;
  });
  context.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/admin/users/user/password-reset");
    assert.equal(options.headers.get("X-Continuator-Embedded"), "1");
    assert.equal(options.headers.get("Content-Type"), "application/json");
    assert.equal(options.method, "POST");
    return Response.json(
      { detail: "Administrator access is required." },
      { status: 403 },
    );
  });
  await assert.rejects(
    accountRequest(
      "/api/admin/users/user/password-reset",
      jsonPost({ admin_password: "test-password" }),
    ),
    (error) =>
      error.status === 403 &&
      error.message === "Administrator access is required.",
  );
});
