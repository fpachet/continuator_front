import {
  ROLL_END_MARGIN_RATIO,
  ROLL_END_MARGIN_MIN_SECONDS,
  ROLL_END_MARGIN_MAX_SECONDS,
  ROLL_DENSE_NOTE_THRESHOLD,
  ROLL_DENSE_MAX_DPR,
} from "./constants.js";
import { eventsToNotes } from "./midi-capture.js";

function pianoRollCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    rect,
    width: Math.max(320, Math.floor(rect.width || 640)),
    height: Math.max(180, Math.floor(rect.height || 244)),
  };
}

function pianoRollNoteRects(width, height, notes) {
  if (!notes?.length) {
    return [];
  }

  const minPitch = Math.max(
    24,
    Math.min(...notes.map((note) => note.pitch)) - 2,
  );
  const maxPitch = Math.min(
    108,
    Math.max(...notes.map((note) => note.pitch)) + 2,
  );
  const totalDuration = pianoRollDurationSeconds(notes);
  const pitchRange = Math.max(1, maxPitch - minPitch + 1);

  return notes.map((note, index) => {
    const noteEndSeconds =
      note.end_seconds || note.start_seconds + note.duration_seconds;
    const x = (note.start_seconds / totalDuration) * width;
    const noteWidth = Math.max(
      8,
      (Math.max(0.05, note.duration_seconds) / totalDuration) * width,
    );
    const y =
      height - ((note.pitch - minPitch + 1) / pitchRange) * (height - 24) - 10;
    const noteHeight = Math.max(10, (height - 34) / pitchRange + 4);
    return {
      index,
      note,
      noteEndSeconds,
      x: x + 2,
      y,
      width: noteWidth,
      height: noteHeight,
    };
  });
}

function pianoRollEventPoint(canvas, event) {
  const { rect, width, height } = pianoRollCanvasSize(canvas);
  if (!rect.width || !rect.height) {
    return null;
  }
  return {
    x: ((event.clientX - rect.left) / rect.width) * width,
    y: ((event.clientY - rect.top) / rect.height) * height,
    width,
    height,
  };
}

function drawPianoRoll(canvas, notes, accent, emptyLabel, options = {}) {
  const { width, height } = pianoRollCanvasSize(canvas);
  const denseRoll = notes?.length >= ROLL_DENSE_NOTE_THRESHOLD;
  const devicePixelRatio = window.devicePixelRatio || 1;
  const dpr = denseRoll
    ? Math.min(devicePixelRatio, ROLL_DENSE_MAX_DPR)
    : devicePixelRatio;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

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

  const totalDuration = pianoRollDurationSeconds(notes);
  const noteRects = pianoRollNoteRects(width, height, notes);

  const playbackSeconds = Number.isFinite(Number(options.playbackSeconds))
    ? Number(options.playbackSeconds)
    : null;
  let highlightedNoteRect = null;

  if (denseRoll) {
    const emphasizedNoteRects = [];
    ctx.shadowBlur = 0;
    ctx.fillStyle = accent;
    for (const noteRect of noteRects) {
      const { note, noteEndSeconds } = noteRect;
      const isPlaying =
        playbackSeconds != null &&
        playbackSeconds >= note.start_seconds &&
        playbackSeconds <= noteEndSeconds;
      const isHighlighted = noteRect.index === options.highlightedNoteIndex;
      if (isHighlighted) {
        highlightedNoteRect = noteRect;
      }
      if (isPlaying || isHighlighted) {
        emphasizedNoteRects.push({ noteRect, isPlaying, isHighlighted });
        continue;
      }
      ctx.fillRect(noteRect.x, noteRect.y, noteRect.width, noteRect.height);
    }

    for (const { noteRect, isPlaying, isHighlighted } of emphasizedNoteRects) {
      ctx.fillStyle = isPlaying ? "#fff5d4" : "#f9dcc4";
      ctx.shadowBlur = 10;
      ctx.shadowColor = isPlaying
        ? "rgba(255, 245, 212, 0.72)"
        : "rgba(249, 220, 196, 0.62)";
      roundRect(
        ctx,
        noteRect.x,
        noteRect.y,
        noteRect.width,
        noteRect.height,
        8,
        true,
      );
      if (isHighlighted && !isPlaying) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.66)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  } else {
    for (const noteRect of noteRects) {
      const { note, noteEndSeconds } = noteRect;
      const isPlaying =
        playbackSeconds != null &&
        playbackSeconds >= note.start_seconds &&
        playbackSeconds <= noteEndSeconds;
      const isHighlighted = noteRect.index === options.highlightedNoteIndex;
      if (isHighlighted) {
        highlightedNoteRect = noteRect;
      }
      ctx.fillStyle = isPlaying
        ? "#fff5d4"
        : isHighlighted
          ? "#f9dcc4"
          : accent;
      ctx.shadowBlur = isPlaying ? 26 : isHighlighted ? 24 : 18;
      ctx.shadowColor = isPlaying
        ? "rgba(255, 245, 212, 0.82)"
        : isHighlighted
          ? "rgba(249, 220, 196, 0.72)"
          : accent;
      roundRect(
        ctx,
        noteRect.x,
        noteRect.y,
        noteRect.width,
        noteRect.height,
        8,
        true,
      );
      if (isHighlighted && !isPlaying) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.66)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  ctx.shadowBlur = 0;

  if (
    highlightedNoteRect &&
    Number.isFinite(Number(options.noteProgressRatio))
  ) {
    const progressRatio = Math.min(
      1,
      Math.max(0, Number(options.noteProgressRatio)),
    );
    const cursorX =
      highlightedNoteRect.x + highlightedNoteRect.width * progressRatio;
    ctx.strokeStyle = "rgba(255, 245, 212, 0.95)";
    ctx.lineWidth = 2;
    ctx.shadowBlur = 10;
    ctx.shadowColor = "rgba(255, 245, 212, 0.62)";
    ctx.beginPath();
    ctx.moveTo(cursorX, highlightedNoteRect.y - 7);
    ctx.lineTo(cursorX, highlightedNoteRect.y + highlightedNoteRect.height + 7);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(255, 245, 212, 0.98)";
    ctx.beginPath();
    ctx.arc(cursorX, highlightedNoteRect.y - 7, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const playbackProgressRatio = Number.isFinite(Number(playbackSeconds))
    ? playbackSeconds / totalDuration
    : Number(options.progressRatio);
  if (Number.isFinite(playbackProgressRatio)) {
    const progressRatio = Math.min(1, Math.max(0, playbackProgressRatio));
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

function pianoRollDurationSeconds(notes) {
  const phraseDurationSeconds = Math.max(
    0,
    ...notes.map(
      (note) => note.end_seconds || note.start_seconds + note.duration_seconds,
    ),
  );
  const endMarginSeconds = Math.min(
    ROLL_END_MARGIN_MAX_SECONDS,
    Math.max(
      ROLL_END_MARGIN_MIN_SECONDS,
      phraseDurationSeconds * ROLL_END_MARGIN_RATIO,
    ),
  );
  return Math.max(2, phraseDurationSeconds + endMarginSeconds);
}

function payloadNotes(payload) {
  const notes = Array.isArray(payload?.notes)
    ? payload.notes.filter(
        (note) =>
          Number.isFinite(Number(note?.pitch)) &&
          Number.isFinite(Number(note?.start_seconds)) &&
          Number.isFinite(Number(note?.duration_seconds)),
      )
    : [];
  return notes.length ? notes : eventsToNotes(payload?.events || []);
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

export {
  pianoRollNoteRects,
  pianoRollEventPoint,
  drawPianoRoll,
  pianoRollDurationSeconds,
  payloadNotes,
};
