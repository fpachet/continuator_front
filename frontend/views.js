import {
  WEB_MIDI_RENDERER_ID,
  ROLL_NOTE_HIT_PADDING_PX,
  CAPTURE_PREVIEW_INTERVAL_MS,
  ENGINE_LABEL,
} from "./constants.js";
import { roundNumber, eventsToNotes } from "./midi-capture.js";
import { FaustPolyRenderer } from "./playback-renderers.js";
import {
  pianoRollNoteRects,
  pianoRollEventPoint,
  drawPianoRoll,
  payloadNotes,
} from "./piano-roll.js";

// Dependencies are supplied by app.js; modules never import the composition root.
export function createViews(dependencies) {
  const {
    auditionRollNote,
    elements,
    formatMilliseconds,
    hasLoopSeedPhrase,
    midiExportZipRememberSupported,
    midiNoteName,
    midiOutputById,
    normalizedKeepLastInputs,
    normalizedMarkovOrder,
    openSavedSession,
    parsePlaybackChoice,
    phraseDurationMs,
    phraseNoteCount,
    playPayload,
    playbackChoiceLabel,
    pluralize,
    refreshSavedSessions,
    refreshUserPlaybackPreferenceFromSavedSessions,
    rememberCapturedPhrase,
    rememberGeneratedPhrase,
    renderAccountTrigger,
    requestJson,
    selectedMidiCopyOutput,
    selectedMidiCopyOutputId,
    selectedPlaybackChoice,
    setPhraseMessage,
    setReadinessStep,
    state,
    stopActivePlayback,
    stopInfiniteMode,
    updateInfiniteActionState,
  } = dependencies;

  function formatDurationSeconds(value) {
    const duration = Number(value) || 0;
    return duration >= 10
      ? `${duration.toFixed(0)}s`
      : `${duration.toFixed(1)}s`;
  }

  function timelineSummary(payloadOrEvents, emptyText) {
    const noteCount = phraseNoteCount(payloadOrEvents);
    if (!noteCount) {
      return emptyText;
    }
    const durationMs = phraseDurationMs(payloadOrEvents);
    return `${pluralize(noteCount, "note")} / ${formatMilliseconds(durationMs)}`;
  }

  function setTimelineSegment(element, stateClass, value) {
    if (!element) {
      return;
    }
    element.classList.remove("is-ready", "is-playing", "is-queued");
    if (stateClass) {
      element.classList.add(stateClass);
    }
    const strong = element.querySelector("strong");
    if (strong) {
      strong.textContent = value;
    }
  }

  function rendererHealthLabel() {
    const choice = selectedPlaybackChoice();
    if (choice.rendererId === WEB_MIDI_RENDERER_ID) {
      if (!state.midiAccess) {
        return "Connect MIDI to inspect external outputs";
      }
      const output = midiOutputById(choice.targetId);
      return output
        ? "External MIDI ready"
        : "External MIDI output unavailable";
    }
    if (choice.renderer instanceof FaustPolyRenderer) {
      return choice.renderer.lastError
        ? `Faust error: ${choice.renderer.lastError.message}`
        : `Faust ${choice.renderer.status.toLowerCase()}`;
    }
    if (choice.renderer?.getHealthLabel) {
      return choice.renderer.getHealthLabel();
    }
    return "Browser renderer ready";
  }

  function renderTimingReadout() {
    if (!elements.timingReadout) {
      return;
    }
    const parts = [];
    if (state.lastCaptureDurationMs != null) {
      parts.push(`capture ${formatMilliseconds(state.lastCaptureDurationMs)}`);
    }
    if (state.lastGenerationMs != null) {
      parts.push(`generation ${formatMilliseconds(state.lastGenerationMs)}`);
    }
    parts.push(`renderer ${playbackChoiceLabel()}`);
    elements.timingReadout.textContent = parts.length
      ? parts.join(" · ")
      : "Waiting for first phrase";
  }

  function renderPerformanceState() {
    setReadinessStep(
      elements.readySessionStep,
      Boolean(state.sessionId),
      "Session",
    );
    setReadinessStep(
      elements.readyMidiStep,
      Boolean(state.activeInputId),
      "MIDI",
    );
    setReadinessStep(elements.readyPhraseStep, hasLoopSeedPhrase(), "Phrase");
    setReadinessStep(
      elements.readyOutputStep,
      Boolean(selectedPlaybackChoice().renderer),
      "Output",
    );

    if (elements.rendererHealth) {
      elements.rendererHealth.textContent = rendererHealthLabel();
    }
    if (elements.midiCopyStatusChip && elements.midiCopyStatus) {
      const outputId = selectedMidiCopyOutputId();
      const output = selectedMidiCopyOutput();
      elements.midiCopyStatusChip.hidden = !outputId;
      elements.midiCopyStatus.textContent = output
        ? `${output.name || output.id} ready`
        : "Output unavailable";
    }
    if (elements.sessionSaveNote) {
      elements.sessionSaveNote.textContent = state.authUser
        ? "Signed-in session: new sessions are saved under your account."
        : "Guest session: sign in before creating a new session if you want it saved and reopenable.";
    }

    setTimelineSegment(
      elements.timelineCaptured,
      state.lastCapturedPhrase.length ? "is-ready" : null,
      timelineSummary(state.lastCapturedPhrase, "empty"),
    );
    setTimelineSegment(
      elements.timelineGenerated,
      state.currentPlaybackPayload
        ? "is-playing"
        : state.lastGeneratedPhrase
          ? "is-ready"
          : null,
      timelineSummary(
        state.currentPlaybackPayload || state.lastGeneratedPhrase,
        "empty",
      ),
    );
    setTimelineSegment(
      elements.timelineQueued,
      state.queuedPlaybackPayload ? "is-queued" : null,
      timelineSummary(state.queuedPlaybackPayload, "none"),
    );
    renderTimingReadout();
  }

  function constraintPillText(label, state) {
    if (!state?.requested) {
      return `${label}: off${state?.reason ? ` (${state.reason})` : ""}`;
    }
    const status = state.relaxed ? "relaxed" : state.applied ? "on" : "off";
    const value = state.value ? ` · ${state.value}` : "";
    return `${label}: ${status}${value}`;
  }

  function constraintPillClass(state) {
    if (!state?.requested || (!state.applied && !state.relaxed)) {
      return "constraint-pill is-off";
    }
    if (state.relaxed) {
      return "constraint-pill is-relaxed";
    }
    return "constraint-pill";
  }

  function comparableSessionSettings(settings) {
    if (!settings) {
      return null;
    }
    return {
      learn_input: Boolean(settings.learn_input),
      transposition: Boolean(settings.transposition),
      forget_past: Boolean(settings.forget_past),
      markov_order: normalizedMarkovOrder(settings.markov_order),
      keep_last_inputs: normalizedKeepLastInputs(settings.keep_last_inputs),
    };
  }

  function sessionSettingValueLabel(key, value) {
    switch (key) {
      case "learn_input":
        return value ? "Learn input on" : "Learn input off";
      case "transposition":
        return value ? "Transpose on" : "Transpose off";
      case "forget_past":
        return value ? "Rolling memory on" : "Full memory";
      case "markov_order":
        return `K=${normalizedMarkovOrder(value)}`;
      case "keep_last_inputs":
        return `Keep last ${normalizedKeepLastInputs(value)}`;
      default:
        return String(value);
    }
  }

  function pendingSessionSettingChanges() {
    if (!state.sessionId || !state.sessionConfiguration) {
      return [];
    }
    const active = comparableSessionSettings(state.sessionConfiguration);
    const draft = comparableSessionSettings(readSessionSettingsFromControls());
    return [
      ["markov_order", "K"],
      ["transposition", "Transpose"],
      ["forget_past", "Memory"],
      ["keep_last_inputs", "Keep last"],
      ["learn_input", "Learn input"],
    ]
      .filter(([key]) => active[key] !== draft[key])
      .map(([key, label]) => ({
        key,
        label,
        active: sessionSettingValueLabel(key, active[key]),
        pending: sessionSettingValueLabel(key, draft[key]),
      }));
  }

  function hasPendingSessionSettings() {
    return pendingSessionSettingChanges().length > 0;
  }

  function pendingSessionSettingsText(
    changes = pendingSessionSettingChanges(),
  ) {
    const visibleChanges = changes.slice(0, 4);
    const suffix =
      changes.length > visibleChanges.length
        ? ` +${changes.length - visibleChanges.length}`
        : "";
    return `${visibleChanges.map((change) => change.pending).join(" · ")}${suffix}`;
  }

  function hasGenerationTrace(trace) {
    return Array.isArray(trace) && trace.length > 0;
  }

  function generationTracePillText(trace) {
    if (!Array.isArray(trace) || !trace.length) {
      return null;
    }
    const orders = trace
      .slice(0, 12)
      .map((step) => `K${Number(step?.effective_order ?? step?.order ?? 0)}`)
      .join(" ");
    const skippedCount = trace.reduce(
      (total, step) =>
        total +
        (Array.isArray(step?.skipped_orders) ? step.skipped_orders.length : 0),
      0,
    );
    const suffix = trace.length > 12 ? ` … +${trace.length - 12}` : "";
    const skipped = skippedCount ? ` · ${skippedCount} skips` : "";
    return `Trace orders: ${orders}${suffix}${skipped}`;
  }

  function generationTraceTitle(trace) {
    if (!Array.isArray(trace) || !trace.length) {
      return "";
    }
    return trace
      .map((step) => {
        const order = Number(step?.effective_order ?? step?.order ?? 0);
        const symbol = Array.isArray(step?.symbol)
          ? step.symbol.join(",")
          : String(step?.symbol ?? "");
        const skipped =
          Array.isArray(step?.skipped_orders) && step.skipped_orders.length
            ? ` skipped ${step.skipped_orders.join("/")}`
            : "";
        return `pos ${step?.position}: K${order} ${symbol}${skipped}`;
      })
      .join("\n");
  }

  function renderConstraintStatus(constraints, generationTrace = null) {
    state.lastConstraints = constraints || null;
    state.lastGenerationTrace = generationTrace || null;
    if (!elements.constraintStatus) {
      return;
    }
    elements.constraintStatus.replaceChildren();
    const traceText = generationTracePillText(generationTrace);
    const pendingChanges = pendingSessionSettingChanges();
    if (!constraints && !traceText && !pendingChanges.length) {
      elements.constraintStatus.hidden = true;
      return;
    }

    const enginePill = document.createElement("span");
    enginePill.className = "constraint-pill is-off";
    enginePill.textContent = `Active engine: ${ENGINE_LABEL}`;
    elements.constraintStatus.append(enginePill);

    if (pendingChanges.length) {
      const pill = document.createElement("span");
      pill.className = "constraint-pill is-pending";
      pill.textContent = `Pending: ${pendingSessionSettingsText(pendingChanges)}`;
      pill.title = pendingChanges
        .map(
          (change) => `${change.label}: ${change.active} -> ${change.pending}`,
        )
        .join("\n");
      elements.constraintStatus.append(pill);
    }

    if (constraints) {
      [
        ["Start", constraints.start],
        ["End", constraints.end],
      ].forEach(([label, value]) => {
        const pill = document.createElement("span");
        pill.className = constraintPillClass(value);
        pill.textContent = constraintPillText(label, value);
        if (value?.reason) {
          pill.title = value.reason;
        }
        elements.constraintStatus.append(pill);
      });
    }
    if (traceText) {
      const pill = document.createElement("span");
      pill.className = hasGenerationTrace(generationTrace)
        ? "constraint-pill"
        : "constraint-pill is-relaxed";
      pill.textContent = traceText;
      pill.title = generationTraceTitle(generationTrace);
      elements.constraintStatus.append(pill);
    }
    elements.constraintStatus.hidden = false;
  }

  function setAuthMessage(message, danger = false) {
    elements.authMessageBox.textContent = message;
    elements.authMessageBox.style.color = danger
      ? "var(--danger)"
      : "var(--muted)";
  }

  function setTextContentIfChanged(element, value) {
    const text = String(value);
    if (element.textContent !== text) {
      element.textContent = text;
    }
  }

  function setSessionStatus(label) {
    setTextContentIfChanged(elements.sessionStatus, label);
  }

  function setMidiStatus(label) {
    setTextContentIfChanged(elements.midiStatus, label);
  }

  function setPhraseStatus(label) {
    setTextContentIfChanged(elements.phraseStatus, label);
  }

  function setSelectedInputName(label) {
    state.selectedInputLabel = label;
  }

  function setLastMidiEvent(label) {
    state.lastMidiEventLabel = label;
  }

  function readSessionSettingsFromControls() {
    return {
      learn_input: elements.learnInputToggle.checked,
      transposition: elements.transposeToggle.checked,
      forget_past: elements.forgetToggle.checked,
      markov_order: normalizedMarkovOrder(elements.markovOrderInput.value),
      keep_last_inputs: normalizedKeepLastInputs(elements.keepLastInput.value),
    };
  }

  function describeSessionSettings(settings) {
    const orderLabel = `K=${normalizedMarkovOrder(settings?.markov_order)}`;
    const transposeLabel = settings?.transposition
      ? "Transpose on"
      : "Transpose off";
    const memoryLabel = settings?.forget_past
      ? `Keep last ${normalizedKeepLastInputs(settings?.keep_last_inputs)} phrases`
      : "Keep full memory";
    return [ENGINE_LABEL, orderLabel, transposeLabel, memoryLabel];
  }

  function settingsChipHtml(label, className = "") {
    return `<span class="settings-chip ${className}">${label}</span>`;
  }

  function savedPlaybackPreferenceLabel(configuration) {
    if (!configuration?.playback_choice) {
      return null;
    }
    if (configuration.playback_choice_name) {
      return configuration.playback_choice_name;
    }

    const { rendererId } = parsePlaybackChoice(configuration.playback_choice);
    if (rendererId === WEB_MIDI_RENDERER_ID) {
      return "External MIDI";
    }
    return playbackChoiceLabel(configuration.playback_choice);
  }

  function describeSessionPreferences(configuration) {
    const labels = [];
    const inputName =
      configuration?.midi_input_name || configuration?.midi_input_id;
    const playbackName = savedPlaybackPreferenceLabel(configuration);
    const midiCopyName =
      configuration?.midi_copy_output_name ||
      configuration?.midi_copy_output_id;
    if (inputName) {
      labels.push(`Input ${inputName}`);
    }
    if (playbackName) {
      labels.push(`Playback ${playbackName}`);
    }
    if (midiCopyName) {
      labels.push(`MIDI copy ${midiCopyName}`);
    }
    return labels;
  }

  function renderSessionSettingsSummary() {
    const activeSettings =
      state.sessionId && state.sessionConfiguration
        ? state.sessionConfiguration
        : readSessionSettingsFromControls();
    const labels = describeSessionSettings(activeSettings);
    const pendingChanges = pendingSessionSettingChanges();
    const chips = labels.map((label, index) =>
      settingsChipHtml(
        state.sessionId && index === 0 ? `Active: ${label}` : label,
        state.sessionId ? "is-active" : "",
      ),
    );
    elements.settingsSummary.classList.toggle(
      "is-pending",
      pendingChanges.length > 0,
    );
    if (pendingChanges.length) {
      chips.unshift(settingsChipHtml("Unsaved settings", "is-warning"));
      chips.push(
        settingsChipHtml(
          `Pending: ${pendingSessionSettingsText(pendingChanges)}`,
          "is-pending",
        ),
      );
    }
    elements.settingsSummary.innerHTML = chips.join("");
    updateSessionActionState();
    renderConstraintStatus(state.lastConstraints, state.lastGenerationTrace);
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
    updateKeepLastFieldState();
    renderSessionSettingsSummary();
  }

  function updateSessionActionState() {
    const hasPendingSettings = hasPendingSessionSettings();
    const canRememberExportFile = midiExportZipRememberSupported();
    elements.createSessionButton.disabled = false;
    elements.resetSessionButton.disabled = !state.sessionId;
    elements.saveSessionMidiButton.disabled =
      !state.sessionId || state.sessionMidiSaving;
    elements.saveSessionMidiButton.classList.toggle(
      "is-pending",
      state.sessionMidiSaving,
    );
    elements.saveSessionMidiButton.textContent = state.sessionMidiSaving
      ? "Saving MIDI..."
      : "Save Session MIDI";
    elements.rememberMidiExportFileToggle.disabled =
      !canRememberExportFile || state.sessionMidiSaving;
    if (!canRememberExportFile) {
      elements.rememberMidiExportFileToggle.checked = false;
      elements.rememberMidiExportFileToggle.title =
        "Remembering export files is not available in this browser.";
    } else {
      elements.rememberMidiExportFileToggle.title = "";
    }
    elements.showGraphButton.disabled = !state.sessionId || state.graphLoading;
    elements.showGraphButton.classList.toggle("is-pending", state.graphLoading);
    elements.showGraphButton.textContent = state.graphLoading
      ? "Rendering..."
      : "Show Memory Graph";
    elements.applySettingsButton.disabled =
      !state.sessionId || !hasPendingSettings;
    elements.applySettingsButton.classList.toggle(
      "is-pending",
      hasPendingSettings,
    );
    elements.applySettingsButton.textContent = !state.sessionId
      ? "Apply to Current Session"
      : hasPendingSettings
        ? "Apply Settings"
        : "Settings Applied";
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

  function formatShortTimestamp(value) {
    if (!value) {
      return "New";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function generatedSessionName(item) {
    const settings = item?.configuration || {};
    const kLabel = `${ENGINE_LABEL} K${normalizedMarkovOrder(
      settings.markov_order,
    )}`;
    const timeLabel = formatShortTimestamp(
      item?.created_at || item?.last_seen_at,
    );
    const learnedCount = Number(item?.active_learned_phrase_count || 0);
    const phraseCount = Number(item?.phrase_count || 0);
    if (learnedCount > 0) {
      return `Live ${pluralize(learnedCount, "phrase")} · ${kLabel} · ${timeLabel}`;
    }
    if (phraseCount > 0) {
      return `Logged ${pluralize(phraseCount, "phrase")} · ${kLabel} · ${timeLabel}`;
    }
    return `Empty ${kLabel} · ${timeLabel}`;
  }

  function sessionDisplayName(item) {
    const customName = item?.configuration?.display_name;
    return typeof customName === "string" && customName.trim()
      ? customName.trim()
      : generatedSessionName(item);
  }

  function createSavedSessionsMarkup(items) {
    if (!state.authUser) {
      return `<p class="muted">Sign in to load your saved sessions.</p>`;
    }
    if (!items.length) {
      return `<p class="muted">No saved sessions yet. Create one, play a phrase, and it will appear here.</p>`;
    }

    return items
      .map((item) => {
        const current = item.session_id === state.sessionId;
        const previewed = item.session_id === state.previewedSavedSessionId;
        const stateLabel = current ? "current" : item.loaded ? "live" : "saved";
        const activityLabel = `${item.active_learned_phrase_count} learned active · ${item.phrase_count} logged`;
        const resetLabel = item.last_reset_at
          ? ` · Reset ${formatTimestamp(item.last_reset_at)}`
          : "";
        const settingsLabel = describeSessionSettings(item.configuration).join(
          " · ",
        );
        const preferenceLabel = describeSessionPreferences(
          item.configuration,
        ).join(" · ");
        const detailLabel = [settingsLabel, preferenceLabel]
          .filter(Boolean)
          .join(" · ");
        const displayName = sessionDisplayName(item);
        return `
          <div
            class="history-item session-item ${current ? "is-selected" : ""} ${previewed ? "is-previewed" : ""}"
            data-owned-session-id="${item.session_id}"
          >
            <button
              class="session-preview-button"
              data-owned-session-preview-id="${item.session_id}"
              type="button"
            >
              <span class="history-kind">${stateLabel}</span>
              <span class="history-meta">
                <strong>${displayName}</strong>
                <span>${activityLabel}</span>
                <span>Seen ${formatTimestamp(item.last_seen_at)}${resetLabel}</span>
                <span>${detailLabel}</span>
              </span>
            </button>
            <button
              class="ghost session-open-button"
              data-owned-session-open-id="${item.session_id}"
              type="button"
              ${current ? "disabled" : ""}
            >
              ${current ? "Current" : "Open"}
            </button>
          </div>
        `;
      })
      .join("");
  }

  function syncSavedSessionSelection() {
    elements.mySessionsList
      .querySelectorAll("[data-owned-session-id]")
      .forEach((node) => {
        const sessionId = node.dataset.ownedSessionId;
        const current = sessionId === state.sessionId;
        const previewed = sessionId === state.previewedSavedSessionId;
        node.classList.toggle("is-selected", current);
        node.classList.toggle("is-previewed", previewed);
        const openButton = node.querySelector("[data-owned-session-open-id]");
        if (openButton) {
          openButton.disabled = current;
          openButton.textContent = current ? "Current" : "Open";
        }
      });
    renderSavedSessionPreview();
  }

  function previewSavedSession(sessionId) {
    const item = state.savedSessions.find(
      (session) => session.session_id === sessionId,
    );
    if (!item) {
      return;
    }
    state.previewedSavedSessionId = sessionId;
    syncSavedSessionSelection();
    setAuthMessage(
      `${item.session_id === state.sessionId ? "Current session" : "Previewing"}: ${sessionDisplayName(item)}.`,
    );
  }

  function selectedSavedSession() {
    return state.savedSessions.find(
      (session) => session.session_id === state.previewedSavedSessionId,
    );
  }

  function renderSavedSessionPreview() {
    const item = selectedSavedSession();
    if (!elements.savedSessionPreview) {
      return;
    }
    elements.savedSessionPreview.hidden = !item;
    if (!item) {
      return;
    }

    const current = item.session_id === state.sessionId;
    elements.savedSessionPreviewName.textContent = sessionDisplayName(item);
    elements.savedSessionNameInput.value =
      item.configuration?.display_name || "";
    elements.savedSessionNameInput.placeholder = generatedSessionName(item);
    elements.savedSessionPreviewOpenButton.disabled = current;
    elements.savedSessionPreviewOpenButton.textContent = current
      ? "Current"
      : "Open";
    elements.savedSessionPreviewMemory.textContent = `${pluralize(item.active_learned_phrase_count, "learned phrase")} active`;
    elements.savedSessionPreviewHistory.textContent = `${pluralize(item.phrase_count, "logged phrase")} · ${pluralize(item.input_phrase_count, "input")}`;
    elements.savedSessionPreviewSettings.textContent = [
      describeSessionSettings(item.configuration).join(" · "),
      describeSessionPreferences(item.configuration).join(" · "),
    ]
      .filter(Boolean)
      .join(" · ");
    elements.savedSessionPreviewSeen.textContent = `${formatTimestamp(item.last_seen_at)}${item.last_reset_at ? ` · Reset ${formatTimestamp(item.last_reset_at)}` : ""}`;
  }

  function attachSavedSessionEvents() {
    elements.mySessionsList
      .querySelectorAll("[data-owned-session-preview-id]")
      .forEach((node) => {
        node.addEventListener("click", () => {
          previewSavedSession(node.dataset.ownedSessionPreviewId);
        });
      });

    elements.mySessionsList
      .querySelectorAll("[data-owned-session-open-id]")
      .forEach((node) => {
        node.addEventListener("click", async () => {
          try {
            await openSavedSession(node.dataset.ownedSessionOpenId);
          } catch (error) {
            setAuthMessage(error.message, true);
          }
        });
      });
  }

  function renderSavedSessions(items) {
    state.savedSessions = items;
    if (state.authUser) {
      refreshUserPlaybackPreferenceFromSavedSessions(items);
    }
    if (
      state.previewedSavedSessionId &&
      !items.some((item) => item.session_id === state.previewedSavedSessionId)
    ) {
      state.previewedSavedSessionId = null;
    }
    elements.mySessionsList.innerHTML = createSavedSessionsMarkup(items);
    elements.savedSessionCount.textContent = state.authUser
      ? `${items.length} saved`
      : "Guest mode";
    elements.savedSessionsCopy.textContent = state.authUser
      ? "Select a session to preview its details, then open it when you want to load its memory."
      : "Sign in to reopen sessions saved under your account.";
    renderAccountTrigger();
    attachSavedSessionEvents();
    syncSavedSessionSelection();
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
    renderPerformanceState();
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
    elements.historyList
      .querySelectorAll("[data-history-index]")
      .forEach((node) => {
        node.classList.toggle(
          "is-selected",
          Number(node.dataset.historyIndex) === state.previewedHistoryIndex,
        );
      });

    const isSelectedMemoryIndex = (node) =>
      Number(node.dataset.memoryIndex) === state.previewedMemoryIndex;

    elements.memoryList
      .querySelectorAll("[data-memory-index]")
      .forEach((node) => {
        node.classList.toggle("is-selected", isSelectedMemoryIndex(node));
      });

    elements.memoryRibbon
      .querySelectorAll("[data-memory-index]")
      .forEach((node) => {
        node.classList.toggle("is-selected", isSelectedMemoryIndex(node));
      });

    syncMemoryPlaybackState();
  }

  function syncMemoryPlaybackState() {
    elements.memoryList
      .querySelectorAll("[data-memory-index]")
      .forEach((node) => {
        const memoryIndex = Number(node.dataset.memoryIndex);
        const isPlaying = memoryIndex === state.activeMemoryPlaybackIndex;
        node.classList.toggle("is-playing", isPlaying);
        const playButton = node.querySelector("[data-memory-play-index]");
        if (playButton) {
          playButton.textContent = isPlaying ? "Stop" : "Play";
          playButton.classList.toggle("danger-button", isPlaying);
          playButton.setAttribute("aria-pressed", String(isPlaying));
          playButton.title = isPlaying
            ? "Stop this memory phrase"
            : "Play this memory phrase";
        }
      });
  }

  function revealPreviewTarget(kind) {
    const target =
      kind === "generated" ? elements.outputRoll : elements.inputRoll;
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
      rememberCapturedPhrase(payload.events, payload.notes);
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
    syncRollPlaybackState();
  }

  function stopCapturedPreviewRender() {
    if (state.capturePreviewTimerId != null) {
      window.clearTimeout(state.capturePreviewTimerId);
      state.capturePreviewTimerId = null;
    }
    state.pendingCapturePreviewNotes = null;
    state.lastCapturePreviewAtMs = 0;
  }

  function scheduleCapturedPreviewRender(notes) {
    state.pendingCapturePreviewNotes = notes;
    if (state.capturePreviewTimerId != null || !notes?.length) {
      return;
    }

    const elapsedMs = window.performance.now() - state.lastCapturePreviewAtMs;
    const delayMs = Math.max(0, CAPTURE_PREVIEW_INTERVAL_MS - elapsedMs);
    state.capturePreviewTimerId = window.setTimeout(() => {
      state.capturePreviewTimerId = null;
      const previewNotes = state.pendingCapturePreviewNotes;
      state.pendingCapturePreviewNotes = null;
      state.lastCapturePreviewAtMs = window.performance.now();
      if (!previewNotes?.length) {
        return;
      }
      drawPianoRoll(
        elements.inputRoll,
        previewNotes,
        "#6dd3ce",
        "Capturing input phrase",
      );
    }, delayMs);
  }

  function renderCapturedProgress(eventCount, noteCount, notes) {
    elements.capturedEventCount.textContent = String(eventCount);
    elements.capturedNoteCount.textContent = String(noteCount);
    setPhraseStatus("Listening");
    if (eventCount === 1) {
      stopCapturedPreviewRender();
      drawPianoRoll(
        elements.inputRoll,
        [],
        "#6dd3ce",
        "Capturing input phrase",
      );
      syncRollPlaybackState();
    }
    scheduleCapturedPreviewRender(notes);
  }

  function renderGeneratedStats(payload) {
    const notes = payloadNotes(payload);
    elements.generatedEventCount.textContent = String(
      payload?.event_count || 0,
    );
    elements.generatedNoteCount.textContent = String(
      payload?.note_count || notes.length,
    );
    drawPianoRoll(
      elements.outputRoll,
      notes,
      "#f4a261",
      "Generated continuation",
    );
    syncRollPlaybackState();
  }

  function capturedRollPayload() {
    const events = state.lastCapturedPhrase;
    if (!events?.length) {
      return null;
    }
    const notes = state.lastCapturedNotes;
    if (!notes.length) {
      return null;
    }
    return {
      event_count: events.length,
      note_count: notes.length,
      duration_seconds: (state.lastCaptureDurationMs || 0) / 1000,
      events,
      notes,
    };
  }

  function rollPayload(kind) {
    return kind === "input" ? capturedRollPayload() : state.lastGeneratedPhrase;
  }

  function rollCanvas(kind) {
    return kind === "input" ? elements.inputRoll : elements.outputRoll;
  }

  function rollSourceLabel(kind) {
    return kind === "input" ? "captured phrase" : "generated continuation";
  }

  function rollAccent(kind) {
    return kind === "input" ? "#6dd3ce" : "#f4a261";
  }

  function rollEmptyLabel(kind) {
    return kind === "input" ? "Input phrase" : "Generated continuation";
  }

  function rollAuditionOptions(kind) {
    const audition = state.activeRollAudition;
    if (!audition || audition.kind !== kind) {
      return {};
    }
    return {
      highlightedNoteIndex: audition.noteIndex,
      noteProgressRatio: audition.progressRatio,
    };
  }

  function renderRollCanvas(kind, options = {}) {
    drawPianoRoll(
      rollCanvas(kind),
      payloadNotes(rollPayload(kind)),
      rollAccent(kind),
      rollEmptyLabel(kind),
      {
        ...rollAuditionOptions(kind),
        ...options,
      },
    );
  }

  function rollDefaultTitle(kind) {
    if (state.activeRollPlaybackKind === kind) {
      return `Click to stop the ${rollSourceLabel(kind)}`;
    }
    if (!rollPayload(kind)?.events?.length) {
      return kind === "input"
        ? "No captured phrase is available yet"
        : "No generated continuation is available yet";
    }
    return `Click a note to audition it, or click empty space to play the ${rollSourceLabel(kind)}`;
  }

  function pianoRollNoteHitFromEvent(kind, event) {
    const payload = rollPayload(kind);
    const notes = payloadNotes(payload);
    if (!notes.length) {
      return null;
    }

    const canvas = rollCanvas(kind);
    const point = pianoRollEventPoint(canvas, event);
    if (!point) {
      return null;
    }

    const noteRects = pianoRollNoteRects(point.width, point.height, notes);
    for (let index = noteRects.length - 1; index >= 0; index -= 1) {
      const noteRect = noteRects[index];
      const left = noteRect.x - ROLL_NOTE_HIT_PADDING_PX;
      const right = noteRect.x + noteRect.width + ROLL_NOTE_HIT_PADDING_PX;
      const top = noteRect.y - ROLL_NOTE_HIT_PADDING_PX;
      const bottom = noteRect.y + noteRect.height + ROLL_NOTE_HIT_PADDING_PX;
      if (
        point.x >= left &&
        point.x <= right &&
        point.y >= top &&
        point.y <= bottom
      ) {
        return noteRect;
      }
    }

    return null;
  }

  function syncRollPlaybackState() {
    elements.inputRoll.classList.toggle(
      "is-roll-playing",
      state.activeRollPlaybackKind === "input",
    );
    elements.outputRoll.classList.toggle(
      "is-roll-playing",
      state.activeRollPlaybackKind === "output",
    );
    elements.inputRoll.title = rollDefaultTitle("input");
    elements.outputRoll.title = rollDefaultTitle("output");
    elements.inputRoll.setAttribute(
      "aria-pressed",
      String(state.activeRollPlaybackKind === "input"),
    );
    elements.outputRoll.setAttribute(
      "aria-pressed",
      String(state.activeRollPlaybackKind === "output"),
    );
  }

  async function toggleRollPlayback(kind) {
    const payload = rollPayload(kind);
    if (!payload?.events?.length) {
      setPhraseMessage(
        kind === "input"
          ? "No captured phrase is available to play yet."
          : "No generated continuation is available to play yet.",
        true,
      );
      return;
    }

    if (state.activeRollPlaybackKind === kind) {
      stopActivePlayback();
      setPhraseStatus(
        state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI",
      );
      setPhraseMessage(
        kind === "input"
          ? "Stopped the captured phrase."
          : "Stopped the generated continuation.",
      );
      return;
    }

    stopInfiniteMode({ stopPlayback: true, silent: true });
    await playPayload(payload, {
      visualizationRoll: kind === "input" ? "input" : "output",
    });
    state.activeRollPlaybackKind = kind;
    syncRollPlaybackState();
    setPhraseMessage(
      kind === "input"
        ? "Playing the captured phrase from the piano roll."
        : "Playing the generated continuation from the piano roll.",
    );
  }

  async function handleRollClick(kind, event) {
    const noteHit = pianoRollNoteHitFromEvent(kind, event);
    if (noteHit) {
      await auditionRollNote(kind, noteHit);
      return;
    }

    if (state.activeRollPlaybackKind === kind) {
      await toggleRollPlayback(kind);
      return;
    }

    await toggleRollPlayback(kind);
  }

  function updateRollPointerTitle(kind, event) {
    if (state.activeRollPlaybackKind === kind) {
      rollCanvas(kind).title = rollDefaultTitle(kind);
      return;
    }

    const noteHit = pianoRollNoteHitFromEvent(kind, event);
    rollCanvas(kind).title = noteHit
      ? `Click to audition ${midiNoteName(noteHit.note.pitch)} from the ${rollSourceLabel(kind)}`
      : rollDefaultTitle(kind);
  }

  async function handleRollKeydown(kind, event) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    await toggleRollPlayback(kind);
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
    elements.historyList
      .querySelectorAll("[data-history-index]")
      .forEach((node) => {
        node.addEventListener("click", () => {
          const historyIndex = Number(node.dataset.historyIndex);
          const item = state.historyItems[historyIndex];
          if (!item) {
            return;
          }

          state.previewedHistoryIndex = historyIndex;
          state.previewedMemoryIndex = null;
          syncPreviewSelection();
          previewPhrasePayload(
            item.payload,
            item.kind,
            `Previewing ${item.kind} phrase from ${item.created_at}.`,
          );
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
      `${memory.summary.active_phrase_count} active`,
      `${memory.summary.live_phrase_count} live`,
    ];
    if (memory.summary.seeded_phrase_count) {
      chips.push(`${memory.summary.seeded_phrase_count} seed`);
    }
    chips.push(`${ENGINE_LABEL} / K=${memory.configuration.markov_order}`);

    return chips
      .map((label) => `<span class="settings-chip">${label}</span>`)
      .join("");
  }

  function createMemoryHint(memory) {
    if (!memory) {
      return "Create or open a session and play a phrase to build the Continuator style memory.";
    }
    if (!memory.summary.active_phrase_count) {
      return memory.configuration.transposition
        ? "No style phrases yet. Transposed variants will appear here after learning."
        : "No style phrases yet. Play a phrase to start filling the Continuator vocabulary.";
    }
    return "";
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
        const deleteButton = item.deletable
          ? `
              <button class="ghost danger-button memory-delete-button" data-memory-delete-index="${item.slot - 1}" type="button">
                Delete
              </button>
            `
          : "";
        return `
          <div class="history-item memory-item" data-memory-index="${item.slot - 1}">
            <button class="memory-preview-button" data-memory-preview-index="${item.slot - 1}" type="button">
              <span class="memory-card-head">
                <span class="history-kind">${itemLabel} #${item.slot}</span>
                <strong class="memory-primary">${item.note_count} notes</strong>
              </span>
              ${createMemoryThumbnailMarkup(item)}
              <span class="memory-detail">${formatDurationSeconds(item.duration_seconds)}</span>
            </button>
            <div class="memory-actions ${item.deletable ? "has-delete" : ""}">
              <button class="ghost memory-play-button" data-memory-play-index="${item.slot - 1}" type="button">
                Play
              </button>
              <button class="ghost memory-seed-button" data-memory-seed-index="${item.slot - 1}" type="button">
                Seed
              </button>
              ${deleteButton}
            </div>
          </div>
        `;
      })
      .join("");
  }

  function createMemoryThumbnailMarkup(item) {
    const notes = item?.payload?.notes?.length
      ? item.payload.notes
      : eventsToNotes(item?.payload?.events || []);
    if (!notes.length) {
      return `<span class="memory-thumbnail" aria-hidden="true"></span>`;
    }

    const minPitch = Math.min(...notes.map((note) => note.pitch));
    const maxPitch = Math.max(...notes.map((note) => note.pitch));
    const pitchRange = Math.max(1, maxPitch - minPitch);
    const duration = Math.max(
      0.1,
      ...notes.map(
        (note) =>
          note.end_seconds || note.start_seconds + note.duration_seconds,
      ),
    );
    const bars = notes
      .slice(0, 18)
      .map((note) => {
        const start = Math.max(
          0,
          Math.min(96, (note.start_seconds / duration) * 100),
        );
        const width = Math.max(
          7,
          Math.min(
            100 - start,
            (Math.max(0.05, note.duration_seconds) / duration) * 100,
          ),
        );
        const y = 74 - ((note.pitch - minPitch) / pitchRange) * 58;
        return `<span style="left:${roundNumber(start)}%;top:${roundNumber(y)}%;width:${roundNumber(width)}%;"></span>`;
      })
      .join("");
    return `<span class="memory-thumbnail" aria-hidden="true">${bars}</span>`;
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
      if (memoryIndex === state.activeMemoryPlaybackIndex) {
        stopActivePlayback();
        setPhraseStatus(
          state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI",
        );
        setPhraseMessage(
          `Stopped ${item?.source || "memory"} memory slot ${item?.slot || memoryIndex + 1}.`,
        );
        return;
      }
      if (!item?.payload?.events?.length) {
        setPhraseMessage("That memory phrase has no playable events.", true);
        return;
      }
      previewMemoryIndex(rawIndex);
      try {
        stopInfiniteMode({ stopPlayback: true, silent: true });
        await playPayload(item.payload);
        state.activeMemoryPlaybackIndex = memoryIndex;
        syncMemoryPlaybackState();
        setPhraseMessage(`Playing ${item.source} memory slot ${item.slot}.`);
      } catch (error) {
        setPhraseMessage(error.message, true);
      }
    };

    const seedMemoryIndex = (rawIndex) => {
      const memoryIndex = Number(rawIndex);
      const item = state.memoryItems[memoryIndex];
      if (!item?.payload?.events?.length) {
        setPhraseMessage("That memory phrase has no seedable events.", true);
        return;
      }
      previewMemoryIndex(rawIndex);
      stopInfiniteMode({ stopPlayback: true, silent: true });
      state.lastGeneratedPhrase = null;
      state.lastGeneratedAt = 0;
      state.queuedPlaybackPayload = null;
      state.currentPlaybackPayload = null;
      state.activeMemoryPlaybackIndex = null;
      renderGeneratedStats(null);
      syncMemoryPlaybackState();
      updateInfiniteActionState();
      renderPerformanceState();
      setPhraseMessage(
        `Using ${item.source} memory slot ${item.slot} as the infinite-mode seed.`,
      );
    };

    const deleteMemoryIndex = async (rawIndex) => {
      const memoryIndex = Number(rawIndex);
      const item = state.memoryItems[memoryIndex];
      if (!item) {
        return;
      }
      if (!item.deletable) {
        setPhraseMessage(
          "That memory phrase cannot be deleted from this session.",
          true,
        );
        return;
      }
      const confirmed = window.confirm(
        `Delete ${item.source} memory slot ${item.slot} from the active memory?`,
      );
      if (!confirmed) {
        return;
      }

      try {
        stopInfiniteMode({ stopPlayback: true, silent: true });
        stopActivePlayback();
        state.previewedMemoryIndex = null;
        setPhraseStatus("Updating memory");
        setPhraseMessage(
          `Deleting memory slot ${item.slot} and rebuilding the active memory...`,
        );
        const payload = await requestJson(
          `/api/sessions/${state.sessionId}/memory/${item.slot}?memory_id=${encodeURIComponent(item.memory_id)}`,
          { method: "DELETE" },
        );
        renderMemory(payload);
        await refreshSavedSessions();
        setPhraseStatus("Memory updated");
        setPhraseMessage(
          `Deleted memory slot ${item.slot}. Active memory was rebuilt.`,
        );
      } catch (error) {
        setPhraseMessage(error.message, true);
        setPhraseStatus("Error");
      }
    };

    elements.memoryList
      .querySelectorAll("[data-memory-preview-index]")
      .forEach((node) => {
        node.addEventListener("click", () => {
          previewMemoryIndex(node.dataset.memoryPreviewIndex);
        });
      });

    elements.memoryList
      .querySelectorAll("[data-memory-play-index]")
      .forEach((node) => {
        node.addEventListener("click", () => {
          void playMemoryIndex(node.dataset.memoryPlayIndex);
        });
      });

    elements.memoryList
      .querySelectorAll("[data-memory-seed-index]")
      .forEach((node) => {
        node.addEventListener("click", () => {
          seedMemoryIndex(node.dataset.memorySeedIndex);
        });
      });

    elements.memoryList
      .querySelectorAll("[data-memory-delete-index]")
      .forEach((node) => {
        node.addEventListener("click", () => {
          void deleteMemoryIndex(node.dataset.memoryDeleteIndex);
        });
      });

    elements.memoryRibbon
      .querySelectorAll("[data-memory-index]")
      .forEach((node) => {
        node.addEventListener("click", () => {
          previewMemoryIndex(node.dataset.memoryIndex);
        });
      });
  }

  function renderMemory(memory) {
    state.memoryItems = memory?.items || [];
    elements.memorySummary.innerHTML = createMemorySummaryMarkup(memory);
    const memoryHint = createMemoryHint(memory);
    elements.memoryHint.textContent = memoryHint;
    elements.memoryHint.hidden = !memoryHint;
    elements.memoryRibbon.innerHTML = createMemoryRibbonMarkup(
      state.memoryItems,
    );
    elements.memoryList.innerHTML = createMemoryMarkup(state.memoryItems);
    attachMemoryEvents();
    syncPreviewSelection();
  }

  return {
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
  };
}
