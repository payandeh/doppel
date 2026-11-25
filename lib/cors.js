// CORS headers for responses Doppel makes up at the network layer (lib/native.js).
// A mock-only response (or a mock for a request that failed) has no real headers to copy, so a cross-origin page
// would get a response without Access-Control-Allow-Origin and Chrome would block it with a CORS error.
// The page-level patch (content/inject.js) never needs this: its mocks never reach the network.
const APIOV_CORS = (() => {
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch (_) {
      return null;
    }
  };

  // CDP gives request headers as an object; the Origin header is not always there yet when a request is paused.
  function headerOf(headers, name) {
    for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return v;
    return undefined;
  }

  // request: CDP Fetch.Request ({ url, headers }); pageOrigin: origin of the page that sent it.
  // Returns [] for same-origin requests (no CORS check), else headers that pass Chrome's check, with or without
  // credentials: the exact origin (not "*", which is refused with credentials) and Allow-Credentials.
  function headersFor(request, pageOrigin) {
    const origin = headerOf(request.headers, 'origin') || pageOrigin;
    const target = originOf(request.url);
    if (!origin || !target || origin === target) return [];
    return [
      { name: 'access-control-allow-origin', value: origin },
      { name: 'access-control-allow-credentials', value: 'true' },
      // "*" is not a wildcard for credentialed requests, so name the header the page may want to read.
      { name: 'access-control-expose-headers', value: 'x-doppel' },
      { name: 'vary', value: 'Origin' }
    ];
  }

  return { headersFor, originOf };
})();
