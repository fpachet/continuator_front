export function createApiFetch(isEmbedded = () => false) {
  return (url, options = {}) => {
    const headers = new Headers(options.headers);
    if (isEmbedded()) headers.set("X-Continuator-Embedded", "1");
    return fetch(url, { ...options, headers, credentials: "same-origin" });
  };
}
