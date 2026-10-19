// Keep remote durability separate from whether a session belongs to an account.
export function createBackupStatus(
  element,
  fetchStatus = () => fetch("/api/backup"),
) {
  let pendingWrites = 0;
  let generation = 0;
  let latest = null;

  function render(payload) {
    const status =
      pendingWrites && payload?.enabled ? "saving" : payload?.status;
    element.dataset.status = status || "unknown";
    element.textContent =
      {
        local: "Local storage only · cloud backup not configured",
        saving: "Saving to cloud…",
        saved: "Cloud saved",
        failed: "Cloud save failed · retrying automatically",
      }[status] || "Cloud save status unavailable";
    element.title = payload?.last_saved_at
      ? `Last successful cloud backup: ${payload.last_saved_at}`
      : "Cloud saves protect phrases, session memory, and accounts across server restarts.";
  }

  async function refresh() {
    const requestGeneration = ++generation;
    try {
      const response = await fetchStatus();
      if (!response.ok) throw new Error("Backup status unavailable");
      const payload = await response.json();
      if (requestGeneration !== generation) return;
      latest = payload;
      render(latest);
    } catch {
      if (requestGeneration === generation) render(null);
    }
  }

  function beginWrite() {
    generation++;
    pendingWrites++;
    render(latest);
  }

  function endWrite() {
    pendingWrites = Math.max(0, pendingWrites - 1);
    void refresh();
  }

  return { refresh, beginWrite, endWrite };
}
