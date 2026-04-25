const DEFAULT_PLAYBACK_CHOICE = "browser_triangle";
const FAUST_CLAVIER_ID = "faust_clavier";
const FAUST_CUSTOM_ID = "faust_custom";
const WEB_MIDI_RENDERER_ID = "web_midi";
const PLAYBACK_CHOICE_SEPARATOR = "::";
const PHRASE_TIMEOUT_MS = 1000;
const PLAYBACK_START_DELAY_MS = 80;
const INFINITE_MIN_LOOKAHEAD_MS = 600;
const INFINITE_MAX_LOOKAHEAD_MS = 2200;
const FAUST_WASM_ESM_URL = "/assets/vendor/faustwasm/esm/index.js";
const FAUST_WASM_JS_URL = "/assets/vendor/faustwasm/libfaust-wasm/libfaust-wasm.js";
const FAUST_WASM_DATA_URL = "/assets/vendor/faustwasm/libfaust-wasm/libfaust-wasm.data";
const FAUST_WASM_BINARY_URL = "/assets/vendor/faustwasm/libfaust-wasm/libfaust-wasm.wasm";
const FAUST_CLAVIER_DSP_URL = "/assets/faust/continuator-clavier.dsp";
const FAUST_CUSTOM_TEMPLATE_DSP_URL = "/assets/faust/custom-poly-template.dsp";
const PHRASE_TIMEOUT_STORAGE_KEY = "continuator.phrase.timeout.ms";
const FAUST_CUSTOM_SOURCE_STORAGE_KEY = "continuator.faust.custom.source";
const FAUST_CUSTOM_VALUES_STORAGE_KEY = "continuator.faust.custom.values";
const FAUST_UI_CONTROL_TYPES = new Set([
  "hslider",
  "vslider",
  "nentry",
  "checkbox",
  "button",
]);
const FAUST_POLY_RESERVED_SUFFIXES = [
  "/gate",
  "/freq",
  "/gain",
  "/key",
  "/vel",
  "/velocity",
];

const elements = {
  serverStatus: document.querySelector("#server-status"),
  controlWorkspace: document.querySelector(".control-workspace"),
  openReadmeButton: document.querySelector("#open-readme-button"),
  closeReadmeButton: document.querySelector("#close-readme-button"),
  readmePanel: document.querySelector("#readme-panel"),
  readmeOverlay: document.querySelector("#readme-overlay"),
  accountPanel: document.querySelector("#account-panel"),
  accountPanelCopy: document.querySelector("#account-panel-copy"),
  authStatus: document.querySelector("#auth-status"),
  authAvatar: document.querySelector("#auth-avatar"),
  authStatusLabel: document.querySelector("#auth-status-label"),
  authStatusCopy: document.querySelector("#auth-status-copy"),
  authUsernameInput: document.querySelector("#auth-username-input"),
  authPasswordInput: document.querySelector("#auth-password-input"),
  loginButton: document.querySelector("#login-button"),
  registerButton: document.querySelector("#register-button"),
  logoutButton: document.querySelector("#logout-button"),
  authSignedOutPanel: document.querySelector("#auth-signed-out-panel"),
  authSignedInPanel: document.querySelector("#auth-signed-in-panel"),
  accountOpenSessionsButton: document.querySelector("#account-open-sessions-button"),
  authMessageBox: document.querySelector("#auth-message-box"),
  authUserName: document.querySelector("#auth-user-name"),
  savedSessionCount: document.querySelector("#saved-session-count"),
  savedSessionsCopy: document.querySelector("#saved-sessions-copy"),
  mySessionsList: document.querySelector("#my-sessions-list"),
  refreshSessionsButton: document.querySelector("#refresh-sessions-button"),
  sessionStatus: document.querySelector("#session-status"),
  sessionId: document.querySelector("#session-id"),
  midiStatus: document.querySelector("#midi-status"),
  phraseStatus: document.querySelector("#phrase-status"),
  phraseGapMeter: document.querySelector("#phrase-gap-meter"),
  phraseGapMeterBar: document.querySelector("#phrase-gap-meter-bar"),
  phraseGapMeterCopy: document.querySelector("#phrase-gap-meter-copy"),
  selectedInputName: document.querySelector("#selected-input-name"),
  selectedOutputName: document.querySelector("#selected-output-name"),
  lastMidiEvent: document.querySelector("#last-midi-event"),
  capturedEventCount: document.querySelector("#captured-event-count"),
  capturedNoteCount: document.querySelector("#captured-note-count"),
  generatedEventCount: document.querySelector("#generated-event-count"),
  generatedNoteCount: document.querySelector("#generated-note-count"),
  messageBox: document.querySelector("#message-box"),
  historyList: document.querySelector("#history-list"),
  memoryList: document.querySelector("#memory-list"),
  memorySummary: document.querySelector("#memory-summary"),
  memoryHint: document.querySelector("#memory-hint"),
  memoryRibbon: document.querySelector("#memory-ribbon"),
  inputRoll: document.querySelector("#input-roll"),
  outputRoll: document.querySelector("#output-roll"),
  settingsSummary: document.querySelector("#settings-summary"),
  controlTabs: document.querySelectorAll("[data-control-tab]"),
  controlPanels: document.querySelectorAll("[data-control-panel]"),
  midiInputSelect: document.querySelector("#midi-input-select"),
  phraseTimeoutInput: document.querySelector("#phrase-timeout-input"),
  midiOutputSelect: document.querySelector("#midi-output-select"),
  faustRendererPanel: document.querySelector("#faust-renderer-panel"),
  faustClavierPanel: document.querySelector("#faust-clavier-panel"),
  faustCustomPanel: document.querySelector("#faust-custom-panel"),
  faustRendererStatus: document.querySelector("#faust-renderer-status"),
  faustRendererHint: document.querySelector("#faust-renderer-hint"),
  faustBrightnessInput: document.querySelector("#faust-brightness-input"),
  faustBrightnessValue: document.querySelector("#faust-brightness-value"),
  faustHardnessInput: document.querySelector("#faust-hardness-input"),
  faustHardnessValue: document.querySelector("#faust-hardness-value"),
  faustDampingInput: document.querySelector("#faust-damping-input"),
  faustDampingValue: document.querySelector("#faust-damping-value"),
  faustReleaseInput: document.querySelector("#faust-release-input"),
  faustReleaseValue: document.querySelector("#faust-release-value"),
  faustBodyInput: document.querySelector("#faust-body-input"),
  faustBodyValue: document.querySelector("#faust-body-value"),
  faustStereoInput: document.querySelector("#faust-stereo-input"),
  faustStereoValue: document.querySelector("#faust-stereo-value"),
  faustCustomCodeInput: document.querySelector("#faust-custom-code-input"),
  faustCustomCompileButton: document.querySelector("#faust-custom-compile-button"),
  faustCustomResetButton: document.querySelector("#faust-custom-reset-button"),
  faustCustomDirtyState: document.querySelector("#faust-custom-dirty-state"),
  faustCustomControls: document.querySelector("#faust-custom-controls"),
  faustCustomControlsHint: document.querySelector("#faust-custom-controls-hint"),
  learnInputToggle: document.querySelector("#learn-input-toggle"),
  autoSendToggle: document.querySelector("#auto-send-toggle"),
  transposeToggle: document.querySelector("#transpose-toggle"),
  forgetToggle: document.querySelector("#forget-toggle"),
  markovOrderInput: document.querySelector("#markov-order-input"),
  keepLastInput: document.querySelector("#keep-last-input"),
  decayModeSelect: document.querySelector("#decay-mode-select"),
  continuationLengthInput: document.querySelector("#continuation-length-input"),
  infiniteStateLabel: document.querySelector("#infinite-state-label"),
  infiniteSeedLabel: document.querySelector("#infinite-seed-label"),
  startInfiniteButton: document.querySelector("#start-infinite-button"),
  stopInfiniteButton: document.querySelector("#stop-infinite-button"),
  testNoteButton: document.querySelector("#test-note-button"),
  panicButton: document.querySelector("#panic-button"),
  createSessionButton: document.querySelector("#create-session-button"),
  resetSessionButton: document.querySelector("#reset-session-button"),
  applySettingsButton: document.querySelector("#apply-settings-button"),
  importMidiFilesButton: document.querySelector("#import-midi-files-button"),
  importMidiFolderButton: document.querySelector("#import-midi-folder-button"),
  midiImportInput: document.querySelector("#midi-import-input"),
  midiFolderImportInput: document.querySelector("#midi-folder-import-input"),
  connectMidiButton: document.querySelector("#connect-midi-button"),
  refreshMidiButton: document.querySelector("#refresh-midi-button"),
  sendPhraseButton: document.querySelector("#send-phrase-button"),
  generateMemoryButton: document.querySelector("#generate-memory-button"),
  replayGeneratedButton: document.querySelector("#replay-generated-button"),
  clearPhraseButton: document.querySelector("#clear-phrase-button"),
};

const state = {
  midiAccess: null,
  activeInputId: null,
  authUser: null,
  sessionId: null,
  sessionIsOwned: false,
  readmeOpen: false,
  accountPanelOpen: false,
  sessionConfiguration: null,
  lastCapturedPhrase: [],
  lastGeneratedPhrase: null,
  lastCapturedAt: 0,
  lastGeneratedAt: 0,
  historyItems: [],
  memoryItems: [],
  savedSessions: [],
  activeControlView: "perform",
  previewedHistoryIndex: null,
  previewedMemoryIndex: null,
  previewPulseTimeoutId: null,
  activePlayback: null,
  phraseGapAnimationFrameId: null,
  playbackVisualizationFrameId: null,
  playbackVisualizationStartTimerId: null,
  playbackVisualizationToken: 0,
  phraseTimeoutMs: PHRASE_TIMEOUT_MS,
  infiniteModeEnabled: false,
  infiniteRequestInFlight: false,
  infiniteScheduleTimerId: null,
  infiniteAbortController: null,
  infiniteRunId: 0,
  customFaustSource: "",
  customFaustTemplateSource: "",
  customFaustControlDescriptors: [],
  customFaustControlBindings: [],
};

function midiToFrequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

function createTriangleVoice(context, destination, note, velocity, at) {
  const oscillator = new OscillatorNode(context, {
    type: "triangle",
    frequency: midiToFrequency(note),
  });
  const gain = new GainNode(context, { gain: 0.0001 });
  oscillator.connect(gain).connect(destination);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(
    Math.max(0.03, (velocity / 127) * 0.2),
    at + 0.015,
  );
  oscillator.start(at);

  return {
    release(releaseAt, releaseSeconds = 0.08) {
      gain.gain.cancelScheduledValues(releaseAt);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), releaseAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + releaseSeconds);
      oscillator.stop(releaseAt + releaseSeconds + 0.02);
    },
  };
}

function createElectricVoice(context, destination, note, velocity, at) {
  const frequency = midiToFrequency(note);
  const filter = new BiquadFilterNode(context, {
    type: "lowpass",
    frequency: 3200,
    Q: 0.8,
  });
  const gain = new GainNode(context, { gain: 0.0001 });
  const bodyGain = new GainNode(context, { gain: 0.82 });
  const shimmerGain = new GainNode(context, { gain: 0.18 });
  const bodyOscillator = new OscillatorNode(context, {
    type: "triangle",
    frequency,
  });
  const shimmerOscillator = new OscillatorNode(context, {
    type: "sine",
    frequency: frequency * 2,
  });

  bodyOscillator.connect(bodyGain).connect(filter);
  shimmerOscillator.connect(shimmerGain).connect(filter);
  filter.connect(gain).connect(destination);

  const peak = Math.max(0.025, (velocity / 127) * 0.17);
  const sustain = Math.max(0.015, peak * 0.55);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(sustain, at + 0.12);
  filter.frequency.setValueAtTime(3200, at);
  filter.frequency.exponentialRampToValueAtTime(1500, at + 0.18);

  bodyOscillator.start(at);
  shimmerOscillator.start(at);

  return {
    release(releaseAt, releaseSeconds = 0.16) {
      gain.gain.cancelScheduledValues(releaseAt);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), releaseAt);
      gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + releaseSeconds);
      bodyOscillator.stop(releaseAt + releaseSeconds + 0.03);
      shimmerOscillator.stop(releaseAt + releaseSeconds + 0.03);
    },
  };
}

class BrowserAudioRenderer {
  constructor({
    id,
    label,
    masterGain = 0.18,
    createVoice,
    groupLabel = "Browser Renderers",
  }) {
    this.id = id;
    this.label = label;
    this.masterGain = masterGain;
    this.createVoice = createVoice;
    this.groupLabel = groupLabel;
    this.context = null;
    this.master = null;
    this.activeVoices = new Map();
  }

  async ensureContext() {
    if (!this.context) {
      this.context = new window.AudioContext();
      this.master = new GainNode(this.context, { gain: this.masterGain });
      this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  async createPlaybackSession() {
    await this.ensureContext();
    return {};
  }

  getDisplayName() {
    return this.label;
  }

  key(note, channel) {
    return `${channel}:${note}`;
  }

  noteOn(note, channel, velocity) {
    if (!this.context || !this.master) {
      return;
    }

    const at = this.context.currentTime + 0.001;
    const key = this.key(note, channel);
    const voice = this.createVoice(this.context, this.master, note, velocity, at);
    const existing = this.activeVoices.get(key) || [];
    existing.push(voice);
    this.activeVoices.set(key, existing);
  }

  noteOff(note, channel) {
    if (!this.context) {
      return;
    }

    const key = this.key(note, channel);
    const voices = this.activeVoices.get(key);
    if (!voices?.length) {
      return;
    }

    const voice = voices.shift();
    voice.release(this.context.currentTime + 0.001);
    if (!voices.length) {
      this.activeVoices.delete(key);
    }
  }

  dispatchEvent(playback, event) {
    if (event.type === "note_on" && event.velocity > 0) {
      this.noteOn(event.note, event.channel, event.velocity);
      return;
    }
    this.noteOff(event.note, event.channel);
  }

  stopVoices(releaseSeconds = 0.04) {
    if (!this.context) {
      return false;
    }

    const at = this.context.currentTime + 0.001;
    const hadVoices = this.activeVoices.size > 0;
    for (const voices of this.activeVoices.values()) {
      for (const voice of voices) {
        voice.release(at, releaseSeconds);
      }
    }
    this.activeVoices.clear();
    return hadVoices;
  }

  stopPlayback() {
    this.stopVoices(0.04);
  }

  panicPlayback() {
    return this.stopVoices(0.02);
  }

  panicTarget() {
    return this.stopVoices(0.02);
  }
}

function walkFaustUi(items, visit) {
  for (const item of items || []) {
    if (Array.isArray(item?.items)) {
      walkFaustUi(item.items, visit);
      continue;
    }
    visit(item);
  }
}

let faustApiPromise = null;
let faustCompilerBundlePromise = null;

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

function createFaustParamPathMap(ui) {
  const paramPaths = new Map();
  walkFaustUi(ui, (item) => {
    const shortname = String(item?.shortname || "");
    const address = String(item?.address || "");
    const label = String(item?.label || "");
    if (!address) {
      return;
    }
    paramPaths.set(address, address);
    if (shortname && !paramPaths.has(shortname)) {
      paramPaths.set(shortname, address);
    }
    if (label) {
      const labelTail = label.split("/").pop() || label;
      const simplifiedLabel = labelTail.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      if (labelTail && !paramPaths.has(labelTail)) {
        paramPaths.set(labelTail, address);
      }
      if (simplifiedLabel && !paramPaths.has(simplifiedLabel)) {
        paramPaths.set(simplifiedLabel, address);
      }
      const lowercaseLabel = simplifiedLabel.toLowerCase();
      if (lowercaseLabel && !paramPaths.has(lowercaseLabel)) {
        paramPaths.set(lowercaseLabel, address);
      }
    }
  });
  return paramPaths;
}

async function loadFaustApi() {
  if (!faustApiPromise) {
    faustApiPromise = import(FAUST_WASM_ESM_URL);
  }
  return faustApiPromise;
}

async function getFaustCompilerBundle() {
  if (!faustCompilerBundlePromise) {
    faustCompilerBundlePromise = (async () => {
      const api = await loadFaustApi();
      const faustModule = await api.instantiateFaustModuleFromFile(
        FAUST_WASM_JS_URL,
        FAUST_WASM_DATA_URL,
        FAUST_WASM_BINARY_URL,
      );
      return {
        api,
        compiler: new api.FaustCompiler(new api.LibFaust(faustModule)),
      };
    })();
  }
  return faustCompilerBundlePromise;
}

class FaustPolyRenderer {
  constructor({
    id,
    label,
    dspUrl,
    getCode = null,
    voices = 24,
    controlDefaults = {},
    groupLabel = "Faust Instruments",
    idleDetail = "Ready when you route playback here.",
  }) {
    this.id = id;
    this.label = label;
    this.dspUrl = dspUrl;
    this.getCode = getCode;
    this.voices = voices;
    this.groupLabel = groupLabel;
    this.context = null;
    this.generator = null;
    this.node = null;
    this.codePromise = null;
    this.initializationPromise = null;
    this.paramPaths = new Map();
    this.controlValues = new Map(Object.entries(controlDefaults));
    this.ui = [];
    this.status = "Idle";
    this.statusDetail = idleDetail;
    this.lastError = null;
    this.lastCompiledCode = null;
  }

  getDisplayName() {
    return this.label;
  }

  setStatus(status, detail) {
    this.status = status;
    if (detail != null) {
      this.statusDetail = detail;
    }
    syncFaustRendererPanel();
  }

  async ensureContext() {
    if (!this.context) {
      this.context = new window.AudioContext();
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  async loadCode(forceRefresh = false) {
    if (this.getCode) {
      const code = await this.getCode();
      if (!String(code || "").trim()) {
        throw new Error("No Faust DSP source is available.");
      }
      return code;
    }

    if (!this.codePromise || forceRefresh) {
      this.codePromise = fetch(this.dspUrl).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Unable to load the Faust DSP (${response.status}).`);
        }
        return response.text();
      });
    }
    return this.codePromise;
  }

  captureParamPaths(ui) {
    this.paramPaths = createFaustParamPathMap(ui);
  }

  applyControlValues() {
    if (!this.node) {
      return;
    }

    this.controlValues.forEach((value, key) => {
      const path = this.paramPaths.get(key);
      if (path) {
        this.node.setParamValue(path, Number(value));
      }
    });
  }

  getUi() {
    return this.ui;
  }

  async ensureNode({ forceRecompile = false } = {}) {
    await this.ensureContext();
    if (this.node && !forceRecompile) {
      return this.node;
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    const previousNode = this.node;
    const previousGenerator = this.generator;
    const previousUi = this.ui;
    const previousParamPaths = this.paramPaths;
    this.initializationPromise = (async () => {
      this.lastError = null;
      this.setStatus("Loading", `Compiling ${this.label}…`);
      const [{ api, compiler }, code] = await Promise.all([
        getFaustCompilerBundle(),
        this.loadCode(forceRecompile),
      ]);
      const generator = new api.FaustPolyDspGenerator();
      const compiledGenerator = await generator.compile(compiler, this.id, code, "-ftz 2");
      if (!compiledGenerator) {
        throw new Error("Faust compilation returned no renderer.");
      }
      const nextNode = await compiledGenerator.createNode(this.context, this.voices, this.id);
      if (!nextNode) {
        throw new Error("Faust could not create a playable WebAudio node.");
      }
      nextNode.connect(this.context.destination);
      const nextUi = compiledGenerator.getUI();
      const nextParamPaths = createFaustParamPathMap(nextUi);
      this.generator = compiledGenerator;
      this.node = nextNode;
      this.ui = nextUi;
      this.paramPaths = nextParamPaths;
      this.lastCompiledCode = code;
      this.applyControlValues();
      if (previousNode && previousNode !== nextNode) {
        previousNode.allNotesOff?.(true);
        previousNode.disconnect?.();
      }
      this.setStatus("Ready", `${this.voices} polyphonic voices are ready.`);
      return nextNode;
    })()
      .catch((error) => {
        if (this.node && this.node !== previousNode) {
          this.node.allNotesOff?.(true);
          this.node.disconnect?.();
        }
        this.node = previousNode;
        this.generator = previousGenerator;
        this.ui = previousUi;
        this.paramPaths = previousParamPaths;
        this.lastError = error instanceof Error ? error : new Error(String(error));
        this.setStatus("Error", this.lastError.message);
        throw this.lastError;
      })
      .finally(() => {
        this.initializationPromise = null;
      });

    return this.initializationPromise;
  }

  async prepare(options = {}) {
    await this.ensureNode(options);
  }

  setControlValue(key, value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return;
    }

    this.controlValues.set(key, numericValue);
    const path = this.paramPaths.get(key);
    if (this.node && path) {
      this.node.setParamValue(path, numericValue);
    }
    syncFaustRendererPanel();
  }

  getControlValue(key) {
    return Number(this.controlValues.get(key));
  }

  async createPlaybackSession() {
    const node = await this.ensureNode();
    return { node };
  }

  dispatchEvent(playback, event) {
    if (!playback?.node) {
      return;
    }

    if (event.type === "note_on" && event.velocity > 0) {
      playback.node.keyOn(event.channel, event.note, event.velocity);
      return;
    }

    playback.node.keyOff(event.channel, event.note, event.velocity || 0);
  }

  stopPlayback(playback) {
    playback?.node?.allNotesOff?.(false);
  }

  panicPlayback(playback) {
    if (!playback?.node) {
      return false;
    }
    playback.node.allNotesOff?.(true);
    return true;
  }

  panicTarget() {
    if (!this.node) {
      return false;
    }
    this.node.allNotesOff?.(true);
    return true;
  }
}

class PhraseRecorder {
  constructor(timeoutMs, onUpdate, onComplete, onGapUpdate = null) {
    this.timeoutMs = timeoutMs;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.onGapUpdate = onGapUpdate;
    this.reset();
  }

  setTimeoutMs(timeoutMs) {
    this.timeoutMs = timeoutMs;
    if (!this.events.length || this.lastTimestamp == null || this.pendingNotes.size) {
      return;
    }
    this.scheduleCompletionCheck(window.performance.now());
  }

  reset() {
    this.events = [];
    this.pendingNotes = new Set();
    this.lastTimestamp = null;
    if (this.timer) {
      window.clearTimeout(this.timer);
    }
    this.timer = null;
    this.onGapUpdate?.({ active: false });
  }

  snapshot() {
    return this.events.map((event) => ({ ...event }));
  }

  handleMessage(messageEvent) {
    const [statusByte, note, rawVelocity = 0] = [...messageEvent.data];
    const status = statusByte & 0xf0;
    const channel = statusByte & 0x0f;
    let type = null;
    let velocity = rawVelocity;

    if (status === 0x90 && velocity > 0) {
      type = "note_on";
    } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      type = "note_off";
      velocity = 0;
    } else {
      return;
    }

    const timestamp =
      typeof messageEvent.receivedTime === "number"
        ? messageEvent.receivedTime
        : window.performance.now();
    const deltaSeconds =
      this.lastTimestamp == null
        ? 0
        : Math.max(0, (timestamp - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestamp;

    const event = {
      type,
      note,
      velocity,
      channel,
      delta_seconds: roundNumber(deltaSeconds),
    };

    const key = `${channel}:${note}`;
    if (type === "note_on") {
      this.pendingNotes.add(key);
      this.onGapUpdate?.({ active: false });
    } else {
      this.pendingNotes.delete(key);
    }

    this.events.push(event);
    this.onUpdate?.(this.snapshot(), false);
    this.scheduleCompletionCheck(timestamp);
  }

  scheduleCompletionCheck(nowTimestamp) {
    if (this.timer) {
      window.clearTimeout(this.timer);
    }

    if (!this.events.length || this.lastTimestamp == null) {
      return;
    }

    if (this.pendingNotes.size) {
      this.onGapUpdate?.({ active: false });
      return;
    }

    const elapsed = nowTimestamp - this.lastTimestamp;
    if (elapsed >= this.timeoutMs) {
      this.completePhrase();
      return;
    }

    this.onGapUpdate?.({
      active: true,
      startedAtMs: this.lastTimestamp,
      timeoutMs: this.timeoutMs,
    });
    this.timer = window.setTimeout(() => {
      this.completePhrase();
    }, this.timeoutMs - elapsed);
  }

  completePhrase() {
    if (!this.events.length || this.pendingNotes.size || this.lastTimestamp == null) {
      return;
    }

    const nowTimestamp = window.performance.now();
    const elapsed = nowTimestamp - this.lastTimestamp;
    if (elapsed < this.timeoutMs) {
      this.scheduleCompletionCheck(nowTimestamp);
      return;
    }

    const phrase = this.snapshot();
    this.reset();
    this.onComplete?.(phrase);
    this.onUpdate?.(phrase, true);
  }
}

const browserPlaybackRenderers = [
  new BrowserAudioRenderer({
    id: "browser_triangle",
    label: "Browser Triangle",
    masterGain: 0.18,
    createVoice: createTriangleVoice,
  }),
  new BrowserAudioRenderer({
    id: "browser_electric",
    label: "Browser Electric",
    masterGain: 0.16,
    createVoice: createElectricVoice,
  }),
];

const faustClavierRenderer = new FaustPolyRenderer({
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
  id: FAUST_CUSTOM_ID,
  label: "Custom Faust",
  getCode: async () => {
    if (state.customFaustSource.trim()) {
      return state.customFaustSource;
    }
    return loadCustomFaustTemplate();
  },
  voices: 24,
  idleDetail: "Paste or edit a polyphonic Faust instrument, then compile it locally.",
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
    const status =
      event.type === "note_on" && event.velocity > 0
        ? 0x90 | (event.channel & 0x0f)
        : 0x80 | (event.channel & 0x0f);
    sendOutputMessage(playback.output, [status, event.note, event.velocity]);

    const key = outputNoteKey(event.note, event.channel);
    if (event.type === "note_on" && event.velocity > 0) {
      playback.activeOutputNotes.add(key);
    } else {
      playback.activeOutputNotes.delete(key);
    }
  },

  stopPlayback(playback) {
    if (!playback.output) {
      return;
    }

    playback.activeOutputNotes.forEach((key) => {
      const [channelRaw, noteRaw] = key.split(":");
      const channel = Number(channelRaw);
      const note = Number(noteRaw);
      sendOutputMessage(playback.output, [0x80 | (channel & 0x0f), note, 0]);
    });
    sendMidiPanicToOutput(playback.output);
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
  (events, completed) => {
    const notes = eventsToNotes(events);
    renderCapturedStats(events, notes, completed);
  },
  async (phrase) => {
    rememberCapturedPhrase(phrase);
    const notes = eventsToNotes(phrase);
    renderCapturedStats(phrase, notes, true);
    setPhraseMessage(
      `Phrase complete: ${phrase.length} events / ${notes.length} notes captured.`,
    );
    if (elements.autoSendToggle.checked) {
      await sendCurrentPhrase();
    }
  },
  updatePhraseGapCountdown,
);

function roundNumber(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatDurationSeconds(value) {
  const duration = Number(value) || 0;
  return duration >= 10 ? `${duration.toFixed(0)}s` : `${duration.toFixed(1)}s`;
}

function stopPhraseGapCountdown() {
  if (state.phraseGapAnimationFrameId) {
    window.cancelAnimationFrame(state.phraseGapAnimationFrameId);
    state.phraseGapAnimationFrameId = null;
  }
  elements.phraseGapMeter.hidden = true;
  elements.phraseGapMeterBar.style.width = "0%";
}

function updatePhraseGapCountdown(update) {
  if (!update?.active) {
    stopPhraseGapCountdown();
    return;
  }

  const startedAtMs = Number(update.startedAtMs);
  const timeoutMs = Math.max(1, Number(update.timeoutMs) || state.phraseTimeoutMs);
  if (!Number.isFinite(startedAtMs)) {
    stopPhraseGapCountdown();
    return;
  }

  if (state.phraseGapAnimationFrameId) {
    window.cancelAnimationFrame(state.phraseGapAnimationFrameId);
  }

  elements.phraseGapMeter.hidden = false;
  const tick = () => {
    const elapsedMs = Math.max(0, window.performance.now() - startedAtMs);
    const remainingMs = Math.max(0, timeoutMs - elapsedMs);
    const progress = Math.min(1, elapsedMs / timeoutMs);
    elements.phraseGapMeterBar.style.width = `${Math.round(progress * 100)}%`;
    elements.phraseGapMeterCopy.textContent = `${(remainingMs / 1000).toFixed(1)}s`;
    setPhraseStatus(remainingMs > 0 ? "Closing phrase" : "Phrase ready");

    if (remainingMs <= 0) {
      state.phraseGapAnimationFrameId = null;
      return;
    }
    state.phraseGapAnimationFrameId = window.requestAnimationFrame(tick);
  };

  tick();
}

function setPhraseMessage(message, danger = false) {
  elements.messageBox.textContent = message;
  elements.messageBox.style.color = danger ? "var(--danger)" : "var(--muted)";
}

function setAuthMessage(message, danger = false) {
  elements.authMessageBox.textContent = message;
  elements.authMessageBox.style.color = danger ? "var(--danger)" : "var(--muted)";
}

function pluralize(value, singular, plural = `${singular}s`) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function rememberCapturedPhrase(events) {
  state.lastCapturedPhrase = Array.isArray(events) ? events : [];
  state.lastCapturedAt = Date.now();
  updateInfiniteActionState();
}

function rememberGeneratedPhrase(payload) {
  state.lastGeneratedPhrase = payload || null;
  state.lastGeneratedAt = Date.now();
  updateInfiniteActionState();
}

function clearRememberedPhrases() {
  state.lastCapturedPhrase = [];
  state.lastGeneratedPhrase = null;
  state.lastCapturedAt = 0;
  state.lastGeneratedAt = 0;
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
    return Math.max(1, eventsToNotes(referenceEvents).length);
  }

  if (state.lastGeneratedPhrase?.note_count) {
    return Math.max(1, Number(state.lastGeneratedPhrase.note_count));
  }

  if (state.lastCapturedPhrase.length) {
    return Math.max(1, eventsToNotes(state.lastCapturedPhrase).length);
  }

  return 12;
}

function renderAccountTrigger() {
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
  elements.authStatus.title = "Guest mode. Click to sign in or create an account.";
  elements.authAvatar.textContent = "G";
  elements.authStatusLabel.textContent = "Guest mode";
  elements.authStatusCopy.textContent = "Click to sign in";
}

function setReadmeOpen(open) {
  state.readmeOpen = open;
  elements.readmePanel.hidden = !open;
  elements.readmeOverlay.hidden = !open;
  elements.openReadmeButton.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("sheet-open", open);
  if (open) {
    setAccountPanelOpen(false);
    window.requestAnimationFrame(() => {
      elements.closeReadmeButton?.focus();
    });
  }
}

function setAccountPanelOpen(open) {
  state.accountPanelOpen = open;
  elements.accountPanel.hidden = !open;
  elements.authStatus.setAttribute("aria-expanded", String(open));
  elements.authStatus.classList.toggle("is-open", open);
  if (open) {
    const focusTarget = state.authUser
      ? elements.accountOpenSessionsButton
      : elements.authUsernameInput;
    window.requestAnimationFrame(() => {
      focusTarget?.focus();
    });
  }
}

function setSessionStatus(label) {
  elements.sessionStatus.textContent = label;
}

function setMidiStatus(label) {
  elements.midiStatus.textContent = label;
}

function setPhraseStatus(label) {
  elements.phraseStatus.textContent = label;
}

function setSelectedInputName(label) {
  elements.selectedInputName.textContent = label;
}

function setSelectedOutputName(label) {
  elements.selectedOutputName.textContent = label;
}

function setLastMidiEvent(label) {
  elements.lastMidiEvent.textContent = label;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const rawText = await response.text();
  let payload = null;

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = rawText;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !String(url).includes("/api/auth/")) {
      state.authUser = null;
      syncAuthUI();
      renderSavedSessions([]);
      clearCurrentSessionState("Your sign-in expired. Sign in again to reopen sessions.");
    }
    const detailList =
      payload && typeof payload === "object" && Array.isArray(payload.detail)
        ? payload.detail
            .map((item) => (typeof item?.msg === "string" ? item.msg : null))
            .filter(Boolean)
        : [];
    const detail =
      payload && typeof payload === "object" && typeof payload.detail === "string"
        ? payload.detail
        : detailList.length
          ? detailList.join(" ")
        : typeof payload === "string"
          ? payload
          : `Request failed (${response.status}).`;
    throw new Error(detail);
  }

  return payload;
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

function applyPhraseTimeoutSetting(value, { persist = true, announce = false } = {}) {
  const timeoutMs = normalizedPhraseTimeoutMs(value);
  state.phraseTimeoutMs = timeoutMs;
  elements.phraseTimeoutInput.value = formatPhraseTimeoutSeconds(timeoutMs);
  recorder.setTimeoutMs(timeoutMs);
  if (persist) {
    safeLocalStorageSet(PHRASE_TIMEOUT_STORAGE_KEY, String(timeoutMs / 1000));
  }
  if (announce) {
    setPhraseMessage(`Phrase gap set to ${formatPhraseTimeoutSeconds(timeoutMs)}s.`);
  }
}

function initializePhraseTimeoutSetting() {
  const storedValue = safeLocalStorageGet(PHRASE_TIMEOUT_STORAGE_KEY);
  applyPhraseTimeoutSetting(
    storedValue ?? String(PHRASE_TIMEOUT_MS / 1000),
    { persist: false },
  );
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
    throw new Error("Username can only use letters, digits, underscores, dots, or dashes.");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  return { username, password };
}

function hasLoopSeedPhrase() {
  return Boolean(state.lastCapturedPhrase.length || state.lastGeneratedPhrase?.events?.length);
}

function describeLoopSeed() {
  if (state.activePlayback && state.lastGeneratedPhrase?.events?.length) {
    return `Seed: playing ${pluralize(state.lastGeneratedPhrase.note_count || 0, "generated note")}`;
  }
  if (state.lastGeneratedPhrase?.events?.length && state.lastGeneratedAt >= state.lastCapturedAt) {
    return `Seed: last continuation (${pluralize(state.lastGeneratedPhrase.note_count || 0, "note")})`;
  }
  if (state.lastCapturedPhrase.length) {
    return `Seed: captured phrase (${pluralize(eventsToNotes(state.lastCapturedPhrase).length, "note")})`;
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

function readSessionSettingsFromControls() {
  return {
    learn_input: elements.learnInputToggle.checked,
    transposition: elements.transposeToggle.checked,
    forget_past: elements.forgetToggle.checked,
    markov_order: normalizedMarkovOrder(elements.markovOrderInput.value),
    keep_last_inputs: normalizedKeepLastInputs(elements.keepLastInput.value),
    decay_mode: elements.decayModeSelect.value,
  };
}

function describeSessionSettings(settings) {
  const orderLabel = `K=${settings.markov_order}`;
  const transposeLabel = settings.transposition ? "Transpose on" : "Transpose off";
  const memoryLabel = settings.forget_past
    ? `Keep last ${settings.keep_last_inputs} phrases`
    : "Keep full memory";
  const decayLabel = `Decay ${settings.decay_mode}`;
  return [orderLabel, transposeLabel, memoryLabel, decayLabel];
}

function renderSessionSettingsSummary() {
  const labels = describeSessionSettings(readSessionSettingsFromControls());
  elements.settingsSummary.innerHTML = labels
    .map((label) => `<span class="settings-chip">${label}</span>`)
    .join("");
}

function updateKeepLastFieldState() {
  const enabled = elements.forgetToggle.checked;
  elements.keepLastInput.disabled = !enabled;
}

function syncSettingsControls(configuration) {
  if (!configuration) {
    return;
  }

  state.sessionConfiguration = configuration;
  elements.learnInputToggle.checked = configuration.learn_input;
  elements.transposeToggle.checked = configuration.transposition;
  elements.forgetToggle.checked = configuration.forget_past;
  elements.markovOrderInput.value = String(
    normalizedMarkovOrder(configuration.markov_order),
  );
  elements.keepLastInput.value = String(configuration.keep_last_inputs);
  elements.decayModeSelect.value = configuration.decay_mode;
  updateKeepLastFieldState();
  renderSessionSettingsSummary();
}

function updateSessionActionState() {
  elements.createSessionButton.disabled = false;
  elements.resetSessionButton.disabled = !state.sessionId;
  elements.applySettingsButton.disabled = !state.sessionId;
}

function updateAuthActionState() {
  const signedIn = Boolean(state.authUser);
  elements.authUsernameInput.disabled = signedIn;
  elements.authPasswordInput.disabled = signedIn;
  elements.loginButton.disabled = signedIn;
  elements.registerButton.disabled = signedIn;
  elements.logoutButton.disabled = !signedIn;
  elements.refreshSessionsButton.disabled = !signedIn;
  elements.accountOpenSessionsButton.disabled = !signedIn;
}

function formatTimestamp(value) {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function clearPhraseBuffers() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  stopPhraseGapCountdown();
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
  elements.sessionId.textContent = "Open or create a session";
  clearPhraseBuffers();
  renderHistory([]);
  renderMemory(null);
  setSessionStatus("No session");
  updateSessionActionState();
  if (message) {
    setPhraseMessage(message);
  }
}

function createSavedSessionsMarkup(items) {
  if (!state.authUser) {
    return `<p class="muted">Use the account control above to sign in and load your saved sessions.</p>`;
  }
  if (!items.length) {
    return `<p class="muted">No saved sessions yet. Create one, play a phrase, and it will appear here.</p>`;
  }

  return items
    .map((item) => {
      const current = item.session_id === state.sessionId;
      const stateLabel = current ? "current" : item.loaded ? "live" : "saved";
      const activityLabel = `${item.active_learned_phrase_count} learned active · ${item.phrase_count} logged`;
      const resetLabel = item.last_reset_at
        ? ` · Reset ${formatTimestamp(item.last_reset_at)}`
        : "";
      const settingsLabel = describeSessionSettings(item.configuration).join(" · ");
      return `
        <button
          class="history-item session-item ${current ? "is-selected" : ""}"
          data-owned-session-id="${item.session_id}"
          type="button"
        >
          <span class="history-kind">${stateLabel}</span>
          <span class="history-meta">
            <strong>${activityLabel}</strong>
            <span>Seen ${formatTimestamp(item.last_seen_at)}${resetLabel}</span>
            <span>${settingsLabel}</span>
          </span>
          <span class="history-index">${current ? "current" : "open"}</span>
        </button>
      `;
    })
    .join("");
}

function attachSavedSessionEvents() {
  elements.mySessionsList.querySelectorAll("[data-owned-session-id]").forEach((node) => {
    node.addEventListener("click", async () => {
      try {
        await openSavedSession(node.dataset.ownedSessionId);
      } catch (error) {
        setAuthMessage(error.message, true);
      }
    });
  });
}

function renderSavedSessions(items) {
  state.savedSessions = items;
  elements.mySessionsList.innerHTML = createSavedSessionsMarkup(items);
  elements.savedSessionCount.textContent = state.authUser
    ? `${items.length} saved`
    : "Guest mode";
  elements.savedSessionsCopy.textContent = state.authUser
    ? "Open any session to rebuild its live memory from learned input phrases."
    : "Use the account control above to sign in, then reopen saved sessions here.";
  renderAccountTrigger();
  attachSavedSessionEvents();
}

function syncAuthUI() {
  const user = state.authUser;
  renderAccountTrigger();
  elements.accountPanelCopy.textContent = user
    ? "Manage your signed-in account here, then jump to your saved sessions when you want to reopen a prior memory."
    : "Guest mode works immediately. Sign in only if you want your sessions saved and reopenable.";
  elements.authUserName.textContent = user ? user.username : "Not signed in";
  elements.authSignedOutPanel.hidden = Boolean(user);
  elements.authSignedInPanel.hidden = !user;
  elements.authPasswordInput.value = "";
  setAuthMessage(
    user
      ? `Signed in as ${user.username}. New sessions will be saved under this account.`
      : "Guest mode is ready. Sign in only if you want saved sessions.",
  );
  updateAuthActionState();
  updateSessionActionState();
}

function setControlView(view) {
  state.activeControlView = view;
  elements.controlTabs.forEach((node) => {
    const active = node.dataset.controlTab === view;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
  elements.controlPanels.forEach((node) => {
    node.hidden = node.dataset.controlPanel !== view;
  });
}

function syncPreviewSelection() {
  elements.historyList.querySelectorAll("[data-history-index]").forEach((node) => {
    node.classList.toggle(
      "is-selected",
      Number(node.dataset.historyIndex) === state.previewedHistoryIndex,
    );
  });

  const isSelectedMemoryIndex = (node) =>
    Number(node.dataset.memoryIndex) === state.previewedMemoryIndex;

  elements.memoryList.querySelectorAll("[data-memory-index]").forEach((node) => {
    node.classList.toggle("is-selected", isSelectedMemoryIndex(node));
  });

  elements.memoryRibbon.querySelectorAll("[data-memory-index]").forEach((node) => {
    node.classList.toggle("is-selected", isSelectedMemoryIndex(node));
  });
}

function revealPreviewTarget(kind) {
  const target = kind === "generated" ? elements.outputRoll : elements.inputRoll;
  elements.inputRoll.classList.remove("is-previewing");
  elements.outputRoll.classList.remove("is-previewing");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  void target.offsetWidth;
  target.classList.add("is-previewing");
  if (state.previewPulseTimeoutId) {
    window.clearTimeout(state.previewPulseTimeoutId);
  }
  state.previewPulseTimeoutId = window.setTimeout(() => {
    target.classList.remove("is-previewing");
    state.previewPulseTimeoutId = null;
  }, 900);
}

function previewPhrasePayload(payload, kind, message) {
  if (kind === "generated") {
    rememberGeneratedPhrase(payload);
    renderGeneratedStats(payload);
  } else {
    rememberCapturedPhrase(payload.events);
    renderCapturedStats(payload.events, payload.notes, true);
  }
  setPhraseMessage(message);
  revealPreviewTarget(kind);
}

function renderCapturedStats(events, notes, completed) {
  elements.capturedEventCount.textContent = String(events.length);
  elements.capturedNoteCount.textContent = String(notes.length);
  setPhraseStatus(completed ? "Phrase ready" : "Listening");
  drawPianoRoll(elements.inputRoll, notes, "#6dd3ce", "Input phrase");
}

function renderGeneratedStats(payload) {
  elements.generatedEventCount.textContent = String(payload?.event_count || 0);
  elements.generatedNoteCount.textContent = String(payload?.note_count || 0);
  drawPianoRoll(
    elements.outputRoll,
    payload?.notes || [],
    "#f4a261",
    "Generated continuation",
  );
}

function createHistoryMarkup(items) {
  if (!items.length) {
    if (!state.sessionId) {
      return `<p class="muted">Create a session to start building history. Sign in if you want it saved under your account.</p>`;
    }
    return `<p class="muted">No phrases logged yet for this session.</p>`;
  }

  return items
    .map(
      (item, index) => `
        <button class="history-item" data-history-index="${index}" type="button">
          <span class="history-kind">${item.kind}</span>
          <span class="history-meta">
            <strong>${item.note_count} notes / ${item.event_count} events</strong>
            <span>${item.created_at}</span>
          </span>
          <span class="history-index">open</span>
        </button>
      `,
    )
    .join("");
}

function attachHistoryEvents() {
  elements.historyList.querySelectorAll("[data-history-index]").forEach((node) => {
    node.addEventListener("click", () => {
      const historyIndex = Number(node.dataset.historyIndex);
      const item = state.historyItems[historyIndex];
      if (!item) {
        return;
      }

      state.previewedHistoryIndex = historyIndex;
      state.previewedMemoryIndex = null;
      syncPreviewSelection();
      previewPhrasePayload(item.payload, item.kind, `Previewing ${item.kind} phrase from ${item.created_at}.`);
    });
  });
}

function renderHistory(items) {
  state.historyItems = items;
  elements.historyList.innerHTML = createHistoryMarkup(items);
  attachHistoryEvents();
  syncPreviewSelection();
}

function createMemorySummaryMarkup(memory) {
  if (!memory) {
    return `<span class="settings-chip">No style memory yet</span>`;
  }

  const chips = [
    `${memory.summary.active_phrase_count} active sequences`,
    `${memory.summary.live_phrase_count} live`,
  ];
  if (memory.summary.seeded_phrase_count) {
    chips.push(`${memory.summary.seeded_phrase_count} seed`);
  }
  chips.push(`K=${memory.configuration.markov_order}`);
  chips.push(memory.configuration.transposition ? "Transpose on" : "Transpose off");
  chips.push(
    memory.configuration.forget_past
      ? `Keep last ${memory.configuration.keep_last_inputs}`
      : "Keep full memory",
  );
  chips.push(`Decay ${memory.configuration.decay_mode}`);

  return chips.map((label) => `<span class="settings-chip">${label}</span>`).join("");
}

function createMemoryHint(memory) {
  if (!memory) {
    return "Create or open a session and play a phrase to build the Continuator style memory.";
  }
  if (!memory.summary.active_phrase_count) {
    return memory.configuration.transposition
      ? "No style phrases yet. When transpose is on, each learned phrase can appear as several active transposed variants."
      : "No style phrases yet. Play a phrase to start filling the Continuator vocabulary.";
  }
  return memory.configuration.transposition
    ? "The ribbon reads oldest to newest. The list below starts with the newest active phrase, and transposed variants appear separately when transpose is enabled."
    : "The ribbon reads oldest to newest. Preview or play any phrase in the current style memory.";
}

function createMemoryRibbonMarkup(items) {
  if (!items.length) {
    return "";
  }

  return items
    .map((item, index) => {
      const opacity = roundNumber(0.3 + ((index + 1) / items.length) * 0.6);
      return `
        <button
          class="memory-ribbon-cell ${item.source}"
          data-memory-index="${index}"
          type="button"
          title="Slot ${item.slot}: ${item.note_count} notes"
          style="opacity: ${opacity};"
        ></button>
      `;
    })
    .join("");
}

function createMemoryMarkup(items) {
  if (!items.length) {
    return `<p class="muted">No style memory to show yet.</p>`;
  }

  return items
    .slice()
    .reverse()
    .map((item) => {
      const itemLabel = item.source === "seed" ? "Seed" : "Live";
      return `
        <div class="history-item memory-item" data-memory-index="${item.slot - 1}">
          <button class="memory-preview-button" data-memory-preview-index="${item.slot - 1}" type="button">
            <span class="history-kind">${itemLabel} #${item.slot}</span>
            <span class="history-meta">
              <strong>${item.note_count} notes / ${formatDurationSeconds(item.duration_seconds)}</strong>
              <span>Active phrase ${item.slot} in the current style memory</span>
            </span>
          </button>
          <button class="ghost memory-play-button" data-memory-play-index="${item.slot - 1}" type="button">
            Play
          </button>
        </div>
      `;
    })
    .join("");
}

function attachMemoryEvents() {
  const previewMemoryIndex = (rawIndex) => {
    const memoryIndex = Number(rawIndex);
    const item = state.memoryItems[memoryIndex];
    if (!item) {
      return;
    }
    state.previewedMemoryIndex = memoryIndex;
    state.previewedHistoryIndex = null;
    syncPreviewSelection();
    previewPhrasePayload(
      item.payload,
      "input",
      `Opened ${item.source} memory slot ${item.slot} in Captured Phrase.`,
    );
  };

  const playMemoryIndex = async (rawIndex) => {
    const memoryIndex = Number(rawIndex);
    const item = state.memoryItems[memoryIndex];
    if (!item?.payload?.events?.length) {
      setPhraseMessage("That memory phrase has no playable events.", true);
      return;
    }
    previewMemoryIndex(rawIndex);
    try {
      stopInfiniteMode({ stopPlayback: true, silent: true });
      await playPayload(item.payload);
      setPhraseMessage(`Playing ${item.source} memory slot ${item.slot}.`);
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  };

  elements.memoryList.querySelectorAll("[data-memory-preview-index]").forEach((node) => {
    node.addEventListener("click", () => {
      previewMemoryIndex(node.dataset.memoryPreviewIndex);
    });
  });

  elements.memoryList.querySelectorAll("[data-memory-play-index]").forEach((node) => {
    node.addEventListener("click", () => {
      void playMemoryIndex(node.dataset.memoryPlayIndex);
    });
  });

  elements.memoryRibbon.querySelectorAll("[data-memory-index]").forEach((node) => {
    node.addEventListener("click", () => {
      previewMemoryIndex(node.dataset.memoryIndex);
    });
  });
}

function renderMemory(memory) {
  state.memoryItems = memory?.items || [];
  elements.memorySummary.innerHTML = createMemorySummaryMarkup(memory);
  elements.memoryHint.textContent = createMemoryHint(memory);
  elements.memoryRibbon.innerHTML = createMemoryRibbonMarkup(state.memoryItems);
  elements.memoryList.innerHTML = createMemoryMarkup(state.memoryItems);
  attachMemoryEvents();
  syncPreviewSelection();
}

function drawPianoRoll(canvas, notes, accent, emptyLabel, options = {}) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width || 640));
  const height = Math.max(180, Math.floor(rect.height || 244));
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, "rgba(255, 255, 255, 0.06)");
  background.addColorStop(1, "rgba(255, 255, 255, 0.015)");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  for (let index = 1; index < 8; index += 1) {
    const x = (index / 8) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let index = 1; index < 6; index += 1) {
    const y = (index / 6) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (!notes?.length) {
    ctx.fillStyle = "rgba(236, 244, 239, 0.45)";
    ctx.font = '600 14px "Avenir Next", "Segoe UI Variable", sans-serif';
    ctx.fillText(emptyLabel, 20, height / 2);
    return;
  }

  const minPitch = Math.max(24, Math.min(...notes.map((note) => note.pitch)) - 2);
  const maxPitch = Math.min(108, Math.max(...notes.map((note) => note.pitch)) + 2);
  const totalDuration = Math.max(
    2,
    ...notes.map((note) => note.end_seconds || note.start_seconds + note.duration_seconds),
  );
  const pitchRange = Math.max(1, maxPitch - minPitch + 1);

  const playbackSeconds =
    Number.isFinite(Number(options.playbackSeconds)) ? Number(options.playbackSeconds) : null;

  for (const note of notes) {
    const noteEndSeconds = note.end_seconds || note.start_seconds + note.duration_seconds;
    const isPlaying =
      playbackSeconds != null &&
      playbackSeconds >= note.start_seconds &&
      playbackSeconds <= noteEndSeconds;
    const x = (note.start_seconds / totalDuration) * width;
    const noteWidth = Math.max(
      8,
      (Math.max(0.05, note.duration_seconds) / totalDuration) * width,
    );
    const y =
      height - ((note.pitch - minPitch + 1) / pitchRange) * (height - 24) - 10;
    const noteHeight = Math.max(10, (height - 34) / pitchRange + 4);
    ctx.fillStyle = isPlaying ? "#fff5d4" : accent;
    ctx.shadowBlur = isPlaying ? 26 : 18;
    ctx.shadowColor = isPlaying ? "rgba(255, 245, 212, 0.82)" : accent;
    roundRect(ctx, x + 2, y, noteWidth, noteHeight, 8, true);
  }

  ctx.shadowBlur = 0;

  if (Number.isFinite(Number(options.progressRatio))) {
    const progressRatio = Math.min(1, Math.max(0, Number(options.progressRatio)));
    const x = Math.round(progressRatio * width) + 0.5;
    ctx.strokeStyle = "rgba(255, 245, 212, 0.86)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 10);
    ctx.lineTo(x, height - 10);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 245, 212, 0.92)";
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x - 5, 0);
    ctx.lineTo(x + 5, 0);
    ctx.closePath();
    ctx.fill();
  }
}

function roundRect(ctx, x, y, width, height, radius, fill) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  if (fill) {
    ctx.fill();
  }
}

function eventsToNotes(events) {
  const notes = [];
  const pending = new Map();
  let currentTime = 0;

  for (const event of events) {
    currentTime += event.delta_seconds;
    const key = `${event.channel}:${event.note}`;

    if (event.type === "note_on" && event.velocity > 0) {
      const stack = pending.get(key) || [];
      stack.push({
        note: event.note,
        velocity: event.velocity,
        start_seconds: currentTime,
      });
      pending.set(key, stack);
      continue;
    }

    const stack = pending.get(key);
    if (!stack?.length) {
      continue;
    }

    const noteOn = stack.shift();
    notes.push({
      pitch: noteOn.note,
      velocity: noteOn.velocity,
      start_seconds: roundNumber(noteOn.start_seconds),
      duration_seconds: roundNumber(Math.max(0, currentTime - noteOn.start_seconds)),
      end_seconds: roundNumber(currentTime),
    });
    if (!stack.length) {
      pending.delete(key);
    }
  }

  notes.sort(
    (left, right) =>
      left.start_seconds - right.start_seconds || left.pitch - right.pitch,
  );
  return notes;
}

async function refreshAuthState() {
  const payload = await requestJson("/api/auth/me");
  state.authUser = payload?.user || null;
  syncAuthUI();
  if (state.authUser) {
    await refreshSavedSessions();
    if (!state.sessionId) {
      clearCurrentSessionState("Create or open a session to start playing.");
    }
    return;
  }

  renderSavedSessions([]);
  if (!state.sessionId) {
    clearCurrentSessionState(
      "Guest mode is ready. Sign in if you want to save sessions and reopen them later.",
    );
  }
}

async function initializeReadySession() {
  if (state.sessionId) {
    return;
  }
  await createSession({ preservePhraseBuffers: true, announce: false });
  setPhraseMessage(
    state.authUser
      ? "Session ready. Connect MIDI, play a phrase, and the Continuator will answer."
      : "Guest session ready. Connect MIDI, play a phrase, and the Continuator will answer.",
  );
}

async function submitAuth(mode) {
  const { username, password } = validateAuthCredentials();

  const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
  const payload = await requestJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  state.authUser = payload.user;
  elements.authUsernameInput.value = payload.user.username;
  syncAuthUI();
  await refreshSavedSessions();
  setAccountPanelOpen(false);
  if (state.sessionId) {
    setAuthMessage(
      mode === "register"
        ? `Account created for ${payload.user.username}. Your current guest session stays open; new sessions will be saved.`
        : `Signed in as ${payload.user.username}. Your current session stays open; new sessions will be saved.`,
    );
    setPhraseMessage(
      mode === "register"
        ? `Account created for ${payload.user.username}. Your current guest session stays open; new sessions will be saved.`
        : `Signed in as ${payload.user.username}. Your current session stays open; new sessions will be saved.`,
    );
    return;
  }
  setAuthMessage(
    mode === "register"
      ? `Account created for ${payload.user.username}. You can create a saved session now.`
      : `Signed in as ${payload.user.username}. You can create or open a saved session now.`,
  );
  setPhraseMessage(
    mode === "register"
      ? `Account created for ${payload.user.username}. Create or open a session to continue.`
      : `Signed in as ${payload.user.username}. Create or open a session to continue.`,
  );
}

async function logoutUser() {
  await requestJson("/api/auth/logout", { method: "POST" });
  state.authUser = null;
  syncAuthUI();
  renderSavedSessions([]);
  setAccountPanelOpen(false);
  if (state.sessionIsOwned) {
    clearCurrentSessionState("Signed out. Reopen a saved session after signing back in, or create a new guest session.");
    return;
  }
  setAuthMessage("Signed out. Guest mode remains available.");
  setPhraseMessage("Signed out. Your current guest session remains open.");
}

async function refreshSavedSessions() {
  if (!state.authUser) {
    renderSavedSessions([]);
    return;
  }

  const payload = await requestJson("/api/my/sessions?limit=24");
  renderSavedSessions(payload.items || []);
}

function useSessionPayload(payload, { owned = Boolean(state.authUser) } = {}) {
  state.sessionId = payload.session_id;
  state.sessionIsOwned = owned;
  state.sessionConfiguration = payload.configuration;
  elements.sessionId.textContent = payload.session_id;
  syncSettingsControls(payload.configuration);
  updateSessionActionState();
  setSessionStatus("Ready");
}

async function openSavedSession(sessionId) {
  if (!sessionId) {
    return;
  }

  const payload = await requestJson(`/api/my/sessions/${sessionId}/open`, {
    method: "POST",
  });
  useSessionPayload(payload, { owned: true });
  setControlView("perform");
  clearPhraseBuffers();
  await refreshSessionActivity();
  await refreshSavedSessions();
  setPhraseMessage(
    payload.restored_from_history
      ? `Opened session and rebuilt live memory from ${payload.restored_phrase_count} learned phrases.`
      : "Opened the selected session.",
  );
}

async function createSession({ preservePhraseBuffers = false, announce = true } = {}) {
  const settings = readSessionSettingsFromControls();
  const payload = await requestJson("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });

  useSessionPayload(payload, { owned: Boolean(state.authUser) });
  setControlView("perform");
  if (!preservePhraseBuffers) {
    clearPhraseBuffers();
  }
  await refreshSavedSessions();
  if (announce) {
    setPhraseMessage(
      `Session created. ${describeSessionSettings(payload.configuration).join(" · ")}.`,
    );
  }
  await refreshSessionActivity();
}

async function ensureSession() {
  if (!state.sessionId) {
    await createSession({ preservePhraseBuffers: true });
  }
}

async function resetSession() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  if (!state.sessionId) {
    setPhraseMessage("Create a session before resetting it.", true);
    return;
  }

  const payload = await requestJson(`/api/sessions/${state.sessionId}/reset`, {
    method: "POST",
  });

  state.lastGeneratedPhrase = null;
  renderGeneratedStats(null);
  updateInfiniteActionState();
  syncSettingsControls(payload.configuration);
  setPhraseMessage("Session memory cleared and the current settings were preserved.");
  await refreshMemory();
  await refreshSavedSessions();
}

async function applyCurrentSessionSettings() {
  if (!state.sessionId) {
    setPhraseMessage("Create a session before applying settings.", true);
    return;
  }

  const settings = readSessionSettingsFromControls();
  const payload = await requestJson(`/api/sessions/${state.sessionId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  syncSettingsControls(payload.configuration);
  setPhraseMessage(
    `Session settings updated. ${describeSessionSettings(payload.configuration).join(" · ")}.`,
  );
  await refreshMemory();
  await refreshSavedSessions();
}

async function refreshHistory() {
  if (!state.sessionId) {
    return;
  }

  const payload = await requestJson(`/api/sessions/${state.sessionId}/history?limit=10`);
  renderHistory(payload.items);
}

async function refreshMemory() {
  if (!state.sessionId) {
    return;
  }

  const payload = await requestJson(`/api/sessions/${state.sessionId}/memory`);
  renderMemory(payload);
}

async function refreshSessionActivity() {
  if (!state.sessionId) {
    return;
  }

  await Promise.all([refreshHistory(), refreshMemory()]);
}

function buildContinuationRequestBody(
  phraseEvents,
  learnInput,
  signal = null,
  enforceEndConstraint = true,
  handoffViewpoint = null,
) {
  const continuationNoteCount = normalizedContinuationNoteCount(
    elements.continuationLengthInput.value,
  );
  const requestBody = {
    session_id: state.sessionId,
    phrase: phraseEvents,
    learn_input: learnInput,
    enforce_end_constraint: enforceEndConstraint,
  };
  if (continuationNoteCount != null) {
    requestBody.continuation_note_count = continuationNoteCount;
  }
  if (handoffViewpoint) {
    requestBody.handoff_viewpoint = handoffViewpoint;
  }
  return {
    requestBody,
    continuationNoteCount,
    fetchOptions: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal,
    },
  };
}

function defaultContinuationMessage(payload, continuationNoteCount) {
  return (
    payload.status_message ||
    (continuationNoteCount == null
      ? `Continuation generated: ${payload.generated_phrase.note_count} notes returned.`
      : `Continuation generated: ${payload.generated_phrase.note_count} notes returned from a ${continuationNoteCount}-note request.`)
  );
}

function applyContinuationPayload(payload) {
  rememberCapturedPhrase(payload.input_phrase.events);
  renderCapturedStats(payload.input_phrase.events, payload.input_phrase.notes, true);
  rememberGeneratedPhrase(payload.generated_phrase);
  renderGeneratedStats(payload.generated_phrase);
}

function applyGeneratedPhrasePayload(payload) {
  rememberGeneratedPhrase(payload);
  renderGeneratedStats(payload);
}

function defaultMidiImportMessage(payload) {
  const importedCount = Number(payload?.imported_file_count || 0);
  const skippedCount = Number(payload?.skipped_file_count || 0);
  const importedNames = Array.isArray(payload?.imported_files)
    ? payload.imported_files
        .map((item) => item?.file_name)
        .filter((value) => typeof value === "string" && value.length)
    : [];

  let message = `Imported ${pluralize(importedCount, "MIDI file")} into the current session memory.`;
  if (importedNames.length) {
    const shownNames = importedNames.slice(0, 3).join(", ");
    const overflow = importedNames.length > 3 ? `, and ${importedNames.length - 3} more` : "";
    message += ` ${shownNames}${overflow}.`;
  }
  if (skippedCount) {
    message += ` Skipped ${pluralize(skippedCount, "file")} that were empty, unreadable, or not MIDI.`;
  }
  return message;
}

function defaultMemoryGenerationMessage(payload, requestedNoteCount) {
  return (
    payload.status_message ||
    `Fresh phrase generated from memory: ${payload.generated_phrase.note_count} notes returned from a ${requestedNoteCount}-note request.`
  );
}

async function requestContinuationFromEvents(
  phraseEvents,
  {
    learnInput = elements.learnInputToggle.checked,
    statusLabel = "Sending",
    signal = null,
    enforceEndConstraint = true,
    handoffViewpoint = null,
  } = {},
) {
  if (!phraseEvents?.length) {
    throw new Error("No completed phrase is ready yet.");
  }

  await ensureSession();
  setPhraseStatus(statusLabel);
  const { continuationNoteCount, fetchOptions } = buildContinuationRequestBody(
    phraseEvents,
    learnInput,
    signal,
    enforceEndConstraint,
    handoffViewpoint,
  );
  const payload = await requestJson("/api/continue", fetchOptions);
  return { payload, continuationNoteCount };
}

async function requestMemoryGeneration(
  {
    noteCount = preferredGenerationNoteCount(),
    statusLabel = "Generating",
    signal = null,
    enforceEndConstraint = true,
  } = {},
) {
  await ensureSession();
  setPhraseStatus(statusLabel);
  const requestBody = {
    note_count: noteCount,
    enforce_end_constraint: enforceEndConstraint,
  };
  const payload = await requestJson(`/api/sessions/${state.sessionId}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  });
  return { payload, noteCount };
}

async function sendCurrentPhrase() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  const { payload, continuationNoteCount } = await requestContinuationFromEvents(
    state.lastCapturedPhrase,
    { learnInput: elements.learnInputToggle.checked },
  );
  applyContinuationPayload(payload);
  if (payload.generated_phrase.event_count > 0) {
    await playPayload(payload.generated_phrase);
  }
  await refreshSessionActivity();
  await refreshSavedSessions();
  setPhraseStatus(payload.generated_phrase.note_count ? "Generated" : "Primed");
  setPhraseMessage(defaultContinuationMessage(payload, continuationNoteCount));
}

async function generateFreshPhrase() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  const { payload, noteCount } = await requestMemoryGeneration({
    noteCount: preferredGenerationNoteCount(),
    statusLabel: "Generating",
  });
  applyGeneratedPhrasePayload(payload.generated_phrase);
  if (payload.generated_phrase.event_count > 0) {
    await playPayload(payload.generated_phrase);
  }
  await refreshSessionActivity();
  await refreshSavedSessions();
  setPhraseStatus(payload.generated_phrase.note_count ? "Generated" : "Primed");
  setPhraseMessage(defaultMemoryGenerationMessage(payload, noteCount));
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

async function playTestNote() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  const payload = createTestNotePayload();
  renderGeneratedStats(payload);
  await playPayload(payload);
  setPhraseMessage(`Testing ${elements.selectedOutputName.textContent}.`);
}

async function panicPlayback() {
  await sendPlaybackPanic();
  stopInfiniteMode({ stopPlayback: true, silent: true });
  setPhraseStatus(state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI");
  setPhraseMessage("Panic sent. Playback and held notes were stopped.");
}

async function importSelectedMidiFiles(fileList, selectionLabel = "selection") {
  const selectedFiles = Array.from(fileList || []);
  if (!selectedFiles.length) {
    return;
  }

  const midiFiles = selectedFiles.filter((file) =>
    hasMidiFileExtension(file.webkitRelativePath || file.name),
  );
  if (!midiFiles.length) {
    throw new Error(`No MIDI files were found in the selected ${selectionLabel}.`);
  }

  stopInfiniteMode({ stopPlayback: true, silent: true });
  await ensureSession();

  const formData = new FormData();
  midiFiles.forEach((file, index) => {
    const uploadName =
      file.webkitRelativePath || file.name || `imported_${index + 1}.mid`;
    formData.append("files", file, uploadName);
  });

  setPhraseMessage(
    `Importing ${pluralize(midiFiles.length, "MIDI file")} into the current session memory...`,
  );
  const payload = await requestJson(`/api/sessions/${state.sessionId}/import-midi`, {
    method: "POST",
    body: formData,
  });

  await refreshSessionActivity();
  await refreshSavedSessions();
  setControlView("memory");
  setSessionStatus("Ready");
  setPhraseStatus(state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI");
  setPhraseMessage(defaultMidiImportMessage(payload));
}

async function checkServer() {
  const payload = await requestJson("/health");
  elements.serverStatus.textContent = payload.ok
    ? payload.seeded
      ? "Healthy / seeded"
      : "Healthy / empty memory"
    : "Unavailable";
}

function midiOutputById(outputId) {
  if (!state.midiAccess || !outputId) {
    return null;
  }
  return state.midiAccess.outputs.get(outputId) || null;
}

function selectedPlaybackChoiceValue() {
  return elements.midiOutputSelect.value || DEFAULT_PLAYBACK_CHOICE;
}

function encodePlaybackChoice(rendererId, targetId = null) {
  return targetId
    ? `${rendererId}${PLAYBACK_CHOICE_SEPARATOR}${targetId}`
    : rendererId;
}

function parsePlaybackChoice(choiceValue) {
  if (!choiceValue) {
    return {
      rendererId: DEFAULT_PLAYBACK_CHOICE,
      targetId: null,
    };
  }

  const [rendererId, ...targetParts] = String(choiceValue).split(
    PLAYBACK_CHOICE_SEPARATOR,
  );
  return {
    rendererId: rendererId || DEFAULT_PLAYBACK_CHOICE,
    targetId: targetParts.length
      ? targetParts.join(PLAYBACK_CHOICE_SEPARATOR)
      : null,
  };
}

function resolvePlaybackChoice(choiceValue = selectedPlaybackChoiceValue()) {
  const { rendererId, targetId } = parsePlaybackChoice(choiceValue);
  const renderer =
    playbackRendererRegistry.get(rendererId) ||
    playbackRendererRegistry.get(DEFAULT_PLAYBACK_CHOICE) ||
    null;
  return {
    value: encodePlaybackChoice(renderer?.id || rendererId, targetId),
    rendererId: renderer?.id || rendererId,
    targetId,
    renderer,
  };
}

function selectedPlaybackChoice() {
  return resolvePlaybackChoice(selectedPlaybackChoiceValue());
}

function playbackChoiceLabel(choiceValue = selectedPlaybackChoiceValue()) {
  const choice = resolvePlaybackChoice(choiceValue);
  return choice.renderer
    ? choice.renderer.getDisplayName(choice.targetId)
    : "Unavailable renderer";
}

async function loadCustomFaustTemplate() {
  if (state.customFaustTemplateSource) {
    return state.customFaustTemplateSource;
  }

  const response = await fetch(FAUST_CUSTOM_TEMPLATE_DSP_URL);
  if (!response.ok) {
    throw new Error(`Unable to load the Custom Faust starter template (${response.status}).`);
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
    safeLocalStorageSet(FAUST_CUSTOM_SOURCE_STORAGE_KEY, state.customFaustSource);
  }
}

function selectedFaustRenderer(choiceValue = selectedPlaybackChoiceValue()) {
  const renderer = resolvePlaybackChoice(choiceValue).renderer;
  return renderer instanceof FaustPolyRenderer ? renderer : null;
}

function selectedRendererIsFaust(choiceValue = selectedPlaybackChoiceValue()) {
  return Boolean(selectedFaustRenderer(choiceValue));
}

function selectedRendererIsCustomFaust(choiceValue = selectedPlaybackChoiceValue()) {
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
  const rawLabel = String(item?.label || item?.shortname || item?.address || "Control");
  const label = rawLabel.split("/").pop() || rawLabel;
  const withSpaces = label.replace(/_/g, " ").trim();
  return withSpaces ? withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1) : "Control";
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
    snapshot[descriptor.key] = customFaustRenderer.getControlValue(descriptor.key);
  }
  safeLocalStorageSet(FAUST_CUSTOM_VALUES_STORAGE_KEY, JSON.stringify(snapshot));
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
    if (FAUST_POLY_RESERVED_SUFFIXES.some((suffix) => address.endsWith(suffix))) {
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
        const nextValue = clampFaustControlValue(Number(input.value), descriptor);
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
    const currentValue = customFaustRenderer.getControlValue(binding.descriptor.key);
    binding.descriptor.value = clampFaustControlValue(currentValue, binding.descriptor);
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

  elements.faustCustomControlsHint.hidden = state.customFaustControlBindings.length > 0;
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
  return state.customFaustSource !== (customFaustRenderer.lastCompiledCode || "");
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
  elements.faustClavierPanel.hidden = !faustSelected || selectedRenderer?.id !== FAUST_CLAVIER_ID;
  elements.faustCustomPanel.hidden = !faustSelected || selectedRenderer?.id !== FAUST_CUSTOM_ID;
  elements.faustRendererStatus.textContent = selectedRenderer?.status || "Idle";

  let hint = "Faust instruments are compiled locally in your browser the first time you use them.";
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
      hint = "Compiling your Custom Faust source in the browser and rebuilding its parameter panel.";
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
  elements.faustCustomResetButton.disabled = customFaustRenderer.status === "Loading";
  elements.faustCustomDirtyState.textContent = customFaustDirtyCopy();
  syncCustomFaustControls();
}

async function createPlaybackSession(choiceValue = selectedPlaybackChoiceValue()) {
  const choice = resolvePlaybackChoice(choiceValue);
  if (!choice.renderer) {
    throw new Error("Selected playback renderer is unavailable.");
  }

  const rendererState = (await choice.renderer.createPlaybackSession?.(choice.targetId)) || {};
  return {
    renderer: choice.renderer,
    rendererId: choice.renderer.id,
    targetId: choice.targetId,
    choiceValue: choice.value,
    timerIds: new Set(),
    cleanupTimerId: null,
    handoffAtMs: performance.now(),
    endsAtMs: performance.now(),
    ...rendererState,
  };
}

function outputNoteKey(note, channel) {
  return `${channel}:${note}`;
}

function sendOutputMessage(output, message) {
  try {
    output.send(message);
  } catch {
    // Ignore unavailable outputs while cancelling or switching playback.
  }
}

function sendMidiPanicToOutput(output) {
  if (!output) {
    return false;
  }

  for (let channel = 0; channel < 16; channel += 1) {
    sendOutputMessage(output, [0xb0 | channel, 64, 0]);
    sendOutputMessage(output, [0xb0 | channel, 121, 0]);
    for (let note = 0; note < 128; note += 1) {
      sendOutputMessage(output, [0x80 | (channel & 0x0f), note, 0]);
    }
    sendOutputMessage(output, [0xb0 | channel, 123, 0]);
    sendOutputMessage(output, [0xb0 | channel, 120, 0]);
  }
  return true;
}

async function sendPlaybackPanic() {
  let sent = false;
  const activePlayback = state.activePlayback;

  if (activePlayback?.renderer?.panicPlayback) {
    sent = (await activePlayback.renderer.panicPlayback(activePlayback)) || sent;
  }

  for (const renderer of localPlaybackRenderers) {
    if (activePlayback?.renderer === renderer) {
      continue;
    }
    sent = (await renderer.panicTarget()) || sent;
  }

  const selectedChoice = selectedPlaybackChoice();
  const matchesActiveSelection =
    activePlayback &&
    activePlayback.rendererId === selectedChoice.rendererId &&
    activePlayback.targetId === selectedChoice.targetId;
  if (!matchesActiveSelection && selectedChoice.renderer?.panicTarget) {
    sent = (await selectedChoice.renderer.panicTarget(selectedChoice.targetId)) || sent;
  }

  return sent;
}

function stopPlaybackVisualization({ redraw = true } = {}) {
  state.playbackVisualizationToken += 1;
  if (state.playbackVisualizationStartTimerId) {
    window.clearTimeout(state.playbackVisualizationStartTimerId);
    state.playbackVisualizationStartTimerId = null;
  }
  if (state.playbackVisualizationFrameId) {
    window.cancelAnimationFrame(state.playbackVisualizationFrameId);
    state.playbackVisualizationFrameId = null;
  }
  if (redraw) {
    renderGeneratedStats(state.lastGeneratedPhrase);
  }
}

function startPlaybackVisualization(payload, startAtMs, durationMs) {
  const notes = payload?.notes?.length ? payload.notes : eventsToNotes(payload?.events || []);
  if (!notes.length) {
    return;
  }

  const delayUntilStartMs = startAtMs - window.performance.now();
  if (delayUntilStartMs > 24) {
    if (state.playbackVisualizationStartTimerId) {
      window.clearTimeout(state.playbackVisualizationStartTimerId);
    }
    state.playbackVisualizationStartTimerId = window.setTimeout(() => {
      state.playbackVisualizationStartTimerId = null;
      startPlaybackVisualization(payload, startAtMs, durationMs);
    }, delayUntilStartMs);
    return;
  }

  stopPlaybackVisualization({ redraw: false });
  const token = ++state.playbackVisualizationToken;
  const totalDurationSeconds = Math.max(
    0.001,
    ...notes.map((note) => note.end_seconds || note.start_seconds + note.duration_seconds),
  );
  const safeDurationMs = Math.max(1, Number(durationMs) || totalDurationSeconds * 1000);

  const tick = () => {
    if (token !== state.playbackVisualizationToken) {
      return;
    }
    const elapsedMs = Math.max(0, window.performance.now() - startAtMs);
    const progressRatio = Math.min(1, elapsedMs / safeDurationMs);
    drawPianoRoll(
      elements.outputRoll,
      notes,
      "#f4a261",
      "Generated continuation",
      {
        progressRatio,
        playbackSeconds: progressRatio * totalDurationSeconds,
      },
    );
    if (progressRatio >= 1) {
      state.playbackVisualizationFrameId = null;
      window.setTimeout(() => {
        if (token === state.playbackVisualizationToken) {
          renderGeneratedStats(state.lastGeneratedPhrase);
        }
      }, 180);
      return;
    }
    state.playbackVisualizationFrameId = window.requestAnimationFrame(tick);
  };

  tick();
}

function stopActivePlayback() {
  const playback = state.activePlayback;
  if (!playback) {
    return false;
  }

  playback.timerIds.forEach((timerId) => {
    window.clearTimeout(timerId);
  });
  playback.timerIds.clear();
  playback.cleanupTimerId = null;
  playback.renderer?.stopPlayback?.(playback);
  state.activePlayback = null;
  stopPlaybackVisualization();
  updateInfiniteActionState();
  return true;
}

function dispatchPlaybackEvent(playback, event) {
  playback.renderer?.dispatchEvent?.(playback, event);
}

async function playPayload(
  payload,
  {
    startDelayMs = PLAYBACK_START_DELAY_MS,
    append = false,
  } = {},
) {
  if (!payload?.events?.length) {
    return;
  }

  let playback = state.activePlayback;
  if (!append || !playback) {
    stopActivePlayback();
    playback = await createPlaybackSession();
    state.activePlayback = playback;
  }

  if (playback.cleanupTimerId != null) {
    window.clearTimeout(playback.cleanupTimerId);
    playback.timerIds.delete(playback.cleanupTimerId);
    playback.cleanupTimerId = null;
  }

  const scheduleDelayMs = Math.max(0, startDelayMs);
  const scheduleBaseMs = performance.now();
  const handoffMs = continuationHandoffMs(payload);
  let cursorMs = 0;
  for (const event of payload.events) {
    cursorMs += event.delta_seconds * 1000;
    const timerId = window.setTimeout(() => {
      if (state.activePlayback !== playback) {
        return;
      }
      dispatchPlaybackEvent(playback, event);
      playback.timerIds.delete(timerId);
    }, scheduleDelayMs + cursorMs);
    playback.timerIds.add(timerId);
  }

  const cleanupTimerId = window.setTimeout(() => {
    if (state.activePlayback !== playback) {
      return;
    }
    playback.timerIds.delete(cleanupTimerId);
    stopActivePlayback();
  }, scheduleDelayMs + cursorMs + 200);
  playback.cleanupTimerId = cleanupTimerId;
  playback.timerIds.add(cleanupTimerId);
  playback.handoffAtMs = Math.max(
    playback.handoffAtMs,
    scheduleBaseMs + scheduleDelayMs + handoffMs,
  );
  playback.endsAtMs = Math.max(playback.endsAtMs, scheduleBaseMs + scheduleDelayMs + cursorMs);
  startPlaybackVisualization(payload, scheduleBaseMs + scheduleDelayMs, cursorMs);
  updateInfiniteActionState();
}

function stopInfiniteMode(
  {
    stopPlayback = true,
    silent = false,
    message = "Infinite mode stopped.",
  } = {},
) {
  const hadInfiniteState =
    state.infiniteModeEnabled ||
    state.infiniteRequestInFlight ||
    state.infiniteScheduleTimerId != null;

  clearInfiniteScheduler();
  if (state.infiniteAbortController) {
    state.infiniteAbortController.abort();
    state.infiniteAbortController = null;
  }
  state.infiniteModeEnabled = false;
  state.infiniteRequestInFlight = false;
  state.infiniteRunId += 1;
  if (stopPlayback) {
    stopActivePlayback();
  }
  updateInfiniteActionState();

  if (!silent && (hadInfiniteState || stopPlayback)) {
    setPhraseMessage(message);
  }

  return hadInfiniteState;
}

function stopLoopAndPlayback(message) {
  const hadInfiniteState =
    state.infiniteModeEnabled ||
    state.infiniteRequestInFlight ||
    state.infiniteScheduleTimerId != null;

  if (hadInfiniteState) {
    stopInfiniteMode({ stopPlayback: true, silent: true });
    void sendPlaybackPanic();
    setPhraseStatus(state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI");
    setPhraseMessage(message || "Infinite mode stopped.");
    return true;
  }

  if (stopActivePlayback()) {
    void sendPlaybackPanic();
    setPhraseStatus(state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI");
    setPhraseMessage(message || "Playback stopped.");
    return true;
  }

  return false;
}

function scheduleInfiniteStep(prefixPayload, runId) {
  if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
    return;
  }

  clearInfiniteScheduler();
  const remainingPlaybackMs = state.activePlayback
    ? Math.max(0, state.activePlayback.handoffAtMs - performance.now())
    : continuationHandoffMs(prefixPayload);
  const delayMs = Math.max(0, remainingPlaybackMs - infiniteLookaheadMs(prefixPayload));

  state.infiniteScheduleTimerId = window.setTimeout(() => {
    state.infiniteScheduleTimerId = null;
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }
    void runInfiniteStep(prefixPayload, runId);
  }, delayMs);
  updateInfiniteActionState();
}

async function runInfiniteStep(prefixPayload, runId) {
  if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
    return;
  }

  const prefixEvents = Array.isArray(prefixPayload)
    ? prefixPayload
    : prefixPayload?.events || [];
  const handoffViewpoint = Array.isArray(prefixPayload)
    ? null
    : prefixPayload?.handoff_viewpoint || null;

  state.infiniteRequestInFlight = true;
  const abortController = new AbortController();
  state.infiniteAbortController = abortController;
  updateInfiniteActionState();

  const continueInfiniteFromMemory = async (reason) => {
    const { payload } = await requestMemoryGeneration({
      noteCount: preferredGenerationNoteCount(prefixEvents),
      statusLabel: state.activePlayback ? "Re-seeding from memory" : "Generating from memory",
      signal: abortController.signal,
      enforceEndConstraint: false,
    });
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return true;
    }

    const generatedPhrase = payload.generated_phrase;
    if (!generatedPhrase.event_count) {
      throw new Error("the memory fallback returned an empty phrase");
    }

    applyGeneratedPhrasePayload(generatedPhrase);
    const startDelayMs = state.activePlayback
      ? Math.max(0, state.activePlayback.handoffAtMs - performance.now())
      : PLAYBACK_START_DELAY_MS;
    await playPayload(generatedPhrase, {
      startDelayMs,
      append: Boolean(state.activePlayback),
    });
    await refreshSessionActivity();
    await refreshSavedSessions();
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return true;
    }

    setPhraseStatus("Infinite");
    setPhraseMessage(
      payload.status_message ||
        `Infinite mode resumed from memory because ${reason}.`,
    );
    scheduleInfiniteStep(generatedPhrase, runId);
    return true;
  };

  try {
    const { payload } = await requestContinuationFromEvents(prefixEvents, {
      learnInput: false,
      statusLabel: state.activePlayback ? "Queueing next" : "Sending",
      signal: abortController.signal,
      enforceEndConstraint: false,
      handoffViewpoint,
    });
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    const generatedPhrase = payload.generated_phrase;
    applyContinuationPayload({
      ...payload,
      generated_phrase: generatedPhrase,
    });
    if (!generatedPhrase.event_count) {
      await continueInfiniteFromMemory("the latest continuation was empty");
      return;
    }

    const startDelayMs = state.activePlayback
      ? Math.max(0, state.activePlayback.handoffAtMs - performance.now())
      : PLAYBACK_START_DELAY_MS;
    await playPayload(generatedPhrase, {
      startDelayMs,
      append: Boolean(state.activePlayback),
    });
    await refreshSessionActivity();
    await refreshSavedSessions();
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    setPhraseStatus("Infinite");
    setPhraseMessage(
      `Infinite mode running: ${generatedPhrase.note_count} notes queued from the latest continuation.`,
    );
    scheduleInfiniteStep(generatedPhrase, runId);
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }

    try {
      const resumed = await continueInfiniteFromMemory(
        "the latest continuation reached a dead end",
      );
      if (resumed) {
        return;
      }
    } catch (fallbackError) {
      error = fallbackError;
    }

    if (runId === state.infiniteRunId) {
      stopInfiniteMode({
        stopPlayback: false,
        message: `Infinite mode stopped: ${error.message}`,
      });
      setPhraseStatus("Error");
    }
  } finally {
    if (runId === state.infiniteRunId) {
      state.infiniteRequestInFlight = false;
      state.infiniteAbortController = null;
      updateInfiniteActionState();
    }
  }
}

async function startInfiniteMode() {
  if (state.infiniteModeEnabled || state.infiniteRequestInFlight) {
    return;
  }

  if (state.activePlayback && state.lastGeneratedPhrase?.events?.length) {
    state.infiniteModeEnabled = true;
    state.infiniteRunId += 1;
    updateInfiniteActionState();
    setPhraseStatus("Infinite");
    setPhraseMessage(
      "Infinite mode armed. The next continuation will be queued before the current one ends.",
    );
    scheduleInfiniteStep(state.lastGeneratedPhrase, state.infiniteRunId);
    return;
  }

  const seedPayload = latestLoopSeedPayload();
  const seedEvents = seedPayload?.events || [];
  if (!seedEvents.length) {
    setPhraseMessage("Play or preview a phrase before starting infinite mode.", true);
    return;
  }

  state.infiniteModeEnabled = true;
  state.infiniteRunId += 1;
  updateInfiniteActionState();
  setPhraseMessage("Infinite mode started. Generating the first continuation...");

  const runId = state.infiniteRunId;
  state.infiniteRequestInFlight = true;
  const abortController = new AbortController();
  state.infiniteAbortController = abortController;
  updateInfiniteActionState();

  try {
    const { payload } = await requestContinuationFromEvents(seedEvents, {
      learnInput: elements.learnInputToggle.checked,
      signal: abortController.signal,
      enforceEndConstraint: false,
      handoffViewpoint: seedPayload?.handoff_viewpoint || null,
    });
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    const generatedPhrase = payload.generated_phrase;
    applyContinuationPayload({
      ...payload,
      generated_phrase: generatedPhrase,
    });
    if (!generatedPhrase.event_count) {
      stopInfiniteMode({
        stopPlayback: false,
        message: "Infinite mode stopped because the first continuation was empty.",
      });
      setPhraseStatus("Primed");
      return;
    }

    await playPayload(generatedPhrase);
    await refreshSessionActivity();
    await refreshSavedSessions();
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    setPhraseStatus("Infinite");
    setPhraseMessage(
      `Infinite mode running: ${generatedPhrase.note_count} notes in the first continuation.`,
    );
    scheduleInfiniteStep(generatedPhrase, runId);
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    if (runId === state.infiniteRunId) {
      stopInfiniteMode({
        stopPlayback: false,
        message: `Infinite mode stopped: ${error.message}`,
      });
      setPhraseStatus("Error");
    }
  } finally {
    if (runId === state.infiniteRunId) {
      state.infiniteRequestInFlight = false;
      state.infiniteAbortController = null;
      updateInfiniteActionState();
    }
  }
}

function populatePlaybackChoices() {
  const outputs = state.midiAccess ? [...state.midiAccess.outputs.values()] : [];
  const previousChoiceValue = selectedPlaybackChoiceValue();
  const availableChoices = new Set([
    ...localPlaybackRenderers.map((renderer) => encodePlaybackChoice(renderer.id)),
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
  const externalMidiOptions = midiOptions ||
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
  elements.midiOutputSelect.value = availableChoices.has(previousChoiceValue)
    ? previousChoiceValue
    : DEFAULT_PLAYBACK_CHOICE;
  updateSelectedOutput();
}

async function populateMidiSelectors() {
  populatePlaybackChoices();
  if (!state.midiAccess) {
    return;
  }

  const inputs = [...state.midiAccess.inputs.values()];
  const previousInputId = elements.midiInputSelect.value;

  elements.midiInputSelect.disabled = false;
  elements.midiInputSelect.innerHTML = inputs.length
    ? inputs
        .map(
          (input) =>
            `<option value="${input.id}">${input.name || input.id}</option>`,
        )
        .join("")
    : `<option value="">No MIDI inputs found</option>`;

  if (inputs.length) {
    const inputId = state.midiAccess.inputs.has(previousInputId)
      ? previousInputId
      : inputs[0].id;
    await attachInput(inputId);
  } else {
    detachCurrentInput();
    setSelectedInputName("No MIDI input found");
    setMidiStatus("No inputs");
    setLastMidiEvent("None yet");
  }
}

function detachCurrentInput() {
  if (!state.midiAccess || !state.activeInputId) {
    return;
  }
  const current = state.midiAccess.inputs.get(state.activeInputId);
  if (current) {
    current.onmidimessage = null;
    void current.close().catch(() => {});
  }
  state.activeInputId = null;
}

async function attachInput(inputId) {
  detachCurrentInput();

  if (!state.midiAccess || !inputId) {
    state.activeInputId = null;
    setSelectedInputName("No MIDI input selected");
    return;
  }

  const input = state.midiAccess.inputs.get(inputId);
  if (!input) {
    setSelectedInputName("Selected input is unavailable");
    return;
  }

  await input.open();
  input.onmidimessage = (messageEvent) => {
    const [statusByte, note, velocity = 0] = [...messageEvent.data];
    const status = statusByte & 0xf0;
    const interruptedPlayback =
      status === 0x90 && velocity > 0
        ? stopLoopAndPlayback(
            `Stopped the current continuation and switched to live MIDI from ${input.name || input.id}.`,
          )
        : false;

    recorder.handleMessage(messageEvent);
    const type =
      status === 0x90 && velocity > 0
        ? "note_on"
        : status === 0x80 || (status === 0x90 && velocity === 0)
          ? "note_off"
          : "message";
    setLastMidiEvent(`${type} ${note} v${velocity}`);
    setPhraseMessage(
      interruptedPlayback
        ? `Stopped the current continuation and switched to live MIDI from ${input.name || input.id}.`
        : `Receiving MIDI from ${input.name || input.id}. Waiting for phrase end…`,
    );
  };

  state.activeInputId = inputId;
  elements.midiInputSelect.value = inputId;
  setSelectedInputName(input.name || input.id);
  setMidiStatus(`Listening on ${input.name || input.id}`);
}

async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    throw new Error("This browser does not support the Web MIDI API.");
  }

  state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  state.midiAccess.onstatechange = () => {
    void populateMidiSelectors();
  };
  await populateMidiSelectors();
  if (!state.activeInputId) {
    setMidiStatus("Connected / choose input");
  }
  setPhraseStatus("Listening");
}

function updateSelectedOutput() {
  setSelectedOutputName(playbackChoiceLabel());
  syncFaustRendererPanel();
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
      setAuthMessage("Guest mode is ready. Sign in only if you want saved sessions.");
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

  elements.authStatus.addEventListener("click", () => {
    if (state.readmeOpen) {
      setReadmeOpen(false);
    }
    setAccountPanelOpen(!state.accountPanelOpen);
  });

  elements.accountOpenSessionsButton.addEventListener("click", () => {
    setControlView("session");
    setAccountPanelOpen(false);
    elements.controlWorkspace?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      elements.authStatus.contains(event.target)
    ) {
      return;
    }
    setAccountPanelOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.readmeOpen) {
      setReadmeOpen(false);
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

  elements.applySettingsButton.addEventListener("click", async () => {
    try {
      await applyCurrentSessionSettings();
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.midiInputSelect.addEventListener("change", async (event) => {
    try {
      await attachInput(event.target.value);
      setPhraseMessage(`MIDI input changed to ${elements.selectedInputName.textContent}.`);
    } catch (error) {
      setPhraseMessage(error.message, true);
    }
  });

  elements.phraseTimeoutInput.addEventListener("change", () => {
    applyPhraseTimeoutSetting(elements.phraseTimeoutInput.value, { announce: true });
  });

  elements.midiOutputSelect.addEventListener("change", async () => {
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
      } else if (choice.renderer instanceof FaustPolyRenderer) {
        await choice.renderer.prepare();
        if (choice.rendererId === FAUST_CUSTOM_ID) {
          refreshCustomFaustControlState();
        }
      }
      setPhraseMessage(`Playback renderer set to ${elements.selectedOutputName.textContent}.`);
    } catch (error) {
      setPhraseMessage(error.message, true);
    } finally {
      syncFaustRendererPanel();
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
      setPhraseMessage("Restored the Custom Faust starter template. Compile to use it.");
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

  elements.decayModeSelect.addEventListener("change", () => {
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

  window.addEventListener("resize", () => {
    drawPianoRoll(
      elements.inputRoll,
      eventsToNotes(state.lastCapturedPhrase),
      "#6dd3ce",
      "Input phrase",
    );
    renderGeneratedStats(state.lastGeneratedPhrase);
  });
}

async function initialize() {
  bindEvents();
  try {
    await initializeCustomFaustSource();
  } catch (error) {
    setPhraseMessage(error.message, true);
  }
  initializePhraseTimeoutSetting();
  populatePlaybackChoices();
  syncAuthUI();
  renderSavedSessions([]);
  clearCurrentSessionState();
  setControlView("perform");
  setSelectedInputName("No MIDI input selected");
  updateSelectedOutput();
  syncFaustRendererPanel();
  setLastMidiEvent("None yet");
  updateKeepLastFieldState();
  renderSessionSettingsSummary();
  updateSessionActionState();
  updateInfiniteActionState();
  try {
    await checkServer();
  } catch (error) {
    elements.serverStatus.textContent = "Offline";
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

initialize();
