const BROWSER_SYNTH_ID = "__browser_synth__";
const PHRASE_TIMEOUT_MS = 1000;
const PLAYBACK_START_DELAY_MS = 80;
const INFINITE_MIN_LOOKAHEAD_MS = 600;
const INFINITE_MAX_LOOKAHEAD_MS = 2200;

const elements = {
  serverStatus: document.querySelector("#server-status"),
  sessionStatus: document.querySelector("#session-status"),
  sessionId: document.querySelector("#session-id"),
  midiStatus: document.querySelector("#midi-status"),
  phraseStatus: document.querySelector("#phrase-status"),
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
  historyTab: document.querySelector("#history-tab"),
  memoryTab: document.querySelector("#memory-tab"),
  historyPanel: document.querySelector("#history-panel"),
  memoryPanel: document.querySelector("#memory-panel"),
  viewTabs: document.querySelectorAll("[data-view-tab]"),
  midiInputSelect: document.querySelector("#midi-input-select"),
  midiOutputSelect: document.querySelector("#midi-output-select"),
  learnInputToggle: document.querySelector("#learn-input-toggle"),
  autoSendToggle: document.querySelector("#auto-send-toggle"),
  transposeToggle: document.querySelector("#transpose-toggle"),
  forgetToggle: document.querySelector("#forget-toggle"),
  keepLastInput: document.querySelector("#keep-last-input"),
  decayModeSelect: document.querySelector("#decay-mode-select"),
  continuationLengthInput: document.querySelector("#continuation-length-input"),
  startInfiniteButton: document.querySelector("#start-infinite-button"),
  stopInfiniteButton: document.querySelector("#stop-infinite-button"),
  createSessionButton: document.querySelector("#create-session-button"),
  resetSessionButton: document.querySelector("#reset-session-button"),
  applySettingsButton: document.querySelector("#apply-settings-button"),
  connectMidiButton: document.querySelector("#connect-midi-button"),
  refreshMidiButton: document.querySelector("#refresh-midi-button"),
  sendPhraseButton: document.querySelector("#send-phrase-button"),
  replayGeneratedButton: document.querySelector("#replay-generated-button"),
  clearPhraseButton: document.querySelector("#clear-phrase-button"),
};

const state = {
  midiAccess: null,
  activeInputId: null,
  sessionId: null,
  sessionConfiguration: null,
  lastCapturedPhrase: [],
  lastGeneratedPhrase: null,
  historyItems: [],
  memoryItems: [],
  activeActivityView: "history",
  previewedHistoryIndex: null,
  previewedMemoryIndex: null,
  previewPulseTimeoutId: null,
  activePlayback: null,
  infiniteModeEnabled: false,
  infiniteRequestInFlight: false,
  infiniteScheduleTimerId: null,
  infiniteAbortController: null,
  infiniteRunId: 0,
};

class BrowserSynth {
  constructor() {
    this.context = null;
    this.master = null;
    this.activeVoices = new Map();
  }

  async ensureContext() {
    if (!this.context) {
      this.context = new window.AudioContext();
      this.master = new window.GainNode(this.context, { gain: 0.18 });
      this.master.connect(this.context.destination);
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  key(note, channel) {
    return `${channel}:${note}`;
  }

  midiToFrequency(note) {
    return 440 * 2 ** ((note - 69) / 12);
  }

  noteOn(note, channel, velocity) {
    if (!this.context || !this.master) {
      return;
    }

    const at = this.context.currentTime + 0.001;
    const key = this.key(note, channel);
    const oscillator = new OscillatorNode(this.context, {
      type: "triangle",
      frequency: this.midiToFrequency(note),
    });
    const gain = new GainNode(this.context, { gain: 0.0001 });
    oscillator.connect(gain).connect(this.master);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.03, (velocity / 127) * 0.2),
      at + 0.015,
    );
    oscillator.start(at);

    const existing = this.activeVoices.get(key) || [];
    existing.push({ oscillator, gain });
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

    const at = this.context.currentTime + 0.001;
    const voice = voices.shift();
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), at);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
    voice.oscillator.stop(at + 0.1);
    if (!voices.length) {
      this.activeVoices.delete(key);
    }
  }

  stop() {
    if (!this.context) {
      return;
    }

    const at = this.context.currentTime + 0.001;
    for (const voices of this.activeVoices.values()) {
      for (const voice of voices) {
        voice.gain.gain.cancelScheduledValues(at);
        voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), at);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
        voice.oscillator.stop(at + 0.06);
      }
    }
    this.activeVoices.clear();
  }
}

class PhraseRecorder {
  constructor(timeoutMs, onUpdate, onComplete) {
    this.timeoutMs = timeoutMs;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.reset();
  }

  reset() {
    this.events = [];
    this.pendingNotes = new Set();
    this.lastTimestamp = null;
    if (this.timer) {
      window.clearTimeout(this.timer);
    }
    this.timer = null;
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
      return;
    }

    const elapsed = nowTimestamp - this.lastTimestamp;
    if (elapsed >= this.timeoutMs) {
      this.completePhrase();
      return;
    }

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

const synth = new BrowserSynth();
const recorder = new PhraseRecorder(
  PHRASE_TIMEOUT_MS,
  (events, completed) => {
    const notes = eventsToNotes(events);
    renderCapturedStats(events, notes, completed);
  },
  async (phrase) => {
    state.lastCapturedPhrase = phrase;
    const notes = eventsToNotes(phrase);
    renderCapturedStats(phrase, notes, true);
    updateInfiniteActionState();
    setPhraseMessage(
      `Phrase complete: ${phrase.length} events / ${notes.length} notes captured.`,
    );
    if (elements.autoSendToggle.checked) {
      await sendCurrentPhrase();
    }
  },
);

function roundNumber(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatDurationSeconds(value) {
  const duration = Number(value) || 0;
  return duration >= 10 ? `${duration.toFixed(0)}s` : `${duration.toFixed(1)}s`;
}

function setPhraseMessage(message, danger = false) {
  elements.messageBox.textContent = message;
  elements.messageBox.style.color = danger ? "var(--danger)" : "var(--muted)";
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

function normalizedKeepLastInputs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 20;
  }
  return Math.min(500, Math.max(1, Math.round(parsed)));
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

function hasLoopSeedPhrase() {
  return Boolean(state.lastCapturedPhrase.length || state.lastGeneratedPhrase?.events?.length);
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

function infiniteLookaheadMs(payload) {
  const durationMs = continuationDurationMs(payload);
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
    keep_last_inputs: normalizedKeepLastInputs(elements.keepLastInput.value),
    decay_mode: elements.decayModeSelect.value,
  };
}

function describeSessionSettings(settings) {
  const transposeLabel = settings.transposition ? "Transpose on" : "Transpose off";
  const memoryLabel = settings.forget_past
    ? `Keep last ${settings.keep_last_inputs} phrases`
    : "Keep full memory";
  const decayLabel = `Decay ${settings.decay_mode}`;
  return [transposeLabel, memoryLabel, decayLabel];
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
  elements.keepLastInput.value = String(configuration.keep_last_inputs);
  elements.decayModeSelect.value = configuration.decay_mode;
  updateKeepLastFieldState();
  renderSessionSettingsSummary();
}

function updateSessionActionState() {
  elements.applySettingsButton.disabled = !state.sessionId;
}

function setActivityView(view) {
  state.activeActivityView = view;
  const showHistory = view === "history";
  elements.historyTab.classList.toggle("is-active", showHistory);
  elements.historyTab.setAttribute("aria-selected", String(showHistory));
  elements.historyPanel.hidden = !showHistory;
  elements.memoryTab.classList.toggle("is-active", !showHistory);
  elements.memoryTab.setAttribute("aria-selected", String(!showHistory));
  elements.memoryPanel.hidden = showHistory;
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
    state.lastGeneratedPhrase = payload;
    renderGeneratedStats(payload);
  } else {
    state.lastCapturedPhrase = payload.events;
    renderCapturedStats(payload.events, payload.notes, true);
  }
  updateInfiniteActionState();
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
    return `<span class="settings-chip">No active memory yet</span>`;
  }

  const chips = [
    `${memory.summary.active_phrase_count} active sequences`,
    `${memory.summary.live_phrase_count} live`,
  ];
  if (memory.summary.seeded_phrase_count) {
    chips.push(`${memory.summary.seeded_phrase_count} seed`);
  }
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
    return "Create a session and play a phrase to inspect the active Continuator memory.";
  }
  if (!memory.summary.active_phrase_count) {
    return memory.configuration.transposition
      ? "No active sequences yet. When transpose is on, each learned phrase can appear as several active transposed variants."
      : "No active sequences yet. Play a phrase to start filling the Continuator memory.";
  }
  return memory.configuration.transposition
    ? "The ribbon reads oldest to newest. The list below starts with the newest active sequence, and transposed variants appear separately when transpose is enabled."
    : "The ribbon reads oldest to newest. The list below starts with the newest active sequence. Click any item to open it in the main piano roll.";
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
    return `<p class="muted">No active memory to show yet.</p>`;
  }

  return items
    .slice()
    .reverse()
    .map((item) => {
      const itemLabel = item.source === "seed" ? "Seed" : "Live";
      return `
        <button class="history-item memory-item" data-memory-index="${item.slot - 1}" type="button">
          <span class="history-kind">${itemLabel} #${item.slot}</span>
          <span class="history-meta">
            <strong>${item.note_count} notes / ${formatDurationSeconds(item.duration_seconds)}</strong>
            <span>Active slot ${item.slot} in current engine memory</span>
          </span>
          <span class="history-index">open</span>
        </button>
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

  elements.memoryList.querySelectorAll("[data-memory-index]").forEach((node) => {
    node.addEventListener("click", () => {
      previewMemoryIndex(node.dataset.memoryIndex);
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

function drawPianoRoll(canvas, notes, accent, emptyLabel) {
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

  ctx.fillStyle = accent;
  ctx.shadowBlur = 18;
  ctx.shadowColor = accent;

  for (const note of notes) {
    const x = (note.start_seconds / totalDuration) * width;
    const noteWidth = Math.max(
      8,
      (Math.max(0.05, note.duration_seconds) / totalDuration) * width,
    );
    const y =
      height - ((note.pitch - minPitch + 1) / pitchRange) * (height - 24) - 10;
    const noteHeight = Math.max(10, (height - 34) / pitchRange + 4);
    roundRect(ctx, x + 2, y, noteWidth, noteHeight, 8, true);
  }

  ctx.shadowBlur = 0;
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

async function createSession() {
  const settings = readSessionSettingsFromControls();
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json();
  state.sessionId = payload.session_id;
  state.sessionConfiguration = payload.configuration;
  elements.sessionId.textContent = payload.session_id;
  syncSettingsControls(payload.configuration);
  updateSessionActionState();
  setSessionStatus("Ready");
  setPhraseMessage(
    `Session created. ${describeSessionSettings(payload.configuration).join(" · ")}.`,
  );
  await refreshSessionActivity();
}

async function ensureSession() {
  if (!state.sessionId) {
    await createSession();
  }
}

async function resetSession() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  if (!state.sessionId) {
    setPhraseMessage("Create a session before resetting it.", true);
    return;
  }

  const response = await fetch(`/api/sessions/${state.sessionId}/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const payload = await response.json();

  state.lastGeneratedPhrase = null;
  renderGeneratedStats(null);
  updateInfiniteActionState();
  syncSettingsControls(payload.configuration);
  setPhraseMessage("Session memory cleared and the current settings were preserved.");
  await refreshMemory();
}

async function applyCurrentSessionSettings() {
  if (!state.sessionId) {
    setPhraseMessage("Create a session before applying settings.", true);
    return;
  }

  const settings = readSessionSettingsFromControls();
  const response = await fetch(`/api/sessions/${state.sessionId}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json();
  syncSettingsControls(payload.configuration);
  setPhraseMessage(
    `Session settings updated. ${describeSessionSettings(payload.configuration).join(" · ")}.`,
  );
  await refreshMemory();
}

async function refreshHistory() {
  if (!state.sessionId) {
    return;
  }

  const response = await fetch(
    `/api/sessions/${state.sessionId}/history?limit=10`,
  );
  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json();
  renderHistory(payload.items);
}

async function refreshMemory() {
  if (!state.sessionId) {
    return;
  }

  const response = await fetch(`/api/sessions/${state.sessionId}/memory`);
  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json();
  renderMemory(payload);
}

async function refreshSessionActivity() {
  if (!state.sessionId) {
    return;
  }

  await Promise.all([refreshHistory(), refreshMemory()]);
}

function buildContinuationRequestBody(phraseEvents, learnInput, signal = null) {
  const continuationNoteCount = normalizedContinuationNoteCount(
    elements.continuationLengthInput.value,
  );
  const requestBody = {
    session_id: state.sessionId,
    phrase: phraseEvents,
    learn_input: learnInput,
  };
  if (continuationNoteCount != null) {
    requestBody.continuation_note_count = continuationNoteCount;
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
  state.lastCapturedPhrase = payload.input_phrase.events;
  renderCapturedStats(payload.input_phrase.events, payload.input_phrase.notes, true);
  state.lastGeneratedPhrase = payload.generated_phrase;
  renderGeneratedStats(payload.generated_phrase);
  updateInfiniteActionState();
}

async function requestContinuationFromEvents(
  phraseEvents,
  {
    learnInput = elements.learnInputToggle.checked,
    statusLabel = "Sending",
    signal = null,
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
  );
  const response = await fetch("/api/continue", fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText);
  }

  const payload = await response.json();
  return { payload, continuationNoteCount };
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
  setPhraseStatus(payload.generated_phrase.note_count ? "Generated" : "Primed");
  setPhraseMessage(defaultContinuationMessage(payload, continuationNoteCount));
}

async function checkServer() {
  const response = await fetch("/health");
  if (!response.ok) {
    throw new Error("Server health check failed.");
  }
  const payload = await response.json();
  elements.serverStatus.textContent = payload.ok
    ? payload.seeded
      ? "Healthy / seeded"
      : "Healthy / empty memory"
    : "Unavailable";
}

function selectedMidiOutput() {
  if (!state.midiAccess) {
    return null;
  }
  return state.midiAccess.outputs.get(elements.midiOutputSelect.value) || null;
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

function stopActivePlayback() {
  const playback = state.activePlayback;
  if (!playback) {
    return false;
  }

  playback.timerIds.forEach((timerId) => {
    window.clearTimeout(timerId);
  });

  if (playback.output) {
    playback.activeOutputNotes.forEach((key) => {
      const [channelRaw, noteRaw] = key.split(":");
      const channel = Number(channelRaw);
      const note = Number(noteRaw);
      sendOutputMessage(playback.output, [0x80 | (channel & 0x0f), note, 0]);
    });

    for (let channel = 0; channel < 16; channel += 1) {
      sendOutputMessage(playback.output, [0xb0 | channel, 64, 0]);
      sendOutputMessage(playback.output, [0xb0 | channel, 123, 0]);
      sendOutputMessage(playback.output, [0xb0 | channel, 120, 0]);
    }
  }

  synth.stop();
  state.activePlayback = null;
  updateInfiniteActionState();
  return true;
}

function dispatchPlaybackEvent(playback, event) {
  if (playback.output) {
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
    return;
  }

  if (event.type === "note_on" && event.velocity > 0) {
    synth.noteOn(event.note, event.channel, event.velocity);
    return;
  }

  synth.noteOff(event.note, event.channel);
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

    let output = null;
    if (elements.midiOutputSelect.value !== BROWSER_SYNTH_ID) {
      output = selectedMidiOutput();
      if (output) {
        await output.open();
      }
    }

    if (!output) {
      await synth.ensureContext();
    }

    playback = {
      output,
      timerIds: new Set(),
      activeOutputNotes: new Set(),
      cleanupTimerId: null,
      endsAtMs: performance.now(),
    };
    state.activePlayback = playback;
  }

  if (playback.cleanupTimerId != null) {
    window.clearTimeout(playback.cleanupTimerId);
    playback.timerIds.delete(playback.cleanupTimerId);
    playback.cleanupTimerId = null;
  }

  const scheduleDelayMs = Math.max(0, startDelayMs);
  const scheduleBaseMs = performance.now();
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
  playback.endsAtMs = Math.max(playback.endsAtMs, scheduleBaseMs + scheduleDelayMs + cursorMs);
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
    setPhraseStatus(state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI");
    setPhraseMessage(message || "Infinite mode stopped.");
    return true;
  }

  if (stopActivePlayback()) {
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
    ? Math.max(0, state.activePlayback.endsAtMs - performance.now())
    : continuationDurationMs(prefixPayload);
  const delayMs = Math.max(0, remainingPlaybackMs - infiniteLookaheadMs(prefixPayload));

  state.infiniteScheduleTimerId = window.setTimeout(() => {
    state.infiniteScheduleTimerId = null;
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }
    void runInfiniteStep(prefixPayload.events, runId);
  }, delayMs);
  updateInfiniteActionState();
}

async function runInfiniteStep(prefixEvents, runId) {
  if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
    return;
  }

  state.infiniteRequestInFlight = true;
  const abortController = new AbortController();
  state.infiniteAbortController = abortController;
  updateInfiniteActionState();

  try {
    const { payload } = await requestContinuationFromEvents(prefixEvents, {
      learnInput: false,
      statusLabel: state.activePlayback ? "Queueing next" : "Sending",
      signal: abortController.signal,
    });
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    applyContinuationPayload(payload);
    if (!payload.generated_phrase.event_count) {
      stopInfiniteMode({
        stopPlayback: false,
        message: "Infinite mode stopped because the latest continuation was empty.",
      });
      setPhraseStatus("Primed");
      return;
    }

    const startDelayMs = state.activePlayback
      ? Math.max(0, state.activePlayback.endsAtMs - performance.now())
      : PLAYBACK_START_DELAY_MS;
    await playPayload(payload.generated_phrase, {
      startDelayMs,
      append: Boolean(state.activePlayback),
    });
    await refreshSessionActivity();
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    setPhraseStatus("Infinite");
    setPhraseMessage(
      `Infinite mode running: ${payload.generated_phrase.note_count} notes queued from the latest continuation.`,
    );
    scheduleInfiniteStep(payload.generated_phrase, runId);
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

  const seedEvents = state.lastCapturedPhrase.length
    ? state.lastCapturedPhrase
    : state.lastGeneratedPhrase?.events || [];
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
    });
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    applyContinuationPayload(payload);
    if (!payload.generated_phrase.event_count) {
      stopInfiniteMode({
        stopPlayback: false,
        message: "Infinite mode stopped because the first continuation was empty.",
      });
      setPhraseStatus("Primed");
      return;
    }

    await playPayload(payload.generated_phrase);
    await refreshSessionActivity();
    if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
      return;
    }

    setPhraseStatus("Infinite");
    setPhraseMessage(
      `Infinite mode running: ${payload.generated_phrase.note_count} notes in the first continuation.`,
    );
    scheduleInfiniteStep(payload.generated_phrase, runId);
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

async function populateMidiSelectors() {
  if (!state.midiAccess) {
    return;
  }

  const inputs = [...state.midiAccess.inputs.values()];
  const outputs = [...state.midiAccess.outputs.values()];
  const previousInputId = elements.midiInputSelect.value;
  const previousOutputId = elements.midiOutputSelect.value;

  elements.midiInputSelect.disabled = false;
  elements.midiInputSelect.innerHTML = inputs.length
    ? inputs
        .map(
          (input) =>
            `<option value="${input.id}">${input.name || input.id}</option>`,
        )
        .join("")
    : `<option value="">No MIDI inputs found</option>`;

  elements.midiOutputSelect.disabled = false;
  const outputOptions = [
    `<option value="${BROWSER_SYNTH_ID}">Browser Synth</option>`,
    ...outputs.map(
      (output) =>
        `<option value="${output.id}">${output.name || output.id}</option>`,
    ),
  ];
  elements.midiOutputSelect.innerHTML = outputOptions.join("");
  elements.midiOutputSelect.value =
    previousOutputId &&
    (previousOutputId === BROWSER_SYNTH_ID ||
      state.midiAccess.outputs.has(previousOutputId))
      ? previousOutputId
      : BROWSER_SYNTH_ID;
  updateSelectedOutput();

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
  const outputId = elements.midiOutputSelect.value;
  if (outputId === BROWSER_SYNTH_ID) {
    setSelectedOutputName("Browser Synth");
    return;
  }

  const output = selectedMidiOutput();
  setSelectedOutputName(output ? output.name || output.id : "Unavailable output");
}

function clearPhrases() {
  stopInfiniteMode({ stopPlayback: true, silent: true });
  state.lastCapturedPhrase = [];
  state.lastGeneratedPhrase = null;
  state.previewedHistoryIndex = null;
  state.previewedMemoryIndex = null;
  recorder.reset();
  renderCapturedStats([], [], false);
  renderGeneratedStats(null);
  syncPreviewSelection();
  updateInfiniteActionState();
  setPhraseStatus("Waiting for MIDI");
  setPhraseMessage("Cleared the local phrase buffers.");
}

function bindEvents() {
  elements.viewTabs.forEach((node) => {
    node.addEventListener("click", () => {
      setActivityView(node.dataset.viewTab);
    });
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

  elements.midiOutputSelect.addEventListener("change", async () => {
    updateSelectedOutput();
    const output = selectedMidiOutput();
    if (output) {
      try {
        await output.open();
      } catch (error) {
        setPhraseMessage(error.message, true);
        return;
      }
    }
    setPhraseMessage(`Playback output set to ${elements.selectedOutputName.textContent}.`);
  });

  elements.learnInputToggle.addEventListener("change", () => {
    renderSessionSettingsSummary();
  });

  elements.transposeToggle.addEventListener("change", () => {
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
  clearPhrases();
  renderMemory(null);
  setActivityView("history");
  setSelectedInputName("No MIDI input selected");
  setSelectedOutputName("Browser Synth");
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
}

initialize();
