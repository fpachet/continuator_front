export const DEFAULT_PLAYBACK_CHOICE = "sample_piano";
export const FAUST_CLAVIER_ID = "faust_clavier";
export const FAUST_CUSTOM_ID = "faust_custom";
export const WEB_MIDI_RENDERER_ID = "web_midi";
export const PLAYBACK_CHOICE_SEPARATOR = "::";
export const PHRASE_TIMEOUT_MS = 1000;
export const PLAYBACK_START_DELAY_MS = 80;
export const INFINITE_MIN_LOOKAHEAD_MS = 600;
export const INFINITE_MAX_LOOKAHEAD_MS = 2200;
export const VIRTUAL_MIDI_INPUT_ID = "__virtual_keyboard__";
export const VIRTUAL_MIDI_INPUT_NAME = "Virtual MIDI Keyboard";
export const VIRTUAL_KEYBOARD_DESKTOP_OCTAVES = 2;
export const VIRTUAL_KEYBOARD_PHONE_OCTAVES = 1;
export const PHONE_LAYOUT_MEDIA_QUERY =
  "(max-width: 640px), (pointer: coarse) and (max-height: 500px)";
export const PHONE_SCREEN_MAX_CSS_PX = 700;
export const VIRTUAL_KEYBOARD_DEFAULT_BASE_NOTE = 60;
export const VIRTUAL_KEYBOARD_MIN_BASE_NOTE = 24;
export const VIRTUAL_KEYBOARD_MAX_BASE_NOTE = 96;
export const VIRTUAL_CHORD_QUANTIZE_MS = 20;
export const VIRTUAL_KEYBOARD_CHANNEL = 0;
export const ROLL_NOTE_HIT_PADDING_PX = 6;
export const ROLL_NOTE_AUDITION_MIN_SECONDS = 0.12;
export const ROLL_NOTE_AUDITION_MAX_SECONDS = 2;
export const ROLL_END_MARGIN_RATIO = 0.08;
export const ROLL_END_MARGIN_MIN_SECONDS = 0.18;
export const ROLL_END_MARGIN_MAX_SECONDS = 1.2;
export const ROLL_DENSE_NOTE_THRESHOLD = 128;
export const ROLL_DENSE_MAX_DPR = 1.5;
export const CAPTURE_PREVIEW_INTERVAL_MS = 250;
export const STATUS_INDICATOR_INTERVAL_MS = 100;
export const PHRASE_GAP_VISIBILITY_DELAY_MS = 150;
export const COMPUTER_KEYBOARD_OFFSETS = new Map([
  ["KeyA", 0],
  ["KeyW", 1],
  ["KeyS", 2],
  ["KeyE", 3],
  ["KeyD", 4],
  ["KeyF", 5],
  ["KeyT", 6],
  ["KeyG", 7],
  ["KeyY", 8],
  ["KeyH", 9],
  ["KeyU", 10],
  ["KeyJ", 11],
  ["KeyK", 12],
]);
export const NOTE_NAMES = [
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
export const BLACK_KEY_OFFSETS = new Set([1, 3, 6, 8, 10]);
export const FAUST_WASM_ESM_URL = "/assets/vendor/faustwasm/esm/index.js";
export const FAUST_WASM_JS_URL =
  "/assets/vendor/faustwasm/libfaust-wasm/libfaust-wasm.js";
export const FAUST_WASM_DATA_URL =
  "/assets/vendor/faustwasm/libfaust-wasm/libfaust-wasm.data";
export const FAUST_WASM_BINARY_URL =
  "/assets/vendor/faustwasm/libfaust-wasm/libfaust-wasm.wasm";
export const FAUST_CLAVIER_DSP_URL = "/assets/faust/continuator-clavier.dsp";
export const FAUST_CUSTOM_TEMPLATE_DSP_URL =
  "/assets/faust/custom-poly-template.dsp";
export const PHRASE_TIMEOUT_STORAGE_KEY = "continuator.phrase.timeout.ms";
export const MIDI_INPUT_MONITOR_STORAGE_KEY = "continuator.midi.input.monitor";
export const MIDI_EXPORT_FILE_DB_NAME = "continuator-midi-zip-export";
export const MIDI_EXPORT_FILE_STORE_NAME = "file-handles";
export const MIDI_EXPORT_FILE_HANDLE_KEY = "session-midi-export-zip";
export const FAUST_CUSTOM_SOURCE_STORAGE_KEY =
  "continuator.faust.custom.source";
export const FAUST_CUSTOM_VALUES_STORAGE_KEY =
  "continuator.faust.custom.values";
export const PLAYBACK_PREFERENCE_STORAGE_PREFIX =
  "continuator.playback.preference";
export const MIDI_COPY_OUTPUT_PREFERENCE_STORAGE_PREFIX =
  "continuator.midi.copy.output.preference";
export const AUDIO_OUTPUT_PREFERENCE_STORAGE_PREFIX =
  "continuator.audio.output.preference";
export const ENGINE_LABEL = "VO Regular BP";
export const GRAPH_MODES = new Set([
  "slice",
  "all",
  "most_used",
  "neighborhood",
]);
export const FAUST_UI_CONTROL_TYPES = new Set([
  "hslider",
  "vslider",
  "nentry",
  "checkbox",
  "button",
]);
export const FAUST_POLY_RESERVED_SUFFIXES = [
  "/gate",
  "/freq",
  "/gain",
  "/key",
  "/vel",
  "/velocity",
];
