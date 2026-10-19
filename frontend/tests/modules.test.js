import test from "node:test";
import assert from "node:assert/strict";
import { PhraseRecorder, eventsToNotes } from "../midi-capture.js";
import { BrowserAudioRenderer } from "../playback-renderers.js";
import { createSessionController } from "../session-controller.js";

function fakeTiming() {
  let time = 0;
  let nextId = 0;
  const callbacks = new Map();
  return {
    performance: { now: () => time },
    setTimeout(callback, delay) {
      const id = ++nextId;
      callbacks.set(id, { callback, at: time + delay });
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, scheduled] of [...callbacks]) {
        if (scheduled.at <= time) {
          callbacks.delete(id);
          scheduled.callback();
        }
      }
    },
  };
}

function message(status, note, velocity, receivedTime) {
  return { data: [status, note, velocity], receivedTime };
}

test("MIDI capture waits for released notes and the phrase gap", () => {
  const timing = fakeTiming();
  const completed = [];
  const recorder = new PhraseRecorder(
    1000,
    () => {},
    (phrase) => completed.push(phrase),
    null,
    timing,
  );
  recorder.handleMessage(message(0x90, 60, 90, 0));
  timing.advance(2000);
  assert.equal(completed.length, 0);
  recorder.handleMessage(message(0x80, 60, 0, 2000));
  timing.advance(999);
  assert.equal(completed.length, 0);
  timing.advance(1);
  assert.equal(completed.length, 1);
  assert.deepEqual(
    completed[0].map((event) => event.type),
    ["note_on", "note_off"],
  );
  assert.equal(completed[0][1].delta_seconds, 2);
  assert.equal(recorder.snapshot().length, 0);
});

test("MIDI capture preserves repeated pitches and channel identities", () => {
  const timing = fakeTiming();
  const recorder = new PhraseRecorder(
    1000,
    () => {},
    () => {},
    null,
    timing,
  );
  for (const event of [
    message(0x90, 60, 90, 0),
    message(0x91, 60, 70, 100),
    message(0x90, 60, 80, 200),
    message(0x90, 60, 0, 300),
    message(0x81, 60, 0, 400),
    message(0x80, 60, 0, 500),
  ])
    recorder.handleMessage(event);
  const notes = eventsToNotes(recorder.snapshot());
  assert.equal(notes.length, 3);
  assert.deepEqual(
    notes.map((note) => [
      note.start_seconds,
      note.duration_seconds,
      note.velocity,
    ]),
    [
      [0, 0.3, 90],
      [0.1, 0.3, 70],
      [0.2, 0.3, 80],
    ],
  );
  assert.equal(recorder.pendingNotes.size, 0);
});

test("reset cancels a pending phrase completion", () => {
  const timing = fakeTiming();
  let count = 0;
  const recorder = new PhraseRecorder(
    1000,
    () => {},
    () => count++,
    null,
    timing,
  );
  recorder.handleMessage(message(0x90, 60, 90, 0));
  recorder.handleMessage(message(0x80, 60, 0, 200));
  recorder.reset();
  timing.advance(2000);
  assert.equal(count, 0);
});

test("audio renderer releases repeated voices independently", () => {
  const released = [];
  const renderer = new BrowserAudioRenderer({
    id: "test",
    label: "test",
    createVoice: () => ({
      release: (...args) => released.push(args),
    }),
  });
  renderer.context = { currentTime: 2 };
  renderer.master = {};
  renderer.noteOn(60, 0, 90);
  renderer.noteOn(60, 0, 80);
  renderer.noteOff(60, 0);
  assert.equal(released.length, 1);
  assert.equal(renderer.activeVoices.get("0:60").length, 1);
  assert.equal(renderer.panicTarget(), true);
  assert.equal(released.length, 2);
  assert.equal(renderer.activeVoices.size, 0);
});

test("API controller reports structured validation errors", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          detail: [{ msg: "Invalid pitch" }, { msg: "Invalid duration" }],
        }),
        { status: 422 },
      ),
  );
  const api = createSessionController({});
  await assert.rejects(
    api.requestJson("/api/continue"),
    /Invalid pitch Invalid duration/,
  );
});

test("API controller clears session state on expired authentication", async (context) => {
  context.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ detail: "Sign in" }), { status: 401 }),
  );
  const state = { authUser: { id: "test" } };
  let cleared = false;
  const api = createSessionController({
    state,
    syncAuthUI: () => {},
    renderSavedSessions: () => {},
    clearCurrentSessionState: () => {
      cleared = true;
    },
  });
  await assert.rejects(api.requestJson("/api/my/sessions"), /Sign in/);
  assert.equal(state.authUser, null);
  assert.equal(cleared, true);
});
