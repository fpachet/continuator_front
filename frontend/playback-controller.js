import {
  DEFAULT_PLAYBACK_CHOICE,
  WEB_MIDI_RENDERER_ID,
  PLAYBACK_CHOICE_SEPARATOR,
  PLAYBACK_START_DELAY_MS,
} from "./constants.js";
import {
  drawPianoRoll,
  pianoRollDurationSeconds,
  payloadNotes,
} from "./piano-roll.js";

// Dependencies are supplied by app.js; modules never import the composition root.
export function createPlaybackController(dependencies) {
  const {
    applyContinuationPayload,
    applyGeneratedPhrasePayload,
    clearInfiniteScheduler,
    continuationHandoffMs,
    elements,
    infiniteLookaheadMs,
    latestLoopSeedPayload,
    localPlaybackRenderers,
    playbackRendererRegistry,
    preferredGenerationNoteCount,
    releaseRollAuditionNote,
    renderGeneratedStats,
    renderPerformanceState,
    requestContinuationFromEvents,
    requestMemoryGeneration,
    rollAuditionOptions,
    rollCanvas,
    scheduleVisibleSessionRefresh,
    setPhraseMessage,
    setPhraseStatus,
    state,
    stopLiveMonitorPlayback,
    stopRollAudition,
    syncMemoryPlaybackState,
    syncRollPlaybackState,
    updateInfiniteActionState,
  } = dependencies;

  function midiOutputById(outputId) {
    if (!state.midiAccess || !outputId) {
      return null;
    }
    return state.midiAccess.outputs.get(outputId) || null;
  }

  function selectedPrimaryMidiOutputId() {
    const choice = resolvePlaybackChoice();
    return choice.rendererId === WEB_MIDI_RENDERER_ID ? choice.targetId : null;
  }

  function selectedMidiCopyOutputId() {
    return elements.midiCopyOutputSelect?.value || null;
  }

  function selectedMidiCopyOutput() {
    const outputId = selectedMidiCopyOutputId();
    if (!outputId || outputId === selectedPrimaryMidiOutputId()) {
      return null;
    }
    return midiOutputById(outputId);
  }

  function midiCopyOutputLabel() {
    const output = selectedMidiCopyOutput();
    return output ? output.name || output.id : null;
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

  async function createPlaybackSession(
    choiceValue = selectedPlaybackChoiceValue(),
  ) {
    const choice = resolvePlaybackChoice(choiceValue);
    if (!choice.renderer) {
      throw new Error("Selected playback renderer is unavailable.");
    }

    const rendererState =
      (await choice.renderer.createPlaybackSession?.(choice.targetId)) || {};
    const midiCopyOutput = selectedMidiCopyOutput();
    let midiCopyReady = false;
    if (midiCopyOutput) {
      try {
        await midiCopyOutput.open();
        midiCopyReady = true;
      } catch {
        setPhraseMessage(
          `${playbackChoiceLabel(choice.value)} remains active, but the MIDI copy output is unavailable.`,
          true,
        );
      }
    }
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
      midiCopyOutput: midiCopyReady ? midiCopyOutput : null,
      midiCopyOutputId: midiCopyOutput?.id || null,
      midiCopyActiveNotes: new Set(),
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

  function midiMessageForPlaybackEvent(event) {
    if (!event || !["note_on", "note_off"].includes(event.type)) {
      return null;
    }
    const noteOn = event.type === "note_on" && event.velocity > 0;
    const status = (noteOn ? 0x90 : 0x80) | (event.channel & 0x0f);
    return [status, event.note, event.velocity];
  }

  function dispatchMidiEventToOutput(output, activeNotes, event) {
    const message = midiMessageForPlaybackEvent(event);
    if (!output || !message) {
      return;
    }
    sendOutputMessage(output, message);

    const key = outputNoteKey(event.note, event.channel);
    if (event.type === "note_on" && event.velocity > 0) {
      activeNotes?.add(key);
    } else {
      activeNotes?.delete(key);
    }
  }

  function stopMidiOutputPlayback(output, activeNotes) {
    if (!output) {
      return false;
    }
    activeNotes?.forEach((key) => {
      const [channelRaw, noteRaw] = key.split(":");
      const channel = Number(channelRaw);
      const note = Number(noteRaw);
      sendOutputMessage(output, [0x80 | (channel & 0x0f), note, 0]);
    });
    activeNotes?.clear();
    return sendMidiPanicToOutput(output);
  }

  function dispatchMidiCopyEvent(playback, event) {
    dispatchMidiEventToOutput(
      playback?.midiCopyOutput,
      playback?.midiCopyActiveNotes,
      event,
    );
  }

  function stopMidiCopyPlayback(playback) {
    return stopMidiOutputPlayback(
      playback?.midiCopyOutput,
      playback?.midiCopyActiveNotes,
    );
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
    const liveMonitorPlayback = state.liveMonitorPlayback;
    const activeRollAudition = state.activeRollAudition;

    if (activePlayback?.renderer?.panicPlayback) {
      sent =
        (await activePlayback.renderer.panicPlayback(activePlayback)) || sent;
    }
    if (activeRollAudition) {
      releaseRollAuditionNote(activeRollAudition);
      stopRollAudition({ redraw: true, releaseNote: false });
      sent = true;
    }
    if (liveMonitorPlayback?.renderer?.panicPlayback) {
      sent =
        (await liveMonitorPlayback.renderer.panicPlayback(
          liveMonitorPlayback,
        )) || sent;
    }
    stopLiveMonitorPlayback();

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
      sent =
        (await selectedChoice.renderer.panicTarget(selectedChoice.targetId)) ||
        sent;
    }

    const selectedCopyOutput = selectedMidiCopyOutput();
    const selectedCopyWillBeStopped =
      selectedCopyOutput &&
      [activePlayback, liveMonitorPlayback].some(
        (playback) => playback?.midiCopyOutput === selectedCopyOutput,
      );
    if (selectedCopyOutput && !selectedCopyWillBeStopped) {
      try {
        await selectedCopyOutput.open();
        sent = sendMidiPanicToOutput(selectedCopyOutput) || sent;
      } catch {
        // Keep panic best-effort when a secondary MIDI destination disconnects.
      }
    }

    return sent;
  }

  function stopPlaybackVisualization({ redraw = true } = {}) {
    const rollKind = state.playbackVisualizationRollKind || "output";
    state.playbackVisualizationToken += 1;
    if (state.playbackVisualizationStartTimerId) {
      window.clearTimeout(state.playbackVisualizationStartTimerId);
      state.playbackVisualizationStartTimerId = null;
    }
    if (state.playbackVisualizationFrameId) {
      window.clearTimeout(state.playbackVisualizationFrameId);
      window.cancelAnimationFrame(state.playbackVisualizationFrameId);
      state.playbackVisualizationFrameId = null;
    }
    if (redraw) {
      if (rollKind === "input") {
        drawPianoRoll(
          elements.inputRoll,
          state.lastCapturedNotes,
          "#6dd3ce",
          "Input phrase",
        );
      } else {
        renderGeneratedStats(state.lastGeneratedPhrase);
      }
    }
    for (const playhead of [elements.inputPlayhead, elements.outputPlayhead]) {
      playhead.hidden = true;
      playhead.style.transform = "translateX(0)";
    }
    state.currentPlaybackPayload = null;
    state.queuedPlaybackPayload = null;
    state.playbackVisualizationDisplayEndsAtMs = 0;
    state.playbackVisualizationRollKind = "output";
    renderPerformanceState();
  }

  function rollPlayhead(kind) {
    return kind === "input" ? elements.inputPlayhead : elements.outputPlayhead;
  }

  function rollPlayheadMaxX(kind) {
    const width = rollCanvas(kind).getBoundingClientRect().width || 0;
    return Math.max(0, width - 2);
  }

  function startPlaybackVisualization(
    payload,
    audioStartAtMs,
    durationMs,
    { rollKind = "output" } = {},
  ) {
    const notes = payloadNotes(payload);
    if (!notes.length) {
      return;
    }
    const targetRoll =
      rollKind === "input" ? elements.inputRoll : elements.outputRoll;
    const accent = rollKind === "input" ? "#6dd3ce" : "#f4a261";
    const emptyLabel =
      rollKind === "input" ? "Input phrase" : "Generated continuation";

    const displayStartAtMs = Math.max(
      audioStartAtMs,
      state.playbackVisualizationDisplayEndsAtMs || 0,
    );
    const delayUntilStartMs = displayStartAtMs - window.performance.now();
    if (delayUntilStartMs > 24) {
      if (state.playbackVisualizationStartTimerId) {
        window.clearTimeout(state.playbackVisualizationStartTimerId);
      }
      state.queuedPlaybackPayload = payload;
      renderPerformanceState();
      state.playbackVisualizationStartTimerId = window.setTimeout(() => {
        state.playbackVisualizationStartTimerId = null;
        startPlaybackVisualization(payload, displayStartAtMs, durationMs, {
          rollKind,
        });
      }, delayUntilStartMs);
      return;
    }

    stopPlaybackVisualization({ redraw: false });
    state.playbackVisualizationRollKind = rollKind;
    state.currentPlaybackPayload = payload;
    if (state.queuedPlaybackPayload === payload) {
      state.queuedPlaybackPayload = null;
    }
    drawPianoRoll(
      targetRoll,
      notes,
      accent,
      emptyLabel,
      rollAuditionOptions(rollKind),
    );
    renderPerformanceState();
    const token = ++state.playbackVisualizationToken;
    const startedAtMs = window.performance.now();
    const playbackDurationSeconds = Math.max(
      0.001,
      ...notes.map(
        (note) =>
          note.end_seconds || note.start_seconds + note.duration_seconds,
      ),
    );
    const rollDurationSeconds = pianoRollDurationSeconds(notes);
    const safeDurationMs = Math.max(
      1,
      Number(durationMs) || playbackDurationSeconds * 1000,
    );
    state.playbackVisualizationDisplayEndsAtMs = startedAtMs + safeDurationMs;
    const playhead = rollPlayhead(rollKind);
    const playheadMaxX = rollPlayheadMaxX(rollKind);
    playhead.hidden = false;

    const tick = () => {
      if (token !== state.playbackVisualizationToken) {
        return;
      }
      const elapsedMs = Math.max(0, window.performance.now() - startedAtMs);
      const progressRatio = Math.min(1, elapsedMs / safeDurationMs);
      const playbackSeconds = progressRatio * playbackDurationSeconds;
      const rollProgressRatio = Math.min(
        1,
        playbackSeconds / rollDurationSeconds,
      );
      playhead.style.transform = `translateX(${Math.round(
        rollProgressRatio * playheadMaxX,
      )}px)`;
      if (progressRatio >= 1) {
        state.playbackVisualizationFrameId = null;
        window.setTimeout(() => {
          if (token === state.playbackVisualizationToken) {
            state.currentPlaybackPayload = null;
            state.playbackVisualizationDisplayEndsAtMs = 0;
            playhead.hidden = true;
            renderPerformanceState();
            if (rollKind === "input") {
              drawPianoRoll(
                elements.inputRoll,
                state.lastCapturedNotes,
                "#6dd3ce",
                "Input phrase",
              );
            } else {
              renderGeneratedStats(state.lastGeneratedPhrase);
            }
          }
        }, 180);
        return;
      }
      state.playbackVisualizationFrameId = window.setTimeout(tick, 33);
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
    stopMidiCopyPlayback(playback);
    state.activePlayback = null;
    state.activeMemoryPlaybackIndex = null;
    state.activeRollPlaybackKind = null;
    stopPlaybackVisualization();
    syncMemoryPlaybackState();
    syncRollPlaybackState();
    updateInfiniteActionState();
    return true;
  }

  function dispatchPlaybackEvent(playback, event) {
    playback.renderer?.dispatchEvent?.(playback, event);
    dispatchMidiCopyEvent(playback, event);
  }

  async function playPayload(
    payload,
    {
      startDelayMs = PLAYBACK_START_DELAY_MS,
      append = false,
      visualizationRoll = "output",
    } = {},
  ) {
    if (!payload?.events?.length) {
      return;
    }

    let playback = state.activePlayback;
    if (!append || !playback) {
      stopRollAudition({ redraw: false, releaseNote: true });
      stopActivePlayback();
      playback = await createPlaybackSession();
      state.activePlayback = playback;
      state.activeMemoryPlaybackIndex = null;
      state.activeRollPlaybackKind = null;
      syncMemoryPlaybackState();
      syncRollPlaybackState();
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

    const cleanupTimerId = window.setTimeout(
      () => {
        if (state.activePlayback !== playback) {
          return;
        }
        playback.timerIds.delete(cleanupTimerId);
        stopActivePlayback();
      },
      scheduleDelayMs + cursorMs + 200,
    );
    playback.cleanupTimerId = cleanupTimerId;
    playback.timerIds.add(cleanupTimerId);
    playback.handoffAtMs = Math.max(
      playback.handoffAtMs,
      scheduleBaseMs + scheduleDelayMs + handoffMs,
    );
    playback.endsAtMs = Math.max(
      playback.endsAtMs,
      scheduleBaseMs + scheduleDelayMs + cursorMs,
    );
    startPlaybackVisualization(
      payload,
      scheduleBaseMs + scheduleDelayMs,
      cursorMs,
      { rollKind: visualizationRoll },
    );
    updateInfiniteActionState();
  }

  function stopInfiniteMode({
    stopPlayback = true,
    silent = false,
    message = "Infinite mode stopped.",
  } = {}) {
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
      setPhraseStatus(
        state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI",
      );
      setPhraseMessage(message || "Infinite mode stopped.");
      return true;
    }

    if (stopActivePlayback()) {
      void sendPlaybackPanic();
      setPhraseStatus(
        state.lastCapturedPhrase.length ? "Phrase ready" : "Waiting for MIDI",
      );
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
    const delayMs = Math.max(
      0,
      remainingPlaybackMs - infiniteLookaheadMs(prefixPayload),
    );

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
        statusLabel: state.activePlayback
          ? "Re-seeding from memory"
          : "Generating from memory",
        signal: abortController.signal,
        enforceStartConstraint: false,
        enforceEndConstraint: false,
      });
      if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
        return true;
      }

      const generatedPhrase = payload.generated_phrase;
      if (!generatedPhrase.event_count) {
        throw new Error("the memory fallback returned an empty phrase");
      }

      const willQueueAfterCurrentPlayback = Boolean(state.activePlayback);
      applyGeneratedPhrasePayload(payload, {
        renderGenerated: !willQueueAfterCurrentPlayback,
      });
      const startDelayMs = state.activePlayback
        ? Math.max(0, state.activePlayback.handoffAtMs - performance.now())
        : PLAYBACK_START_DELAY_MS;
      await playPayload(generatedPhrase, {
        startDelayMs,
        append: Boolean(state.activePlayback),
      });
      if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
        return true;
      }

      setPhraseStatus("Infinite");
      setPhraseMessage(
        payload.status_message ||
          `Infinite mode resumed from memory because ${reason}.`,
      );
      scheduleInfiniteStep(generatedPhrase, runId);
      scheduleVisibleSessionRefresh();
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
      const willQueueAfterCurrentPlayback = Boolean(state.activePlayback);
      applyContinuationPayload(
        {
          ...payload,
          generated_phrase: generatedPhrase,
        },
        {
          renderGenerated: !willQueueAfterCurrentPlayback,
        },
      );
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
      if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
        return;
      }

      setPhraseStatus("Infinite");
      setPhraseMessage(
        payload.status_message ||
          `Infinite mode running: ${generatedPhrase.note_count} notes queued from the latest continuation.`,
      );
      scheduleInfiniteStep(generatedPhrase, runId);
      scheduleVisibleSessionRefresh();
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
      setPhraseMessage(
        "Play or preview a phrase before starting infinite mode.",
        true,
      );
      return;
    }

    state.infiniteModeEnabled = true;
    state.infiniteRunId += 1;
    updateInfiniteActionState();
    setPhraseMessage(
      "Infinite mode started. Generating the first continuation...",
    );

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
          message:
            "Infinite mode stopped because the first continuation was empty.",
        });
        setPhraseStatus("Primed");
        return;
      }

      await playPayload(generatedPhrase);
      if (!state.infiniteModeEnabled || runId !== state.infiniteRunId) {
        return;
      }

      setPhraseStatus("Infinite");
      setPhraseMessage(
        `Infinite mode running: ${generatedPhrase.note_count} notes in the first continuation.`,
      );
      scheduleVisibleSessionRefresh();
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

  return {
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
  };
}
