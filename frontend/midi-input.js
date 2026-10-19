import {
  VIRTUAL_MIDI_INPUT_ID,
  VIRTUAL_MIDI_INPUT_NAME,
  VIRTUAL_KEYBOARD_DESKTOP_OCTAVES,
  VIRTUAL_KEYBOARD_PHONE_OCTAVES,
  PHONE_LAYOUT_MEDIA_QUERY,
  PHONE_SCREEN_MAX_CSS_PX,
  VIRTUAL_KEYBOARD_MIN_BASE_NOTE,
  VIRTUAL_KEYBOARD_MAX_BASE_NOTE,
  VIRTUAL_CHORD_QUANTIZE_MS,
  VIRTUAL_KEYBOARD_CHANNEL,
  COMPUTER_KEYBOARD_OFFSETS,
  NOTE_NAMES,
  BLACK_KEY_OFFSETS,
} from "./constants.js";
import { midiMessageToEvent } from "./midi-capture.js";

// Dependencies are supplied by app.js; modules never import the composition root.
export function createMidiInput(dependencies) {
  const {
    createPlaybackSession,
    currentMidiCopyOutputPreference,
    currentPlaybackPreference,
    dispatchPlaybackEvent,
    elements,
    populateMidiCopyOutputChoices,
    populatePlaybackChoices,
    recorder,
    renderPerformanceState,
    saveSessionPreferences,
    selectedMidiCopyRestoresPendingPreference,
    selectedPlaybackChoice,
    selectedPlaybackRestoresPendingPreference,
    setLastMidiEvent,
    setMidiStatus,
    setPhraseMessage,
    setPhraseStatus,
    setSelectedInputName,
    state,
    stopLoopAndPlayback,
    stopMidiCopyPlayback,
    syncFaustRendererPanel,
  } = dependencies;

  function midiNoteName(note) {
    return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
  }

  function isVirtualMidiInputId(inputId) {
    return inputId === VIRTUAL_MIDI_INPUT_ID;
  }

  function isVirtualMidiInputSelected() {
    return isVirtualMidiInputId(state.activeInputId);
  }

  function selectedMidiInputId() {
    return elements.midiInputSelect?.value || "";
  }

  function isVirtualMidiInputChosen() {
    return (
      isVirtualMidiInputSelected() ||
      isVirtualMidiInputId(selectedMidiInputId())
    );
  }

  function syncVirtualKeyboardVisibility() {
    elements.virtualKeyboardPanel.hidden = !isVirtualMidiInputChosen();
  }

  function shouldMonitorSelectedMidiInput() {
    return state.inputMonitorEnabled && !isVirtualMidiInputSelected();
  }

  function normalizeMidiNote(note) {
    return Math.max(0, Math.min(127, Number(note) || 0));
  }

  function virtualKeyboardRangeLabel() {
    const first = state.virtualKeyboardBaseNote;
    const last = first + virtualKeyboardOctaves() * 12 - 1;
    return `${midiNoteName(first)}-${midiNoteName(last)}`;
  }

  function virtualKeyboardOctaves() {
    return isPhoneLayout()
      ? VIRTUAL_KEYBOARD_PHONE_OCTAVES
      : VIRTUAL_KEYBOARD_DESKTOP_OCTAVES;
  }

  function isPhoneLayout() {
    const requestedLayout = new URLSearchParams(window.location.search).get(
      "layout",
    );
    if (requestedLayout === "phone") {
      return true;
    }
    if (requestedLayout === "desktop") {
      return false;
    }

    const responsiveMatch = Boolean(
      window.matchMedia?.(PHONE_LAYOUT_MEDIA_QUERY).matches,
    );
    const mobileClientHint = navigator.userAgentData?.mobile === true;
    const phoneUserAgent = /Android.+Mobile|iPhone|iPod/i.test(
      navigator.userAgent || "",
    );
    const coarseTouch =
      Boolean(window.matchMedia?.("(pointer: coarse)").matches) ||
      navigator.maxTouchPoints > 0;
    const screenDimensions = [window.screen?.width, window.screen?.height]
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0);
    const compactPhysicalScreen =
      screenDimensions.length > 0 &&
      Math.min(...screenDimensions) <= PHONE_SCREEN_MAX_CSS_PX;

    return (
      responsiveMatch ||
      mobileClientHint ||
      phoneUserAgent ||
      (coarseTouch && compactPhysicalScreen)
    );
  }

  function syncPhoneLayout() {
    const phoneLayout = isPhoneLayout();
    document.documentElement.classList.toggle("phone-layout", phoneLayout);
    document.querySelectorAll("[data-phone-collapsible]").forEach((details) => {
      if (!(details instanceof HTMLDetailsElement)) {
        return;
      }
      if (!phoneLayout) {
        details.open = true;
        details.dataset.phoneInitialized = "false";
        return;
      }
      if (details.dataset.phoneInitialized !== "true") {
        details.open = false;
        details.dataset.phoneInitialized = "true";
      }
    });
    return phoneLayout;
  }

  async function initializePhoneInput() {
    if (!isPhoneLayout() || isVirtualMidiInputSelected()) {
      return;
    }
    await attachInput(VIRTUAL_MIDI_INPUT_ID, { savePreference: false });
  }

  function getVirtualVelocity() {
    return Math.max(
      1,
      Math.min(127, Number(elements.virtualVelocityInput.value) || 100),
    );
  }

  function makeMidiMessageEvent(data, receivedTime = window.performance.now()) {
    return {
      data: Uint8Array.from(data),
      receivedTime,
    };
  }

  function getVirtualNoteTimestamp(type) {
    const now = window.performance.now();
    if (type !== "note_on") {
      return now;
    }
    if (
      state.virtualQuantizedTimestamp == null ||
      now - state.virtualQuantizedAt > VIRTUAL_CHORD_QUANTIZE_MS
    ) {
      state.virtualQuantizedTimestamp = now;
      state.virtualQuantizedAt = now;
    }
    return state.virtualQuantizedTimestamp;
  }

  function updateVisualMidiState(messageEvent) {
    const [statusByte, note, velocity = 0] = [...messageEvent.data];
    const status = statusByte & 0xf0;
    if (status === 0x90 && velocity > 0) {
      state.activeVisualMidiNotes.add(note);
    } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      state.activeVisualMidiNotes.delete(note);
    } else {
      return;
    }
    renderVirtualKeyboardNoteState(note);
  }

  async function ensureLiveMonitorPlayback() {
    const choice = selectedPlaybackChoice();
    if (!choice.renderer) {
      return null;
    }
    if (
      state.liveMonitorPlayback &&
      state.liveMonitorChoiceValue === choice.value
    ) {
      return state.liveMonitorPlayback;
    }
    if (
      state.liveMonitorPlaybackPromise &&
      state.liveMonitorChoiceValue === choice.value
    ) {
      return state.liveMonitorPlaybackPromise;
    }

    stopLiveMonitorPlayback();
    state.liveMonitorChoiceValue = choice.value;
    const token = ++state.liveMonitorToken;
    state.liveMonitorPlaybackPromise = createPlaybackSession(choice.value)
      .then((playback) => {
        if (token !== state.liveMonitorToken) {
          playback.renderer?.stopPlayback?.(playback);
          stopMidiCopyPlayback(playback);
          return null;
        }
        state.liveMonitorPlayback = playback;
        return playback;
      })
      .catch((error) => {
        state.liveMonitorChoiceValue = null;
        setPhraseMessage(
          `Live input monitor unavailable: ${error.message}`,
          true,
        );
        return null;
      })
      .finally(() => {
        state.liveMonitorPlaybackPromise = null;
      });
    return state.liveMonitorPlaybackPromise;
  }

  function stopLiveMonitorPlayback() {
    const playback = state.liveMonitorPlayback;
    if (playback?.renderer?.stopPlayback) {
      playback.renderer.stopPlayback(playback);
    }
    stopMidiCopyPlayback(playback);
    state.liveMonitorPlayback = null;
    state.liveMonitorPlaybackPromise = null;
    state.liveMonitorChoiceValue = null;
    state.liveMonitorToken += 1;
  }

  async function monitorLiveMidiMessage(messageEvent) {
    const event = midiMessageToEvent(messageEvent);
    if (!event) {
      return;
    }
    const playback = await ensureLiveMonitorPlayback();
    if (!playback) {
      return;
    }
    dispatchPlaybackEvent(playback, event);
  }

  function handleUnifiedMidiMessage(
    messageEvent,
    sourceLabel,
    { monitor = false } = {},
  ) {
    const [statusByte, note, velocity = 0] = [...messageEvent.data];
    const status = statusByte & 0xf0;
    const type =
      status === 0x90 && velocity > 0
        ? "note_on"
        : status === 0x80 || (status === 0x90 && velocity === 0)
          ? "note_off"
          : "message";

    updateVisualMidiState(messageEvent);

    const interruptedPlayback =
      type === "note_on"
        ? stopLoopAndPlayback(
            `Stopped the current continuation and switched to live MIDI from ${sourceLabel}.`,
          )
        : false;

    const phraseWasEmpty = recorder.events.length === 0;
    recorder.handleMessage(messageEvent);
    if (monitor) {
      void monitorLiveMidiMessage(messageEvent);
    }
    setLastMidiEvent(`${type} ${note} v${velocity}`);
    if (interruptedPlayback) {
      setPhraseMessage(
        `Stopped the current continuation and switched to live MIDI from ${sourceLabel}.`,
      );
    } else if (phraseWasEmpty) {
      setPhraseMessage(
        `Receiving MIDI from ${sourceLabel}. Waiting for phrase end...`,
      );
    }
  }

  function emitVirtualMidiNote(note, type) {
    const midiNote = normalizeMidiNote(note);
    const status = type === "note_on" ? 0x90 : 0x80;
    const velocity = type === "note_on" ? getVirtualVelocity() : 0;
    const timestamp = getVirtualNoteTimestamp(type);
    handleUnifiedMidiMessage(
      makeMidiMessageEvent(
        [status | VIRTUAL_KEYBOARD_CHANNEL, midiNote, velocity],
        timestamp,
      ),
      "Virtual Keyboard",
      { monitor: true },
    );
  }

  function virtualHeldSources(note) {
    const midiNote = normalizeMidiNote(note);
    let sources = state.virtualHeldSourcesByNote.get(midiNote);
    if (!sources) {
      sources = new Set();
      state.virtualHeldSourcesByNote.set(midiNote, sources);
    }
    return sources;
  }

  function pressVirtualNote(note, sourceId) {
    const midiNote = normalizeMidiNote(note);
    const sources = virtualHeldSources(midiNote);
    if (sources.has(sourceId) || state.virtualLatchedNotes.has(midiNote)) {
      return;
    }
    const wasInactive =
      sources.size === 0 && !state.virtualSustainedNotes.has(midiNote);
    sources.add(sourceId);
    state.virtualSustainedNotes.delete(midiNote);
    if (wasInactive) {
      emitVirtualMidiNote(midiNote, "note_on");
    }
  }

  function releaseVirtualNote(note, sourceId) {
    const midiNote = normalizeMidiNote(note);
    const sources = state.virtualHeldSourcesByNote.get(midiNote);
    if (!sources?.has(sourceId)) {
      return;
    }
    sources.delete(sourceId);
    if (!sources.size) {
      state.virtualHeldSourcesByNote.delete(midiNote);
    }
    if (sources?.size || state.virtualLatchedNotes.has(midiNote)) {
      return;
    }
    if (elements.virtualSustainToggle.checked) {
      state.virtualSustainedNotes.add(midiNote);
      return;
    }
    emitVirtualMidiNote(midiNote, "note_off");
  }

  function toggleLatchedVirtualNote(note) {
    const midiNote = normalizeMidiNote(note);
    if (state.virtualLatchedNotes.has(midiNote)) {
      state.virtualLatchedNotes.delete(midiNote);
      if (!state.virtualHeldSourcesByNote.has(midiNote)) {
        emitVirtualMidiNote(midiNote, "note_off");
      }
      return;
    }
    const wasInactive =
      !state.virtualHeldSourcesByNote.has(midiNote) &&
      !state.virtualSustainedNotes.has(midiNote);
    state.virtualLatchedNotes.add(midiNote);
    state.virtualSustainedNotes.delete(midiNote);
    if (wasInactive) {
      emitVirtualMidiNote(midiNote, "note_on");
    }
  }

  function releaseSustainedVirtualNotes() {
    for (const note of [...state.virtualSustainedNotes]) {
      if (
        !state.virtualHeldSourcesByNote.has(note) &&
        !state.virtualLatchedNotes.has(note)
      ) {
        emitVirtualMidiNote(note, "note_off");
        state.virtualSustainedNotes.delete(note);
      }
    }
  }

  function allVirtualNotesOff({ clearLatch = true } = {}) {
    const notes = new Set([
      ...state.virtualHeldSourcesByNote.keys(),
      ...state.virtualSustainedNotes,
      ...state.virtualLatchedNotes,
    ]);
    state.virtualHeldSourcesByNote.clear();
    state.virtualSustainedNotes.clear();
    state.virtualActivePointers.clear();
    state.virtualActiveComputerKeys.clear();
    if (clearLatch) {
      state.virtualLatchedNotes.clear();
    }
    for (const note of notes) {
      emitVirtualMidiNote(note, "note_off");
    }
    renderVirtualKeyboardActiveNotes();
  }

  function clearLatchedVirtualChord() {
    const notes = [...state.virtualLatchedNotes];
    state.virtualLatchedNotes.clear();
    for (const note of notes) {
      if (!state.virtualHeldSourcesByNote.has(note)) {
        emitVirtualMidiNote(note, "note_off");
      }
    }
    renderVirtualKeyboardActiveNotes();
  }

  function renderVirtualKeyboardActiveNotes() {
    elements.virtualKeyboard
      .querySelectorAll("[data-midi-note]")
      .forEach((key) => {
        const note = Number(key.dataset.midiNote);
        key.classList.toggle(
          "is-active",
          state.activeVisualMidiNotes.has(note),
        );
        key.classList.toggle("is-latched", state.virtualLatchedNotes.has(note));
      });
  }

  function renderVirtualKeyboardNoteState(note) {
    const key = elements.virtualKeyboard.querySelector(
      `[data-midi-note="${note}"]`,
    );
    if (!key) {
      return;
    }
    key.classList.toggle("is-active", state.activeVisualMidiNotes.has(note));
    key.classList.toggle("is-latched", state.virtualLatchedNotes.has(note));
  }

  function renderVirtualKeyboard() {
    const base = state.virtualKeyboardBaseNote;
    const noteCount = virtualKeyboardOctaves() * 12;
    const whiteNotes = [];
    const blackNotes = [];

    for (let offset = 0; offset < noteCount; offset += 1) {
      const note = base + offset;
      const noteOffset = note % 12;
      if (BLACK_KEY_OFFSETS.has(noteOffset)) {
        blackNotes.push({ note, offset, whiteIndex: whiteNotes.length - 1 });
      } else {
        whiteNotes.push({ note, offset });
      }
    }

    const whiteMarkup = whiteNotes
      .map(
        ({ note }) => `
          <div
            class="virtual-key white-key"
            role="button"
            tabindex="-1"
            data-midi-note="${note}"
            aria-label="${midiNoteName(note)}"
          ><span>${midiNoteName(note)}</span></div>`,
      )
      .join("");
    const blackMarkup = blackNotes
      .map(
        ({ note, whiteIndex }) => `
          <div
            class="virtual-key black-key"
            role="button"
            tabindex="-1"
            data-midi-note="${note}"
            aria-label="${midiNoteName(note)}"
            style="--key-left: ${((whiteIndex + 1) / whiteNotes.length) * 100}%"
          ><span>${midiNoteName(note)}</span></div>`,
      )
      .join("");

    elements.virtualKeyboard.style.setProperty(
      "--white-key-count",
      whiteNotes.length,
    );
    elements.virtualKeyboard.innerHTML = `
      <div class="white-key-row">${whiteMarkup}</div>
      <div class="black-key-row" aria-hidden="false">${blackMarkup}</div>
    `;
    elements.virtualOctaveLabel.textContent = virtualKeyboardRangeLabel();
    renderVirtualKeyboardActiveNotes();
  }

  function setVirtualKeyboardBaseNote(nextBaseNote) {
    allVirtualNotesOff();
    state.virtualKeyboardBaseNote = Math.max(
      VIRTUAL_KEYBOARD_MIN_BASE_NOTE,
      Math.min(VIRTUAL_KEYBOARD_MAX_BASE_NOTE, nextBaseNote),
    );
    renderVirtualKeyboard();
  }

  function virtualNoteFromComputerKey(code) {
    const offset = COMPUTER_KEYBOARD_OFFSETS.get(code);
    return offset == null ? null : state.virtualKeyboardBaseNote + offset;
  }

  async function populateMidiSelectors() {
    populatePlaybackChoices();
    const inputs = state.midiAccess
      ? [...state.midiAccess.inputs.values()]
      : [];
    const previousInputId = elements.midiInputSelect.value;
    const currentInputId = isVirtualMidiInputId(previousInputId)
      ? previousInputId
      : state.activeInputId || previousInputId;
    const preferredInputId = state.sessionConfiguration?.midi_input_id || null;
    const physicalInputIds = new Set(inputs.map((input) => input.id));
    const currentInputAvailable =
      isVirtualMidiInputId(currentInputId) ||
      physicalInputIds.has(currentInputId);
    const preferredInputAvailable =
      isVirtualMidiInputId(preferredInputId) ||
      physicalInputIds.has(preferredInputId);

    elements.midiInputSelect.disabled = false;
    elements.midiInputSelect.innerHTML = [
      `<option value="">Choose input source</option>`,
      `<option value="${VIRTUAL_MIDI_INPUT_ID}">${VIRTUAL_MIDI_INPUT_NAME}</option>`,
      ...inputs.map(
        (input) =>
          `<option value="${input.id}">${input.name || input.id}</option>`,
      ),
    ].join("");

    const inputId = currentInputAvailable
      ? currentInputId
      : preferredInputAvailable
        ? preferredInputId
        : inputs.length
          ? inputs[0].id
          : "";
    await attachInput(inputId, { savePreference: false });
  }

  function detachCurrentInput() {
    if (!state.activeInputId) {
      return;
    }
    if (isVirtualMidiInputSelected()) {
      allVirtualNotesOff();
    } else if (state.midiAccess) {
      const current = state.midiAccess.inputs.get(state.activeInputId);
      if (current) {
        current.onmidimessage = null;
        void current.close().catch(() => {});
      }
    }
    stopLiveMonitorPlayback();
    state.activeInputId = null;
    syncVirtualKeyboardVisibility();
    renderPerformanceState();
  }

  async function attachInput(inputId, { savePreference = false } = {}) {
    detachCurrentInput();

    if (isVirtualMidiInputId(inputId)) {
      state.activeInputId = VIRTUAL_MIDI_INPUT_ID;
      elements.midiInputSelect.value = VIRTUAL_MIDI_INPUT_ID;
      setSelectedInputName(VIRTUAL_MIDI_INPUT_NAME);
      setMidiStatus("Using virtual input");
      setPhraseStatus("Listening");
      syncVirtualKeyboardVisibility();
      renderPerformanceState();
      if (savePreference) {
        await saveSessionPreferences({
          midi_input_id: VIRTUAL_MIDI_INPUT_ID,
          midi_input_name: VIRTUAL_MIDI_INPUT_NAME,
        });
      }
      return;
    }

    if (!state.midiAccess || !inputId) {
      state.activeInputId = null;
      elements.midiInputSelect.value = "";
      setSelectedInputName("No MIDI input selected");
      syncVirtualKeyboardVisibility();
      renderPerformanceState();
      return;
    }

    const input = state.midiAccess.inputs.get(inputId);
    if (!input) {
      setSelectedInputName("Selected input is unavailable");
      syncVirtualKeyboardVisibility();
      renderPerformanceState();
      return;
    }

    await input.open();
    input.onmidimessage = (messageEvent) => {
      handleUnifiedMidiMessage(messageEvent, input.name || input.id, {
        monitor: shouldMonitorSelectedMidiInput(),
      });
    };

    state.activeInputId = inputId;
    elements.midiInputSelect.value = inputId;
    setSelectedInputName(input.name || input.id);
    setMidiStatus(`Listening on ${input.name || input.id}`);
    syncVirtualKeyboardVisibility();
    renderPerformanceState();
    if (savePreference) {
      await saveSessionPreferences({
        midi_input_id: input.id,
        midi_input_name: input.name || input.id,
      });
    }
  }

  async function connectMidi() {
    if (!navigator.requestMIDIAccess) {
      throw new Error("This browser does not support the Web MIDI API.");
    }

    state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    state.midiAccess.onstatechange = async () => {
      try {
        await populateMidiSelectors();
        const restoredPreferences = {
          ...(selectedPlaybackRestoresPendingPreference()
            ? currentPlaybackPreference()
            : {}),
          ...(selectedMidiCopyRestoresPendingPreference()
            ? currentMidiCopyOutputPreference()
            : {}),
        };
        if (Object.keys(restoredPreferences).length) {
          await saveSessionPreferences(restoredPreferences);
        }
      } catch (error) {
        setPhraseMessage(error.message, true);
      }
    };
    await populateMidiSelectors();
    const restoredPreferences = {
      ...(selectedPlaybackRestoresPendingPreference()
        ? currentPlaybackPreference()
        : {}),
      ...(selectedMidiCopyRestoresPendingPreference()
        ? currentMidiCopyOutputPreference()
        : {}),
    };
    if (Object.keys(restoredPreferences).length) {
      await saveSessionPreferences(restoredPreferences);
    }
    if (!state.activeInputId) {
      setMidiStatus("Connected / choose input");
    }
    setPhraseStatus("Listening");
  }

  function updateSelectedOutput() {
    stopLiveMonitorPlayback();
    populateMidiCopyOutputChoices();
    syncFaustRendererPanel();
    renderPerformanceState();
  }

  return {
    midiNoteName,
    isVirtualMidiInputId,
    isVirtualMidiInputSelected,
    syncVirtualKeyboardVisibility,
    syncPhoneLayout,
    initializePhoneInput,
    getVirtualVelocity,
    stopLiveMonitorPlayback,
    pressVirtualNote,
    releaseVirtualNote,
    toggleLatchedVirtualNote,
    releaseSustainedVirtualNotes,
    allVirtualNotesOff,
    clearLatchedVirtualChord,
    renderVirtualKeyboard,
    setVirtualKeyboardBaseNote,
    virtualNoteFromComputerKey,
    populateMidiSelectors,
    attachInput,
    connectMidi,
    updateSelectedOutput,
  };
}
