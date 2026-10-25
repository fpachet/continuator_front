import test from "node:test";
import assert from "node:assert/strict";
import { createMidiInput } from "../midi-input.js";
import { createSessionController } from "../session-controller.js";

function inputHarness(
  context,
  stopMemoryOnUserPlay = true,
  memoryIndex = null,
) {
  const input = { id: "keyboard", name: "Keyboard", open: async () => {} };
  const state = {
    stopMemoryOnUserPlay,
    activePlayback: {},
    activeMemoryPlaybackIndex: memoryIndex,
    midiAccess: { inputs: new Map([[input.id, input]]) },
    activeVisualMidiNotes: new Set(),
    virtualHeldSourcesByNote: new Map(),
    virtualSustainedNotes: new Set(),
    virtualLatchedNotes: new Set(),
    liveMonitorToken: 0,
  };
  const recorded = [];
  const stop = context.mock.fn(() => true);
  const dispatch = context.mock.fn();
  const midi = createMidiInput({
    state,
    elements: {
      midiInputSelect: {},
      virtualKeyboardPanel: {},
      virtualKeyboard: { querySelector: () => null },
      virtualVelocityInput: { value: "100" },
      virtualSustainToggle: { checked: false },
    },
    recorder: {
      events: recorded,
      handleMessage: (message) => recorded.push(message),
    },
    stopLoopAndPlayback: stop,
    stopMidiCopyPlayback: () => {},
    selectedPlaybackChoice: () => ({ renderer: {}, value: "triangle" }),
    createPlaybackSession: async () => ({}),
    dispatchPlaybackEvent: dispatch,
    renderPerformanceState: () => {},
    setLastMidiEvent: () => {},
    setMidiStatus: () => {},
    setPhraseStatus: () => {},
    setSelectedInputName: () => {},
    setPhraseMessage: () => {},
  });
  return { midi, input, state, recorded, stop, dispatch };
}

test("hardware input protects only memory playback and keeps recording", async (context) => {
  const { midi, input, state, recorded, stop } = inputHarness(context, true, 0);
  await midi.attachInput(input.id);
  const noteOn = { data: [0x91, 60, 90], receivedTime: 0 };
  input.onmidimessage(noteOn);
  assert.equal(stop.mock.callCount(), 1);

  state.stopMemoryOnUserPlay = false;
  input.onmidimessage(noteOn);
  input.onmidimessage({ data: [0x81, 60, 0], receivedTime: 100 });
  input.onmidimessage({ data: [0x91, 60, 0], receivedTime: 110 });
  input.onmidimessage({ data: [0xb1, 64, 127], receivedTime: 120 });
  assert.equal(stop.mock.callCount(), 1);
  assert.equal(recorded.length, 5);

  // Generated playback must still stop with the memory option off.
  state.activeMemoryPlaybackIndex = null;
  input.onmidimessage(noteOn);
  assert.equal(stop.mock.callCount(), 2);
  assert.equal(recorded.length, 6);

  state.activeMemoryPlaybackIndex = 0;
  state.stopMemoryOnUserPlay = true;
  input.onmidimessage(noteOn);
  assert.equal(stop.mock.callCount(), 3);
});

for (const [label, enabled, memoryIndex, infiniteModeEnabled, shouldStop] of [
  ["memory with stopping off", false, 0, false, false],
  ["memory with stopping on", true, 0, false, true],
  ["generated continuation with memory stopping off", false, null, false, true],
  ["infinite mode armed from memory", false, 0, true, true],
]) {
  test(`virtual input keeps monitoring and recording: ${label}`, async (context) => {
    Object.defineProperty(globalThis, "window", {
      value: { performance },
      configurable: true,
    });
    context.after(() => delete globalThis.window);
    const { midi, state, recorded, stop, dispatch } = inputHarness(
      context,
      enabled,
      memoryIndex,
    );
    state.infiniteModeEnabled = infiniteModeEnabled;
    midi.pressVirtualNote(60, "pointer:1");
    midi.releaseVirtualNote(60, "pointer:1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stop.mock.callCount(), shouldStop ? 1 : 0);
    assert.equal(recorded.length, 2);
    assert.deepEqual(
      dispatch.mock.calls.map(({ arguments: [, event] }) => event.type),
      ["note_on", "note_off"],
    );
  });
}

function sessionHarness(context, stateOverrides) {
  const phrase = {
    events: [{ type: "note_on", note: 60, velocity: 90, delta_seconds: 0 }],
    notes: [],
    event_count: 1,
    note_count: 1,
  };
  const stop = context.mock.fn();
  const play = context.mock.fn();
  const fetchApi = context.mock.fn(async () =>
    Response.json({ input_phrase: phrase, generated_phrase: phrase }),
  );
  const state = {
    sessionId: "session",
    lastCapturedPhrase: phrase.events,
    stopMemoryOnUserPlay: false,
    ...stateOverrides,
  };
  const session = createSessionController({
    state,
    elements: {
      learnInputToggle: { checked: true },
      continuationLengthInput: { value: "" },
    },
    fetchApi,
    stopInfiniteMode: stop,
    playPayload: play,
    normalizedContinuationNoteCount: () => null,
    serverWaitLabel: (label) => label,
    startServerWaitIndicator: () => {},
    stopServerWaitIndicator: () => {},
    setPhraseStatus: () => {},
    setPhraseMessage: () => {},
    renderPerformanceState: () => {},
    rememberCapturedPhrase: () => {},
    rememberGeneratedPhrase: () => {},
    renderConstraintStatus: () => {},
    renderGeneratedStats: () => {},
  });
  return { session, stop, play, fetchApi };
}

test("auto-send preserves memory playback when memory stopping is off", async (context) => {
  const { session, stop, play, fetchApi } = sessionHarness(context, {
    activePlayback: {},
    activeMemoryPlaybackIndex: 0,
  });
  await session.sendCurrentPhrase({ automatic: true });
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(play.mock.callCount(), 0);
  assert.equal(fetchApi.mock.callCount(), 0);
});

for (const [label, state, options] of [
  [
    "manual send can replace protected memory playback",
    { activePlayback: {}, activeMemoryPlaybackIndex: 0 },
    {},
  ],
  ["auto-send works after playback ends", {}, { automatic: true }],
  [
    "auto-send works for generated continuations with memory stopping off",
    { activePlayback: {}, activeMemoryPlaybackIndex: null },
    { automatic: true },
  ],
  [
    "auto-send works in infinite mode armed from memory",
    {
      activePlayback: {},
      activeMemoryPlaybackIndex: 0,
      infiniteModeEnabled: true,
    },
    { automatic: true },
  ],
  [
    "auto-send works while an infinite continuation is being generated",
    { infiniteRequestInFlight: true },
    { automatic: true },
  ],
  [
    "auto-send works when memory stopping is enabled",
    {
      activePlayback: {},
      activeMemoryPlaybackIndex: 0,
      stopMemoryOnUserPlay: true,
    },
    { automatic: true },
  ],
  [
    "auto-send works after memory playback ends even with a stale slot index",
    { activeMemoryPlaybackIndex: 0 },
    { automatic: true },
  ],
]) {
  test(label, async (context) => {
    Object.defineProperty(globalThis, "window", {
      value: { performance },
      configurable: true,
    });
    context.after(() => delete globalThis.window);
    const { session, stop, play, fetchApi } = sessionHarness(context, state);
    await session.sendCurrentPhrase(options);
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(fetchApi.mock.callCount(), 1);
    assert.equal(play.mock.callCount(), 1);
  });
}
