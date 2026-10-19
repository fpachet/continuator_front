class PhraseRecorder {
  constructor(
    timeoutMs,
    onUpdate,
    onComplete,
    onGapUpdate = null,
    timing = globalThis,
  ) {
    this.timing = timing;
    this.timeoutMs = timeoutMs;
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.onGapUpdate = onGapUpdate;
    this.reset();
  }

  setTimeoutMs(timeoutMs) {
    this.timeoutMs = timeoutMs;
    if (
      !this.events.length ||
      this.lastTimestamp == null ||
      this.pendingNotes.size
    ) {
      return;
    }
    this.scheduleCompletionCheck(this.timing.performance.now());
  }

  reset() {
    this.events = [];
    this.pendingNotes = new Map();
    this.completedNotes = [];
    this.currentTime = 0;
    this.lastTimestamp = null;
    if (this.timer) {
      this.timing.clearTimeout(this.timer);
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
        : this.timing.performance.now();
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
    this.currentTime += event.delta_seconds;

    const key = `${channel}:${note}`;
    if (type === "note_on") {
      const stack = this.pendingNotes.get(key) || [];
      stack.push({
        pitch: note,
        channel,
        velocity,
        start_seconds: this.currentTime,
      });
      this.pendingNotes.set(key, stack);
      this.onGapUpdate?.({ active: false });
    } else {
      const stack = this.pendingNotes.get(key);
      if (stack?.length) {
        const noteOn = stack.shift();
        this.completedNotes.push({
          ...noteOn,
          start_seconds: roundNumber(noteOn.start_seconds),
          duration_seconds: roundNumber(
            Math.max(0, this.currentTime - noteOn.start_seconds),
          ),
          end_seconds: roundNumber(this.currentTime),
        });
        if (!stack.length) {
          this.pendingNotes.delete(key);
        }
      }
    }

    this.events.push(event);
    this.onUpdate?.({
      eventCount: this.events.length,
      noteCount: this.completedNotes.length,
      notes: this.completedNotes,
    });
    this.scheduleCompletionCheck(timestamp);
  }

  scheduleCompletionCheck(nowTimestamp) {
    if (this.timer) {
      this.timing.clearTimeout(this.timer);
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
    this.timer = this.timing.setTimeout(() => {
      this.completePhrase();
    }, this.timeoutMs - elapsed);
  }

  completePhrase() {
    if (
      !this.events.length ||
      this.pendingNotes.size ||
      this.lastTimestamp == null
    ) {
      return;
    }

    const nowTimestamp = this.timing.performance.now();
    const elapsed = nowTimestamp - this.lastTimestamp;
    if (elapsed < this.timeoutMs) {
      this.scheduleCompletionCheck(nowTimestamp);
      return;
    }

    const phrase = this.snapshot();
    this.reset();
    this.onComplete?.(phrase);
  }
}

function roundNumber(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function midiMessageToEvent(messageEvent) {
  const [statusByte, note, rawVelocity = 0] = [...messageEvent.data];
  const status = statusByte & 0xf0;
  const channel = statusByte & 0x0f;
  if (status === 0x90 && rawVelocity > 0) {
    return {
      type: "note_on",
      note,
      velocity: rawVelocity,
      channel,
      delta_seconds: 0,
    };
  }
  if (status === 0x80 || (status === 0x90 && rawVelocity === 0)) {
    return {
      type: "note_off",
      note,
      velocity: 0,
      channel,
      delta_seconds: 0,
    };
  }
  return null;
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
        channel: event.channel,
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
      channel: noteOn.channel,
      velocity: noteOn.velocity,
      start_seconds: roundNumber(noteOn.start_seconds),
      duration_seconds: roundNumber(
        Math.max(0, currentTime - noteOn.start_seconds),
      ),
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

export { PhraseRecorder, roundNumber, midiMessageToEvent, eventsToNotes };
