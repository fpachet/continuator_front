const MIDI_JS_SOUNDFONT_BASE_URL =
  "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM";
const MIDI_JS_NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const MIDI_JS_NOTE_OFFSETS = new Map(
  [
    ...MIDI_JS_NOTE_NAMES.map((name, index) => [name, index]),
    ["Db", 1],
    ["Eb", 3],
    ["Gb", 6],
    ["Ab", 8],
    ["Bb", 10],
  ],
);
const MIN_GAIN = 0.0001;
const SCRIPT_LOAD_TIMEOUT_MS = 120000;
const DECODE_BATCH_SIZE = 8;

const scriptPromises = new Map();

export const SAMPLE_INSTRUMENTS = {
  piano: {
    id: "sample_piano",
    label: "Browser Piano",
    instrumentName: "acoustic_grand_piano",
    scriptUrl: `${MIDI_JS_SOUNDFONT_BASE_URL}/acoustic_grand_piano-mp3.js`,
    masterGain: 0.46,
    releaseSeconds: 0.12,
  },
  violin: {
    id: "sample_violin",
    label: "Browser Violin",
    instrumentName: "violin",
    scriptUrl: `${MIDI_JS_SOUNDFONT_BASE_URL}/violin-mp3.js`,
    masterGain: 0.3,
    releaseSeconds: 0.2,
  },
};

function noteNameToMidi(noteName) {
  const match = /^([A-G](?:#|b)?)(-?\d+)$/.exec(noteName);
  if (!match) {
    return null;
  }
  const [, name, octaveRaw] = match;
  const offset = MIDI_JS_NOTE_OFFSETS.get(name);
  if (offset == null) {
    return null;
  }
  return (Number(octaveRaw) + 1) * 12 + offset;
}

function samplePreset(instrumentName) {
  return globalThis.MIDI?.Soundfont?.[instrumentName] || null;
}

function loadClassicScript(scriptUrl) {
  if (scriptPromises.has(scriptUrl)) {
    return scriptPromises.get(scriptUrl);
  }

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let timeoutId = null;

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      script.onload = null;
      script.onerror = null;
    };

    script.src = scriptUrl;
    script.async = true;
    script.onload = () => {
      cleanup();
      resolve();
    };
    script.onerror = () => {
      cleanup();
      reject(new Error(`Unable to load sample instrument: ${scriptUrl}`));
    };
    timeoutId = window.setTimeout(() => {
      cleanup();
      script.remove();
      reject(new Error("Sample instrument download timed out after 120 seconds."));
    }, SCRIPT_LOAD_TIMEOUT_MS);

    document.head.appendChild(script);
  });

  scriptPromises.set(scriptUrl, promise);
  promise.catch(() => {
    scriptPromises.delete(scriptUrl);
  });
  return promise;
}

function decodeAudioData(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    context.decodeAudioData(arrayBuffer.slice(0), resolve, reject);
  });
}

async function decodeDataUrl(context, dataUrl) {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error("Unable to decode sample audio data.");
  }
  return decodeAudioData(context, await response.arrayBuffer());
}

function voiceGain(velocity) {
  const normalizedVelocity = Math.max(0.05, Math.min(1, velocity / 127));
  return Math.max(0.04, normalizedVelocity ** 1.45);
}

export class MidiJsSampleRenderer {
  constructor({
    id,
    label,
    instrumentName,
    scriptUrl,
    masterGain = 0.35,
    releaseSeconds = 0.16,
    groupLabel = "Browser Sample Renderers",
    applyAudioOutputToContext = async () => {},
    onStatusChange = () => {},
  }) {
    this.id = id;
    this.label = label;
    this.instrumentName = instrumentName;
    this.scriptUrl = scriptUrl;
    this.masterGain = masterGain;
    this.releaseSeconds = releaseSeconds;
    this.groupLabel = groupLabel;
    this.applyAudioOutputToContext = applyAudioOutputToContext;
    this.onStatusChange = onStatusChange;
    this.context = null;
    this.master = null;
    this.activeVoices = new Map();
    this.samplesByMidiNote = new Map();
    this.availableMidiNotes = [];
    this.loadingPromise = null;
    this.status = "Idle";
    this.lastError = null;
  }

  getDisplayName() {
    return this.label;
  }

  getHealthLabel() {
    if (this.lastError) {
      return `Sample error: ${this.lastError.message}`;
    }
    if (this.status === "Loading") {
      return `${this.label} downloading samples`;
    }
    if (this.status === "Ready") {
      return `${this.label} ready`;
    }
    return `${this.label} ready on first use`;
  }

  setStatus(status, error = null) {
    this.status = status;
    this.lastError = error;
    this.onStatusChange();
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

  async prepare() {
    await this.ensureContext();
    if (this.samplesByMidiNote.size) {
      this.setStatus("Ready");
      return;
    }
    if (!this.loadingPromise) {
      this.loadingPromise = this.loadSamples();
    }
    return this.loadingPromise;
  }

  async loadSamples() {
    try {
      this.setStatus("Loading");
      if (!samplePreset(this.instrumentName)) {
        await loadClassicScript(this.scriptUrl);
      }
      const preset = samplePreset(this.instrumentName);
      if (!preset) {
        throw new Error(`Sample instrument is unavailable: ${this.instrumentName}.`);
      }

      const entries = Object.entries(preset)
        .map(([noteName, dataUrl]) => ({
          noteName,
          midiNote: noteNameToMidi(noteName),
          dataUrl,
        }))
        .filter((entry) => entry.midiNote != null && entry.dataUrl);

      for (let index = 0; index < entries.length; index += DECODE_BATCH_SIZE) {
        const batch = entries.slice(index, index + DECODE_BATCH_SIZE);
        await Promise.all(
          batch.map(async (entry) => {
            const buffer = await decodeDataUrl(this.context, entry.dataUrl);
            this.samplesByMidiNote.set(entry.midiNote, {
              buffer,
              midiNote: entry.midiNote,
              noteName: entry.noteName,
            });
          }),
        );
      }

      this.availableMidiNotes = [...this.samplesByMidiNote.keys()].sort((a, b) => a - b);
      if (!this.availableMidiNotes.length) {
        throw new Error(`No samples were found for ${this.label}.`);
      }
      this.setStatus("Ready");
    } catch (error) {
      this.samplesByMidiNote.clear();
      this.availableMidiNotes = [];
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.setStatus("Error", normalizedError);
      throw normalizedError;
    } finally {
      this.loadingPromise = null;
    }
  }

  async createPlaybackSession() {
    await this.prepare();
    return {};
  }

  key(note, channel) {
    return `${channel}:${note}`;
  }

  nearestSample(note) {
    const exactSample = this.samplesByMidiNote.get(note);
    if (exactSample) {
      return exactSample;
    }
    let nearestNote = this.availableMidiNotes[0];
    let nearestDistance = Math.abs(note - nearestNote);
    for (const candidate of this.availableMidiNotes) {
      const distance = Math.abs(note - candidate);
      if (distance < nearestDistance) {
        nearestNote = candidate;
        nearestDistance = distance;
      }
    }
    return this.samplesByMidiNote.get(nearestNote);
  }

  noteOn(note, channel, velocity) {
    if (!this.context || !this.master || !this.samplesByMidiNote.size) {
      return;
    }

    const sample = this.nearestSample(note);
    if (!sample) {
      return;
    }

    const at = this.context.currentTime + 0.001;
    const source = new AudioBufferSourceNode(this.context, {
      buffer: sample.buffer,
      playbackRate: 2 ** ((note - sample.midiNote) / 12),
    });
    const gain = new GainNode(this.context, { gain: MIN_GAIN });
    source.connect(gain).connect(this.master);
    gain.gain.setValueAtTime(MIN_GAIN, at);
    gain.gain.exponentialRampToValueAtTime(voiceGain(velocity), at + 0.008);

    let released = false;
    const key = this.key(note, channel);
    const voice = {
      release: (releaseAt, releaseSeconds = this.releaseSeconds) => {
        if (released) {
          return;
        }
        released = true;
        gain.gain.cancelScheduledValues(releaseAt);
        gain.gain.setValueAtTime(Math.max(MIN_GAIN, gain.gain.value), releaseAt);
        gain.gain.exponentialRampToValueAtTime(MIN_GAIN, releaseAt + releaseSeconds);
        try {
          source.stop(releaseAt + releaseSeconds + 0.02);
        } catch {
          // The sample may already have ended naturally.
        }
      },
    };

    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      this.forgetVoice(key, voice);
    };
    source.start(at);

    const existing = this.activeVoices.get(key) || [];
    existing.push(voice);
    this.activeVoices.set(key, existing);
  }

  forgetVoice(key, voice) {
    const voices = this.activeVoices.get(key);
    if (!voices?.length) {
      return;
    }
    const index = voices.indexOf(voice);
    if (index >= 0) {
      voices.splice(index, 1);
    }
    if (!voices.length) {
      this.activeVoices.delete(key);
    }
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
