import {
  FAUST_WASM_ESM_URL,
  FAUST_WASM_JS_URL,
  FAUST_WASM_DATA_URL,
  FAUST_WASM_BINARY_URL,
} from "./constants.js";

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
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        releaseAt + releaseSeconds,
      );
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
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        releaseAt + releaseSeconds,
      );
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
    applyAudioOutputToContext = async () => {},
    groupLabel = "Browser Renderers",
  }) {
    this.id = id;
    this.applyAudioOutputToContext = applyAudioOutputToContext;
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
      await this.applyAudioOutputToContext(this.context);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  async applyAudioOutputPreference() {
    return this.applyAudioOutputToContext(this.context);
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
    const voice = this.createVoice(
      this.context,
      this.master,
      note,
      velocity,
      at,
    );
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
      const simplifiedLabel = labelTail
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
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
    applyAudioOutputToContext = async () => {},
    onStatusChange = () => {},
  }) {
    this.id = id;
    this.applyAudioOutputToContext = applyAudioOutputToContext;
    this.label = label;
    this.dspUrl = dspUrl;
    this.onStatusChange = onStatusChange;
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
    this.onStatusChange();
  }

  async ensureContext() {
    if (!this.context) {
      this.context = new window.AudioContext();
      await this.applyAudioOutputToContext(this.context);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  async applyAudioOutputPreference() {
    return this.applyAudioOutputToContext(this.context);
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
      const compiledGenerator = await generator.compile(
        compiler,
        this.id,
        code,
        "-ftz 2",
      );
      if (!compiledGenerator) {
        throw new Error("Faust compilation returned no renderer.");
      }
      const nextNode = await compiledGenerator.createNode(
        this.context,
        this.voices,
        this.id,
      );
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
        this.lastError =
          error instanceof Error ? error : new Error(String(error));
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
    this.onStatusChange();
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

let faustApiPromise = null;

let faustCompilerBundlePromise = null;

export {
  createTriangleVoice,
  createElectricVoice,
  BrowserAudioRenderer,
  walkFaustUi,
  FaustPolyRenderer,
};
