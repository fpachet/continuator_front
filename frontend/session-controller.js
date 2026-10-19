import { VIRTUAL_MIDI_INPUT_ID, VIRTUAL_MIDI_INPUT_NAME } from "./constants.js";

// Dependencies are supplied by app.js; modules never import the composition root.
export function createSessionController(dependencies) {
  const {
    applyPreferredAudioOutput,
    backupStatus,
    attachInput,
    chooseMidiExportZipFileHandle,
    clearCurrentSessionState,
    clearPhraseBuffers,
    describeSessionSettings,
    downloadZipBlob,
    elements,
    filePickerBlockedByFrame,
    fetchApi = (...args) => fetch(...args),
    hasMidiFileExtension,
    hasPendingSessionSettings,
    isVirtualMidiInputId,
    isVirtualMidiInputSelected,
    loadStoredAudioOutputPreference,
    loadStoredMidiCopyOutputPreference,
    loadStoredPlaybackPreference,
    midiExportZipSaveSupported,
    midiOutputById,
    normalizedContinuationNoteCount,
    playPayload,
    playbackChoiceLabel,
    pluralize,
    populateAudioOutputChoices,
    preferredGenerationNoteCount,
    readSessionSettingsFromControls,
    rememberCapturedPhrase,
    rememberGeneratedPhrase,
    rememberMidiCopyOutputPreference,
    rememberPlaybackPreference,
    renderCapturedStats,
    renderConstraintStatus,
    renderGeneratedStats,
    renderHistory,
    renderMemory,
    renderPerformanceState,
    renderSavedSessions,
    requestSessionMidiZip,
    selectMidiCopyOutputPreference,
    selectPlaybackPreference,
    selectedMidiCopyOutputId,
    selectedPlaybackChoiceValue,
    selectedSavedSession,
    serverWaitLabel,
    sessionDisplayName,
    setAccountPanelOpen,
    setAuthMessage,
    setControlView,
    setPhraseMessage,
    setPhraseStatus,
    setSessionMidiSaveResult,
    setSessionStatus,
    startServerWaitIndicator,
    state,
    stopInfiniteMode,
    stopServerWaitIndicator,
    syncAuthUI,
    syncSettingsControls,
    updateInfiniteActionState,
    updateSessionActionState,
    updateSessionGraphImage,
    validateAuthCredentials,
    writeZipBlobToFileHandle,
  } = dependencies;

  async function requestJson(url, options = {}) {
    const writing = ["POST", "PATCH", "DELETE", "PUT"].includes(
      options.method?.toUpperCase(),
    );
    if (writing) backupStatus?.beginWrite();
    try {
      return await fetchJson(url, options);
    } finally {
      if (writing) backupStatus?.endWrite();
    }
  }

  async function fetchJson(url, options = {}) {
    const response = await fetchApi(url, options);
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
        clearCurrentSessionState(
          "Your sign-in expired. Sign in again to reopen sessions.",
        );
      }
      const detailList =
        payload && typeof payload === "object" && Array.isArray(payload.detail)
          ? payload.detail
              .map((item) => (typeof item?.msg === "string" ? item.msg : null))
              .filter(Boolean)
          : [];
      const detail =
        payload &&
        typeof payload === "object" &&
        typeof payload.detail === "string"
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

  async function renamePreviewedSession() {
    const item = selectedSavedSession();
    if (!item) {
      setAuthMessage("Select a saved session before renaming it.", true);
      return;
    }
    const displayName = elements.savedSessionNameInput.value.trim();
    if (!displayName) {
      setAuthMessage("Enter a session name before saving.", true);
      return;
    }

    const payload = await requestJson(
      `/api/my/sessions/${item.session_id}/name`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName }),
      },
    );
    item.configuration = payload.configuration;
    item.last_seen_at = payload.updated_at;
    if (item.session_id === state.sessionId) {
      state.sessionConfiguration = payload.configuration;
    }
    renderSavedSessions(state.savedSessions);
    setAuthMessage(`Renamed session to ${sessionDisplayName(item)}.`);
  }

  function updateSavedSessionConfiguration(
    sessionId,
    configuration,
    updatedAt = null,
  ) {
    const item = state.savedSessions.find(
      (session) => session.session_id === sessionId,
    );
    if (!item) {
      return;
    }
    item.configuration = configuration;
    if (updatedAt) {
      item.last_seen_at = updatedAt;
    }
    renderSavedSessions(state.savedSessions);
  }

  function currentInputPreference() {
    if (isVirtualMidiInputSelected()) {
      return {
        midi_input_id: VIRTUAL_MIDI_INPUT_ID,
        midi_input_name: VIRTUAL_MIDI_INPUT_NAME,
      };
    }
    if (!state.midiAccess || !state.activeInputId) {
      return {};
    }
    const input = state.midiAccess.inputs.get(state.activeInputId);
    if (!input) {
      return {};
    }
    return {
      midi_input_id: input.id,
      midi_input_name: input.name || input.id,
    };
  }

  function currentPlaybackPreference() {
    return {
      playback_choice: selectedPlaybackChoiceValue(),
      playback_choice_name: playbackChoiceLabel(),
    };
  }

  function currentMidiCopyOutputPreference() {
    const outputId = selectedMidiCopyOutputId();
    const output = midiOutputById(outputId);
    return {
      midi_copy_output_id: output?.id || null,
      midi_copy_output_name: output ? output.name || output.id : null,
    };
  }

  async function saveSessionPreferences(preferences) {
    if (preferences?.playback_choice) {
      rememberPlaybackPreference(preferences);
    }
    if (
      preferences &&
      Object.prototype.hasOwnProperty.call(preferences, "midi_copy_output_id")
    ) {
      rememberMidiCopyOutputPreference(preferences);
    }
    if (!state.sessionId || !preferences || !Object.keys(preferences).length) {
      return null;
    }

    const payload = await requestJson(
      `/api/sessions/${state.sessionId}/preferences`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      },
    );
    state.sessionConfiguration = payload.configuration;
    updateSavedSessionConfiguration(
      payload.session_id,
      payload.configuration,
      payload.updated_at,
    );
    return payload;
  }

  async function refreshAuthState() {
    const payload = await requestJson("/api/auth/me");
    state.authUser = payload?.user || null;
    state.userMidiCopyOutputPreference = loadStoredMidiCopyOutputPreference();
    state.userAudioOutputPreference = loadStoredAudioOutputPreference();
    populateAudioOutputChoices();
    await applyPreferredAudioOutput();
    syncAuthUI();
    if (state.authUser) {
      await refreshSavedSessions();
      if (!state.sessionId) {
        clearCurrentSessionState("Create or open a session to start playing.");
      }
      return;
    }

    state.userPlaybackPreference = loadStoredPlaybackPreference();
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

    const endpoint =
      mode === "register" ? "/api/auth/register" : "/api/auth/login";
    const payload = await requestJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    // A successful password check does not prove that an embedded browser kept
    // the cookie. Check it before changing ownership or discarding guest state.
    const confirmed = await requestJson("/api/auth/me");
    if (confirmed.user?.id !== payload.user?.id) {
      throw new Error(
        "Your browser did not retain the sign-in cookie. Open the app in its own tab using the link below, then sign in there. Your current guest session is still open.",
      );
    }

    state.authUser = payload.user;
    state.userMidiCopyOutputPreference = loadStoredMidiCopyOutputPreference();
    state.userAudioOutputPreference = loadStoredAudioOutputPreference();
    populateAudioOutputChoices();
    await applyPreferredAudioOutput();
    elements.authUsernameInput.value = payload.user.username;
    syncAuthUI();
    if (
      state.sessionId &&
      !state.sessionIsOwned &&
      elements.claimSessionToggle.checked
    ) {
      await claimCurrentSession();
    } else {
      await refreshSavedSessions();
      const message = `Signed in as ${payload.user.username}. ${
        state.sessionId && !state.sessionIsOwned
          ? "This session is still a guest session. Use Save current session to keep it in your account."
          : "Your sessions are linked to your account."
      }`;
      setAuthMessage(message);
      setPhraseMessage(message);
    }
    setAccountPanelOpen(false);
  }

  async function claimCurrentSession() {
    if (!state.authUser || !state.sessionId || state.sessionIsOwned) return;
    elements.claimSessionButton.disabled = true;
    try {
      await requestJson(`/api/my/sessions/${state.sessionId}/claim`, {
        method: "POST",
      });
      // Keep phrase buffers, playback and memory in place. Only ownership changes.
      state.sessionIsOwned = true;
      syncAuthUI();
      await refreshSavedSessions();
      const message =
        "This session and its existing phrases are now linked to your account. Check the cloud save status above.";
      setAuthMessage(message);
      setPhraseMessage(message);
    } finally {
      elements.claimSessionButton.disabled = false;
    }
  }

  async function logoutUser() {
    await requestJson("/api/auth/logout", { method: "POST" });
    state.authUser = null;
    state.userPlaybackPreference = loadStoredPlaybackPreference();
    state.userMidiCopyOutputPreference = loadStoredMidiCopyOutputPreference();
    state.userAudioOutputPreference = loadStoredAudioOutputPreference();
    populateAudioOutputChoices();
    await applyPreferredAudioOutput();
    syncAuthUI();
    renderSavedSessions([]);
    setAccountPanelOpen(false);
    if (state.sessionIsOwned) {
      clearCurrentSessionState(
        "Signed out. Reopen a saved session after signing back in, or create a new guest session.",
      );
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

  async function selectMidiInputPreference(configuration) {
    const preferredInputId = configuration?.midi_input_id;
    if (!preferredInputId) {
      return false;
    }
    if (isVirtualMidiInputId(preferredInputId)) {
      await attachInput(VIRTUAL_MIDI_INPUT_ID, { savePreference: false });
      return true;
    }
    if (!state.midiAccess || !state.midiAccess.inputs.has(preferredInputId)) {
      return false;
    }

    await attachInput(preferredInputId, { savePreference: false });
    return true;
  }

  async function restoreSessionPreferences(configuration) {
    selectPlaybackPreference(configuration);
    selectMidiCopyOutputPreference(configuration);
    await selectMidiInputPreference(configuration);
  }

  async function useSessionPayload(
    payload,
    { owned = Boolean(state.authUser) } = {},
  ) {
    state.sessionId = payload.session_id;
    state.sessionIsOwned = owned;
    state.sessionConfiguration = payload.configuration;
    setSessionMidiSaveResult();
    elements.sessionId.textContent = payload.session_id;
    syncSettingsControls(payload.configuration);
    await restoreSessionPreferences(payload.configuration);
    updateSessionActionState();
    setSessionStatus("Ready");
    renderPerformanceState();
  }

  async function openSavedSession(sessionId) {
    if (!sessionId) {
      return;
    }

    const payload = await requestJson(`/api/my/sessions/${sessionId}/open`, {
      method: "POST",
    });
    state.previewedSavedSessionId = sessionId;
    await useSessionPayload(payload, { owned: true });
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

  async function createSession({
    preservePhraseBuffers = false,
    announce = true,
  } = {}) {
    const settings = readSessionSettingsFromControls();
    const payload = await requestJson("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });

    await useSessionPayload(payload, { owned: Boolean(state.authUser) });
    const restoredPlaybackPreference = selectPlaybackPreference(
      state.userPlaybackPreference,
    );
    const restoredMidiCopyPreference = selectMidiCopyOutputPreference(
      state.userMidiCopyOutputPreference,
    );
    await saveSessionPreferences({
      ...currentInputPreference(),
      ...(restoredPlaybackPreference ||
      !state.userPlaybackPreference?.playback_choice
        ? currentPlaybackPreference()
        : {}),
      ...(restoredMidiCopyPreference ||
      !state.userMidiCopyOutputPreference?.midi_copy_output_id
        ? currentMidiCopyOutputPreference()
        : state.userMidiCopyOutputPreference),
    });
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

    const payload = await requestJson(
      `/api/sessions/${state.sessionId}/reset`,
      {
        method: "POST",
      },
    );

    state.lastGeneratedPhrase = null;
    state.currentPlaybackPayload = null;
    state.queuedPlaybackPayload = null;
    renderGeneratedStats(null);
    renderPerformanceState();
    updateInfiniteActionState();
    syncSettingsControls(payload.configuration);
    renderConstraintStatus(null);
    setPhraseMessage(
      "Session memory cleared and the current settings were preserved.",
    );
    await refreshMemory();
    await refreshSavedSessions();
  }

  async function saveSessionMidi() {
    if (!state.sessionId) {
      setSessionMidiSaveResult(
        "Create or open a session before saving MIDI files.",
        true,
      );
      setPhraseMessage(
        "Create or open a session before saving MIDI files.",
        true,
      );
      return;
    }

    state.sessionMidiSaving = true;
    updateSessionActionState();
    setSessionMidiSaveResult(
      "Saving played and generated phrases as MIDI files...",
    );
    setPhraseStatus("Saving");
    setPhraseMessage("Saving played and generated phrases as MIDI files...");
    try {
      const payload = await requestSessionMidiZip();
      let destinationLabel = null;
      if (midiExportZipSaveSupported()) {
        let fileHandle = null;
        try {
          fileHandle = await chooseMidiExportZipFileHandle(
            payload.archive_file_name,
          );
        } catch (error) {
          if (error?.name === "AbortError") {
            setPhraseStatus(
              state.lastCapturedPhrase.length
                ? "Phrase ready"
                : "Waiting for MIDI",
            );
            setSessionMidiSaveResult("MIDI export cancelled.");
            setPhraseMessage("MIDI export cancelled.");
            return;
          }
          if (filePickerBlockedByFrame(error)) {
            destinationLabel = `${downloadZipBlob(payload.blob, payload.archive_file_name)} in your browser downloads`;
            setSessionMidiSaveResult(
              "File picker is blocked in this embedded page; using browser downloads instead.",
            );
            fileHandle = null;
          } else if (
            error?.name === "NotAllowedError" ||
            /system files/i.test(error?.message || "")
          ) {
            throw new Error(
              "Chrome blocked that location. Save the ZIP in Downloads, Documents, Desktop, or Music instead of a system, home, or project folder.",
            );
          } else {
            throw error;
          }
        }
        if (fileHandle) {
          destinationLabel = await writeZipBlobToFileHandle(
            payload.blob,
            fileHandle,
          );
        }
      } else {
        destinationLabel = `${downloadZipBlob(payload.blob, payload.archive_file_name)} in your browser downloads`;
      }

      const message = defaultSessionMidiSaveMessage(payload, destinationLabel);
      setPhraseStatus("Saved");
      setSessionMidiSaveResult(message);
      setPhraseMessage(message);
    } finally {
      state.sessionMidiSaving = false;
      updateSessionActionState();
    }
  }

  async function applyCurrentSessionSettings() {
    if (!state.sessionId) {
      setPhraseMessage("Create a session before applying settings.", true);
      return;
    }
    if (!hasPendingSessionSettings()) {
      setPhraseMessage("Settings are already applied to the active session.");
      return;
    }

    const settings = readSessionSettingsFromControls();
    const payload = await requestJson(
      `/api/sessions/${state.sessionId}/settings`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      },
    );
    syncSettingsControls(payload.configuration);
    renderConstraintStatus(null);
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

    const payload = await requestJson(
      `/api/sessions/${state.sessionId}/history?limit=10`,
    );
    renderHistory(payload.items);
  }

  async function refreshMemory() {
    if (!state.sessionId) {
      return;
    }

    const payload = await requestJson(
      `/api/sessions/${state.sessionId}/memory`,
    );
    renderMemory(payload);
  }

  async function refreshSessionActivity() {
    if (!state.sessionId) {
      return;
    }

    await Promise.all([refreshHistory(), refreshMemory()]);
    if (state.graphOpen) {
      await updateSessionGraphImage(state.activeGraphKind, {
        openPanel: false,
        announce: false,
        closeOnError: false,
        preserveScroll: true,
      });
    }
  }

  async function refreshVisibleSessionViews() {
    const refreshes = [];
    if (state.activeControlView === "memory") {
      refreshes.push(refreshSessionActivity());
    }
    if (state.activeControlView === "session" || state.accountPanelOpen) {
      refreshes.push(refreshSavedSessions());
    }
    await Promise.all(refreshes);
  }

  function scheduleVisibleSessionRefresh() {
    void refreshVisibleSessionViews().catch((error) => {
      console.warn("Could not refresh the visible session view.", error);
    });
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

  function applyContinuationPayload(
    payload,
    { renderCaptured = true, renderGenerated = true } = {},
  ) {
    rememberCapturedPhrase(
      payload.input_phrase.events,
      payload.input_phrase.notes,
    );
    if (renderCaptured) {
      renderCapturedStats(
        payload.input_phrase.events,
        payload.input_phrase.notes,
        true,
      );
    }
    rememberGeneratedPhrase(payload.generated_phrase);
    renderConstraintStatus(payload.constraints, payload.generation_trace);
    if (renderGenerated) {
      renderGeneratedStats(payload.generated_phrase);
    }
  }

  function applyGeneratedPhrasePayload(
    payload,
    { renderGenerated = true } = {},
  ) {
    const generatedPhrase = payload?.generated_phrase || payload;
    rememberGeneratedPhrase(generatedPhrase);
    if (payload?.generated_phrase) {
      renderConstraintStatus(payload.constraints, payload.generation_trace);
    }
    if (renderGenerated) {
      renderGeneratedStats(generatedPhrase);
    }
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
      const overflow =
        importedNames.length > 3
          ? `, and ${importedNames.length - 3} more`
          : "";
      message += ` ${shownNames}${overflow}.`;
    }
    if (skippedCount) {
      message += ` Skipped ${pluralize(skippedCount, "file")} that were empty, unreadable, or not MIDI.`;
    }
    return message;
  }

  function defaultSessionMidiSaveMessage(payload, destinationLabel = null) {
    const fileCount = Number(payload?.file_count || 0);
    const inputCount = Number(payload?.input_file_count || 0);
    const generatedCount = Number(payload?.generated_file_count || 0);
    const destination =
      destinationLabel || payload?.directory || "the selected folder";
    return `Saved ${pluralize(fileCount, "MIDI file")} (${pluralize(inputCount, "played phrase")}, ${pluralize(generatedCount, "generated phrase")}) to ${destination}.`;
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
    const { continuationNoteCount, fetchOptions } =
      buildContinuationRequestBody(
        phraseEvents,
        learnInput,
        signal,
        enforceEndConstraint,
        handoffViewpoint,
      );
    const requestStartedAt = window.performance.now();
    startServerWaitIndicator(serverWaitLabel(statusLabel), requestStartedAt);
    try {
      const payload = await requestJson("/api/continue", fetchOptions);
      state.lastGenerationMs = window.performance.now() - requestStartedAt;
      renderPerformanceState();
      return { payload, continuationNoteCount };
    } finally {
      stopServerWaitIndicator();
    }
  }

  async function requestMemoryGeneration({
    noteCount = preferredGenerationNoteCount(),
    statusLabel = "Generating",
    signal = null,
    enforceStartConstraint = true,
    enforceEndConstraint = true,
  } = {}) {
    await ensureSession();
    setPhraseStatus(statusLabel);
    const requestBody = {
      note_count: noteCount,
      enforce_start_constraint: enforceStartConstraint,
      enforce_end_constraint: enforceEndConstraint,
    };
    const requestStartedAt = window.performance.now();
    startServerWaitIndicator(serverWaitLabel(statusLabel), requestStartedAt);
    try {
      const payload = await requestJson(
        `/api/sessions/${state.sessionId}/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal,
        },
      );
      state.lastGenerationMs = window.performance.now() - requestStartedAt;
      renderPerformanceState();
      return { payload, noteCount };
    } finally {
      stopServerWaitIndicator();
    }
  }

  async function sendCurrentPhrase() {
    stopInfiniteMode({ stopPlayback: true, silent: true });
    const { payload, continuationNoteCount } =
      await requestContinuationFromEvents(state.lastCapturedPhrase, {
        learnInput: elements.learnInputToggle.checked,
      });
    applyContinuationPayload(payload, { renderCaptured: false });
    if (payload.generated_phrase.event_count > 0) {
      await playPayload(payload.generated_phrase);
    }
    setPhraseStatus(
      payload.generated_phrase.note_count ? "Generated" : "Primed",
    );
    setPhraseMessage(
      defaultContinuationMessage(payload, continuationNoteCount),
    );
    scheduleVisibleSessionRefresh();
  }

  async function generateFreshPhrase() {
    stopInfiniteMode({ stopPlayback: true, silent: true });
    const { payload, noteCount } = await requestMemoryGeneration({
      noteCount: preferredGenerationNoteCount(),
      statusLabel: "Generating",
    });
    applyGeneratedPhrasePayload(payload);
    if (payload.generated_phrase.event_count > 0) {
      await playPayload(payload.generated_phrase);
    }
    setPhraseStatus(
      payload.generated_phrase.note_count ? "Generated" : "Primed",
    );
    setPhraseMessage(defaultMemoryGenerationMessage(payload, noteCount));
    scheduleVisibleSessionRefresh();
  }

  async function importSelectedMidiFiles(
    fileList,
    selectionLabel = "selection",
  ) {
    const selectedFiles = Array.from(fileList || []);
    if (!selectedFiles.length) {
      return;
    }

    const midiFiles = selectedFiles.filter((file) =>
      hasMidiFileExtension(file.webkitRelativePath || file.name),
    );
    if (!midiFiles.length) {
      throw new Error(
        `No MIDI files were found in the selected ${selectionLabel}.`,
      );
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
    const payload = await requestJson(
      `/api/sessions/${state.sessionId}/import-midi`,
      {
        method: "POST",
        body: formData,
      },
    );

    await refreshSessionActivity();
    await refreshSavedSessions();
    setControlView("memory");
    setSessionStatus("Ready");
    setPhraseStatus(
      state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI",
    );
    setPhraseMessage(defaultMidiImportMessage(payload));
  }

  return {
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
  };
}
