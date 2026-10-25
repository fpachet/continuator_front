import { state, elements } from "./app-state.js";
import { createBackupStatus } from "./backup-status.js";
import {
  createApiFetch,
  isEmbeddedView as isCrossOriginSubframe,
} from "./auth-transport.js";

const backupStatus = createBackupStatus(elements.cloudSaveStatus);
const fetchApi = createApiFetch(isCrossOriginSubframe);
import {
  DEFAULT_PLAYBACK_CHOICE,
  FAUST_CLAVIER_ID,
  FAUST_CUSTOM_ID,
  WEB_MIDI_RENDERER_ID,
  PHRASE_TIMEOUT_MS,
  INFINITE_MIN_LOOKAHEAD_MS,
  INFINITE_MAX_LOOKAHEAD_MS,
  ROLL_NOTE_AUDITION_MIN_SECONDS,
  ROLL_NOTE_AUDITION_MAX_SECONDS,
  STATUS_INDICATOR_INTERVAL_MS,
  PHRASE_GAP_VISIBILITY_DELAY_MS,
  FAUST_CLAVIER_DSP_URL,
  FAUST_CUSTOM_TEMPLATE_DSP_URL,
  PHRASE_TIMEOUT_STORAGE_KEY,
  MIDI_INPUT_MONITOR_STORAGE_KEY,
  STOP_MEMORY_ON_USER_PLAY_STORAGE_KEY,
  MIDI_EXPORT_FILE_DB_NAME,
  MIDI_EXPORT_FILE_STORE_NAME,
  MIDI_EXPORT_FILE_HANDLE_KEY,
  FAUST_CUSTOM_SOURCE_STORAGE_KEY,
  FAUST_CUSTOM_VALUES_STORAGE_KEY,
  PLAYBACK_PREFERENCE_STORAGE_PREFIX,
  MIDI_COPY_OUTPUT_PREFERENCE_STORAGE_PREFIX,
  AUDIO_OUTPUT_PREFERENCE_STORAGE_PREFIX,
  GRAPH_MODES,
  FAUST_UI_CONTROL_TYPES,
  FAUST_POLY_RESERVED_SUFFIXES,
} from "./constants.js";
import { PhraseRecorder, roundNumber, eventsToNotes } from "./midi-capture.js";
import {
  createTriangleVoice,
  createElectricVoice,
  BrowserAudioRenderer,
  walkFaustUi,
  FaustPolyRenderer,
} from "./playback-renderers.js";
import { drawPianoRoll } from "./piano-roll.js";
import { createViews } from "./views.js";
import { createSessionController } from "./session-controller.js";
import { createPlaybackController } from "./playback-controller.js";
import { createMidiInput } from "./midi-input.js";

import {
  MidiJsSampleRenderer,
  SAMPLE_INSTRUMENTS,
} from "./sample-renderer.js?v=20260504-sample-timeout";

function safeLocalStorageGet(key) {
  try {
    return window.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key, value) {
  try {
    if (!window.localStorage) {
      return;
    }
    if (value == null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore private-browsing or storage-denied failures.
  }
}

function filePickerBlockedByFrame(error) {
  return /cross.?origin|sub.?frames?|file picker/i.test(error?.message || "");
}

function midiExportZipSaveSupported() {
  return (
    typeof window.showSaveFilePicker === "function" && !isCrossOriginSubframe()
  );
}

function midiExportZipRememberSupported() {
  return (
    midiExportZipSaveSupported() && typeof window.indexedDB !== "undefined"
  );
}

function openMidiExportFileDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("This browser cannot remember export files."));
      return;
    }
    const request = window.indexedDB.open(MIDI_EXPORT_FILE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(MIDI_EXPORT_FILE_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Could not open export file storage."));
  });
}

async function withMidiExportFileStore(mode, callback) {
  const db = await openMidiExportFileDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(MIDI_EXPORT_FILE_STORE_NAME, mode);
      const store = transaction.objectStore(MIDI_EXPORT_FILE_STORE_NAME);
      const request = callback(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("Export file storage failed."));
    });
  } finally {
    db.close();
  }
}

function readStoredMidiExportFileHandle() {
  return withMidiExportFileStore("readonly", (store) =>
    store.get(MIDI_EXPORT_FILE_HANDLE_KEY),
  );
}

function writeStoredMidiExportFileHandle(handle) {
  return withMidiExportFileStore("readwrite", (store) =>
    store.put(handle, MIDI_EXPORT_FILE_HANDLE_KEY),
  );
}

function clearStoredMidiExportFileHandle() {
  return withMidiExportFileStore("readwrite", (store) =>
    store.delete(MIDI_EXPORT_FILE_HANDLE_KEY),
  );
}

async function initializeMidiExportFilePreference() {
  if (!elements.rememberMidiExportFileToggle) {
    return;
  }
  const supported = midiExportZipRememberSupported();
  elements.rememberMidiExportFileToggle.disabled = !supported;
  if (!supported) {
    elements.rememberMidiExportFileToggle.title =
      "Remembering export files is not available in this browser.";
    return;
  }
  try {
    const handle = await readStoredMidiExportFileHandle();
    if (handle) {
      state.midiExportFileHandle = handle;
      elements.rememberMidiExportFileToggle.checked = true;
    }
  } catch {
    state.midiExportFileHandle = null;
    elements.rememberMidiExportFileToggle.checked = false;
  }
}

function loadStoredInputMonitorPreference() {
  return safeLocalStorageGet(MIDI_INPUT_MONITOR_STORAGE_KEY) === "true";
}

function applyInputMonitorPreference(
  enabled,
  { persist = true, announce = false } = {},
) {
  const nextValue = Boolean(enabled);
  state.inputMonitorEnabled = nextValue;
  elements.inputMonitorToggle.checked = nextValue;
  if (persist) {
    safeLocalStorageSet(
      MIDI_INPUT_MONITOR_STORAGE_KEY,
      nextValue ? "true" : "false",
    );
  }
  if (!nextValue) {
    stopLiveMonitorPlayback();
  }
  renderPerformanceState();
  if (announce) {
    setPhraseMessage(
      nextValue
        ? `Monitoring MIDI input through ${playbackChoiceLabel()}.`
        : "MIDI input monitoring off.",
    );
  }
}

function initializeInputMonitorPreference() {
  applyInputMonitorPreference(loadStoredInputMonitorPreference(), {
    persist: false,
  });
}

function applyStopMemoryOnUserPlayPreference(enabled, { persist = true } = {}) {
  state.stopMemoryOnUserPlay = Boolean(enabled);
  elements.stopMemoryOnUserPlayToggle.checked = state.stopMemoryOnUserPlay;
  if (persist) {
    safeLocalStorageSet(
      STOP_MEMORY_ON_USER_PLAY_STORAGE_KEY,
      String(state.stopMemoryOnUserPlay),
    );
  }
}

function playbackPreferenceStorageKey() {
  const userId = state.authUser?.id || "guest";
  return `${PLAYBACK_PREFERENCE_STORAGE_PREFIX}.${userId}`;
}

function midiCopyOutputPreferenceStorageKey() {
  const userId = state.authUser?.id || "guest";
  return `${MIDI_COPY_OUTPUT_PREFERENCE_STORAGE_PREFIX}.${userId}`;
}

function audioOutputPreferenceStorageKey() {
  const userId = state.authUser?.id || "guest";
  return `${AUDIO_OUTPUT_PREFERENCE_STORAGE_PREFIX}.${userId}`;
}

function parseStoredPlaybackPreference(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    const playbackChoice = String(parsed?.playback_choice || "").trim();
    if (!playbackChoice) {
      return null;
    }
    const playbackName = String(parsed?.playback_choice_name || "").trim();
    return {
      playback_choice: playbackChoice,
      playback_choice_name: playbackName || null,
    };
  } catch {
    return null;
  }
}

function loadStoredPlaybackPreference() {
  return parseStoredPlaybackPreference(
    safeLocalStorageGet(playbackPreferenceStorageKey()),
  );
}

function rememberPlaybackPreference(preference) {
  const playbackChoice = String(preference?.playback_choice || "").trim();
  if (!playbackChoice) {
    return;
  }
  const playbackName = String(preference?.playback_choice_name || "").trim();
  state.userPlaybackPreference = {
    playback_choice: playbackChoice,
    playback_choice_name: playbackName || null,
  };
  safeLocalStorageSet(
    playbackPreferenceStorageKey(),
    JSON.stringify(state.userPlaybackPreference),
  );
}

function parseStoredMidiCopyOutputPreference(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    const outputId = String(parsed?.midi_copy_output_id || "").trim();
    const outputName = String(parsed?.midi_copy_output_name || "").trim();
    if (!outputId) {
      return null;
    }
    return {
      midi_copy_output_id: outputId,
      midi_copy_output_name: outputName || null,
    };
  } catch {
    return null;
  }
}

function loadStoredMidiCopyOutputPreference() {
  return parseStoredMidiCopyOutputPreference(
    safeLocalStorageGet(midiCopyOutputPreferenceStorageKey()),
  );
}

function rememberMidiCopyOutputPreference(preference) {
  const outputId = String(preference?.midi_copy_output_id || "").trim();
  if (!outputId) {
    state.userMidiCopyOutputPreference = null;
    safeLocalStorageSet(midiCopyOutputPreferenceStorageKey(), null);
    return;
  }
  const outputName = String(preference?.midi_copy_output_name || "").trim();
  state.userMidiCopyOutputPreference = {
    midi_copy_output_id: outputId,
    midi_copy_output_name: outputName || null,
  };
  safeLocalStorageSet(
    midiCopyOutputPreferenceStorageKey(),
    JSON.stringify(state.userMidiCopyOutputPreference),
  );
}

function latestSavedPlaybackPreference(items = state.savedSessions) {
  const item =
    items.find((candidate) => {
      const choice = candidate?.configuration?.playback_choice;
      return parsePlaybackChoice(choice).rendererId === WEB_MIDI_RENDERER_ID;
    }) || items.find((candidate) => candidate?.configuration?.playback_choice);
  if (!item) {
    return null;
  }
  return {
    playback_choice: item.configuration.playback_choice,
    playback_choice_name: item.configuration.playback_choice_name || null,
  };
}

function refreshUserPlaybackPreferenceFromSavedSessions(
  items = state.savedSessions,
) {
  const storedPreference = loadStoredPlaybackPreference();
  const savedPreference = latestSavedPlaybackPreference(items);
  const storedRendererId = parsePlaybackChoice(
    storedPreference?.playback_choice,
  ).rendererId;
  const savedRendererId = parsePlaybackChoice(
    savedPreference?.playback_choice,
  ).rendererId;
  if (
    savedPreference &&
    storedRendererId !== WEB_MIDI_RENDERER_ID &&
    savedRendererId === WEB_MIDI_RENDERER_ID
  ) {
    rememberPlaybackPreference(savedPreference);
    return;
  }
  if (storedPreference) {
    state.userPlaybackPreference = storedPreference;
    return;
  }
  if (savedPreference) {
    rememberPlaybackPreference(savedPreference);
  }
}

function parseStoredAudioOutputPreference(value) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    const deviceId = String(parsed?.device_id || "").trim();
    const deviceName = String(parsed?.device_name || "").trim();
    if (!deviceId) {
      return null;
    }
    return {
      device_id: deviceId,
      device_name: deviceName || null,
    };
  } catch {
    return null;
  }
}

function loadStoredAudioOutputPreference() {
  return parseStoredAudioOutputPreference(
    safeLocalStorageGet(audioOutputPreferenceStorageKey()),
  );
}

function rememberAudioOutputPreference(preference) {
  const deviceId = String(preference?.device_id || "").trim();
  if (!deviceId) {
    return;
  }
  const deviceName = String(preference?.device_name || "").trim();
  state.userAudioOutputPreference = {
    device_id: deviceId,
    device_name: deviceName || null,
  };
  safeLocalStorageSet(
    audioOutputPreferenceStorageKey(),
    JSON.stringify(state.userAudioOutputPreference),
  );
}

function preferredAudioOutputDeviceId() {
  return state.userAudioOutputPreference?.device_id || "default";
}

function audioOutputIsSupported() {
  return (
    Boolean(navigator.mediaDevices?.enumerateDevices) &&
    typeof window.AudioContext?.prototype?.setSinkId === "function"
  );
}

async function applyAudioOutputToContext(context) {
  if (!context || typeof context.setSinkId !== "function") {
    return false;
  }
  const deviceId = preferredAudioOutputDeviceId();
  if (!deviceId || deviceId === "default") {
    return false;
  }
  await context.setSinkId(deviceId);
  return true;
}

async function applyPreferredAudioOutput() {
  const renderers = [
    ...localPlaybackRenderers,
    faustClavierRenderer,
    customFaustRenderer,
  ];
  await Promise.all(
    renderers.map((renderer) =>
      renderer.applyAudioOutputPreference?.().catch((error) => {
        setPhraseMessage(error.message, true);
      }),
    ),
  );
}

function populateAudioOutputChoices() {
  const supported = audioOutputIsSupported();
  const preferredDeviceId = preferredAudioOutputDeviceId();
  const devices = state.audioOutputDevices || [];
  const choices = [
    { deviceId: "default", label: "System default" },
    ...devices
      .filter((device) => device.deviceId && device.deviceId !== "default")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Sound output ${index + 1}`,
      })),
  ];
  const availableDeviceIds = new Set(choices.map((choice) => choice.deviceId));

  elements.audioOutputSelect.disabled = !supported;
  elements.audioOutputSelect.replaceChildren(
    ...choices.map((choice) => {
      const option = document.createElement("option");
      option.value = choice.deviceId;
      option.textContent = choice.label;
      return option;
    }),
  );
  elements.audioOutputSelect.value = availableDeviceIds.has(preferredDeviceId)
    ? preferredDeviceId
    : "default";
  if (!supported) {
    elements.audioOutputSelect.title =
      "This browser does not expose app-level audio output selection.";
  } else {
    elements.audioOutputSelect.title = "";
  }
}

async function refreshAudioOutputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    state.audioOutputDevices = [];
    populateAudioOutputChoices();
    return;
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  state.audioOutputDevices = devices.filter(
    (device) => device.kind === "audiooutput",
  );
  populateAudioOutputChoices();
}

const browserPlaybackRenderers = [
  new BrowserAudioRenderer({
    id: "browser_triangle",
    label: "Browser Triangle",
    masterGain: 0.18,
    createVoice: createTriangleVoice,
    applyAudioOutputToContext,
  }),
  new BrowserAudioRenderer({
    id: "browser_electric",
    label: "Browser Electric",
    masterGain: 0.16,
    createVoice: createElectricVoice,
    applyAudioOutputToContext,
  }),
];

const samplePlaybackRenderers = Object.values(SAMPLE_INSTRUMENTS).map(
  (instrument) =>
    new MidiJsSampleRenderer({
      ...instrument,
      applyAudioOutputToContext,
      onStatusChange: () => renderPerformanceState(),
    }),
);

const faustClavierRenderer = new FaustPolyRenderer({
  applyAudioOutputToContext,
  onStatusChange: () => syncFaustRendererPanel(),
  id: FAUST_CLAVIER_ID,
  label: "Faust Clavier",
  dspUrl: FAUST_CLAVIER_DSP_URL,
  voices: 24,
  controlDefaults: {
    brightness: 0.58,
    hardness: 0.34,
    damping: 0.42,
    release: 0.95,
    body: 0.33,
    stereo: 0.45,
  },
});

const customFaustRenderer = new FaustPolyRenderer({
  applyAudioOutputToContext,
  onStatusChange: () => syncFaustRendererPanel(),
  id: FAUST_CUSTOM_ID,
  label: "Custom Faust",
  getCode: async () => {
    if (state.customFaustSource.trim()) {
      return state.customFaustSource;
    }
    return loadCustomFaustTemplate();
  },
  voices: 24,
  idleDetail:
    "Paste or edit a polyphonic Faust instrument, then compile it locally.",
});

const faustClavierControls = [
  {
    key: "brightness",
    input: elements.faustBrightnessInput,
    output: elements.faustBrightnessValue,
    format: (value) => Number(value).toFixed(2),
  },
  {
    key: "hardness",
    input: elements.faustHardnessInput,
    output: elements.faustHardnessValue,
    format: (value) => Number(value).toFixed(2),
  },
  {
    key: "damping",
    input: elements.faustDampingInput,
    output: elements.faustDampingValue,
    format: (value) => Number(value).toFixed(2),
  },
  {
    key: "release",
    input: elements.faustReleaseInput,
    output: elements.faustReleaseValue,
    format: (value) => `${Number(value).toFixed(2)} s`,
  },
  {
    key: "body",
    input: elements.faustBodyInput,
    output: elements.faustBodyValue,
    format: (value) => Number(value).toFixed(2),
  },
  {
    key: "stereo",
    input: elements.faustStereoInput,
    output: elements.faustStereoValue,
    format: (value) => Number(value).toFixed(2),
  },
];

const localPlaybackRenderers = [
  ...samplePlaybackRenderers,
  ...browserPlaybackRenderers,
  faustClavierRenderer,
  customFaustRenderer,
];

const webMidiRenderer = {
  id: WEB_MIDI_RENDERER_ID,

  async createPlaybackSession(targetId) {
    const output = midiOutputById(targetId);
    if (!output) {
      throw new Error("Selected MIDI output is unavailable.");
    }
    await output.open();
    return {
      output,
      targetId,
      activeOutputNotes: new Set(),
    };
  },

  getDisplayName(targetId) {
    const output = midiOutputById(targetId);
    return output ? output.name || output.id : "Unavailable MIDI output";
  },

  dispatchEvent(playback, event) {
    dispatchMidiEventToOutput(
      playback.output,
      playback.activeOutputNotes,
      event,
    );
  },

  stopPlayback(playback) {
    stopMidiOutputPlayback(playback.output, playback.activeOutputNotes);
  },

  panicPlayback(playback) {
    if (!playback?.output) {
      return false;
    }
    return sendMidiPanicToOutput(playback.output);
  },

  async panicTarget(targetId) {
    const output = midiOutputById(targetId);
    if (!output) {
      return false;
    }
    try {
      await output.open();
    } catch {
      return false;
    }
    return sendMidiPanicToOutput(output);
  },
};

const playbackRendererRegistry = new Map(
  [...localPlaybackRenderers, webMidiRenderer].map((renderer) => [
    renderer.id,
    renderer,
  ]),
);

const recorder = new PhraseRecorder(
  PHRASE_TIMEOUT_MS,
  ({ eventCount, noteCount, notes }) => {
    renderCapturedProgress(eventCount, noteCount, notes);
  },
  async (phrase) => {
    stopCapturedPreviewRender();
    const notes = eventsToNotes(phrase);
    rememberCapturedPhrase(phrase, notes);
    renderCapturedStats(phrase, notes, true);
    setPhraseMessage(
      `Phrase complete: ${phrase.length} events / ${notes.length} notes captured.`,
    );
    if (elements.autoSendToggle.checked) {
      await sendCurrentPhrase({ automatic: true });
    }
  },
  updatePhraseGapCountdown,
);

function setSessionMidiSaveResult(message = "", isError = false) {
  if (!elements.sessionMidiSaveResult) {
    return;
  }
  const normalizedMessage = String(message || "").trim();
  elements.sessionMidiSaveResult.hidden = !normalizedMessage;
  elements.sessionMidiSaveResult.textContent = normalizedMessage;
  elements.sessionMidiSaveResult.classList.toggle("is-error", Boolean(isError));
}

async function ensureFileWritePermission(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") {
    return true;
  }
  return (await handle.requestPermission(options)) === "granted";
}

function fileNameFromContentDisposition(value) {
  const match = String(value || "").match(/filename="([^"]+)"/i);
  return match?.[1] || `continuator-session-${Date.now()}.zip`;
}

async function requestSessionMidiZip() {
  const response = await fetchApi(`/api/sessions/${state.sessionId}/midi.zip`);
  const blob = await response.blob();
  if (!response.ok) {
    let detail = `MIDI export failed (${response.status}).`;
    try {
      const text = await blob.text();
      const payload = JSON.parse(text);
      if (typeof payload?.detail === "string") {
        detail = payload.detail;
      }
    } catch {
      // Keep the default error.
    }
    throw new Error(detail);
  }

  return {
    blob,
    archive_file_name: fileNameFromContentDisposition(
      response.headers.get("Content-Disposition"),
    ),
    file_count: Number(response.headers.get("X-Midi-File-Count") || 0),
    input_file_count: Number(
      response.headers.get("X-Midi-Input-File-Count") || 0,
    ),
    generated_file_count: Number(
      response.headers.get("X-Midi-Generated-File-Count") || 0,
    ),
  };
}

async function chooseMidiExportZipFileHandle(fileName) {
  const rememberFile = elements.rememberMidiExportFileToggle?.checked;
  if (rememberFile && state.midiExportFileHandle) {
    if (await ensureFileWritePermission(state.midiExportFileHandle)) {
      return state.midiExportFileHandle;
    }
  }

  const pickerOptions = {
    id: "continuator-session-midi-zip-export",
    suggestedName: fileName || `continuator-session-${Date.now()}.zip`,
    startIn: "downloads",
    types: [
      {
        description: "ZIP archive",
        accept: {
          "application/zip": [".zip"],
        },
      },
    ],
  };
  let handle = null;
  try {
    handle = await window.showSaveFilePicker(pickerOptions);
  } catch (error) {
    if (error?.name === "TypeError") {
      handle = await window.showSaveFilePicker({
        suggestedName: pickerOptions.suggestedName,
        types: pickerOptions.types,
      });
    } else {
      throw error;
    }
  }
  if (!(await ensureFileWritePermission(handle))) {
    throw new Error("Permission to write that ZIP file was not granted.");
  }

  if (rememberFile && midiExportZipRememberSupported()) {
    state.midiExportFileHandle = handle;
    await writeStoredMidiExportFileHandle(handle);
  }
  return handle;
}

async function writeZipBlobToFileHandle(blob, handle) {
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return handle.name || "selected ZIP file";
}

function downloadZipBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName || `continuator-session-${Date.now()}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return link.download;
}

function stopPhraseGapCountdown() {
  if (state.phraseGapTimerId != null) {
    window.clearTimeout(state.phraseGapTimerId);
    state.phraseGapTimerId = null;
  }
  if (elements.phraseGapMeter.classList.contains("is-server-wait")) {
    return;
  }
  if (!elements.phraseGapMeter.hidden) {
    elements.phraseGapMeter.hidden = true;
  }
  if (elements.phraseGapMeterBar.style.width !== "0%") {
    elements.phraseGapMeterBar.style.width = "0%";
  }
}

function serverWaitLabel(statusLabel) {
  const normalizedLabel = (statusLabel || "").toLowerCase();
  if (normalizedLabel.includes("memory") || normalizedLabel.includes("queue")) {
    return statusLabel;
  }
  return "Waiting for Continuator";
}

function stopServerWaitIndicator() {
  if (state.serverWaitTimerId != null) {
    window.clearTimeout(state.serverWaitTimerId);
    state.serverWaitTimerId = null;
  }
  if (!elements.phraseGapMeter.classList.contains("is-server-wait")) {
    return;
  }
  elements.phraseGapMeter.classList.remove("is-server-wait");
  elements.phraseGapMeter.hidden = true;
  elements.phraseGapMeterBar.style.width = "0%";
}

function startServerWaitIndicator(
  label,
  startedAtMs = window.performance.now(),
) {
  stopPhraseGapCountdown();
  stopServerWaitIndicator();
  elements.phraseGapMeterLabel.textContent = label;
  elements.phraseGapMeterCopy.textContent = "0.0s";
  elements.phraseGapMeterBar.style.width = "38%";
  elements.phraseGapMeter.classList.add("is-server-wait");
  elements.phraseGapMeter.hidden = false;

  const tick = () => {
    const elapsedMs = Math.max(0, window.performance.now() - startedAtMs);
    setTextContentIfChanged(
      elements.phraseGapMeterCopy,
      `${(elapsedMs / 1000).toFixed(1)}s`,
    );
    state.serverWaitTimerId = window.setTimeout(
      tick,
      STATUS_INDICATOR_INTERVAL_MS,
    );
  };

  tick();
}

function updatePhraseGapCountdown(update) {
  if (!update?.active) {
    stopPhraseGapCountdown();
    return;
  }

  const startedAtMs = Number(update.startedAtMs);
  const timeoutMs = Math.max(
    1,
    Number(update.timeoutMs) || state.phraseTimeoutMs,
  );
  if (!Number.isFinite(startedAtMs)) {
    stopPhraseGapCountdown();
    return;
  }

  if (state.phraseGapTimerId != null) {
    window.clearTimeout(state.phraseGapTimerId);
  }

  const tick = () => {
    const elapsedMs = Math.max(0, window.performance.now() - startedAtMs);
    const remainingMs = Math.max(0, timeoutMs - elapsedMs);
    const progress = Math.min(1, elapsedMs / timeoutMs);
    if (elapsedMs >= PHRASE_GAP_VISIBILITY_DELAY_MS || remainingMs <= 0) {
      elements.phraseGapMeter.classList.remove("is-server-wait");
      setTextContentIfChanged(
        elements.phraseGapMeterLabel,
        "Listening for more notes",
      );
      elements.phraseGapMeter.hidden = false;
      elements.phraseGapMeterBar.style.width = `${Math.round(progress * 100)}%`;
      setTextContentIfChanged(
        elements.phraseGapMeterCopy,
        `${(remainingMs / 1000).toFixed(1)}s`,
      );
      setPhraseStatus(remainingMs > 0 ? "Listening" : "Phrase ready");
    }

    if (remainingMs <= 0) {
      state.phraseGapTimerId = null;
      return;
    }
    state.phraseGapTimerId = window.setTimeout(
      tick,
      STATUS_INDICATOR_INTERVAL_MS,
    );
  };

  state.phraseGapTimerId = window.setTimeout(
    tick,
    Math.min(STATUS_INDICATOR_INTERVAL_MS, timeoutMs),
  );
}

function setPhraseMessage(message, danger = false) {
  setTextContentIfChanged(elements.messageBox, message);
  setTextContentIfChanged(elements.phoneMessageBox, message);
  const color = danger ? "var(--danger)" : "var(--muted)";
  if (elements.messageBox.style.color !== color) {
    elements.messageBox.style.color = color;
  }
  if (elements.phoneMessageBox.style.color !== color) {
    elements.phoneMessageBox.style.color = color;
  }
}

function pluralize(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function phraseNoteCount(payloadOrEvents) {
  if (Array.isArray(payloadOrEvents)) {
    if (payloadOrEvents === state.lastCapturedPhrase) {
      return state.lastCapturedNotes.length;
    }
    return eventsToNotes(payloadOrEvents).length;
  }
  return Number(
    payloadOrEvents?.note_count || payloadOrEvents?.notes?.length || 0,
  );
}

function phraseDurationMs(payloadOrEvents) {
  if (Array.isArray(payloadOrEvents)) {
    if (
      payloadOrEvents === state.lastCapturedPhrase &&
      state.lastCaptureDurationMs != null
    ) {
      return state.lastCaptureDurationMs;
    }
    return continuationDurationMs({ events: payloadOrEvents });
  }
  return continuationDurationMs(payloadOrEvents);
}

function formatMilliseconds(ms) {
  if (!Number.isFinite(Number(ms))) {
    return "n/a";
  }
  const value = Math.max(0, Number(ms));
  return value >= 1000
    ? `${(value / 1000).toFixed(1)}s`
    : `${Math.round(value)}ms`;
}

function setReadinessStep(element, active, label = null) {
  if (!element) {
    return;
  }
  element.classList.toggle("is-ready", Boolean(active));
  if (label) {
    element.textContent = label;
  }
}

function rememberCapturedPhrase(events, notes = null) {
  const capturedEvents = Array.isArray(events) ? events : [];
  const capturedNotes = Array.isArray(notes)
    ? notes
    : eventsToNotes(capturedEvents);
  const captureDurationMs = capturedEvents.length
    ? continuationDurationMs({ events: capturedEvents })
    : null;
  state.lastCapturedPhrase = capturedEvents;
  state.lastCapturedNotes = capturedNotes;
  state.lastCapturedAt = Date.now();
  state.lastCaptureDurationMs = captureDurationMs;
  renderPerformanceState();
  updateInfiniteActionState();
}

function rememberGeneratedPhrase(payload) {
  state.lastGeneratedPhrase = payload || null;
  state.lastGeneratedAt = Date.now();
  renderPerformanceState();
  updateInfiniteActionState();
}

function clearRememberedPhrases() {
  state.lastCapturedPhrase = [];
  state.lastCapturedNotes = [];
  state.lastGeneratedPhrase = null;
  state.lastCapturedAt = 0;
  state.lastGeneratedAt = 0;
  state.currentPlaybackPayload = null;
  state.queuedPlaybackPayload = null;
  state.activeMemoryPlaybackIndex = null;
  state.activeRollPlaybackKind = null;
  stopRollAudition({ redraw: false, releaseNote: true });
  state.lastGenerationMs = null;
  state.lastCaptureDurationMs = null;
  renderConstraintStatus(null);
  syncRollPlaybackState();
  renderPerformanceState();
  updateInfiniteActionState();
}

function latestLoopSeedPayload() {
  const generatedPayload = state.lastGeneratedPhrase;
  const generatedEvents = generatedPayload?.events || [];
  if (generatedEvents.length && state.lastGeneratedAt >= state.lastCapturedAt) {
    return generatedPayload;
  }
  if (state.lastCapturedPhrase.length) {
    return {
      events: state.lastCapturedPhrase,
      handoff_viewpoint: null,
    };
  }
  return generatedEvents.length ? generatedPayload : null;
}

function preferredGenerationNoteCount(referenceEvents = null) {
  const requestedNoteCount = normalizedContinuationNoteCount(
    elements.continuationLengthInput.value,
  );
  if (requestedNoteCount != null) {
    return requestedNoteCount;
  }

  if (referenceEvents?.length) {
    if (referenceEvents === state.lastCapturedPhrase) {
      return Math.max(1, state.lastCapturedNotes.length);
    }
    return Math.max(1, eventsToNotes(referenceEvents).length);
  }

  if (state.lastCapturedPhrase.length) {
    return Math.max(1, state.lastCapturedNotes.length);
  }

  if (state.lastGeneratedPhrase?.note_count) {
    return Math.max(1, Number(state.lastGeneratedPhrase.note_count));
  }

  return 12;
}

function renderAccountTrigger() {
  elements.adminLink.hidden = !state.authUser?.is_admin;
  const sessionSelect = elements.accountSessionSelect;
  const selectedId =
    state.accountSelectedSessionId || state.sessionId || sessionSelect.value;
  const options = state.savedSessions.map((session) => {
    const option = document.createElement("option");
    option.value = session.session_id;
    option.textContent = `${session.configuration.display_name || session.session_id.slice(0, 8)} · ${session.phrase_count} phrases`;
    return option;
  });
  if (!options.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No saved sessions yet";
    options.push(empty);
  }
  sessionSelect.replaceChildren(...options);
  if (state.savedSessions.some((session) => session.session_id === selectedId))
    sessionSelect.value = selectedId;
  sessionSelect.disabled = !state.authUser || !state.savedSessions.length;
  elements.accountOpenSessionsButton.disabled =
    !state.authUser || !state.savedSessions.length;
  elements.accountTitle.textContent = state.authUser
    ? "Account and saved sessions"
    : "Sign in and save your session";
  if (state.authUser) {
    const username = state.authUser.username;
    elements.authStatus.dataset.authState = "signed-in";
    elements.authStatus.title = `Signed in as ${username}. Click to manage account or sign out.`;
    elements.authAvatar.textContent = username.slice(0, 1).toUpperCase();
    elements.authStatusLabel.textContent = username;
    elements.authStatusCopy.textContent =
      state.savedSessions.length > 0
        ? `${pluralize(state.savedSessions.length, "saved session")} available`
        : "Manage account and sign out";
    return;
  }

  elements.authStatus.dataset.authState = "guest";
  elements.authStatus.title =
    "Guest mode. Click to sign in or create an account.";
  elements.authAvatar.textContent = "G";
  elements.authStatusLabel.textContent = "Sign in";
  elements.authStatusCopy.textContent = "Save and reopen sessions";
}

function syncSheetOpenClass() {
  document.body.classList.toggle(
    "sheet-open",
    state.readmeOpen || state.accountPanelOpen,
  );
}

function setReadmeOpen(open) {
  state.readmeOpen = open;
  elements.readmePanel.hidden = !open;
  elements.readmeOverlay.hidden = !open;
  elements.openReadmeButton.setAttribute("aria-expanded", String(open));
  syncSheetOpenClass();
  if (open) {
    setGraphOpen(false);
    setAccountPanelOpen(false);
    window.requestAnimationFrame(() => {
      elements.closeReadmeButton?.focus();
    });
  }
}

function clearGraphImage() {
  if (state.graphImageUrl) {
    URL.revokeObjectURL(state.graphImageUrl);
    state.graphImageUrl = null;
  }
  elements.graphImage.removeAttribute("src");
}

function normalizedGraphKind(kind) {
  return kind === "constraints" ? "constraints" : "memory";
}

function normalizedGraphMode(mode) {
  return GRAPH_MODES.has(mode) ? mode : "slice";
}

function normalizedGraphOrder(order) {
  return order === "all" ? "all" : String(normalizedMarkovOrder(order));
}

function graphOrderLimit() {
  return normalizedMarkovOrder(
    state.sessionConfiguration?.markov_order ||
      elements.markovOrderInput?.value ||
      4,
  );
}

function syncGraphOrderOptions() {
  const select = elements.graphOrderSelect;
  if (!select) {
    return;
  }
  const selected = normalizedGraphOrder(state.graphOrder);
  const limit = graphOrderLimit();
  select.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All orders";
  select.append(allOption);
  for (let order = 1; order <= limit; order += 1) {
    const option = document.createElement("option");
    option.value = String(order);
    option.textContent = `Order ${order}`;
    select.append(option);
  }
  const nextValue =
    selected === "all" || Number(selected) <= limit ? selected : "all";
  state.graphOrder = nextValue;
  select.value = nextValue;
}

function graphKindTitle(kind) {
  return normalizedGraphKind(kind) === "constraints"
    ? "Last Constraint Graph"
    : "Memory Graph";
}

function graphKindMeta(kind, phase = "idle") {
  const normalizedKind = normalizedGraphKind(kind);
  if (phase === "loading") {
    return normalizedKind === "constraints"
      ? "Rendering the latest constrained generation trace..."
      : "Rendering the learned memory graph...";
  }
  return normalizedKind === "constraints"
    ? "Snapshot from the most recent constrained generation request."
    : "Snapshot generated from the active session memory.";
}

function graphKindEndpoint(kind) {
  const normalizedKind = normalizedGraphKind(kind);
  const timestamp = Date.now();
  if (normalizedKind === "constraints") {
    return `/api/sessions/${state.sessionId}/graphs/constraints.svg?max_steps=96&ts=${timestamp}`;
  }
  const mode = normalizedGraphMode(state.graphMode);
  const order = normalizedGraphOrder(state.graphOrder);
  const params = new URLSearchParams({
    max_nodes: mode === "all" ? "240" : "96",
    max_edges: mode === "all" ? "600" : "220",
    mode,
    ts: String(timestamp),
  });
  if (order !== "all") {
    params.set("order", order);
  }
  return `/api/sessions/${state.sessionId}/graphs/memory.svg?${params.toString()}`;
}

function setActiveGraphKind(kind) {
  state.activeGraphKind = normalizedGraphKind(kind);
  elements.graphTitle.textContent = graphKindTitle(state.activeGraphKind);
  elements.graphMeta.textContent = graphKindMeta(state.activeGraphKind);
  syncGraphOrderOptions();
  if (elements.graphControls) {
    elements.graphControls.hidden = state.activeGraphKind !== "memory";
  }
  elements.graphKindTabs.forEach((node) => {
    const active =
      normalizedGraphKind(node.dataset.graphKind) === state.activeGraphKind;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
}

function clampGraphPanelPosition(position) {
  const panel = elements.graphPanel;
  const margin = 8;
  const visibleStrip = 120;
  const verticalStrip = 80;
  const panelWidth = panel?.offsetWidth || 780;
  const minX = Math.min(margin, visibleStrip - panelWidth);
  const minY = margin;
  const maxX = Math.max(minX, window.innerWidth - visibleStrip);
  const maxY = Math.max(minY, window.innerHeight - verticalStrip);
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(position.x))),
    y: Math.min(maxY, Math.max(minY, Math.round(position.y))),
  };
}

function defaultGraphPanelPosition() {
  const panel = elements.graphPanel;
  const panelWidth = panel?.offsetWidth || 780;
  return clampGraphPanelPosition({
    x: window.innerWidth - panelWidth - 24,
    y: 84,
  });
}

function applyGraphPanelPosition(position) {
  const nextPosition = clampGraphPanelPosition(position);
  state.graphPanelPosition = nextPosition;
  elements.graphPanel.style.left = `${nextPosition.x}px`;
  elements.graphPanel.style.top = `${nextPosition.y}px`;
}

function ensureGraphPanelPosition() {
  applyGraphPanelPosition(
    state.graphPanelPosition || defaultGraphPanelPosition(),
  );
}

function setGraphOpen(open) {
  state.graphOpen = open;
  elements.graphPanel.hidden = !open;
  elements.graphOverlay.hidden = true;
  elements.showGraphButton.setAttribute("aria-expanded", String(open));
  syncSheetOpenClass();
  if (open) {
    setReadmeOpen(false);
    setAccountPanelOpen(false);
    window.requestAnimationFrame(() => {
      ensureGraphPanelPosition();
    });
    return;
  }
  clearGraphImage();
}

function graphDragHandleIsInteractive(target) {
  return (
    target instanceof Element &&
    Boolean(target.closest("button, a, input, select, textarea"))
  );
}

function startGraphPanelDrag(event) {
  if (event.button !== 0 || graphDragHandleIsInteractive(event.target)) {
    return;
  }
  if (window.matchMedia("(max-width: 640px)").matches) {
    return;
  }
  event.preventDefault();
  ensureGraphPanelPosition();
  const position = state.graphPanelPosition || defaultGraphPanelPosition();
  state.graphDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    panelX: position.x,
    panelY: position.y,
  };
  elements.graphPanel.classList.add("is-dragging");
  elements.graphHead.setPointerCapture?.(event.pointerId);
}

function moveGraphPanelDrag(event) {
  const dragState = state.graphDragState;
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  applyGraphPanelPosition({
    x: dragState.panelX + event.clientX - dragState.startX,
    y: dragState.panelY + event.clientY - dragState.startY,
  });
}

function stopGraphPanelDrag(event) {
  const dragState = state.graphDragState;
  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }
  state.graphDragState = null;
  elements.graphPanel.classList.remove("is-dragging");
  elements.graphHead.releasePointerCapture?.(event.pointerId);
}

function setAccountPanelOpen(open) {
  state.accountPanelOpen = open;
  elements.accountPanel.hidden = !open;
  if (open && !elements.accountPanel.open) {
    elements.accountPanel.showModal();
  } else if (!open && elements.accountPanel.open) {
    elements.accountPanel.close();
  }
  elements.authStatus.setAttribute("aria-expanded", String(open));
  elements.authStatus.classList.toggle("is-open", open);
  syncSheetOpenClass();
  if (open) {
    syncAuthUI();
    scheduleVisibleSessionRefresh();
    const focusTarget = state.authUser
      ? elements.accountOpenSessionsButton
      : elements.authUsernameInput;
    window.requestAnimationFrame(() => {
      focusTarget?.focus();
    });
  }
}

function normalizedKeepLastInputs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 20;
  }
  return Math.min(500, Math.max(1, Math.round(parsed)));
}

function normalizedMarkovOrder(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 4;
  }
  return Math.min(16, Math.max(1, Math.round(parsed)));
}

function normalizedContinuationNoteCount(value) {
  if (value == null || value === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(1, Math.round(parsed));
}

function normalizedPhraseTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return PHRASE_TIMEOUT_MS;
  }
  const clampedSeconds = Math.min(5, Math.max(0.2, parsed));
  const roundedSeconds = Math.round(clampedSeconds * 10) / 10;
  return Math.round(roundedSeconds * 1000);
}

function clampedPhraseTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return PHRASE_TIMEOUT_MS;
  }
  return Math.min(5000, Math.max(200, Math.round(parsed / 100) * 100));
}

function formatPhraseTimeoutSeconds(timeoutMs) {
  const seconds = (clampedPhraseTimeoutMs(timeoutMs) / 1000).toFixed(1);
  return seconds.endsWith(".0") ? seconds.slice(0, -2) : seconds;
}

function applyPhraseTimeoutSetting(
  value,
  { persist = true, announce = false } = {},
) {
  const timeoutMs = normalizedPhraseTimeoutMs(value);
  state.phraseTimeoutMs = timeoutMs;
  elements.phraseTimeoutInput.value = formatPhraseTimeoutSeconds(timeoutMs);
  recorder.setTimeoutMs(timeoutMs);
  if (persist) {
    safeLocalStorageSet(PHRASE_TIMEOUT_STORAGE_KEY, String(timeoutMs / 1000));
  }
  if (announce) {
    setPhraseMessage(
      `Phrase gap set to ${formatPhraseTimeoutSeconds(timeoutMs)}s.`,
    );
  }
}

function initializePhraseTimeoutSetting() {
  const storedValue = safeLocalStorageGet(PHRASE_TIMEOUT_STORAGE_KEY);
  applyPhraseTimeoutSetting(storedValue ?? String(PHRASE_TIMEOUT_MS / 1000), {
    persist: false,
  });
}

function hasMidiFileExtension(name) {
  return /\.(mid|midi)$/i.test(String(name || ""));
}

function validateAuthCredentials() {
  const username = elements.authUsernameInput.value.trim();
  const password = elements.authPasswordInput.value;

  if (!username || !password) {
    throw new Error("Enter both a username and password.");
  }
  if (username.length < 2 || username.length > 32) {
    throw new Error("Username must be between 2 and 32 characters.");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(username)) {
    throw new Error(
      "Username can only use letters, digits, underscores, dots, or dashes.",
    );
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  return { username, password };
}

function hasLoopSeedPhrase() {
  return Boolean(
    state.lastCapturedPhrase.length ||
    state.lastGeneratedPhrase?.events?.length,
  );
}

function describeLoopSeed() {
  if (state.activePlayback && state.lastGeneratedPhrase?.events?.length) {
    return `Seed: playing ${pluralize(state.lastGeneratedPhrase.note_count || 0, "generated note")}`;
  }
  if (
    state.lastGeneratedPhrase?.events?.length &&
    state.lastGeneratedAt >= state.lastCapturedAt
  ) {
    return `Seed: last continuation (${pluralize(state.lastGeneratedPhrase.note_count || 0, "note")})`;
  }
  if (state.lastCapturedPhrase.length) {
    return `Seed: captured phrase (${pluralize(state.lastCapturedNotes.length, "note")})`;
  }
  return "Seed: play or preview a phrase";
}

function describeInfiniteState(loopBusy) {
  if (state.infiniteRequestInFlight) {
    return state.activePlayback ? "Queueing next" : "Generating";
  }
  if (state.infiniteScheduleTimerId != null) {
    return "Next phrase armed";
  }
  if (state.infiniteModeEnabled) {
    return "Playing";
  }
  if (state.activePlayback) {
    return "Playback";
  }
  return "Idle";
}

function clearInfiniteScheduler() {
  if (state.infiniteScheduleTimerId) {
    window.clearTimeout(state.infiniteScheduleTimerId);
    state.infiniteScheduleTimerId = null;
  }
}

function updateInfiniteActionState() {
  const loopBusy =
    state.infiniteModeEnabled ||
    state.infiniteRequestInFlight ||
    state.infiniteScheduleTimerId != null;
  elements.startInfiniteButton.disabled = loopBusy || !hasLoopSeedPhrase();
  elements.stopInfiniteButton.disabled = !(loopBusy || state.activePlayback);
  elements.infiniteStateLabel.textContent = describeInfiniteState(loopBusy);
  elements.infiniteSeedLabel.textContent = describeLoopSeed();
}

function continuationDurationMs(payload) {
  if (payload?.duration_seconds != null) {
    return Math.max(0, Math.round(Number(payload.duration_seconds) * 1000));
  }

  if (!payload?.events?.length) {
    return 0;
  }

  return payload.events.reduce(
    (total, event) => total + Number(event.delta_seconds || 0) * 1000,
    0,
  );
}

function continuationHandoffMs(payload) {
  if (payload?.handoff_seconds != null) {
    return Math.max(0, Math.round(Number(payload.handoff_seconds) * 1000));
  }
  return continuationDurationMs(payload);
}

function infiniteLookaheadMs(payload) {
  const durationMs = continuationHandoffMs(payload);
  return Math.min(
    INFINITE_MAX_LOOKAHEAD_MS,
    Math.max(INFINITE_MIN_LOOKAHEAD_MS, Math.round(durationMs * 0.4)),
  );
}

function clearPhraseBuffers() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  stopPhraseGapCountdown();
  stopCapturedPreviewRender();
  stopPlaybackVisualization({ redraw: false });
  clearRememberedPhrases();
  state.previewedHistoryIndex = null;
  state.previewedMemoryIndex = null;
  recorder.reset();
  renderCapturedStats([], [], false);
  renderGeneratedStats(null);
  syncPreviewSelection();
  setPhraseStatus("Waiting for MIDI");
}

function clearCurrentSessionState(message = null) {
  state.sessionId = null;
  state.sessionIsOwned = false;
  state.sessionConfiguration = null;
  state.historyItems = [];
  state.memoryItems = [];
  setSessionMidiSaveResult();
  elements.sessionId.textContent = "Open or create a session";
  setGraphOpen(false);
  clearPhraseBuffers();
  renderHistory([]);
  renderMemory(null);
  setSessionStatus("No session");
  renderSessionSettingsSummary();
  updateSessionActionState();
  if (message) {
    setPhraseMessage(message);
  }
}

function selectPlaybackPreference(configuration) {
  const preferredChoiceValue = resolveAvailablePlaybackPreference(
    configuration,
    state.midiAccess ? [...state.midiAccess.outputs.values()] : [],
  );
  if (!preferredChoiceValue) {
    return false;
  }

  const options = new Set(
    [...elements.midiOutputSelect.options].map((option) => option.value),
  );
  if (!options.has(preferredChoiceValue)) {
    return false;
  }

  elements.midiOutputSelect.value = preferredChoiceValue;
  updateSelectedOutput();
  rememberPlaybackPreference({
    playback_choice: preferredChoiceValue,
    playback_choice_name:
      configuration?.playback_choice_name ||
      playbackChoiceLabel(preferredChoiceValue),
  });
  return true;
}

function pendingPlaybackPreference() {
  const sessionPreference = state.sessionConfiguration?.playback_choice
    ? {
        playback_choice: state.sessionConfiguration.playback_choice,
        playback_choice_name:
          state.sessionConfiguration.playback_choice_name || null,
      }
    : null;
  const userRendererId = parsePlaybackChoice(
    state.userPlaybackPreference?.playback_choice,
  ).rendererId;
  const sessionRendererId = parsePlaybackChoice(
    sessionPreference?.playback_choice,
  ).rendererId;
  if (
    state.userPlaybackPreference &&
    userRendererId === WEB_MIDI_RENDERER_ID &&
    sessionRendererId !== WEB_MIDI_RENDERER_ID
  ) {
    return state.userPlaybackPreference;
  }
  return state.sessionConfiguration?.playback_choice
    ? sessionPreference
    : state.userPlaybackPreference;
}

function pendingMidiCopyOutputPreference() {
  return state.sessionConfiguration?.midi_copy_output_id
    ? {
        midi_copy_output_id: state.sessionConfiguration.midi_copy_output_id,
        midi_copy_output_name:
          state.sessionConfiguration.midi_copy_output_name || null,
      }
    : state.userMidiCopyOutputPreference;
}

function selectedPlaybackRestoresPendingPreference() {
  const preference = pendingPlaybackPreference();
  if (!preference?.playback_choice) {
    return false;
  }
  const selectedChoiceValue = selectedPlaybackChoiceValue();
  if (selectedChoiceValue === preference.playback_choice) {
    return true;
  }
  const selectedChoice = parsePlaybackChoice(selectedChoiceValue);
  const preferredChoice = parsePlaybackChoice(preference.playback_choice);
  return (
    selectedChoice.rendererId === WEB_MIDI_RENDERER_ID &&
    preferredChoice.rendererId === WEB_MIDI_RENDERER_ID &&
    normalizedDeviceName(playbackChoiceLabel(selectedChoiceValue)) ===
      normalizedDeviceName(preference.playback_choice_name)
  );
}

function selectedMidiCopyRestoresPendingPreference() {
  const preference = pendingMidiCopyOutputPreference();
  const selectedOutput = selectedMidiCopyOutput();
  if (!preference?.midi_copy_output_id || !selectedOutput) {
    return false;
  }
  if (selectedOutput.id === preference.midi_copy_output_id) {
    return true;
  }
  return (
    normalizedDeviceName(selectedOutput.name || selectedOutput.id) ===
    normalizedDeviceName(preference.midi_copy_output_name)
  );
}

function normalizedDeviceName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function resolveAvailablePlaybackPreference(preference, outputs = []) {
  const preferredChoiceValue = preference?.playback_choice || null;
  if (!preferredChoiceValue) {
    return null;
  }

  const availableChoices = new Set([
    ...localPlaybackRenderers.map((renderer) =>
      encodePlaybackChoice(renderer.id),
    ),
    ...outputs.map((output) =>
      encodePlaybackChoice(WEB_MIDI_RENDERER_ID, output.id),
    ),
  ]);
  if (availableChoices.has(preferredChoiceValue)) {
    return preferredChoiceValue;
  }

  const { rendererId } = parsePlaybackChoice(preferredChoiceValue);
  if (rendererId !== WEB_MIDI_RENDERER_ID) {
    return null;
  }

  const preferredName = normalizedDeviceName(preference.playback_choice_name);
  if (!preferredName) {
    return null;
  }
  const matchedOutput = outputs.find((output) => {
    const outputName = normalizedDeviceName(output.name || output.id);
    return outputName === preferredName;
  });
  return matchedOutput
    ? encodePlaybackChoice(WEB_MIDI_RENDERER_ID, matchedOutput.id)
    : null;
}

function resolveAvailableMidiCopyOutputId(preference, outputs = []) {
  const primaryOutputId = selectedPrimaryMidiOutputId();
  const eligibleOutputs = outputs.filter(
    (output) => output.id !== primaryOutputId,
  );
  const preferredOutputId = preference?.midi_copy_output_id || null;
  if (!preferredOutputId) {
    return null;
  }

  const matchedById = eligibleOutputs.find(
    (output) => output.id === preferredOutputId,
  );
  if (matchedById) {
    return matchedById.id;
  }

  const preferredName = normalizedDeviceName(preference?.midi_copy_output_name);
  if (!preferredName) {
    return null;
  }
  const matchedByName = eligibleOutputs.find(
    (output) =>
      normalizedDeviceName(output.name || output.id) === preferredName,
  );
  return matchedByName?.id || null;
}

function selectMidiCopyOutputPreference(preference) {
  const selectedOutputId = populateMidiCopyOutputChoices(preference);
  if (!selectedOutputId) {
    return false;
  }
  const output = midiOutputById(selectedOutputId);
  rememberMidiCopyOutputPreference({
    midi_copy_output_id: selectedOutputId,
    midi_copy_output_name:
      preference?.midi_copy_output_name || output?.name || selectedOutputId,
  });
  return true;
}

async function updateSessionGraphImage(
  kind = state.activeGraphKind,
  {
    openPanel = true,
    announce = true,
    closeOnError = true,
    preserveScroll = false,
  } = {},
) {
  if (!state.sessionId) {
    if (announce) {
      setPhraseMessage("Create a session before showing its graph.", true);
    }
    return;
  }

  const graphKind = normalizedGraphKind(kind);
  const previousScrollLeft = preserveScroll
    ? elements.graphImageFrame?.scrollLeft || 0
    : 0;
  const previousScrollTop = preserveScroll
    ? elements.graphImageFrame?.scrollTop || 0
    : 0;
  state.graphLoading = true;
  updateSessionActionState();
  setActiveGraphKind(graphKind);
  elements.graphMeta.textContent = graphKindMeta(graphKind, "loading");
  if (openPanel || !preserveScroll) {
    clearGraphImage();
  }
  if (openPanel) {
    setGraphOpen(true);
  }

  try {
    const response = await fetchApi(graphKindEndpoint(graphKind), {
      headers: { Accept: "image/svg+xml" },
    });
    const rawText = await response.text();
    if (!response.ok) {
      let detail = rawText || `Graph request failed (${response.status}).`;
      try {
        const payload = JSON.parse(rawText);
        if (typeof payload?.detail === "string") {
          detail = payload.detail;
        }
      } catch {
        // Keep the raw response text.
      }
      throw new Error(detail);
    }

    const nextImageUrl = URL.createObjectURL(
      new Blob([rawText], { type: "image/svg+xml" }),
    );
    const previousImageUrl = state.graphImageUrl;
    state.graphImageUrl = nextImageUrl;
    elements.graphImage.src = nextImageUrl;
    if (previousImageUrl) {
      URL.revokeObjectURL(previousImageUrl);
    }
    elements.graphMeta.textContent = graphKindMeta(graphKind);
    if (preserveScroll && elements.graphImageFrame) {
      window.requestAnimationFrame(() => {
        elements.graphImageFrame.scrollLeft = previousScrollLeft;
        elements.graphImageFrame.scrollTop = previousScrollTop;
      });
    }
    if (announce) {
      setPhraseMessage(
        `Rendered the ${graphKindTitle(graphKind).toLowerCase()}.`,
      );
    }
  } catch (error) {
    if (closeOnError) {
      setGraphOpen(false);
    }
    if (announce) {
      setPhraseMessage(error.message, true);
    }
  } finally {
    state.graphLoading = false;
    updateSessionActionState();
  }
}

async function showSessionGraph(kind = state.activeGraphKind) {
  await updateSessionGraphImage(kind);
}

function createTestNotePayload() {
  return {
    event_count: 2,
    note_count: 1,
    duration_seconds: 0.7,
    events: [
      {
        type: "note_on",
        note: 60,
        velocity: 92,
        channel: 0,
        delta_seconds: 0,
      },
      {
        type: "note_off",
        note: 60,
        velocity: 0,
        channel: 0,
        delta_seconds: 0.7,
      },
    ],
    notes: [
      {
        pitch: 60,
        velocity: 92,
        start_seconds: 0,
        duration_seconds: 0.7,
        end_seconds: 0.7,
      },
    ],
  };
}

function createNoteAuditionPayload(note) {
  const pitch = Math.min(
    127,
    Math.max(0, Math.round(Number(note?.pitch) || 60)),
  );
  const channel = Math.min(
    15,
    Math.max(0, Math.round(Number(note?.channel) || 0)),
  );
  const velocity = Math.min(
    127,
    Math.max(1, Math.round(Number(note?.velocity) || 92)),
  );
  const durationSeconds = Math.min(
    ROLL_NOTE_AUDITION_MAX_SECONDS,
    Math.max(
      ROLL_NOTE_AUDITION_MIN_SECONDS,
      Number(note?.duration_seconds) || 0.7,
    ),
  );
  const duration = roundNumber(durationSeconds);

  return {
    event_count: 2,
    note_count: 1,
    duration_seconds: duration,
    events: [
      {
        type: "note_on",
        note: pitch,
        velocity,
        channel,
        delta_seconds: 0,
      },
      {
        type: "note_off",
        note: pitch,
        velocity: 0,
        channel,
        delta_seconds: duration,
      },
    ],
    notes: [
      {
        pitch,
        channel,
        velocity,
        start_seconds: 0,
        duration_seconds: duration,
        end_seconds: duration,
      },
    ],
  };
}

async function playTestNote() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  const payload = createTestNotePayload();
  renderGeneratedStats(payload);
  await playPayload(payload);
  setPhraseMessage(`Testing ${playbackChoiceLabel()}.`);
}

function releaseRollAuditionNote(audition) {
  if (!audition || audition.released || !audition.noteOffEvent) {
    return;
  }
  dispatchPlaybackEvent(audition, audition.noteOffEvent);
  audition.released = true;
}

function clearRollAuditionTimers(audition) {
  audition?.timerIds?.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  audition?.timerIds?.clear();
  if (audition?.animationFrameId != null) {
    window.cancelAnimationFrame(audition.animationFrameId);
    audition.animationFrameId = null;
  }
}

function stopRollAudition({ redraw = true, releaseNote = true } = {}) {
  const audition = state.activeRollAudition;
  if (!audition) {
    return false;
  }
  clearRollAuditionTimers(audition);
  if (releaseNote) {
    releaseRollAuditionNote(audition);
  }
  state.activeRollAudition = null;
  if (redraw) {
    renderRollCanvas(audition.kind);
  }
  return true;
}

function scheduleRollAuditionTimeout(audition, callback, delayMs) {
  const timerId = window.setTimeout(
    () => {
      audition.timerIds.delete(timerId);
      callback();
    },
    Math.max(0, delayMs),
  );
  audition.timerIds.add(timerId);
  return timerId;
}

function startRollAuditionAnimation(audition, durationMs) {
  const startedAtMs = window.performance.now();
  const safeDurationMs = Math.max(1, durationMs);

  const tick = () => {
    if (state.activeRollAudition !== audition) {
      return;
    }
    const elapsedMs = Math.max(0, window.performance.now() - startedAtMs);
    const progressRatio = Math.min(1, elapsedMs / safeDurationMs);
    audition.progressRatio = progressRatio;
    renderRollCanvas(audition.kind, {
      highlightedNoteIndex: audition.noteIndex,
      noteProgressRatio: progressRatio,
    });
    if (progressRatio >= 1) {
      audition.animationFrameId = null;
      return;
    }
    audition.animationFrameId = window.requestAnimationFrame(tick);
  };

  tick();
}

async function auditionRollNote(kind, noteHit) {
  stopRollAudition({ redraw: true, releaseNote: true });
  const payload = createNoteAuditionPayload(noteHit.note);
  const durationMs = Math.max(1, payload.duration_seconds * 1000);
  const playback = await createPlaybackSession();
  const audition = {
    ...playback,
    kind,
    noteIndex: noteHit.index,
    noteOffEvent: payload.events[1],
    released: false,
    animationFrameId: null,
    progressRatio: 0,
  };
  state.activeRollAudition = audition;
  dispatchPlaybackEvent(audition, payload.events[0]);
  startRollAuditionAnimation(audition, durationMs);
  scheduleRollAuditionTimeout(
    audition,
    () => {
      if (state.activeRollAudition === audition) {
        releaseRollAuditionNote(audition);
      }
    },
    durationMs,
  );
  scheduleRollAuditionTimeout(
    audition,
    () => {
      if (state.activeRollAudition !== audition) {
        return;
      }
      clearRollAuditionTimers(audition);
      state.activeRollAudition = null;
      renderRollCanvas(kind);
    },
    durationMs + 160,
  );
  setPhraseMessage(
    `Auditioning ${midiNoteName(payload.notes[0].pitch)} from the ${rollSourceLabel(kind)}.`,
  );
}

async function panicPlayback() {
  await sendPlaybackPanic();
  stopInfiniteMode({ stopPlayback: true, silent: true });
  setPhraseStatus(
    state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI",
  );
  setPhraseMessage("Panic sent. Playback and held notes were stopped.");
}

function shortCommit(commit) {
  return typeof commit === "string" && commit.length > 7
    ? commit.slice(0, 7)
    : commit;
}

function describeContinuatorRuntime(info) {
  if (!info) {
    return "Unknown";
  }
  const labels = [];
  if (info.version) {
    labels.push(`v${info.version}`);
  } else if (info.package_version) {
    labels.push(`pkg ${info.package_version}`);
  }
  if (info.commit) {
    labels.push(shortCommit(info.commit));
  }
  return labels.length ? labels.join(" · ") : "Unknown";
}

async function checkServer() {
  const payload = await requestJson("/health");
  elements.serverStatus.textContent = payload.ok
    ? payload.seeded
      ? "Healthy / seeded"
      : "Healthy / empty memory"
    : "Unavailable";
  elements.continuatorVersion.textContent = describeContinuatorRuntime(
    payload.continuator,
  );
  if (payload.continuator?.commit) {
    elements.continuatorVersion.title = payload.continuator.commit;
  }
}

async function loadCustomFaustTemplate() {
  if (state.customFaustTemplateSource) {
    return state.customFaustTemplateSource;
  }

  const response = await fetch(FAUST_CUSTOM_TEMPLATE_DSP_URL);
  if (!response.ok) {
    throw new Error(
      `Unable to load the Custom Faust starter template (${response.status}).`,
    );
  }
  state.customFaustTemplateSource = await response.text();
  return state.customFaustTemplateSource;
}

async function initializeCustomFaustSource() {
  const storedSource = safeLocalStorageGet(FAUST_CUSTOM_SOURCE_STORAGE_KEY);
  if (storedSource && storedSource.trim()) {
    state.customFaustSource = storedSource;
    elements.faustCustomCodeInput.value = storedSource;
    return;
  }

  const template = await loadCustomFaustTemplate();
  state.customFaustSource = template;
  elements.faustCustomCodeInput.value = template;
  safeLocalStorageSet(FAUST_CUSTOM_SOURCE_STORAGE_KEY, template);
}

function setCustomFaustSource(source, { persist = true } = {}) {
  state.customFaustSource = String(source ?? "");
  if (
    document.activeElement !== elements.faustCustomCodeInput &&
    elements.faustCustomCodeInput.value !== state.customFaustSource
  ) {
    elements.faustCustomCodeInput.value = state.customFaustSource;
  }
  if (persist) {
    safeLocalStorageSet(
      FAUST_CUSTOM_SOURCE_STORAGE_KEY,
      state.customFaustSource,
    );
  }
}

function selectedFaustRenderer(choiceValue = selectedPlaybackChoiceValue()) {
  const renderer = resolvePlaybackChoice(choiceValue).renderer;
  return renderer instanceof FaustPolyRenderer ? renderer : null;
}

function selectedRendererIsCustomFaust(
  choiceValue = selectedPlaybackChoiceValue(),
) {
  return resolvePlaybackChoice(choiceValue).rendererId === FAUST_CUSTOM_ID;
}

function clampFaustControlValue(value, descriptor) {
  if (descriptor.kind !== "range") {
    return value >= 0.5 ? 1 : 0;
  }
  return Math.min(descriptor.max, Math.max(descriptor.min, value));
}

function faustMetaMap(item) {
  const meta = {};
  for (const entry of item?.meta || []) {
    for (const [key, value] of Object.entries(entry || {})) {
      meta[key] = value;
    }
  }
  return meta;
}

function faustLabel(item) {
  const rawLabel = String(
    item?.label || item?.shortname || item?.address || "Control",
  );
  const label = rawLabel.split("/").pop() || rawLabel;
  const withSpaces = label.replace(/_/g, " ").trim();
  return withSpaces
    ? withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1)
    : "Control";
}

function faustControlPrecision(step) {
  const numericStep = Number(step);
  if (!Number.isFinite(numericStep) || numericStep <= 0 || numericStep >= 1) {
    return 0;
  }
  return Math.min(4, Math.max(0, Math.ceil(-Math.log10(numericStep))));
}

function formatFaustControlValue(descriptor, value) {
  if (descriptor.kind === "toggle") {
    return value >= 0.5 ? "On" : "Off";
  }
  const precision = faustControlPrecision(descriptor.step);
  const formatted = Number(value).toFixed(precision);
  return descriptor.unit ? `${formatted} ${descriptor.unit}` : formatted;
}

function loadStoredCustomFaustValues() {
  const stored = safeLocalStorageGet(FAUST_CUSTOM_VALUES_STORAGE_KEY);
  if (!stored) {
    return {};
  }
  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistCustomFaustValues() {
  if (!state.customFaustControlDescriptors.length) {
    safeLocalStorageSet(FAUST_CUSTOM_VALUES_STORAGE_KEY, null);
    return;
  }

  const snapshot = {};
  for (const descriptor of state.customFaustControlDescriptors) {
    snapshot[descriptor.key] = customFaustRenderer.getControlValue(
      descriptor.key,
    );
  }
  safeLocalStorageSet(
    FAUST_CUSTOM_VALUES_STORAGE_KEY,
    JSON.stringify(snapshot),
  );
}

function buildCustomFaustControlDescriptors(ui) {
  const storedValues = loadStoredCustomFaustValues();
  const descriptors = [];
  walkFaustUi(ui, (item) => {
    if (!FAUST_UI_CONTROL_TYPES.has(item?.type)) {
      return;
    }

    const address = String(item?.address || "");
    const meta = faustMetaMap(item);
    if (!address || meta.hidden === "1") {
      return;
    }
    if (
      FAUST_POLY_RESERVED_SUFFIXES.some((suffix) => address.endsWith(suffix))
    ) {
      return;
    }

    const kind =
      item.type === "checkbox" || item.type === "button" ? "toggle" : "range";
    const descriptor = {
      key: address,
      kind,
      label: faustLabel(item),
      unit: String(meta.unit || ""),
      min: Number.isFinite(Number(item?.min)) ? Number(item.min) : 0,
      max: Number.isFinite(Number(item?.max)) ? Number(item.max) : 1,
      step:
        Number.isFinite(Number(item?.step)) && Number(item.step) > 0
          ? Number(item.step)
          : kind === "range"
            ? 0.01
            : 1,
      defaultValue: Number.isFinite(Number(item?.init)) ? Number(item.init) : 0,
    };

    const existingValue = customFaustRenderer.controlValues.get(descriptor.key);
    const storedValue = storedValues[descriptor.key];
    const nextValue = Number.isFinite(Number(existingValue))
      ? Number(existingValue)
      : Number.isFinite(Number(storedValue))
        ? Number(storedValue)
        : descriptor.defaultValue;
    descriptor.value = clampFaustControlValue(nextValue, descriptor);
    descriptors.push(descriptor);
  });

  customFaustRenderer.controlValues = new Map(
    descriptors.map((descriptor) => [descriptor.key, descriptor.value]),
  );
  return descriptors;
}

function rebuildCustomFaustControls() {
  elements.faustCustomControls.replaceChildren();
  state.customFaustControlBindings = [];

  if (!state.customFaustControlDescriptors.length) {
    return;
  }

  const fragment = document.createDocumentFragment();
  state.customFaustControlDescriptors.forEach((descriptor, index) => {
    const field = document.createElement("div");
    field.className = "field faust-field";

    const labelRow = document.createElement("div");
    labelRow.className = "faust-label-row";

    const label = document.createElement("label");
    const output = document.createElement("output");
    const inputId = `faust-custom-control-${index}`;
    label.setAttribute("for", inputId);
    output.setAttribute("for", inputId);
    label.textContent = descriptor.label;

    let input;
    if (descriptor.kind === "toggle") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.id = inputId;
      input.checked = descriptor.value >= 0.5;
      input.addEventListener("change", () => {
        const nextValue = input.checked ? 1 : 0;
        descriptor.value = nextValue;
        customFaustRenderer.setControlValue(descriptor.key, nextValue);
        persistCustomFaustValues();
        syncFaustRendererPanel();
      });
    } else {
      input = document.createElement("input");
      input.type = "range";
      input.id = inputId;
      input.min = String(descriptor.min);
      input.max = String(descriptor.max);
      input.step = String(descriptor.step);
      input.value = String(descriptor.value);
      input.addEventListener("input", () => {
        const nextValue = clampFaustControlValue(
          Number(input.value),
          descriptor,
        );
        descriptor.value = nextValue;
        customFaustRenderer.setControlValue(descriptor.key, nextValue);
        persistCustomFaustValues();
        syncFaustRendererPanel();
      });
    }

    output.textContent = formatFaustControlValue(descriptor, descriptor.value);
    labelRow.append(label, output);
    field.append(labelRow, input);
    fragment.append(field);
    state.customFaustControlBindings.push({ descriptor, input, output });
  });

  elements.faustCustomControls.append(fragment);
}

function syncCustomFaustControls() {
  const customSelected = selectedRendererIsCustomFaust();
  const inputsEnabled =
    customSelected &&
    customFaustRenderer.status !== "Loading" &&
    customFaustRenderer.status !== "Error";
  for (const binding of state.customFaustControlBindings) {
    const currentValue = customFaustRenderer.getControlValue(
      binding.descriptor.key,
    );
    binding.descriptor.value = clampFaustControlValue(
      currentValue,
      binding.descriptor,
    );
    if (binding.descriptor.kind === "toggle") {
      binding.input.checked = binding.descriptor.value >= 0.5;
    } else if (binding.input.value !== String(binding.descriptor.value)) {
      binding.input.value = String(binding.descriptor.value);
    }
    binding.input.disabled = !inputsEnabled;
    binding.output.textContent = formatFaustControlValue(
      binding.descriptor,
      binding.descriptor.value,
    );
  }

  elements.faustCustomControlsHint.hidden =
    state.customFaustControlBindings.length > 0;
  if (state.customFaustControlBindings.length) {
    return;
  }
  if (customFaustRenderer.status === "Ready") {
    elements.faustCustomControlsHint.textContent =
      "This DSP compiled successfully, but it does not expose any visible user parameters.";
    return;
  }
  elements.faustCustomControlsHint.textContent =
    "Compile a polyphonic instrument to expose its parameters.";
}

function customFaustHasPendingChanges() {
  return (
    state.customFaustSource !== (customFaustRenderer.lastCompiledCode || "")
  );
}

function customFaustDirtyCopy() {
  if (!state.customFaustSource.trim()) {
    return "Paste or write a Faust DSP before compiling.";
  }
  if (customFaustRenderer.status === "Loading") {
    return "Compiling the current source in your browser…";
  }
  if (customFaustHasPendingChanges()) {
    return customFaustRenderer.lastCompiledCode
      ? "Edits are saved locally. Compile to replace the last working build with these changes."
      : "Compile to turn this source into the active renderer.";
  }
  if (customFaustRenderer.status === "Ready") {
    return "The editor matches the currently active compiled renderer.";
  }
  return "Compile to turn the latest source into the active renderer.";
}

function refreshCustomFaustControlState() {
  state.customFaustControlDescriptors = buildCustomFaustControlDescriptors(
    customFaustRenderer.getUi(),
  );
  rebuildCustomFaustControls();
  persistCustomFaustValues();
}

function syncFaustRendererPanel() {
  const selectedRenderer = selectedFaustRenderer();
  const faustSelected = Boolean(selectedRenderer);
  elements.faustRendererPanel.hidden = !faustSelected;
  elements.faustClavierPanel.hidden =
    !faustSelected || selectedRenderer?.id !== FAUST_CLAVIER_ID;
  elements.faustCustomPanel.hidden =
    !faustSelected || selectedRenderer?.id !== FAUST_CUSTOM_ID;
  elements.faustRendererStatus.textContent = selectedRenderer?.status || "Idle";

  let hint =
    "Faust instruments are compiled locally in your browser the first time you use them.";
  if (selectedRenderer?.lastError) {
    hint = `Faust renderer error: ${selectedRenderer.lastError.message}`;
  } else if (selectedRenderer?.id === FAUST_CLAVIER_ID) {
    if (selectedRenderer.status === "Loading") {
      hint =
        "Compiling the built-in Faust Clavier in your browser. Once it is ready, these controls update the live renderer.";
    } else if (selectedRenderer.status === "Ready") {
      hint =
        "These controls are live on the built-in Faust Clavier. They shape attack, damping, release, body resonance, and stereo spread.";
    }
  } else if (selectedRenderer?.id === FAUST_CUSTOM_ID) {
    if (selectedRenderer.status === "Loading") {
      hint =
        "Compiling your Custom Faust source in the browser and rebuilding its parameter panel.";
    } else if (customFaustHasPendingChanges()) {
      hint =
        "Custom Faust keeps using the last compiled build until you compile the latest source in the editor.";
    } else if (selectedRenderer.status === "Ready") {
      hint =
        "The Custom Faust renderer is active. Any visible Faust controls from your DSP appear below automatically.";
    }
  }
  elements.faustRendererHint.textContent = hint;

  for (const control of faustClavierControls) {
    const value = faustClavierRenderer.getControlValue(control.key);
    const inputValue = String(value);
    if (control.input.value !== inputValue) {
      control.input.value = inputValue;
    }
    control.input.disabled =
      !faustSelected ||
      selectedRenderer?.id !== FAUST_CLAVIER_ID ||
      selectedRenderer.status === "Loading";
    control.output.textContent = control.format(value);
  }

  if (document.activeElement !== elements.faustCustomCodeInput) {
    elements.faustCustomCodeInput.value = state.customFaustSource;
  }
  elements.faustCustomCompileButton.disabled =
    !state.customFaustSource.trim() || customFaustRenderer.status === "Loading";
  elements.faustCustomResetButton.disabled =
    customFaustRenderer.status === "Loading";
  elements.faustCustomDirtyState.textContent = customFaustDirtyCopy();
  syncCustomFaustControls();
  renderPerformanceState();
}

function populatePlaybackChoices() {
  const outputs = state.midiAccess
    ? [...state.midiAccess.outputs.values()]
    : [];
  const previousChoiceValue = selectedPlaybackChoiceValue();
  const preferredChoiceValue = resolveAvailablePlaybackPreference(
    pendingPlaybackPreference(),
    outputs,
  );
  const availableChoices = new Set([
    ...localPlaybackRenderers.map((renderer) =>
      encodePlaybackChoice(renderer.id),
    ),
    ...outputs.map((output) =>
      encodePlaybackChoice(WEB_MIDI_RENDERER_ID, output.id),
    ),
  ]);

  const localRendererGroups = new Map();
  for (const renderer of localPlaybackRenderers) {
    const groupLabel = renderer.groupLabel || "Playback Renderers";
    const existing = localRendererGroups.get(groupLabel) || [];
    existing.push(
      `<option value="${encodePlaybackChoice(renderer.id)}">${renderer.getDisplayName()}</option>`,
    );
    localRendererGroups.set(groupLabel, existing);
  }
  const midiOptions = outputs
    .map(
      (output) =>
        `<option value="${encodePlaybackChoice(
          WEB_MIDI_RENDERER_ID,
          output.id,
        )}">${output.name || output.id}</option>`,
    )
    .join("");
  const externalMidiOptions =
    midiOptions ||
    `<option value="" disabled>${
      state.midiAccess
        ? "No external MIDI outputs found"
        : "Connect MIDI to show external outputs"
    }</option>`;

  elements.midiOutputSelect.disabled = false;
  elements.midiOutputSelect.innerHTML = [
    ...Array.from(localRendererGroups.entries()).map(
      ([groupLabel, options]) =>
        `<optgroup label="${groupLabel}">${options.join("")}</optgroup>`,
    ),
    `<optgroup label="External MIDI">${externalMidiOptions}</optgroup>`,
  ]
    .filter(Boolean)
    .join("");
  elements.midiOutputSelect.value =
    preferredChoiceValue && availableChoices.has(preferredChoiceValue)
      ? preferredChoiceValue
      : availableChoices.has(previousChoiceValue)
        ? previousChoiceValue
        : DEFAULT_PLAYBACK_CHOICE;
  updateSelectedOutput();
}

function populateMidiCopyOutputChoices(
  preference = pendingMidiCopyOutputPreference(),
) {
  if (!elements.midiCopyOutputSelect) {
    return null;
  }
  const outputs = state.midiAccess
    ? [...state.midiAccess.outputs.values()]
    : [];
  const primaryOutputId = selectedPrimaryMidiOutputId();
  const eligibleOutputs = outputs.filter(
    (output) => output.id !== primaryOutputId,
  );
  const eligibleOutputIds = new Set(eligibleOutputs.map((output) => output.id));
  const previousOutputId = selectedMidiCopyOutputId();
  const preferredOutputId = resolveAvailableMidiCopyOutputId(
    preference,
    outputs,
  );
  const selectedOutputId =
    preferredOutputId ||
    (previousOutputId && eligibleOutputIds.has(previousOutputId)
      ? previousOutputId
      : null);

  const outputOptions = eligibleOutputs
    .map(
      (output) =>
        `<option value="${output.id}">${output.name || output.id}</option>`,
    )
    .join("");
  const emptyOption = !eligibleOutputs.length
    ? `<option value="__no_additional_midi_outputs__" disabled>${
        state.midiAccess
          ? "No additional MIDI outputs found"
          : "Connect MIDI to show outputs"
      }</option>`
    : "";

  elements.midiCopyOutputSelect.innerHTML = [
    `<option value="">Off</option>`,
    outputOptions,
    emptyOption,
  ].join("");
  elements.midiCopyOutputSelect.disabled = !state.midiAccess;
  elements.midiCopyOutputSelect.value = selectedOutputId || "";
  return selectedOutputId;
}

async function compileCustomFaustFromEditor() {
  const source = elements.faustCustomCodeInput.value;
  if (!source.trim()) {
    throw new Error("Paste or write a Faust DSP before compiling.");
  }

  setCustomFaustSource(source);
  stopLoopAndPlayback("Stopped playback before recompiling Custom Faust.");
  await customFaustRenderer.prepare({ forceRecompile: true });
  refreshCustomFaustControlState();
}

function clearPhrases() {
  clearPhraseBuffers();
  setPhraseMessage("Cleared the local phrase buffers.");
}

function bindEvents() {
  elements.controlTabs.forEach((node) => {
    node.addEventListener("click", () => {
      setAccountPanelOpen(false);
      setControlView(node.dataset.controlTab);
      scheduleVisibleSessionRefresh();
    });
  });

  elements.loginButton.addEventListener("click", async () => {
    try {
      await submitAuth("login");
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  elements.registerButton.addEventListener("click", async () => {
    try {
      await submitAuth("register");
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  elements.logoutButton.addEventListener("click", async () => {
    try {
      await logoutUser();
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  elements.refreshSessionsButton.addEventListener("click", async () => {
    try {
      await refreshSavedSessions();
      setAuthMessage("Saved sessions refreshed.");
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  elements.savedSessionPreviewOpenButton.addEventListener("click", async () => {
    const item = selectedSavedSession();
    if (!item) {
      return;
    }
    try {
      await openSavedSession(item.session_id);
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  elements.renameSessionButton.addEventListener("click", async () => {
    try {
      await renamePreviewedSession();
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  elements.savedSessionNameInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    try {
      await renamePreviewedSession();
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  [elements.authUsernameInput, elements.authPasswordInput].forEach((input) => {
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      try {
        await submitAuth("login");
      } catch (error) {
        setAuthMessage(error.message, true);
      }
    });
  });

  [elements.authUsernameInput, elements.authPasswordInput].forEach((input) => {
    input.addEventListener("input", () => {
      if (state.authUser) {
        return;
      }
      setAuthMessage(
        "Guest mode is ready. Sign in only if you want saved sessions.",
      );
    });
  });

  elements.openReadmeButton.addEventListener("click", () => {
    setReadmeOpen(!state.readmeOpen);
  });

  elements.closeReadmeButton.addEventListener("click", () => {
    setReadmeOpen(false);
  });

  elements.readmeOverlay.addEventListener("click", () => {
    setReadmeOpen(false);
  });

  elements.showGraphButton.addEventListener("click", async () => {
    try {
      await showSessionGraph("memory");
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.graphKindTabs.forEach((node) => {
    node.addEventListener("click", async () => {
      try {
        await showSessionGraph(node.dataset.graphKind);
      } catch (error) {
        setPhraseMessage(error.message, true);
      }
    });
  });

  elements.graphModeSelect?.addEventListener("change", async () => {
    state.graphMode = normalizedGraphMode(elements.graphModeSelect.value);
    elements.graphModeSelect.value = state.graphMode;
    if (state.graphOpen && state.activeGraphKind === "memory") {
      await updateSessionGraphImage("memory", {
        openPanel: false,
        closeOnError: false,
        preserveScroll: true,
      });
    }
  });

  elements.graphOrderSelect?.addEventListener("change", async () => {
    state.graphOrder = normalizedGraphOrder(elements.graphOrderSelect.value);
    elements.graphOrderSelect.value = state.graphOrder;
    if (state.graphOpen && state.activeGraphKind === "memory") {
      await updateSessionGraphImage("memory", {
        openPanel: false,
        closeOnError: false,
        preserveScroll: true,
      });
    }
  });

  elements.graphHead.addEventListener("pointerdown", startGraphPanelDrag);
  elements.graphHead.addEventListener("pointermove", moveGraphPanelDrag);
  elements.graphHead.addEventListener("pointerup", stopGraphPanelDrag);
  elements.graphHead.addEventListener("pointercancel", stopGraphPanelDrag);

  elements.closeGraphButton.addEventListener("click", () => {
    setGraphOpen(false);
  });

  elements.authStatus.addEventListener("click", () => {
    if (state.readmeOpen) {
      setReadmeOpen(false);
    }
    setAccountPanelOpen(!state.accountPanelOpen);
  });

  elements.closeAccountButton.addEventListener("click", () =>
    setAccountPanelOpen(false),
  );
  elements.accountSessionSelect.addEventListener("change", () => {
    state.accountSelectedSessionId = elements.accountSessionSelect.value;
  });
  elements.accountPanel.addEventListener("cancel", (event) => {
    event.preventDefault();
    setAccountPanelOpen(false);
  });
  elements.accountPanel.addEventListener("click", (event) => {
    if (event.target !== elements.accountPanel) return;
    const bounds = elements.accountPanel.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      setAccountPanelOpen(false);
    }
  });
  elements.saveAccountButton.addEventListener("click", () =>
    setAccountPanelOpen(true),
  );
  elements.claimSessionButton.addEventListener("click", async () => {
    try {
      await claimCurrentSession();
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  elements.accountOpenSessionsButton.addEventListener("click", async () => {
    try {
      const sessionId = elements.accountSessionSelect.value;
      if (!sessionId) return;
      await openSavedSession(sessionId);
      setAccountPanelOpen(false);
    } catch (error) {
      setAuthMessage(error.message, true);
    }
  });

  document.addEventListener("click", (event) => {
    if (!state.accountPanelOpen) {
      return;
    }
    if (!(event.target instanceof Node)) {
      return;
    }
    if (
      elements.accountPanel.contains(event.target) ||
      elements.authStatus.contains(event.target) ||
      elements.saveAccountButton.contains(event.target)
    ) {
      return;
    }
    setAccountPanelOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.accountPanelOpen) {
      setAccountPanelOpen(false);
      return;
    }
    if (event.key === "Escape" && state.readmeOpen) {
      setReadmeOpen(false);
      return;
    }
    if (event.key === "Escape" && state.graphOpen) {
      setGraphOpen(false);
      return;
    }
    if (event.key === "Escape" && state.accountPanelOpen) {
      setAccountPanelOpen(false);
    }
  });

  elements.createSessionButton.addEventListener("click", async () => {
    try {
      await createSession();
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.resetSessionButton.addEventListener("click", async () => {
    try {
      await resetSession();
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.saveSessionMidiButton.addEventListener("click", async () => {
    try {
      await saveSessionMidi();
    } catch (error) {
      setSessionMidiSaveResult(error.message, true);
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.rememberMidiExportFileToggle.addEventListener("change", async () => {
    if (elements.rememberMidiExportFileToggle.checked) {
      setSessionMidiSaveResult(
        "The next selected MIDI ZIP file will be remembered and overwritten on future saves.",
      );
      return;
    }
    state.midiExportFileHandle = null;
    try {
      await clearStoredMidiExportFileHandle();
      setSessionMidiSaveResult("MIDI export ZIP preference cleared.");
    } catch {
      setSessionMidiSaveResult(
        "MIDI export ZIP preference cleared for this page.",
      );
    }
  });

  elements.connectMidiButton.addEventListener("click", async () => {
    try {
      await connectMidi();
    } catch (error) {
      setPhraseMessage(error.message, true);
      setMidiStatus("Unavailable");
    }
  });

  elements.refreshMidiButton.addEventListener("click", async () => {
    try {
      if (!state.midiAccess) {
        await connectMidi();
        return;
      }
      await populateMidiSelectors();
      setPhraseMessage("MIDI ports refreshed.");
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.virtualKeyboard.addEventListener("pointerdown", (event) => {
    if (!isVirtualMidiInputSelected()) {
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    const key = event.target.closest("[data-midi-note]");
    if (!key) {
      return;
    }
    event.preventDefault();
    const note = Number(key.dataset.midiNote);
    if (elements.virtualLatchToggle.checked) {
      toggleLatchedVirtualNote(note);
      return;
    }
    const sourceId = `pointer:${event.pointerId}`;
    state.virtualActivePointers.set(event.pointerId, note);
    key.setPointerCapture?.(event.pointerId);
    pressVirtualNote(note, sourceId);
  });

  elements.virtualKeyboard.addEventListener("pointerup", (event) => {
    const note = state.virtualActivePointers.get(event.pointerId);
    if (note == null) {
      return;
    }
    state.virtualActivePointers.delete(event.pointerId);
    releaseVirtualNote(note, `pointer:${event.pointerId}`);
  });

  elements.virtualKeyboard.addEventListener("pointercancel", (event) => {
    const note = state.virtualActivePointers.get(event.pointerId);
    if (note == null) {
      return;
    }
    state.virtualActivePointers.delete(event.pointerId);
    releaseVirtualNote(note, `pointer:${event.pointerId}`);
  });

  elements.virtualKeyboard.addEventListener("pointerleave", () => {
    for (const [pointerId, note] of [...state.virtualActivePointers]) {
      releaseVirtualNote(note, `pointer:${pointerId}`);
      state.virtualActivePointers.delete(pointerId);
    }
  });

  elements.virtualOctaveDownButton.addEventListener("click", () => {
    setVirtualKeyboardBaseNote(state.virtualKeyboardBaseNote - 12);
  });

  elements.virtualOctaveUpButton.addEventListener("click", () => {
    setVirtualKeyboardBaseNote(state.virtualKeyboardBaseNote + 12);
  });

  elements.virtualVelocityInput.addEventListener("input", () => {
    elements.virtualVelocityValue.textContent = String(getVirtualVelocity());
  });

  elements.virtualSustainToggle.addEventListener("change", () => {
    if (!elements.virtualSustainToggle.checked) {
      releaseSustainedVirtualNotes();
    }
  });

  elements.virtualLatchToggle.addEventListener("change", () => {
    allVirtualNotesOff();
  });

  elements.virtualClearLatchButton.addEventListener("click", () => {
    clearLatchedVirtualChord();
  });

  elements.virtualPanicButton.addEventListener("click", async () => {
    allVirtualNotesOff();
    try {
      await sendPlaybackPanic();
      setPhraseMessage("All virtual and playback notes were stopped.");
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.sendPhraseButton.addEventListener("click", async () => {
    try {
      await sendCurrentPhrase();
    } catch (error) {
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.generateMemoryButton.addEventListener("click", async () => {
    try {
      await generateFreshPhrase();
    } catch (error) {
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.globalPanicButton.addEventListener("click", async () => {
    try {
      await panicPlayback();
    } catch (error) {
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.testNoteButton.addEventListener("click", async () => {
    try {
      await playTestNote();
    } catch (error) {
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.panicButton.addEventListener("click", async () => {
    try {
      await panicPlayback();
    } catch (error) {
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.replayGeneratedButton.addEventListener("click", async () => {
    if (!state.lastGeneratedPhrase) {
      setPhraseMessage("No generated phrase is available yet.", true);
      return;
    }
    try {
      stopInfiniteMode({ stopPlayback: true, silent: true });
      await playPayload(state.lastGeneratedPhrase);
      setPhraseMessage("Replaying the latest generated phrase.");
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.startInfiniteButton.addEventListener("click", async () => {
    try {
      await startInfiniteMode();
    } catch (error) {
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.stopInfiniteButton.addEventListener("click", () => {
    stopLoopAndPlayback();
  });

  elements.clearPhraseButton.addEventListener("click", () => {
    clearPhrases();
  });

  elements.inputRoll.addEventListener("click", async (event) => {
    try {
      await handleRollClick("input", event);
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.outputRoll.addEventListener("click", async (event) => {
    try {
      await handleRollClick("output", event);
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.inputRoll.addEventListener("pointermove", (event) => {
    updateRollPointerTitle("input", event);
  });

  elements.outputRoll.addEventListener("pointermove", (event) => {
    updateRollPointerTitle("output", event);
  });

  elements.inputRoll.addEventListener("pointerleave", () => {
    syncRollPlaybackState();
  });

  elements.outputRoll.addEventListener("pointerleave", () => {
    syncRollPlaybackState();
  });

  elements.inputRoll.addEventListener("keydown", (event) => {
    void handleRollKeydown("input", event).catch((error) => {
      setPhraseMessage(error.message, true);
    });
  });

  elements.outputRoll.addEventListener("keydown", (event) => {
    void handleRollKeydown("output", event).catch((error) => {
      setPhraseMessage(error.message, true);
    });
  });

  elements.applySettingsButton.addEventListener("click", async () => {
    try {
      await applyCurrentSessionSettings();
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.midiInputSelect.addEventListener("change", async (event) => {
    try {
      syncVirtualKeyboardVisibility();
      await attachInput(event.target.value, { savePreference: true });
      setPhraseMessage(`MIDI input changed to ${state.selectedInputLabel}.`);
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.phraseTimeoutInput.addEventListener("change", () => {
    applyPhraseTimeoutSetting(elements.phraseTimeoutInput.value, {
      announce: true,
    });
  });

  elements.inputMonitorToggle.addEventListener("change", () => {
    applyInputMonitorPreference(elements.inputMonitorToggle.checked, {
      announce: true,
    });
  });

  elements.stopMemoryOnUserPlayToggle.addEventListener("change", () => {
    applyStopMemoryOnUserPlayPreference(
      elements.stopMemoryOnUserPlayToggle.checked,
    );
    setPhraseMessage(
      state.stopMemoryOnUserPlay
        ? "Memory phrases will stop when you play a note."
        : "Memory phrases will keep playing while you play.",
    );
  });

  elements.midiOutputSelect.addEventListener("change", async () => {
    stopLiveMonitorPlayback();
    updateSelectedOutput();
    const choice = selectedPlaybackChoice();
    try {
      if (choice.rendererId === WEB_MIDI_RENDERER_ID) {
        const output = midiOutputById(choice.targetId);
        if (!output) {
          setPhraseMessage("The selected MIDI output is unavailable.", true);
          return;
        }
        await output.open();
      } else if (choice.renderer?.prepare) {
        await choice.renderer.prepare();
        if (choice.rendererId === FAUST_CUSTOM_ID) {
          refreshCustomFaustControlState();
        }
      }
      await saveSessionPreferences({
        ...currentPlaybackPreference(),
        ...currentMidiCopyOutputPreference(),
      });
      const copyLabel = midiCopyOutputLabel();
      setPhraseMessage(
        copyLabel
          ? `Playback renderer set to ${playbackChoiceLabel()}, also sending MIDI to ${copyLabel}.`
          : `Playback renderer set to ${playbackChoiceLabel()}.`,
      );
    } catch (error) {
      setPhraseMessage(error.message, true);
    } finally {
      syncFaustRendererPanel();
    }
  });

  elements.midiCopyOutputSelect.addEventListener("change", async () => {
    stopLiveMonitorPlayback();
    const output = selectedMidiCopyOutput();
    try {
      if (output) {
        await output.open();
      }
      await saveSessionPreferences(currentMidiCopyOutputPreference());
      setPhraseMessage(
        output
          ? `Also sending MIDI to ${output.name || output.id}.`
          : "Secondary MIDI output off.",
      );
    } catch (error) {
      elements.midiCopyOutputSelect.value = "";
      await saveSessionPreferences(currentMidiCopyOutputPreference());
      setPhraseMessage(
        `Could not open the secondary MIDI output: ${error.message}`,
        true,
      );
    } finally {
      renderPerformanceState();
    }
  });

  elements.audioOutputSelect.addEventListener("change", async () => {
    const selectedDeviceId = elements.audioOutputSelect.value || "default";
    const device = state.audioOutputDevices.find(
      (candidate) => candidate.deviceId === selectedDeviceId,
    );
    rememberAudioOutputPreference({
      device_id: selectedDeviceId,
      device_name: device?.label || "System default",
    });
    try {
      await applyPreferredAudioOutput();
      setPhraseMessage(
        `Sound output set to ${device?.label || "System default"}.`,
      );
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  faustClavierControls.forEach((control) => {
    control.input.addEventListener("input", () => {
      faustClavierRenderer.setControlValue(control.key, control.input.value);
    });
  });

  elements.faustCustomCodeInput.addEventListener("input", () => {
    setCustomFaustSource(elements.faustCustomCodeInput.value);
    syncFaustRendererPanel();
  });

  elements.faustCustomCompileButton.addEventListener("click", async () => {
    try {
      await compileCustomFaustFromEditor();
      setPhraseMessage("Custom Faust compiled and is ready for playback.");
    } catch (error) {
      setPhraseMessage(error.message, true);
      setPhraseStatus("Error");
    }
  });

  elements.faustCustomResetButton.addEventListener("click", async () => {
    try {
      const starter = await loadCustomFaustTemplate();
      setCustomFaustSource(starter);
      syncFaustRendererPanel();
      setPhraseMessage(
        "Restored the Custom Faust starter template. Compile to use it.",
      );
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.learnInputToggle.addEventListener("change", () => {
    renderSessionSettingsSummary();
  });

  elements.transposeToggle.addEventListener("change", () => {
    renderSessionSettingsSummary();
  });

  elements.markovOrderInput.addEventListener("change", () => {
    elements.markovOrderInput.value = String(
      normalizedMarkovOrder(elements.markovOrderInput.value),
    );
    renderSessionSettingsSummary();
  });
  elements.markovOrderInput.addEventListener("input", () => {
    renderSessionSettingsSummary();
  });

  elements.forgetToggle.addEventListener("change", () => {
    updateKeepLastFieldState();
    renderSessionSettingsSummary();
  });

  elements.keepLastInput.addEventListener("change", () => {
    elements.keepLastInput.value = String(
      normalizedKeepLastInputs(elements.keepLastInput.value),
    );
    renderSessionSettingsSummary();
  });
  elements.keepLastInput.addEventListener("input", () => {
    renderSessionSettingsSummary();
  });

  elements.continuationLengthInput.addEventListener("change", () => {
    const noteCount = normalizedContinuationNoteCount(
      elements.continuationLengthInput.value,
    );
    elements.continuationLengthInput.value =
      noteCount == null ? "" : String(noteCount);
  });

  elements.importMidiFilesButton.addEventListener("click", () => {
    elements.midiImportInput.click();
  });

  elements.importMidiFolderButton.addEventListener("click", () => {
    elements.midiFolderImportInput.click();
  });

  elements.midiImportInput.addEventListener("change", async (event) => {
    const input = event.target;
    try {
      await importSelectedMidiFiles(input.files, "file selection");
    } catch (error) {
      setPhraseMessage(error.message, true);
    } finally {
      input.value = "";
    }
  });

  elements.midiFolderImportInput.addEventListener("change", async (event) => {
    const input = event.target;
    try {
      await importSelectedMidiFiles(input.files, "folder");
    } catch (error) {
      setPhraseMessage(error.message, true);
    } finally {
      input.value = "";
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!isVirtualMidiInputSelected()) {
      return;
    }
    const note = virtualNoteFromComputerKey(event.code);
    if (note == null || event.repeat) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, select, textarea")
    ) {
      return;
    }
    event.preventDefault();
    if (elements.virtualLatchToggle.checked) {
      toggleLatchedVirtualNote(note);
      return;
    }
    state.virtualActiveComputerKeys.set(event.code, note);
    pressVirtualNote(note, `key:${event.code}`);
  });

  document.addEventListener("keyup", (event) => {
    const note = state.virtualActiveComputerKeys.get(event.code);
    if (note == null) {
      return;
    }
    event.preventDefault();
    state.virtualActiveComputerKeys.delete(event.code);
    releaseVirtualNote(note, `key:${event.code}`);
  });

  window.addEventListener("blur", () => {
    allVirtualNotesOff();
  });

  window.addEventListener("resize", () => {
    syncPhoneLayout();
    if (state.graphOpen && state.graphPanelPosition) {
      applyGraphPanelPosition(state.graphPanelPosition);
    }
    renderVirtualKeyboard();
    drawPianoRoll(
      elements.inputRoll,
      state.lastCapturedNotes,
      "#6dd3ce",
      "Input phrase",
    );
    renderGeneratedStats(state.lastGeneratedPhrase);
  });
}

async function initialize() {
  syncPhoneLayout();
  bindEvents();
  void backupStatus.refresh();
  window.setInterval(() => {
    if (!document.hidden) void backupStatus.refresh();
  }, 3000);
  state.userMidiCopyOutputPreference = loadStoredMidiCopyOutputPreference();
  state.userAudioOutputPreference = loadStoredAudioOutputPreference();
  try {
    await initializeCustomFaustSource();
  } catch (error) {
    setPhraseMessage(error.message, true);
  }
  initializePhraseTimeoutSetting();
  initializeInputMonitorPreference();
  applyStopMemoryOnUserPlayPreference(
    safeLocalStorageGet(STOP_MEMORY_ON_USER_PLAY_STORAGE_KEY) !== "false",
    { persist: false },
  );
  await initializeMidiExportFilePreference();
  populatePlaybackChoices();
  syncAuthUI();
  renderSavedSessions([]);
  clearCurrentSessionState();
  setControlView("perform");
  try {
    await refreshAudioOutputDevices();
  } catch {
    populateAudioOutputChoices();
  }
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      void refreshAudioOutputDevices().catch(() =>
        populateAudioOutputChoices(),
      );
    });
  }
  setSelectedInputName("No MIDI input selected");
  updateSelectedOutput();
  syncFaustRendererPanel();
  setLastMidiEvent("None yet");
  renderVirtualKeyboard();
  elements.virtualVelocityValue.textContent = String(getVirtualVelocity());
  await populateMidiSelectors();
  await initializePhoneInput();
  updateKeepLastFieldState();
  renderSessionSettingsSummary();
  updateSessionActionState();
  updateInfiniteActionState();
  renderPerformanceState();
  try {
    await checkServer();
  } catch (error) {
    elements.serverStatus.textContent = "Offline";
    elements.continuatorVersion.textContent = "Unknown";
    setPhraseMessage(error.message, true);
  }
  try {
    await refreshAuthState();
  } catch (error) {
    setPhraseMessage(error.message, true);
  }
  try {
    await initializeReadySession();
  } catch (error) {
    setPhraseMessage(`Could not auto-create a session: ${error.message}`, true);
  }
}

const {
  renderPerformanceState,
  hasPendingSessionSettings,
  renderConstraintStatus,
  setAuthMessage,
  setTextContentIfChanged,
  setSessionStatus,
  setMidiStatus,
  setPhraseStatus,
  setSelectedInputName,
  setLastMidiEvent,
  readSessionSettingsFromControls,
  describeSessionSettings,
  renderSessionSettingsSummary,
  updateKeepLastFieldState,
  syncSettingsControls,
  updateSessionActionState,
  sessionDisplayName,
  selectedSavedSession,
  renderSavedSessions,
  syncAuthUI,
  setControlView,
  syncPreviewSelection,
  syncMemoryPlaybackState,
  renderCapturedStats,
  stopCapturedPreviewRender,
  renderCapturedProgress,
  renderGeneratedStats,
  rollCanvas,
  rollSourceLabel,
  rollAuditionOptions,
  renderRollCanvas,
  syncRollPlaybackState,
  handleRollClick,
  updateRollPointerTitle,
  handleRollKeydown,
  renderHistory,
  renderMemory,
} = createViews({
  auditionRollNote: (...args) => auditionRollNote(...args),
  elements,
  formatMilliseconds: (...args) => formatMilliseconds(...args),
  hasLoopSeedPhrase: (...args) => hasLoopSeedPhrase(...args),
  midiExportZipRememberSupported: (...args) =>
    midiExportZipRememberSupported(...args),
  midiNoteName: (...args) => midiNoteName(...args),
  midiOutputById: (...args) => midiOutputById(...args),
  normalizedKeepLastInputs: (...args) => normalizedKeepLastInputs(...args),
  normalizedMarkovOrder: (...args) => normalizedMarkovOrder(...args),
  openSavedSession: (...args) => openSavedSession(...args),
  parsePlaybackChoice: (...args) => parsePlaybackChoice(...args),
  phraseDurationMs: (...args) => phraseDurationMs(...args),
  phraseNoteCount: (...args) => phraseNoteCount(...args),
  playPayload: (...args) => playPayload(...args),
  playbackChoiceLabel: (...args) => playbackChoiceLabel(...args),
  pluralize: (...args) => pluralize(...args),
  refreshSavedSessions: (...args) => refreshSavedSessions(...args),
  refreshUserPlaybackPreferenceFromSavedSessions: (...args) =>
    refreshUserPlaybackPreferenceFromSavedSessions(...args),
  rememberCapturedPhrase: (...args) => rememberCapturedPhrase(...args),
  rememberGeneratedPhrase: (...args) => rememberGeneratedPhrase(...args),
  renderAccountTrigger: (...args) => renderAccountTrigger(...args),
  requestJson: (...args) => requestJson(...args),
  selectedMidiCopyOutput: (...args) => selectedMidiCopyOutput(...args),
  selectedMidiCopyOutputId: (...args) => selectedMidiCopyOutputId(...args),
  selectedPlaybackChoice: (...args) => selectedPlaybackChoice(...args),
  setPhraseMessage: (...args) => setPhraseMessage(...args),
  setReadinessStep: (...args) => setReadinessStep(...args),
  state,
  stopActivePlayback: (...args) => stopActivePlayback(...args),
  stopInfiniteMode: (...args) => stopInfiniteMode(...args),
  updateInfiniteActionState: (...args) => updateInfiniteActionState(...args),
});

const {
  requestJson,
  renamePreviewedSession,
  currentPlaybackPreference,
  currentMidiCopyOutputPreference,
  saveSessionPreferences,
  refreshAuthState,
  initializeReadySession,
  submitAuth,
  claimCurrentSession,
  logoutUser,
  refreshSavedSessions,
  openSavedSession,
  createSession,
  resetSession,
  saveSessionMidi,
  applyCurrentSessionSettings,
  scheduleVisibleSessionRefresh,
  applyContinuationPayload,
  applyGeneratedPhrasePayload,
  requestContinuationFromEvents,
  requestMemoryGeneration,
  sendCurrentPhrase,
  generateFreshPhrase,
  importSelectedMidiFiles,
} = createSessionController({
  fetchApi,
  backupStatus,
  applyPreferredAudioOutput: (...args) => applyPreferredAudioOutput(...args),
  attachInput: (...args) => attachInput(...args),
  chooseMidiExportZipFileHandle: (...args) =>
    chooseMidiExportZipFileHandle(...args),
  clearCurrentSessionState: (...args) => clearCurrentSessionState(...args),
  clearPhraseBuffers: (...args) => clearPhraseBuffers(...args),
  describeSessionSettings: (...args) => describeSessionSettings(...args),
  downloadZipBlob: (...args) => downloadZipBlob(...args),
  elements,
  filePickerBlockedByFrame: (...args) => filePickerBlockedByFrame(...args),
  hasMidiFileExtension: (...args) => hasMidiFileExtension(...args),
  hasPendingSessionSettings: (...args) => hasPendingSessionSettings(...args),
  isVirtualMidiInputId: (...args) => isVirtualMidiInputId(...args),
  isVirtualMidiInputSelected: (...args) => isVirtualMidiInputSelected(...args),
  loadStoredAudioOutputPreference: (...args) =>
    loadStoredAudioOutputPreference(...args),
  loadStoredMidiCopyOutputPreference: (...args) =>
    loadStoredMidiCopyOutputPreference(...args),
  loadStoredPlaybackPreference: (...args) =>
    loadStoredPlaybackPreference(...args),
  midiExportZipSaveSupported: (...args) => midiExportZipSaveSupported(...args),
  midiOutputById: (...args) => midiOutputById(...args),
  normalizedContinuationNoteCount: (...args) =>
    normalizedContinuationNoteCount(...args),
  playPayload: (...args) => playPayload(...args),
  playbackChoiceLabel: (...args) => playbackChoiceLabel(...args),
  pluralize: (...args) => pluralize(...args),
  populateAudioOutputChoices: (...args) => populateAudioOutputChoices(...args),
  preferredGenerationNoteCount: (...args) =>
    preferredGenerationNoteCount(...args),
  readSessionSettingsFromControls: (...args) =>
    readSessionSettingsFromControls(...args),
  rememberCapturedPhrase: (...args) => rememberCapturedPhrase(...args),
  rememberGeneratedPhrase: (...args) => rememberGeneratedPhrase(...args),
  rememberMidiCopyOutputPreference: (...args) =>
    rememberMidiCopyOutputPreference(...args),
  rememberPlaybackPreference: (...args) => rememberPlaybackPreference(...args),
  renderCapturedStats: (...args) => renderCapturedStats(...args),
  renderConstraintStatus: (...args) => renderConstraintStatus(...args),
  renderGeneratedStats: (...args) => renderGeneratedStats(...args),
  renderHistory: (...args) => renderHistory(...args),
  renderMemory: (...args) => renderMemory(...args),
  renderPerformanceState: (...args) => renderPerformanceState(...args),
  renderSavedSessions: (...args) => renderSavedSessions(...args),
  requestSessionMidiZip: (...args) => requestSessionMidiZip(...args),
  selectMidiCopyOutputPreference: (...args) =>
    selectMidiCopyOutputPreference(...args),
  selectPlaybackPreference: (...args) => selectPlaybackPreference(...args),
  selectedMidiCopyOutputId: (...args) => selectedMidiCopyOutputId(...args),
  selectedPlaybackChoiceValue: (...args) =>
    selectedPlaybackChoiceValue(...args),
  selectedSavedSession: (...args) => selectedSavedSession(...args),
  serverWaitLabel: (...args) => serverWaitLabel(...args),
  sessionDisplayName: (...args) => sessionDisplayName(...args),
  setAccountPanelOpen: (...args) => setAccountPanelOpen(...args),
  setAuthMessage: (...args) => setAuthMessage(...args),
  setControlView: (...args) => setControlView(...args),
  setPhraseMessage: (...args) => setPhraseMessage(...args),
  setPhraseStatus: (...args) => setPhraseStatus(...args),
  setSessionMidiSaveResult: (...args) => setSessionMidiSaveResult(...args),
  setSessionStatus: (...args) => setSessionStatus(...args),
  startServerWaitIndicator: (...args) => startServerWaitIndicator(...args),
  state,
  stopInfiniteMode: (...args) => stopInfiniteMode(...args),
  stopServerWaitIndicator: (...args) => stopServerWaitIndicator(...args),
  syncAuthUI: (...args) => syncAuthUI(...args),
  syncSettingsControls: (...args) => syncSettingsControls(...args),
  updateInfiniteActionState: (...args) => updateInfiniteActionState(...args),
  updateSessionActionState: (...args) => updateSessionActionState(...args),
  updateSessionGraphImage: (...args) => updateSessionGraphImage(...args),
  validateAuthCredentials: (...args) => validateAuthCredentials(...args),
  writeZipBlobToFileHandle: (...args) => writeZipBlobToFileHandle(...args),
});

const {
  midiOutputById,
  selectedPrimaryMidiOutputId,
  selectedMidiCopyOutputId,
  selectedMidiCopyOutput,
  midiCopyOutputLabel,
  selectedPlaybackChoiceValue,
  encodePlaybackChoice,
  parsePlaybackChoice,
  resolvePlaybackChoice,
  selectedPlaybackChoice,
  playbackChoiceLabel,
  createPlaybackSession,
  dispatchMidiEventToOutput,
  stopMidiOutputPlayback,
  stopMidiCopyPlayback,
  sendMidiPanicToOutput,
  sendPlaybackPanic,
  stopPlaybackVisualization,
  stopActivePlayback,
  dispatchPlaybackEvent,
  playPayload,
  stopInfiniteMode,
  stopLoopAndPlayback,
  startInfiniteMode,
} = createPlaybackController({
  applyContinuationPayload: (...args) => applyContinuationPayload(...args),
  applyGeneratedPhrasePayload: (...args) =>
    applyGeneratedPhrasePayload(...args),
  clearInfiniteScheduler: (...args) => clearInfiniteScheduler(...args),
  continuationHandoffMs: (...args) => continuationHandoffMs(...args),
  elements,
  infiniteLookaheadMs: (...args) => infiniteLookaheadMs(...args),
  latestLoopSeedPayload: (...args) => latestLoopSeedPayload(...args),
  localPlaybackRenderers,
  playbackRendererRegistry,
  preferredGenerationNoteCount: (...args) =>
    preferredGenerationNoteCount(...args),
  releaseRollAuditionNote: (...args) => releaseRollAuditionNote(...args),
  renderGeneratedStats: (...args) => renderGeneratedStats(...args),
  renderPerformanceState: (...args) => renderPerformanceState(...args),
  requestContinuationFromEvents: (...args) =>
    requestContinuationFromEvents(...args),
  requestMemoryGeneration: (...args) => requestMemoryGeneration(...args),
  rollAuditionOptions: (...args) => rollAuditionOptions(...args),
  rollCanvas: (...args) => rollCanvas(...args),
  scheduleVisibleSessionRefresh: (...args) =>
    scheduleVisibleSessionRefresh(...args),
  setPhraseMessage: (...args) => setPhraseMessage(...args),
  setPhraseStatus: (...args) => setPhraseStatus(...args),
  state,
  stopLiveMonitorPlayback: (...args) => stopLiveMonitorPlayback(...args),
  stopRollAudition: (...args) => stopRollAudition(...args),
  syncMemoryPlaybackState: (...args) => syncMemoryPlaybackState(...args),
  syncRollPlaybackState: (...args) => syncRollPlaybackState(...args),
  updateInfiniteActionState: (...args) => updateInfiniteActionState(...args),
});

const {
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
} = createMidiInput({
  createPlaybackSession: (...args) => createPlaybackSession(...args),
  currentMidiCopyOutputPreference: (...args) =>
    currentMidiCopyOutputPreference(...args),
  currentPlaybackPreference: (...args) => currentPlaybackPreference(...args),
  dispatchPlaybackEvent: (...args) => dispatchPlaybackEvent(...args),
  elements,
  populateMidiCopyOutputChoices: (...args) =>
    populateMidiCopyOutputChoices(...args),
  populatePlaybackChoices: (...args) => populatePlaybackChoices(...args),
  recorder,
  renderPerformanceState: (...args) => renderPerformanceState(...args),
  saveSessionPreferences: (...args) => saveSessionPreferences(...args),
  selectedMidiCopyRestoresPendingPreference: (...args) =>
    selectedMidiCopyRestoresPendingPreference(...args),
  selectedPlaybackChoice: (...args) => selectedPlaybackChoice(...args),
  selectedPlaybackRestoresPendingPreference: (...args) =>
    selectedPlaybackRestoresPendingPreference(...args),
  setLastMidiEvent: (...args) => setLastMidiEvent(...args),
  setMidiStatus: (...args) => setMidiStatus(...args),
  setPhraseMessage: (...args) => setPhraseMessage(...args),
  setPhraseStatus: (...args) => setPhraseStatus(...args),
  setSelectedInputName: (...args) => setSelectedInputName(...args),
  state,
  stopLoopAndPlayback: (...args) => stopLoopAndPlayback(...args),
  stopMidiCopyPlayback: (...args) => stopMidiCopyPlayback(...args),
  syncFaustRendererPanel: (...args) => syncFaustRendererPanel(...args),
});

initialize();
