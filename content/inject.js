(() => {
  if (window.__apiovInstalled) return;
  Object.defineProperty(window, '__apiovInstalled', { value: true });

  const TAG = '%c[Doppel]';
  const TAG_STYLE = 'color:#FF6B5B;font-weight:bold';
  const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
  const STATUS_TEXT = {
    200: 'OK',
    201: 'Created',
    202: 'Accepted',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    408: 'Request Timeout',
    409: 'Conflict',
    410: 'Gone',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout'
  };

  let activeCount = 0;
  let native = false; // Doppel applies overrides at the network layer for this frame (DevTools setting)
  let isReady = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const markReady = () => {
    if (!isReady) {
      isReady = true;
      resolveReady();
    }
  };
  // Do not block the page for long if the bridge never answers (e.g. the extension was reloaded).
  setTimeout(markReady, 1500);

  document.addEventListener('apiov:state', (e) => {
    try {
      const d = JSON.parse(e.detail);
      activeCount = d.active | 0;
      native = !!d.native;
    } catch (_) {}
    markReady();
  });
  document.dispatchEvent(new CustomEvent('apiov:request-state'));

  // DOM events dispatch synchronously across worlds, so this is a synchronous round-trip.
  function findRule(url, method) {
    if (!activeCount || native) return null;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let rule = null;
    const onResult = (e) => {
      try {
        const d = JSON.parse(e.detail);
        if (d.id === id) rule = d.rule;
      } catch (_) {}
    };
    document.addEventListener('apiov:match-result', onResult);
    try {
      document.dispatchEvent(new CustomEvent('apiov:match', { detail: JSON.stringify({ id, url, method }) }));
    } finally {
      document.removeEventListener('apiov:match-result', onResult);
    }
    return rule;
  }

  const hasBody = (r) => typeof r.body === 'string' && r.body.trim() !== '';
  const hasStatus = (r) => Number.isInteger(r.status) && r.status >= 200 && r.status <= 599;

  function absUrl(u) {
    try {
      return new URL(u, location.href).href;
    } catch (_) {
      return String(u);
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true }
        );
    });
  }

  // Same rules as APIOV_TYPE.header in lib/content-type.js. This script runs in the page, so it cannot load that file.
  function contentTypeHeader(value) {
    let raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return 'application/json; charset=utf-8';
    if (!raw.includes('/')) {
      const alias = {
        json: 'application/json',
        html: 'text/html',
        xml: 'application/xml',
        text: 'text/plain',
        plain: 'text/plain',
        txt: 'text/plain',
        js: 'application/javascript',
        javascript: 'application/javascript',
        css: 'text/css',
        csv: 'text/csv',
        svg: 'image/svg+xml',
        yaml: 'application/yaml',
        yml: 'application/yaml',
        graphql: 'application/graphql',
        form: 'application/x-www-form-urlencoded',
        binary: 'application/octet-stream'
      }[raw.toLowerCase()];
      if (alias) raw = alias;
    }
    const bits = raw.split(';');
    const type = bits[0].trim().toLowerCase();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(type))
      return 'application/json; charset=utf-8';
    const params = bits
      .slice(1)
      .map((p) => p.trim())
      .filter(Boolean);
    if (params.some((p) => /^charset\s*=/i.test(p))) return type + '; ' + params.join('; ');
    const binary =
      (type.startsWith('image/') && type !== 'image/svg+xml') ||
      type.startsWith('audio/') ||
      type.startsWith('video/') ||
      type.startsWith('font/') ||
      type.startsWith('multipart/') ||
      type === 'application/octet-stream' ||
      type === 'application/pdf' ||
      type === 'application/zip' ||
      type === 'application/gzip' ||
      type === 'application/wasm' ||
      type === 'application/protobuf' ||
      type === 'application/x-protobuf';
    if (binary && !type.endsWith('+xml') && !type.endsWith('+json'))
      return params.length ? type + '; ' + params.join('; ') : type;
    return type + '; charset=utf-8' + (params.length ? '; ' + params.join('; ') : '');
  }

  function build(rule, real, url) {
    const status = hasStatus(rule) ? rule.status : real ? real.status : 200;
    const statusText = hasStatus(rule) ? STATUS_TEXT[status] || '' : real ? real.statusText : 'OK';
    const headers = new Headers(real && real.headers ? real.headers : undefined);
    let body = hasBody(rule) ? rule.body : real ? real.text : '';
    if (hasBody(rule)) {
      headers.set('content-type', contentTypeHeader(rule.contentType));
      headers.delete('content-length');
      headers.delete('content-encoding');
    }
    if (NULL_BODY_STATUS.has(status)) body = null;
    return { status, statusText, headers, body, url: (real && real.url) || url };
  }

  // Lets Doppel's DevTools tab show what the page received (Chrome's Network tab only sees the real response).
  function report(method, url, out, real, kind) {
    try {
      document.dispatchEvent(
        new CustomEvent('apiov:applied', {
          detail: JSON.stringify({
            url,
            method,
            status: out.status,
            realStatus: real ? real.status : null,
            body: out.body == null ? '' : out.body,
            contentType: out.headers.get('content-type') || '',
            mocked: !real,
            via: 'page',
            kind,
            at: Date.now()
          })
        })
      );
    } catch (_) {}
  }

  function log(method, url, rule, out, real) {
    const parts = [];
    parts.push(
      hasStatus(rule) ? `status ${real ? real.status + ' → ' : ''}${out.status}` : `status ${out.status} (original)`
    );
    parts.push(hasBody(rule) ? 'body overridden' : 'body original');
    if (rule.delay > 0) parts.push(`+${rule.delay}ms`);
    if (!real) parts.push('mocked (no network)');
    console.info(`${TAG}%c ${method} ${url}  →  ${parts.join(', ')}`, TAG_STYLE, '');
  }

  const origFetch = window.fetch;
  const sendMarked = window[Symbol.for('apiov.send')] || ((fn, input, init) => fn.call(window, input, init));

  async function patchedFetch(input, init) {
    if (!isReady) await ready;
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const url = absUrl(isReq ? input.url : String(input));
    const method = String((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
    const rule = findRule(url, method);
    if (!rule) return origFetch.call(window, input, init);

    const signal = (init && init.signal) || (isReq ? input.signal : null);
    const mockOnly = rule.mockOnly && hasBody(rule);
    let real = null;

    if (!mockOnly) {
      try {
        const res = await sendMarked(origFetch, input, init);
        real = { status: res.status, statusText: res.statusText, headers: res.headers, url: res.url, text: null };
        if (hasBody(rule)) {
          // Drain instead of cancel: a cancelled stream leaves DevTools with no response body to show.
          res.arrayBuffer().catch(() => {});
        } else {
          real.text = await res.text();
        }
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (!hasBody(rule)) throw err;
        real = null;
      }
    }

    if (rule.delay > 0) await sleep(rule.delay, signal);

    const out = build(rule, real, url);
    const response = new Response(out.body, { status: out.status, statusText: out.statusText, headers: out.headers });
    try {
      Object.defineProperty(response, 'url', { value: out.url });
    } catch (_) {}
    log(method, url, rule, out, real);
    report(method, url, out, real, 'fetch');
    return response;
  }
  window.fetch = patchedFetch;

  const XHRProto = XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const origSetHeader = XHRProto.setRequestHeader;
  const origAbort = XHRProto.abort;
  const state = new WeakMap();
  const FAKE_PROPS = [
    'readyState',
    'status',
    'statusText',
    'response',
    'responseText',
    'responseURL',
    'responseXML',
    'getResponseHeader',
    'getAllResponseHeaders'
  ];

  function clearFake(xhr) {
    for (const p of FAKE_PROPS) if (Object.prototype.hasOwnProperty.call(xhr, p)) delete xhr[p];
  }
  function def(xhr, name, get) {
    Object.defineProperty(xhr, name, { configurable: true, get });
  }
  function fire(xhr, type, loaded = 0, total = 0) {
    const ev =
      type === 'readystatechange'
        ? new Event(type)
        : new ProgressEvent(type, { lengthComputable: total > 0, loaded, total });
    xhr.dispatchEvent(ev);
  }

  XHRProto.open = function (method, url, async) {
    clearFake(this);
    state.set(this, {
      method: String(method).toUpperCase(),
      url: absUrl(url),
      async: arguments.length < 3 || async !== false,
      headers: {},
      active: false,
      aborted: false,
      done: false,
      rs: 1
    });
    return origOpen.apply(this, arguments);
  };

  XHRProto.setRequestHeader = function (name, value) {
    const st = state.get(this);
    if (st) st.headers[name] = st.headers[name] ? st.headers[name] + ', ' + value : String(value);
    return origSetHeader.apply(this, arguments);
  };

  XHRProto.send = function (body) {
    const st = state.get(this);
    if (!st || !st.async) return origSend.apply(this, arguments);
    const xhr = this;
    const args = arguments;
    const go = () => {
      if (st.aborted || state.get(xhr) !== st) return;
      const rule = findRule(st.url, st.method);
      if (!rule) return origSend.apply(xhr, args);
      st.active = true;
      runFakeXhr(xhr, st, rule, body);
    };
    if (isReady) return go();
    ready.then(go);
  };

  XHRProto.abort = function () {
    const st = state.get(this);
    if (st && st.active && !st.done) {
      st.aborted = true;
      st.done = true;
      clearTimeout(st.timer);
      if (st.controller) st.controller.abort();
      def(this, 'status', () => 0);
      def(this, 'readyState', () => st.rs);
      st.rs = 4;
      fire(this, 'readystatechange');
      fire(this, 'abort');
      fire(this, 'loadend');
      st.rs = 0;
      return;
    }
    if (st && !st.active) st.aborted = true;
    return origAbort.apply(this, arguments);
  };

  async function runFakeXhr(xhr, st, rule, body) {
    const stale = () => st.aborted || st.done || state.get(xhr) !== st;
    def(xhr, 'readyState', () => st.rs);
    fire(xhr, 'loadstart');
    if (xhr.timeout > 0) {
      st.timer = setTimeout(() => {
        if (stale()) return;
        st.aborted = true;
        st.done = true;
        if (st.controller) st.controller.abort();
        def(xhr, 'status', () => 0);
        st.rs = 4;
        fire(xhr, 'readystatechange');
        fire(xhr, 'timeout');
        fire(xhr, 'loadend');
      }, xhr.timeout);
    }
    const mockOnly = rule.mockOnly && hasBody(rule);
    let real = null;

    if (!mockOnly) {
      try {
        st.controller = new AbortController();
        const init = {
          method: st.method,
          headers: st.headers,
          credentials: xhr.withCredentials ? 'include' : 'same-origin',
          signal: st.controller.signal
        };
        if (body != null && st.method !== 'GET' && st.method !== 'HEAD') init.body = body;
        const res = await sendMarked(origFetch, st.url, init);
        real = { status: res.status, statusText: res.statusText, headers: res.headers, url: res.url, text: null };
        if (hasBody(rule)) {
          // Drain instead of cancel: a cancelled stream leaves DevTools with no response body to show.
          res.arrayBuffer().catch(() => {});
        } else {
          real.text = await res.text();
        }
      } catch (err) {
        if (stale()) return;
        if (!hasBody(rule)) {
          clearTimeout(st.timer);
          st.done = true;
          def(xhr, 'status', () => 0);
          st.rs = 4;
          fire(xhr, 'readystatechange');
          fire(xhr, 'error');
          fire(xhr, 'loadend');
          return;
        }
        real = null;
      }
    }

    if (rule.delay > 0) await sleep(rule.delay);
    if (stale()) return;
    clearTimeout(st.timer);

    const out = build(rule, real, st.url);
    const text = out.body == null ? '' : out.body;
    let response;
    switch (xhr.responseType) {
      case 'json':
        try {
          response = text ? JSON.parse(text) : null;
        } catch (_) {
          response = null;
        }
        break;
      case 'arraybuffer':
        response = new TextEncoder().encode(text).buffer;
        break;
      case 'blob':
        response = new Blob([text], { type: out.headers.get('content-type') || '' });
        break;
      default:
        response = text;
    }
    const headerLines = [];
    out.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));

    st.done = true;
    def(xhr, 'status', () => out.status);
    def(xhr, 'statusText', () => out.statusText);
    def(xhr, 'responseURL', () => out.url);
    def(xhr, 'response', () => response);
    def(xhr, 'responseText', () => text);
    def(xhr, 'responseXML', () => null);
    Object.defineProperty(xhr, 'getResponseHeader', { configurable: true, value: (n) => out.headers.get(n) });
    Object.defineProperty(xhr, 'getAllResponseHeaders', {
      configurable: true,
      value: () => headerLines.join('\r\n') + (headerLines.length ? '\r\n' : '')
    });

    const len = text.length;
    st.rs = 2;
    fire(xhr, 'readystatechange');
    st.rs = 3;
    fire(xhr, 'readystatechange');
    fire(xhr, 'progress', len, len);
    st.rs = 4;
    fire(xhr, 'readystatechange');
    fire(xhr, 'load', len, len);
    fire(xhr, 'loadend', len, len);
    log(st.method, st.url, rule, out, real);
    report(st.method, st.url, out, real, 'xhr');
  }
})();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5qZWN0LmpzIiwic291cmNlcyI6WyJkb3BwZWwtaW50ZXJuYWwvaW5qZWN0LmpzIl0sInNvdXJjZXNDb250ZW50IjpbIigoKSA9PiB7XG4gIGlmICh3aW5kb3cuX19hcGlvdkluc3RhbGxlZCkgcmV0dXJuO1xuICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCAnX19hcGlvdkluc3RhbGxlZCcsIHsgdmFsdWU6IHRydWUgfSk7XG5cbiAgY29uc3QgVEFHID0gJyVjW0RvcHBlbF0nO1xuICBjb25zdCBUQUdfU1RZTEUgPSAnY29sb3I6I0ZGNkI1Qjtmb250LXdlaWdodDpib2xkJztcbiAgY29uc3QgTlVMTF9CT0RZX1NUQVRVUyA9IG5ldyBTZXQoWzEwMSwgMjA0LCAyMDUsIDMwNF0pO1xuICBjb25zdCBTVEFUVVNfVEVYVCA9IHtcbiAgICAyMDA6ICdPSycsXG4gICAgMjAxOiAnQ3JlYXRlZCcsXG4gICAgMjAyOiAnQWNjZXB0ZWQnLFxuICAgIDIwNDogJ05vIENvbnRlbnQnLFxuICAgIDMwMTogJ01vdmVkIFBlcm1hbmVudGx5JyxcbiAgICAzMDI6ICdGb3VuZCcsXG4gICAgMzA0OiAnTm90IE1vZGlmaWVkJyxcbiAgICA0MDA6ICdCYWQgUmVxdWVzdCcsXG4gICAgNDAxOiAnVW5hdXRob3JpemVkJyxcbiAgICA0MDI6ICdQYXltZW50IFJlcXVpcmVkJyxcbiAgICA0MDM6ICdGb3JiaWRkZW4nLFxuICAgIDQwNDogJ05vdCBGb3VuZCcsXG4gICAgNDA1OiAnTWV0aG9kIE5vdCBBbGxvd2VkJyxcbiAgICA0MDg6ICdSZXF1ZXN0IFRpbWVvdXQnLFxuICAgIDQwOTogJ0NvbmZsaWN0JyxcbiAgICA0MTA6ICdHb25lJyxcbiAgICA0MTM6ICdQYXlsb2FkIFRvbyBMYXJnZScsXG4gICAgNDE1OiAnVW5zdXBwb3J0ZWQgTWVkaWEgVHlwZScsXG4gICAgNDIyOiAnVW5wcm9jZXNzYWJsZSBFbnRpdHknLFxuICAgIDQyOTogJ1RvbyBNYW55IFJlcXVlc3RzJyxcbiAgICA1MDA6ICdJbnRlcm5hbCBTZXJ2ZXIgRXJyb3InLFxuICAgIDUwMTogJ05vdCBJbXBsZW1lbnRlZCcsXG4gICAgNTAyOiAnQmFkIEdhdGV3YXknLFxuICAgIDUwMzogJ1NlcnZpY2UgVW5hdmFpbGFibGUnLFxuICAgIDUwNDogJ0dhdGV3YXkgVGltZW91dCdcbiAgfTtcblxuICBsZXQgYWN0aXZlQ291bnQgPSAwO1xuICBsZXQgbmF0aXZlID0gZmFsc2U7IC8vIERvcHBlbCBhcHBsaWVzIG92ZXJyaWRlcyBhdCB0aGUgbmV0d29yayBsYXllciBmb3IgdGhpcyBmcmFtZSAoRGV2VG9vbHMgc2V0dGluZylcbiAgbGV0IGlzUmVhZHkgPSBmYWxzZTtcbiAgbGV0IHJlc29sdmVSZWFkeTtcbiAgY29uc3QgcmVhZHkgPSBuZXcgUHJvbWlzZSgocikgPT4gKHJlc29sdmVSZWFkeSA9IHIpKTtcbiAgY29uc3QgbWFya1JlYWR5ID0gKCkgPT4ge1xuICAgIGlmICghaXNSZWFkeSkge1xuICAgICAgaXNSZWFkeSA9IHRydWU7XG4gICAgICByZXNvbHZlUmVhZHkoKTtcbiAgICB9XG4gIH07XG4gIC8vIERvIG5vdCBibG9jayB0aGUgcGFnZSBmb3IgbG9uZyBpZiB0aGUgYnJpZGdlIG5ldmVyIGFuc3dlcnMgKGUuZy4gdGhlIGV4dGVuc2lvbiB3YXMgcmVsb2FkZWQpLlxuICBzZXRUaW1lb3V0KG1hcmtSZWFkeSwgMTUwMCk7XG5cbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignYXBpb3Y6c3RhdGUnLCAoZSkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkID0gSlNPTi5wYXJzZShlLmRldGFpbCk7XG4gICAgICBhY3RpdmVDb3VudCA9IGQuYWN0aXZlIHwgMDtcbiAgICAgIG5hdGl2ZSA9ICEhZC5uYXRpdmU7XG4gICAgfSBjYXRjaCAoXykge31cbiAgICBtYXJrUmVhZHkoKTtcbiAgfSk7XG4gIGRvY3VtZW50LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCdhcGlvdjpyZXF1ZXN0LXN0YXRlJykpO1xuXG4gIC8vIERPTSBldmVudHMgZGlzcGF0Y2ggc3luY2hyb25vdXNseSBhY3Jvc3Mgd29ybGRzLCBzbyB0aGlzIGlzIGEgc3luY2hyb25vdXMgcm91bmQtdHJpcC5cbiAgZnVuY3Rpb24gZmluZFJ1bGUodXJsLCBtZXRob2QpIHtcbiAgICBpZiAoIWFjdGl2ZUNvdW50IHx8IG5hdGl2ZSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgaWQgPSBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKSArIERhdGUubm93KCkudG9TdHJpbmcoMzYpO1xuICAgIGxldCBydWxlID0gbnVsbDtcbiAgICBjb25zdCBvblJlc3VsdCA9IChlKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBkID0gSlNPTi5wYXJzZShlLmRldGFpbCk7XG4gICAgICAgIGlmIChkLmlkID09PSBpZCkgcnVsZSA9IGQucnVsZTtcbiAgICAgIH0gY2F0Y2ggKF8pIHt9XG4gICAgfTtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdhcGlvdjptYXRjaC1yZXN1bHQnLCBvblJlc3VsdCk7XG4gICAgdHJ5IHtcbiAgICAgIGRvY3VtZW50LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KCdhcGlvdjptYXRjaCcsIHsgZGV0YWlsOiBKU09OLnN0cmluZ2lmeSh7IGlkLCB1cmwsIG1ldGhvZCB9KSB9KSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2FwaW92Om1hdGNoLXJlc3VsdCcsIG9uUmVzdWx0KTtcbiAgICB9XG4gICAgcmV0dXJuIHJ1bGU7XG4gIH1cblxuICBjb25zdCBoYXNCb2R5ID0gKHIpID0+IHR5cGVvZiByLmJvZHkgPT09ICdzdHJpbmcnICYmIHIuYm9keS50cmltKCkgIT09ICcnO1xuICBjb25zdCBoYXNTdGF0dXMgPSAocikgPT4gTnVtYmVyLmlzSW50ZWdlcihyLnN0YXR1cykgJiYgci5zdGF0dXMgPj0gMjAwICYmIHIuc3RhdHVzIDw9IDU5OTtcblxuICBmdW5jdGlvbiBhYnNVcmwodSkge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gbmV3IFVSTCh1LCBsb2NhdGlvbi5ocmVmKS5ocmVmO1xuICAgIH0gY2F0Y2ggKF8pIHtcbiAgICAgIHJldHVybiBTdHJpbmcodSk7XG4gICAgfVxuICB9XG5cbiAgZnVuY3Rpb24gc2xlZXAobXMsIHNpZ25hbCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0ID0gc2V0VGltZW91dChyZXNvbHZlLCBtcyk7XG4gICAgICBpZiAoc2lnbmFsKVxuICAgICAgICBzaWduYWwuYWRkRXZlbnRMaXN0ZW5lcihcbiAgICAgICAgICAnYWJvcnQnLFxuICAgICAgICAgICgpID0+IHtcbiAgICAgICAgICAgIGNsZWFyVGltZW91dCh0KTtcbiAgICAgICAgICAgIHJlamVjdChuZXcgRE9NRXhjZXB0aW9uKCdUaGUgb3BlcmF0aW9uIHdhcyBhYm9ydGVkLicsICdBYm9ydEVycm9yJykpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgeyBvbmNlOiB0cnVlIH1cbiAgICAgICAgKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFNhbWUgcnVsZXMgYXMgQVBJT1ZfVFlQRS5oZWFkZXIgaW4gbGliL2NvbnRlbnQtdHlwZS5qcy4gVGhpcyBzY3JpcHQgcnVucyBpbiB0aGUgcGFnZSwgc28gaXQgY2Fubm90IGxvYWQgdGhhdCBmaWxlLlxuICBmdW5jdGlvbiBjb250ZW50VHlwZUhlYWRlcih2YWx1ZSkge1xuICAgIGxldCByYXcgPSB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gdmFsdWUudHJpbSgpIDogJyc7XG4gICAgaWYgKCFyYXcpIHJldHVybiAnYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCc7XG4gICAgaWYgKCFyYXcuaW5jbHVkZXMoJy8nKSkge1xuICAgICAgY29uc3QgYWxpYXMgPSB7XG4gICAgICAgIGpzb246ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgaHRtbDogJ3RleHQvaHRtbCcsXG4gICAgICAgIHhtbDogJ2FwcGxpY2F0aW9uL3htbCcsXG4gICAgICAgIHRleHQ6ICd0ZXh0L3BsYWluJyxcbiAgICAgICAgcGxhaW46ICd0ZXh0L3BsYWluJyxcbiAgICAgICAgdHh0OiAndGV4dC9wbGFpbicsXG4gICAgICAgIGpzOiAnYXBwbGljYXRpb24vamF2YXNjcmlwdCcsXG4gICAgICAgIGphdmFzY3JpcHQ6ICdhcHBsaWNhdGlvbi9qYXZhc2NyaXB0JyxcbiAgICAgICAgY3NzOiAndGV4dC9jc3MnLFxuICAgICAgICBjc3Y6ICd0ZXh0L2NzdicsXG4gICAgICAgIHN2ZzogJ2ltYWdlL3N2Zyt4bWwnLFxuICAgICAgICB5YW1sOiAnYXBwbGljYXRpb24veWFtbCcsXG4gICAgICAgIHltbDogJ2FwcGxpY2F0aW9uL3lhbWwnLFxuICAgICAgICBncmFwaHFsOiAnYXBwbGljYXRpb24vZ3JhcGhxbCcsXG4gICAgICAgIGZvcm06ICdhcHBsaWNhdGlvbi94LXd3dy1mb3JtLXVybGVuY29kZWQnLFxuICAgICAgICBiaW5hcnk6ICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nXG4gICAgICB9W3Jhdy50b0xvd2VyQ2FzZSgpXTtcbiAgICAgIGlmIChhbGlhcykgcmF3ID0gYWxpYXM7XG4gICAgfVxuICAgIGNvbnN0IGJpdHMgPSByYXcuc3BsaXQoJzsnKTtcbiAgICBjb25zdCB0eXBlID0gYml0c1swXS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBpZiAoIS9eWyEjJCUmJyorXFwtLl5fYHx+MC05QS1aYS16XStcXC9bISMkJSYnKitcXC0uXl9gfH4wLTlBLVphLXpdKyQvLnRlc3QodHlwZSkpXG4gICAgICByZXR1cm4gJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnO1xuICAgIGNvbnN0IHBhcmFtcyA9IGJpdHNcbiAgICAgIC5zbGljZSgxKVxuICAgICAgLm1hcCgocCkgPT4gcC50cmltKCkpXG4gICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgIGlmIChwYXJhbXMuc29tZSgocCkgPT4gL15jaGFyc2V0XFxzKj0vaS50ZXN0KHApKSkgcmV0dXJuIHR5cGUgKyAnOyAnICsgcGFyYW1zLmpvaW4oJzsgJyk7XG4gICAgY29uc3QgYmluYXJ5ID1cbiAgICAgICh0eXBlLnN0YXJ0c1dpdGgoJ2ltYWdlLycpICYmIHR5cGUgIT09ICdpbWFnZS9zdmcreG1sJykgfHxcbiAgICAgIHR5cGUuc3RhcnRzV2l0aCgnYXVkaW8vJykgfHxcbiAgICAgIHR5cGUuc3RhcnRzV2l0aCgndmlkZW8vJykgfHxcbiAgICAgIHR5cGUuc3RhcnRzV2l0aCgnZm9udC8nKSB8fFxuICAgICAgdHlwZS5zdGFydHNXaXRoKCdtdWx0aXBhcnQvJykgfHxcbiAgICAgIHR5cGUgPT09ICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nIHx8XG4gICAgICB0eXBlID09PSAnYXBwbGljYXRpb24vcGRmJyB8fFxuICAgICAgdHlwZSA9PT0gJ2FwcGxpY2F0aW9uL3ppcCcgfHxcbiAgICAgIHR5cGUgPT09ICdhcHBsaWNhdGlvbi9nemlwJyB8fFxuICAgICAgdHlwZSA9PT0gJ2FwcGxpY2F0aW9uL3dhc20nIHx8XG4gICAgICB0eXBlID09PSAnYXBwbGljYXRpb24vcHJvdG9idWYnIHx8XG4gICAgICB0eXBlID09PSAnYXBwbGljYXRpb24veC1wcm90b2J1Zic7XG4gICAgaWYgKGJpbmFyeSAmJiAhdHlwZS5lbmRzV2l0aCgnK3htbCcpICYmICF0eXBlLmVuZHNXaXRoKCcranNvbicpKVxuICAgICAgcmV0dXJuIHBhcmFtcy5sZW5ndGggPyB0eXBlICsgJzsgJyArIHBhcmFtcy5qb2luKCc7ICcpIDogdHlwZTtcbiAgICByZXR1cm4gdHlwZSArICc7IGNoYXJzZXQ9dXRmLTgnICsgKHBhcmFtcy5sZW5ndGggPyAnOyAnICsgcGFyYW1zLmpvaW4oJzsgJykgOiAnJyk7XG4gIH1cblxuICBmdW5jdGlvbiBidWlsZChydWxlLCByZWFsLCB1cmwpIHtcbiAgICBjb25zdCBzdGF0dXMgPSBoYXNTdGF0dXMocnVsZSkgPyBydWxlLnN0YXR1cyA6IHJlYWwgPyByZWFsLnN0YXR1cyA6IDIwMDtcbiAgICBjb25zdCBzdGF0dXNUZXh0ID0gaGFzU3RhdHVzKHJ1bGUpID8gU1RBVFVTX1RFWFRbc3RhdHVzXSB8fCAnJyA6IHJlYWwgPyByZWFsLnN0YXR1c1RleHQgOiAnT0snO1xuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycyhyZWFsICYmIHJlYWwuaGVhZGVycyA/IHJlYWwuaGVhZGVycyA6IHVuZGVmaW5lZCk7XG4gICAgbGV0IGJvZHkgPSBoYXNCb2R5KHJ1bGUpID8gcnVsZS5ib2R5IDogcmVhbCA/IHJlYWwudGV4dCA6ICcnO1xuICAgIGlmIChoYXNCb2R5KHJ1bGUpKSB7XG4gICAgICBoZWFkZXJzLnNldCgnY29udGVudC10eXBlJywgY29udGVudFR5cGVIZWFkZXIocnVsZS5jb250ZW50VHlwZSkpO1xuICAgICAgaGVhZGVycy5kZWxldGUoJ2NvbnRlbnQtbGVuZ3RoJyk7XG4gICAgICBoZWFkZXJzLmRlbGV0ZSgnY29udGVudC1lbmNvZGluZycpO1xuICAgIH1cbiAgICBpZiAoTlVMTF9CT0RZX1NUQVRVUy5oYXMoc3RhdHVzKSkgYm9keSA9IG51bGw7XG4gICAgcmV0dXJuIHsgc3RhdHVzLCBzdGF0dXNUZXh0LCBoZWFkZXJzLCBib2R5LCB1cmw6IChyZWFsICYmIHJlYWwudXJsKSB8fCB1cmwgfTtcbiAgfVxuXG4gIC8vIExldHMgRG9wcGVsJ3MgRGV2VG9vbHMgdGFiIHNob3cgd2hhdCB0aGUgcGFnZSByZWNlaXZlZCAoQ2hyb21lJ3MgTmV0d29yayB0YWIgb25seSBzZWVzIHRoZSByZWFsIHJlc3BvbnNlKS5cbiAgZnVuY3Rpb24gcmVwb3J0KG1ldGhvZCwgdXJsLCBvdXQsIHJlYWwsIGtpbmQpIHtcbiAgICB0cnkge1xuICAgICAgZG9jdW1lbnQuZGlzcGF0Y2hFdmVudChcbiAgICAgICAgbmV3IEN1c3RvbUV2ZW50KCdhcGlvdjphcHBsaWVkJywge1xuICAgICAgICAgIGRldGFpbDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgdXJsLFxuICAgICAgICAgICAgbWV0aG9kLFxuICAgICAgICAgICAgc3RhdHVzOiBvdXQuc3RhdHVzLFxuICAgICAgICAgICAgcmVhbFN0YXR1czogcmVhbCA/IHJlYWwuc3RhdHVzIDogbnVsbCxcbiAgICAgICAgICAgIGJvZHk6IG91dC5ib2R5ID09IG51bGwgPyAnJyA6IG91dC5ib2R5LFxuICAgICAgICAgICAgY29udGVudFR5cGU6IG91dC5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJykgfHwgJycsXG4gICAgICAgICAgICBtb2NrZWQ6ICFyZWFsLFxuICAgICAgICAgICAgdmlhOiAncGFnZScsXG4gICAgICAgICAgICBraW5kLFxuICAgICAgICAgICAgYXQ6IERhdGUubm93KClcbiAgICAgICAgICB9KVxuICAgICAgICB9KVxuICAgICAgKTtcbiAgICB9IGNhdGNoIChfKSB7fVxuICB9XG5cbiAgZnVuY3Rpb24gbG9nKG1ldGhvZCwgdXJsLCBydWxlLCBvdXQsIHJlYWwpIHtcbiAgICBjb25zdCBwYXJ0cyA9IFtdO1xuICAgIHBhcnRzLnB1c2goXG4gICAgICBoYXNTdGF0dXMocnVsZSkgPyBgc3RhdHVzICR7cmVhbCA/IHJlYWwuc3RhdHVzICsgJyDihpIgJyA6ICcnfSR7b3V0LnN0YXR1c31gIDogYHN0YXR1cyAke291dC5zdGF0dXN9IChvcmlnaW5hbClgXG4gICAgKTtcbiAgICBwYXJ0cy5wdXNoKGhhc0JvZHkocnVsZSkgPyAnYm9keSBvdmVycmlkZGVuJyA6ICdib2R5IG9yaWdpbmFsJyk7XG4gICAgaWYgKHJ1bGUuZGVsYXkgPiAwKSBwYXJ0cy5wdXNoKGArJHtydWxlLmRlbGF5fW1zYCk7XG4gICAgaWYgKCFyZWFsKSBwYXJ0cy5wdXNoKCdtb2NrZWQgKG5vIG5ldHdvcmspJyk7XG4gICAgY29uc29sZS5pbmZvKGAke1RBR30lYyAke21ldGhvZH0gJHt1cmx9ICDihpIgICR7cGFydHMuam9pbignLCAnKX1gLCBUQUdfU1RZTEUsICcnKTtcbiAgfVxuXG4gIGNvbnN0IG9yaWdGZXRjaCA9IHdpbmRvdy5mZXRjaDtcbiAgY29uc3Qgc2VuZE1hcmtlZCA9IHdpbmRvd1tTeW1ib2wuZm9yKCdhcGlvdi5zZW5kJyldIHx8ICgoZm4sIGlucHV0LCBpbml0KSA9PiBmbi5jYWxsKHdpbmRvdywgaW5wdXQsIGluaXQpKTtcblxuICBhc3luYyBmdW5jdGlvbiBwYXRjaGVkRmV0Y2goaW5wdXQsIGluaXQpIHtcbiAgICBpZiAoIWlzUmVhZHkpIGF3YWl0IHJlYWR5O1xuICAgIGNvbnN0IGlzUmVxID0gdHlwZW9mIFJlcXVlc3QgIT09ICd1bmRlZmluZWQnICYmIGlucHV0IGluc3RhbmNlb2YgUmVxdWVzdDtcbiAgICBjb25zdCB1cmwgPSBhYnNVcmwoaXNSZXEgPyBpbnB1dC51cmwgOiBTdHJpbmcoaW5wdXQpKTtcbiAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcoKGluaXQgJiYgaW5pdC5tZXRob2QpIHx8IChpc1JlcSA/IGlucHV0Lm1ldGhvZCA6ICdHRVQnKSkudG9VcHBlckNhc2UoKTtcbiAgICBjb25zdCBydWxlID0gZmluZFJ1bGUodXJsLCBtZXRob2QpO1xuICAgIGlmICghcnVsZSkgcmV0dXJuIG9yaWdGZXRjaC5jYWxsKHdpbmRvdywgaW5wdXQsIGluaXQpO1xuXG4gICAgY29uc3Qgc2lnbmFsID0gKGluaXQgJiYgaW5pdC5zaWduYWwpIHx8IChpc1JlcSA/IGlucHV0LnNpZ25hbCA6IG51bGwpO1xuICAgIGNvbnN0IG1vY2tPbmx5ID0gcnVsZS5tb2NrT25seSAmJiBoYXNCb2R5KHJ1bGUpO1xuICAgIGxldCByZWFsID0gbnVsbDtcblxuICAgIGlmICghbW9ja09ubHkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHNlbmRNYXJrZWQob3JpZ0ZldGNoLCBpbnB1dCwgaW5pdCk7XG4gICAgICAgIHJlYWwgPSB7IHN0YXR1czogcmVzLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzLnN0YXR1c1RleHQsIGhlYWRlcnM6IHJlcy5oZWFkZXJzLCB1cmw6IHJlcy51cmwsIHRleHQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGhhc0JvZHkocnVsZSkpIHtcbiAgICAgICAgICAvLyBEcmFpbiBpbnN0ZWFkIG9mIGNhbmNlbDogYSBjYW5jZWxsZWQgc3RyZWFtIGxlYXZlcyBEZXZUb29scyB3aXRoIG5vIHJlc3BvbnNlIGJvZHkgdG8gc2hvdy5cbiAgICAgICAgICByZXMuYXJyYXlCdWZmZXIoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVhbC50ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChlcnIgJiYgZXJyLm5hbWUgPT09ICdBYm9ydEVycm9yJykgdGhyb3cgZXJyO1xuICAgICAgICBpZiAoIWhhc0JvZHkocnVsZSkpIHRocm93IGVycjtcbiAgICAgICAgcmVhbCA9IG51bGw7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHJ1bGUuZGVsYXkgPiAwKSBhd2FpdCBzbGVlcChydWxlLmRlbGF5LCBzaWduYWwpO1xuXG4gICAgY29uc3Qgb3V0ID0gYnVpbGQocnVsZSwgcmVhbCwgdXJsKTtcbiAgICBjb25zdCByZXNwb25zZSA9IG5ldyBSZXNwb25zZShvdXQuYm9keSwgeyBzdGF0dXM6IG91dC5zdGF0dXMsIHN0YXR1c1RleHQ6IG91dC5zdGF0dXNUZXh0LCBoZWFkZXJzOiBvdXQuaGVhZGVycyB9KTtcbiAgICB0cnkge1xuICAgICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHJlc3BvbnNlLCAndXJsJywgeyB2YWx1ZTogb3V0LnVybCB9KTtcbiAgICB9IGNhdGNoIChfKSB7fVxuICAgIGxvZyhtZXRob2QsIHVybCwgcnVsZSwgb3V0LCByZWFsKTtcbiAgICByZXBvcnQobWV0aG9kLCB1cmwsIG91dCwgcmVhbCwgJ2ZldGNoJyk7XG4gICAgcmV0dXJuIHJlc3BvbnNlO1xuICB9XG4gIHdpbmRvdy5mZXRjaCA9IHBhdGNoZWRGZXRjaDtcblxuICBjb25zdCBYSFJQcm90byA9IFhNTEh0dHBSZXF1ZXN0LnByb3RvdHlwZTtcbiAgY29uc3Qgb3JpZ09wZW4gPSBYSFJQcm90by5vcGVuO1xuICBjb25zdCBvcmlnU2VuZCA9IFhIUlByb3RvLnNlbmQ7XG4gIGNvbnN0IG9yaWdTZXRIZWFkZXIgPSBYSFJQcm90by5zZXRSZXF1ZXN0SGVhZGVyO1xuICBjb25zdCBvcmlnQWJvcnQgPSBYSFJQcm90by5hYm9ydDtcbiAgY29uc3Qgc3RhdGUgPSBuZXcgV2Vha01hcCgpO1xuICBjb25zdCBGQUtFX1BST1BTID0gW1xuICAgICdyZWFkeVN0YXRlJyxcbiAgICAnc3RhdHVzJyxcbiAgICAnc3RhdHVzVGV4dCcsXG4gICAgJ3Jlc3BvbnNlJyxcbiAgICAncmVzcG9uc2VUZXh0JyxcbiAgICAncmVzcG9uc2VVUkwnLFxuICAgICdyZXNwb25zZVhNTCcsXG4gICAgJ2dldFJlc3BvbnNlSGVhZGVyJyxcbiAgICAnZ2V0QWxsUmVzcG9uc2VIZWFkZXJzJ1xuICBdO1xuXG4gIGZ1bmN0aW9uIGNsZWFyRmFrZSh4aHIpIHtcbiAgICBmb3IgKGNvbnN0IHAgb2YgRkFLRV9QUk9QUykgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbCh4aHIsIHApKSBkZWxldGUgeGhyW3BdO1xuICB9XG4gIGZ1bmN0aW9uIGRlZih4aHIsIG5hbWUsIGdldCkge1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh4aHIsIG5hbWUsIHsgY29uZmlndXJhYmxlOiB0cnVlLCBnZXQgfSk7XG4gIH1cbiAgZnVuY3Rpb24gZmlyZSh4aHIsIHR5cGUsIGxvYWRlZCA9IDAsIHRvdGFsID0gMCkge1xuICAgIGNvbnN0IGV2ID1cbiAgICAgIHR5cGUgPT09ICdyZWFkeXN0YXRlY2hhbmdlJ1xuICAgICAgICA/IG5ldyBFdmVudCh0eXBlKVxuICAgICAgICA6IG5ldyBQcm9ncmVzc0V2ZW50KHR5cGUsIHsgbGVuZ3RoQ29tcHV0YWJsZTogdG90YWwgPiAwLCBsb2FkZWQsIHRvdGFsIH0pO1xuICAgIHhoci5kaXNwYXRjaEV2ZW50KGV2KTtcbiAgfVxuXG4gIFhIUlByb3RvLm9wZW4gPSBmdW5jdGlvbiAobWV0aG9kLCB1cmwsIGFzeW5jKSB7XG4gICAgY2xlYXJGYWtlKHRoaXMpO1xuICAgIHN0YXRlLnNldCh0aGlzLCB7XG4gICAgICBtZXRob2Q6IFN0cmluZyhtZXRob2QpLnRvVXBwZXJDYXNlKCksXG4gICAgICB1cmw6IGFic1VybCh1cmwpLFxuICAgICAgYXN5bmM6IGFyZ3VtZW50cy5sZW5ndGggPCAzIHx8IGFzeW5jICE9PSBmYWxzZSxcbiAgICAgIGhlYWRlcnM6IHt9LFxuICAgICAgYWN0aXZlOiBmYWxzZSxcbiAgICAgIGFib3J0ZWQ6IGZhbHNlLFxuICAgICAgZG9uZTogZmFsc2UsXG4gICAgICByczogMVxuICAgIH0pO1xuICAgIHJldHVybiBvcmlnT3Blbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICB9O1xuXG4gIFhIUlByb3RvLnNldFJlcXVlc3RIZWFkZXIgPSBmdW5jdGlvbiAobmFtZSwgdmFsdWUpIHtcbiAgICBjb25zdCBzdCA9IHN0YXRlLmdldCh0aGlzKTtcbiAgICBpZiAoc3QpIHN0LmhlYWRlcnNbbmFtZV0gPSBzdC5oZWFkZXJzW25hbWVdID8gc3QuaGVhZGVyc1tuYW1lXSArICcsICcgKyB2YWx1ZSA6IFN0cmluZyh2YWx1ZSk7XG4gICAgcmV0dXJuIG9yaWdTZXRIZWFkZXIuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcblxuICBYSFJQcm90by5zZW5kID0gZnVuY3Rpb24gKGJvZHkpIHtcbiAgICBjb25zdCBzdCA9IHN0YXRlLmdldCh0aGlzKTtcbiAgICBpZiAoIXN0IHx8ICFzdC5hc3luYykgcmV0dXJuIG9yaWdTZW5kLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgY29uc3QgeGhyID0gdGhpcztcbiAgICBjb25zdCBhcmdzID0gYXJndW1lbnRzO1xuICAgIGNvbnN0IGdvID0gKCkgPT4ge1xuICAgICAgaWYgKHN0LmFib3J0ZWQgfHwgc3RhdGUuZ2V0KHhocikgIT09IHN0KSByZXR1cm47XG4gICAgICBjb25zdCBydWxlID0gZmluZFJ1bGUoc3QudXJsLCBzdC5tZXRob2QpO1xuICAgICAgaWYgKCFydWxlKSByZXR1cm4gb3JpZ1NlbmQuYXBwbHkoeGhyLCBhcmdzKTtcbiAgICAgIHN0LmFjdGl2ZSA9IHRydWU7XG4gICAgICBydW5GYWtlWGhyKHhociwgc3QsIHJ1bGUsIGJvZHkpO1xuICAgIH07XG4gICAgaWYgKGlzUmVhZHkpIHJldHVybiBnbygpO1xuICAgIHJlYWR5LnRoZW4oZ28pO1xuICB9O1xuXG4gIFhIUlByb3RvLmFib3J0ID0gZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IHN0ID0gc3RhdGUuZ2V0KHRoaXMpO1xuICAgIGlmIChzdCAmJiBzdC5hY3RpdmUgJiYgIXN0LmRvbmUpIHtcbiAgICAgIHN0LmFib3J0ZWQgPSB0cnVlO1xuICAgICAgc3QuZG9uZSA9IHRydWU7XG4gICAgICBjbGVhclRpbWVvdXQoc3QudGltZXIpO1xuICAgICAgaWYgKHN0LmNvbnRyb2xsZXIpIHN0LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgIGRlZih0aGlzLCAnc3RhdHVzJywgKCkgPT4gMCk7XG4gICAgICBkZWYodGhpcywgJ3JlYWR5U3RhdGUnLCAoKSA9PiBzdC5ycyk7XG4gICAgICBzdC5ycyA9IDQ7XG4gICAgICBmaXJlKHRoaXMsICdyZWFkeXN0YXRlY2hhbmdlJyk7XG4gICAgICBmaXJlKHRoaXMsICdhYm9ydCcpO1xuICAgICAgZmlyZSh0aGlzLCAnbG9hZGVuZCcpO1xuICAgICAgc3QucnMgPSAwO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoc3QgJiYgIXN0LmFjdGl2ZSkgc3QuYWJvcnRlZCA9IHRydWU7XG4gICAgcmV0dXJuIG9yaWdBYm9ydC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICB9O1xuXG4gIGFzeW5jIGZ1bmN0aW9uIHJ1bkZha2VYaHIoeGhyLCBzdCwgcnVsZSwgYm9keSkge1xuICAgIGNvbnN0IHN0YWxlID0gKCkgPT4gc3QuYWJvcnRlZCB8fCBzdC5kb25lIHx8IHN0YXRlLmdldCh4aHIpICE9PSBzdDtcbiAgICBkZWYoeGhyLCAncmVhZHlTdGF0ZScsICgpID0+IHN0LnJzKTtcbiAgICBmaXJlKHhociwgJ2xvYWRzdGFydCcpO1xuICAgIGlmICh4aHIudGltZW91dCA+IDApIHtcbiAgICAgIHN0LnRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGlmIChzdGFsZSgpKSByZXR1cm47XG4gICAgICAgIHN0LmFib3J0ZWQgPSB0cnVlO1xuICAgICAgICBzdC5kb25lID0gdHJ1ZTtcbiAgICAgICAgaWYgKHN0LmNvbnRyb2xsZXIpIHN0LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgZGVmKHhociwgJ3N0YXR1cycsICgpID0+IDApO1xuICAgICAgICBzdC5ycyA9IDQ7XG4gICAgICAgIGZpcmUoeGhyLCAncmVhZHlzdGF0ZWNoYW5nZScpO1xuICAgICAgICBmaXJlKHhociwgJ3RpbWVvdXQnKTtcbiAgICAgICAgZmlyZSh4aHIsICdsb2FkZW5kJyk7XG4gICAgICB9LCB4aHIudGltZW91dCk7XG4gICAgfVxuICAgIGNvbnN0IG1vY2tPbmx5ID0gcnVsZS5tb2NrT25seSAmJiBoYXNCb2R5KHJ1bGUpO1xuICAgIGxldCByZWFsID0gbnVsbDtcblxuICAgIGlmICghbW9ja09ubHkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0LmNvbnRyb2xsZXIgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICAgIGNvbnN0IGluaXQgPSB7XG4gICAgICAgICAgbWV0aG9kOiBzdC5tZXRob2QsXG4gICAgICAgICAgaGVhZGVyczogc3QuaGVhZGVycyxcbiAgICAgICAgICBjcmVkZW50aWFsczogeGhyLndpdGhDcmVkZW50aWFscyA/ICdpbmNsdWRlJyA6ICdzYW1lLW9yaWdpbicsXG4gICAgICAgICAgc2lnbmFsOiBzdC5jb250cm9sbGVyLnNpZ25hbFxuICAgICAgICB9O1xuICAgICAgICBpZiAoYm9keSAhPSBudWxsICYmIHN0Lm1ldGhvZCAhPT0gJ0dFVCcgJiYgc3QubWV0aG9kICE9PSAnSEVBRCcpIGluaXQuYm9keSA9IGJvZHk7XG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHNlbmRNYXJrZWQob3JpZ0ZldGNoLCBzdC51cmwsIGluaXQpO1xuICAgICAgICByZWFsID0geyBzdGF0dXM6IHJlcy5zdGF0dXMsIHN0YXR1c1RleHQ6IHJlcy5zdGF0dXNUZXh0LCBoZWFkZXJzOiByZXMuaGVhZGVycywgdXJsOiByZXMudXJsLCB0ZXh0OiBudWxsIH07XG4gICAgICAgIGlmIChoYXNCb2R5KHJ1bGUpKSB7XG4gICAgICAgICAgLy8gRHJhaW4gaW5zdGVhZCBvZiBjYW5jZWw6IGEgY2FuY2VsbGVkIHN0cmVhbSBsZWF2ZXMgRGV2VG9vbHMgd2l0aCBubyByZXNwb25zZSBib2R5IHRvIHNob3cuXG4gICAgICAgICAgcmVzLmFycmF5QnVmZmVyKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlYWwudGV4dCA9IGF3YWl0IHJlcy50ZXh0KCk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoc3RhbGUoKSkgcmV0dXJuO1xuICAgICAgICBpZiAoIWhhc0JvZHkocnVsZSkpIHtcbiAgICAgICAgICBjbGVhclRpbWVvdXQoc3QudGltZXIpO1xuICAgICAgICAgIHN0LmRvbmUgPSB0cnVlO1xuICAgICAgICAgIGRlZih4aHIsICdzdGF0dXMnLCAoKSA9PiAwKTtcbiAgICAgICAgICBzdC5ycyA9IDQ7XG4gICAgICAgICAgZmlyZSh4aHIsICdyZWFkeXN0YXRlY2hhbmdlJyk7XG4gICAgICAgICAgZmlyZSh4aHIsICdlcnJvcicpO1xuICAgICAgICAgIGZpcmUoeGhyLCAnbG9hZGVuZCcpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZWFsID0gbnVsbDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocnVsZS5kZWxheSA+IDApIGF3YWl0IHNsZWVwKHJ1bGUuZGVsYXkpO1xuICAgIGlmIChzdGFsZSgpKSByZXR1cm47XG4gICAgY2xlYXJUaW1lb3V0KHN0LnRpbWVyKTtcblxuICAgIGNvbnN0IG91dCA9IGJ1aWxkKHJ1bGUsIHJlYWwsIHN0LnVybCk7XG4gICAgY29uc3QgdGV4dCA9IG91dC5ib2R5ID09IG51bGwgPyAnJyA6IG91dC5ib2R5O1xuICAgIGxldCByZXNwb25zZTtcbiAgICBzd2l0Y2ggKHhoci5yZXNwb25zZVR5cGUpIHtcbiAgICAgIGNhc2UgJ2pzb24nOlxuICAgICAgICB0cnkge1xuICAgICAgICAgIHJlc3BvbnNlID0gdGV4dCA/IEpTT04ucGFyc2UodGV4dCkgOiBudWxsO1xuICAgICAgICB9IGNhdGNoIChfKSB7XG4gICAgICAgICAgcmVzcG9uc2UgPSBudWxsO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnYXJyYXlidWZmZXInOlxuICAgICAgICByZXNwb25zZSA9IG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh0ZXh0KS5idWZmZXI7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnYmxvYic6XG4gICAgICAgIHJlc3BvbnNlID0gbmV3IEJsb2IoW3RleHRdLCB7IHR5cGU6IG91dC5oZWFkZXJzLmdldCgnY29udGVudC10eXBlJykgfHwgJycgfSk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmVzcG9uc2UgPSB0ZXh0O1xuICAgIH1cbiAgICBjb25zdCBoZWFkZXJMaW5lcyA9IFtdO1xuICAgIG91dC5oZWFkZXJzLmZvckVhY2goKHYsIGspID0+IGhlYWRlckxpbmVzLnB1c2goYCR7a306ICR7dn1gKSk7XG5cbiAgICBzdC5kb25lID0gdHJ1ZTtcbiAgICBkZWYoeGhyLCAnc3RhdHVzJywgKCkgPT4gb3V0LnN0YXR1cyk7XG4gICAgZGVmKHhociwgJ3N0YXR1c1RleHQnLCAoKSA9PiBvdXQuc3RhdHVzVGV4dCk7XG4gICAgZGVmKHhociwgJ3Jlc3BvbnNlVVJMJywgKCkgPT4gb3V0LnVybCk7XG4gICAgZGVmKHhociwgJ3Jlc3BvbnNlJywgKCkgPT4gcmVzcG9uc2UpO1xuICAgIGRlZih4aHIsICdyZXNwb25zZVRleHQnLCAoKSA9PiB0ZXh0KTtcbiAgICBkZWYoeGhyLCAncmVzcG9uc2VYTUwnLCAoKSA9PiBudWxsKTtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkoeGhyLCAnZ2V0UmVzcG9uc2VIZWFkZXInLCB7IGNvbmZpZ3VyYWJsZTogdHJ1ZSwgdmFsdWU6IChuKSA9PiBvdXQuaGVhZGVycy5nZXQobikgfSk7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHhociwgJ2dldEFsbFJlc3BvbnNlSGVhZGVycycsIHtcbiAgICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICAgIHZhbHVlOiAoKSA9PiBoZWFkZXJMaW5lcy5qb2luKCdcXHJcXG4nKSArIChoZWFkZXJMaW5lcy5sZW5ndGggPyAnXFxyXFxuJyA6ICcnKVxuICAgIH0pO1xuXG4gICAgY29uc3QgbGVuID0gdGV4dC5sZW5ndGg7XG4gICAgc3QucnMgPSAyO1xuICAgIGZpcmUoeGhyLCAncmVhZHlzdGF0ZWNoYW5nZScpO1xuICAgIHN0LnJzID0gMztcbiAgICBmaXJlKHhociwgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICBmaXJlKHhociwgJ3Byb2dyZXNzJywgbGVuLCBsZW4pO1xuICAgIHN0LnJzID0gNDtcbiAgICBmaXJlKHhociwgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICBmaXJlKHhociwgJ2xvYWQnLCBsZW4sIGxlbik7XG4gICAgZmlyZSh4aHIsICdsb2FkZW5kJywgbGVuLCBsZW4pO1xuICAgIGxvZyhzdC5tZXRob2QsIHN0LnVybCwgcnVsZSwgb3V0LCByZWFsKTtcbiAgICByZXBvcnQoc3QubWV0aG9kLCBzdC51cmwsIG91dCwgcmVhbCwgJ3hocicpO1xuICB9XG59KSgpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsInhfZ29vZ2xlX2lnbm9yZUxpc3QiOlswXX0=
