import { accountRequest, jsonPost } from "./account-pages.js";
import { createBackupStatus } from "./backup-status.js";

const byId = (id) => document.getElementById(id);
const backup = createBackupStatus(byId("admin-backup-status"));
const state = {
  query: "",
  offset: 0,
  selectedId: null,
  resetBusy: false,
  userGeneration: 0,
};
const date = (value) =>
  value ? new Date(value).toLocaleString() : "Not recorded";
const count = (value, singular) =>
  `${value} ${singular}${value === 1 ? "" : "s"}`;
const labels = {
  account_registered: "Account registered",
  signed_in: "Signed in",
  session_created: "Session created",
  phrase_input: "Input recorded",
  phrase_generated: "Continuation generated",
  reset_link_created: "Reset link created",
  password_reset: "Password changed",
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function message(text, error = false) {
  byId("admin-message").textContent = text;
  byId("admin-message").classList.toggle("is-error", error);
}

function rows(target, items, columns) {
  const body = byId(target);
  body.replaceChildren();
  if (!items.length) {
    const row = node("tr");
    const cell = node("td", "Nothing to show yet.");
    cell.colSpan = columns.length;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const item of items) {
    const row = node("tr");
    for (const column of columns) {
      const cell = node("td");
      const value = column(item);
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? "—";
      row.append(cell);
    }
    body.append(row);
  }
}

function renderActivity(items, username = null) {
  byId("admin-activity-title").textContent = username
    ? `Recent activity · ${username}`
    : "Recent activity";
  rows("admin-activity", items, [
    (item) => date(item.created_at),
    (item) => item.username || "Guest",
    (item) => labels[item.event_type] || item.event_type,
    (item) =>
      [
        item.session_id ? `Session ${item.session_id.slice(0, 8)}` : "",
        item.note_count !== null
          ? `${item.note_count} notes · ${Number(item.duration_seconds).toFixed(1)}s`
          : "",
        item.actor_username && item.actor_username !== item.username
          ? `By ${item.actor_username}`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
  ]);
}

async function selectUser(userId, { scroll = true } = {}) {
  if (state.resetBusy) return;
  state.selectedId = userId;
  const generation = ++state.userGeneration;
  byId("user-detail").hidden = true;
  byId("create-reset-button").disabled = true;
  byId("reset-link-output").hidden = true;
  byId("reset-link-input").value = "";
  byId("admin-password").value = "";
  const detail = await accountRequest(`/api/admin/users/${userId}`);
  if (generation !== state.userGeneration) return;
  byId("user-detail").hidden = false;
  byId("create-reset-button").disabled = false;
  byId("selected-user-name").textContent = detail.user.username;
  byId("selected-user-summary").textContent = [
    count(detail.user.session_count, "session"),
    count(detail.user.input_phrase_count, "recorded input"),
    count(detail.user.generated_phrase_count, "generated continuation"),
  ].join(" · ");
  rows("admin-user-sessions", detail.sessions, [
    (item) => item.display_name,
    (item) => date(item.last_seen_at),
    (item) => item.input_phrase_count,
    (item) => item.generated_phrase_count,
    (item) => item.memory_variant_count,
  ]);
  renderActivity(detail.activity, detail.user.username);
  if (scroll)
    byId("user-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadUsers() {
  const data = await accountRequest(
    `/api/admin/users?q=${encodeURIComponent(state.query)}&offset=${state.offset}&limit=50`,
  );
  rows("admin-users", data.items, [
    (user) => {
      const button = node("button", user.username, "ghost");
      button.type = "button";
      button.addEventListener("click", () => {
        void selectUser(user.id).catch((error) => message(error.message, true));
      });
      return button;
    },
    (user) => date(user.created_at),
    (user) => date(user.last_login_at),
    (user) => user.session_count,
    (user) => user.input_phrase_count,
    (user) => user.generated_phrase_count,
    (user) => date(user.last_activity_at),
  ]);
  byId("admin-user-count").textContent = data.total
    ? `${data.offset + 1}–${Math.min(data.offset + data.items.length, data.total)} of ${data.total} users`
    : "No users match this search.";
  byId("users-previous").disabled = state.offset === 0;
  byId("users-next").disabled = state.offset + data.items.length >= data.total;
}

async function refresh() {
  byId("admin-refresh").disabled = true;
  try {
    const [overview, activity] = await Promise.all([
      accountRequest("/api/admin/overview"),
      accountRequest("/api/admin/activity"),
      loadUsers(),
    ]);
    const metrics = [
      ["registered_users", "Registered users"],
      ["total_sessions", "Sessions"],
      ["input_phrases", "Recorded inputs"],
      ["generated_phrases", "Continuations"],
      ["guest_sessions", "Guest sessions"],
      ["guest_phrases", "Guest phrases"],
    ];
    byId("admin-overview").replaceChildren(
      ...metrics.map(([key, label]) => {
        const card = node("div", undefined, "admin-metric");
        card.append(node("strong", overview[key]), node("span", label));
        return card;
      }),
    );
    if (state.selectedId) await selectUser(state.selectedId, { scroll: false });
    else renderActivity(activity.items);
    message("Administration is up to date.");
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      byId("admin-content").hidden = true;
      byId("admin-signin-help").hidden = false;
    }
    message(error.message, true);
  } finally {
    byId("admin-refresh").disabled = false;
  }
}

byId("admin-refresh").addEventListener("click", () => {
  void refresh();
});
byId("user-search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  state.query = byId("user-search").value.trim();
  state.offset = 0;
  void loadUsers().catch((error) => message(error.message, true));
});
for (const [id, delta] of [
  ["users-previous", -50],
  ["users-next", 50],
]) {
  byId(id).addEventListener("click", () => {
    state.offset = Math.max(0, state.offset + delta);
    void loadUsers().catch((error) => message(error.message, true));
  });
}
byId("all-activity-button").addEventListener("click", () => {
  void accountRequest("/api/admin/activity")
    .then((data) => renderActivity(data.items))
    .catch((error) => message(error.message, true));
});
byId("create-reset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedId || state.resetBusy) return;
  state.resetBusy = true;
  byId("create-reset-button").disabled = true;
  backup.beginWrite();
  byId("reset-link-output").hidden = true;
  try {
    const data = await accountRequest(
      `/api/admin/users/${state.selectedId}/password-reset`,
      jsonPost({ admin_password: byId("admin-password").value }),
    );
    const link = new URL("/reset-password", window.location.origin);
    link.hash = new URLSearchParams({ token: data.token }).toString();
    byId("reset-link-input").value = link.href;
    byId("reset-link-expiry").textContent =
      `For ${data.username} · expires ${date(data.expires_at)}`;
    byId("reset-link-output").hidden = false;
    message(
      `Reset link created for ${data.username}. Share it privately with them.`,
    );
  } catch (error) {
    message(error.message, true);
  } finally {
    byId("admin-password").value = "";
    state.resetBusy = false;
    byId("create-reset-button").disabled = false;
    backup.endWrite();
  }
});
byId("copy-reset-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(byId("reset-link-input").value);
    message("Reset link copied.");
  } catch {
    byId("reset-link-input").select();
    message("Select and copy the reset link above.");
  }
});

async function initialize() {
  try {
    const { user } = await accountRequest("/api/auth/me");
    if (!user?.is_admin) {
      byId("admin-signin-help").hidden = false;
      message(
        "Sign in with an administrator account to view users and activity.",
        true,
      );
      return;
    }
    byId("admin-identity").textContent = `Signed in as ${user.username}`;
    byId("admin-content").hidden = false;
    await refresh();
  } catch (error) {
    message(error.message, true);
  }
}
void backup.refresh();
window.addEventListener("pagehide", () => {
  byId("admin-content").hidden = true;
  byId("admin-password").value = "";
  byId("reset-link-input").value = "";
  byId("reset-link-output").hidden = true;
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void initialize();
});
window.setInterval(() => {
  if (!document.hidden) void backup.refresh();
}, 3000);
void initialize();
