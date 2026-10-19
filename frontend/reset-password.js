import { accountRequest, jsonPost } from "./account-pages.js";
import { createBackupStatus } from "./backup-status.js";

const form = document.getElementById("password-reset-form");
const message = document.getElementById("reset-message");
const button = document.getElementById("reset-password-button");
const backup = createBackupStatus(
  document.getElementById("reset-backup-status"),
);
void backup.refresh();
window.setInterval(() => {
  if (!document.hidden) void backup.refresh();
}, 3000);
let token =
  new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
// Keep the capability out of the address bar, browser history, requests and
// referrers. It remains only in this page's memory until submission.
window.history.replaceState(null, "", window.location.pathname);
if (!token) {
  form.hidden = true;
  message.textContent =
    "This page needs a reset link from the administrator. Open the complete link they sent you.";
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  const password = document.getElementById("new-password").value;
  const confirmation = document.getElementById("confirm-password").value;
  message.classList.remove("is-error");
  if (password !== confirmation) {
    message.textContent = "The passwords do not match.";
    message.classList.add("is-error");
    return;
  }
  button.disabled = true;
  backup.beginWrite();
  try {
    await accountRequest(
      "/api/auth/reset-password",
      jsonPost({ token, password, confirm_password: confirmation }),
    );
    token = "";
    form.reset();
    form.hidden = true;
    message.textContent =
      "Your password has been changed and previous sign-ins have been revoked. Return to the instrument and sign in with your new password.";
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("is-error");
  } finally {
    backup.endWrite();
    button.disabled = false;
  }
});
