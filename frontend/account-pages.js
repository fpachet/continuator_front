import { createApiFetch, isEmbeddedView } from "./auth-transport.js";

const fetchApi = createApiFetch(isEmbeddedView);

export async function accountRequest(url, options = {}) {
  const response = await fetchApi(url, options);
  const payload = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(payload.detail)
      ? payload.detail.map((item) => item.msg).join(" ")
      : payload.detail || `Request failed (${response.status}).`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function jsonPost(payload) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}
