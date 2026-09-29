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
      activeCount = JSON.parse(e.detail).active | 0;
    } catch (_) {}
    markReady();
  });
  document.dispatchEvent(new CustomEvent('apiov:request-state'));

  // DOM events dispatch synchronously across worlds, so this is a synchronous round-trip.
  function findRule(url, method) {
    if (!activeCount) return null;
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

  function build(rule, real, url) {
    const status = hasStatus(rule) ? rule.status : real ? real.status : 200;
    const statusText = hasStatus(rule) ? STATUS_TEXT[status] || '' : real ? real.statusText : 'OK';
    const headers = new Headers(real && real.headers ? real.headers : undefined);
    let body = hasBody(rule) ? rule.body : real ? real.text : '';
    if (hasBody(rule)) {
      headers.set('content-type', 'application/json; charset=utf-8');
      headers.delete('content-length');
      headers.delete('content-encoding');
    }
    if (NULL_BODY_STATUS.has(status)) body = null;
    return { status, statusText, headers, body, url: (real && real.url) || url };
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
          try {
            res.body && res.body.cancel().catch(() => {});
          } catch (_) {}
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
          try {
            res.body && res.body.cancel().catch(() => {});
          } catch (_) {}
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
  }
})();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5qZWN0LmpzIiwic291cmNlcyI6WyJkb3BwZWwtaW50ZXJuYWwvaW5qZWN0LmpzIl0sInNvdXJjZXNDb250ZW50IjpbIigoKSA9PiB7XG4gIGlmICh3aW5kb3cuX19hcGlvdkluc3RhbGxlZCkgcmV0dXJuO1xuICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCAnX19hcGlvdkluc3RhbGxlZCcsIHsgdmFsdWU6IHRydWUgfSk7XG5cbiAgY29uc3QgVEFHID0gJyVjW0RvcHBlbF0nO1xuICBjb25zdCBUQUdfU1RZTEUgPSAnY29sb3I6I0ZGNkI1Qjtmb250LXdlaWdodDpib2xkJztcbiAgY29uc3QgTlVMTF9CT0RZX1NUQVRVUyA9IG5ldyBTZXQoWzEwMSwgMjA0LCAyMDUsIDMwNF0pO1xuICBjb25zdCBTVEFUVVNfVEVYVCA9IHtcbiAgICAyMDA6ICdPSycsXG4gICAgMjAxOiAnQ3JlYXRlZCcsXG4gICAgMjAyOiAnQWNjZXB0ZWQnLFxuICAgIDIwNDogJ05vIENvbnRlbnQnLFxuICAgIDMwMTogJ01vdmVkIFBlcm1hbmVudGx5JyxcbiAgICAzMDI6ICdGb3VuZCcsXG4gICAgMzA0OiAnTm90IE1vZGlmaWVkJyxcbiAgICA0MDA6ICdCYWQgUmVxdWVzdCcsXG4gICAgNDAxOiAnVW5hdXRob3JpemVkJyxcbiAgICA0MDI6ICdQYXltZW50IFJlcXVpcmVkJyxcbiAgICA0MDM6ICdGb3JiaWRkZW4nLFxuICAgIDQwNDogJ05vdCBGb3VuZCcsXG4gICAgNDA1OiAnTWV0aG9kIE5vdCBBbGxvd2VkJyxcbiAgICA0MDg6ICdSZXF1ZXN0IFRpbWVvdXQnLFxuICAgIDQwOTogJ0NvbmZsaWN0JyxcbiAgICA0MTA6ICdHb25lJyxcbiAgICA0MTM6ICdQYXlsb2FkIFRvbyBMYXJnZScsXG4gICAgNDE1OiAnVW5zdXBwb3J0ZWQgTWVkaWEgVHlwZScsXG4gICAgNDIyOiAnVW5wcm9jZXNzYWJsZSBFbnRpdHknLFxuICAgIDQyOTogJ1RvbyBNYW55IFJlcXVlc3RzJyxcbiAgICA1MDA6ICdJbnRlcm5hbCBTZXJ2ZXIgRXJyb3InLFxuICAgIDUwMTogJ05vdCBJbXBsZW1lbnRlZCcsXG4gICAgNTAyOiAnQmFkIEdhdGV3YXknLFxuICAgIDUwMzogJ1NlcnZpY2UgVW5hdmFpbGFibGUnLFxuICAgIDUwNDogJ0dhdGV3YXkgVGltZW91dCdcbiAgfTtcblxuICBsZXQgYWN0aXZlQ291bnQgPSAwO1xuICBsZXQgaXNSZWFkeSA9IGZhbHNlO1xuICBsZXQgcmVzb2x2ZVJlYWR5O1xuICBjb25zdCByZWFkeSA9IG5ldyBQcm9taXNlKChyKSA9PiAocmVzb2x2ZVJlYWR5ID0gcikpO1xuICBjb25zdCBtYXJrUmVhZHkgPSAoKSA9PiB7XG4gICAgaWYgKCFpc1JlYWR5KSB7XG4gICAgICBpc1JlYWR5ID0gdHJ1ZTtcbiAgICAgIHJlc29sdmVSZWFkeSgpO1xuICAgIH1cbiAgfTtcbiAgLy8gRG8gbm90IGJsb2NrIHRoZSBwYWdlIGZvciBsb25nIGlmIHRoZSBicmlkZ2UgbmV2ZXIgYW5zd2VycyAoZS5nLiB0aGUgZXh0ZW5zaW9uIHdhcyByZWxvYWRlZCkuXG4gIHNldFRpbWVvdXQobWFya1JlYWR5LCAxNTAwKTtcblxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdhcGlvdjpzdGF0ZScsIChlKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIGFjdGl2ZUNvdW50ID0gSlNPTi5wYXJzZShlLmRldGFpbCkuYWN0aXZlIHwgMDtcbiAgICB9IGNhdGNoIChfKSB7fVxuICAgIG1hcmtSZWFkeSgpO1xuICB9KTtcbiAgZG9jdW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoJ2FwaW92OnJlcXVlc3Qtc3RhdGUnKSk7XG5cbiAgLy8gRE9NIGV2ZW50cyBkaXNwYXRjaCBzeW5jaHJvbm91c2x5IGFjcm9zcyB3b3JsZHMsIHNvIHRoaXMgaXMgYSBzeW5jaHJvbm91cyByb3VuZC10cmlwLlxuICBmdW5jdGlvbiBmaW5kUnVsZSh1cmwsIG1ldGhvZCkge1xuICAgIGlmICghYWN0aXZlQ291bnQpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IGlkID0gTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMikgKyBEYXRlLm5vdygpLnRvU3RyaW5nKDM2KTtcbiAgICBsZXQgcnVsZSA9IG51bGw7XG4gICAgY29uc3Qgb25SZXN1bHQgPSAoZSkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZCA9IEpTT04ucGFyc2UoZS5kZXRhaWwpO1xuICAgICAgICBpZiAoZC5pZCA9PT0gaWQpIHJ1bGUgPSBkLnJ1bGU7XG4gICAgICB9IGNhdGNoIChfKSB7fVxuICAgIH07XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignYXBpb3Y6bWF0Y2gtcmVzdWx0Jywgb25SZXN1bHQpO1xuICAgIHRyeSB7XG4gICAgICBkb2N1bWVudC5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgnYXBpb3Y6bWF0Y2gnLCB7IGRldGFpbDogSlNPTi5zdHJpbmdpZnkoeyBpZCwgdXJsLCBtZXRob2QgfSkgfSkpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKCdhcGlvdjptYXRjaC1yZXN1bHQnLCBvblJlc3VsdCk7XG4gICAgfVxuICAgIHJldHVybiBydWxlO1xuICB9XG5cbiAgY29uc3QgaGFzQm9keSA9IChyKSA9PiB0eXBlb2Ygci5ib2R5ID09PSAnc3RyaW5nJyAmJiByLmJvZHkudHJpbSgpICE9PSAnJztcbiAgY29uc3QgaGFzU3RhdHVzID0gKHIpID0+IE51bWJlci5pc0ludGVnZXIoci5zdGF0dXMpICYmIHIuc3RhdHVzID49IDIwMCAmJiByLnN0YXR1cyA8PSA1OTk7XG5cbiAgZnVuY3Rpb24gYWJzVXJsKHUpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIG5ldyBVUkwodSwgbG9jYXRpb24uaHJlZikuaHJlZjtcbiAgICB9IGNhdGNoIChfKSB7XG4gICAgICByZXR1cm4gU3RyaW5nKHUpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHNsZWVwKG1zLCBzaWduYWwpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpO1xuICAgICAgaWYgKHNpZ25hbClcbiAgICAgICAgc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoXG4gICAgICAgICAgJ2Fib3J0JyxcbiAgICAgICAgICAoKSA9PiB7XG4gICAgICAgICAgICBjbGVhclRpbWVvdXQodCk7XG4gICAgICAgICAgICByZWplY3QobmV3IERPTUV4Y2VwdGlvbignVGhlIG9wZXJhdGlvbiB3YXMgYWJvcnRlZC4nLCAnQWJvcnRFcnJvcicpKTtcbiAgICAgICAgICB9LFxuICAgICAgICAgIHsgb25jZTogdHJ1ZSB9XG4gICAgICAgICk7XG4gICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBidWlsZChydWxlLCByZWFsLCB1cmwpIHtcbiAgICBjb25zdCBzdGF0dXMgPSBoYXNTdGF0dXMocnVsZSkgPyBydWxlLnN0YXR1cyA6IHJlYWwgPyByZWFsLnN0YXR1cyA6IDIwMDtcbiAgICBjb25zdCBzdGF0dXNUZXh0ID0gaGFzU3RhdHVzKHJ1bGUpID8gU1RBVFVTX1RFWFRbc3RhdHVzXSB8fCAnJyA6IHJlYWwgPyByZWFsLnN0YXR1c1RleHQgOiAnT0snO1xuICAgIGNvbnN0IGhlYWRlcnMgPSBuZXcgSGVhZGVycyhyZWFsICYmIHJlYWwuaGVhZGVycyA/IHJlYWwuaGVhZGVycyA6IHVuZGVmaW5lZCk7XG4gICAgbGV0IGJvZHkgPSBoYXNCb2R5KHJ1bGUpID8gcnVsZS5ib2R5IDogcmVhbCA/IHJlYWwudGV4dCA6ICcnO1xuICAgIGlmIChoYXNCb2R5KHJ1bGUpKSB7XG4gICAgICBoZWFkZXJzLnNldCgnY29udGVudC10eXBlJywgJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnKTtcbiAgICAgIGhlYWRlcnMuZGVsZXRlKCdjb250ZW50LWxlbmd0aCcpO1xuICAgICAgaGVhZGVycy5kZWxldGUoJ2NvbnRlbnQtZW5jb2RpbmcnKTtcbiAgICB9XG4gICAgaWYgKE5VTExfQk9EWV9TVEFUVVMuaGFzKHN0YXR1cykpIGJvZHkgPSBudWxsO1xuICAgIHJldHVybiB7IHN0YXR1cywgc3RhdHVzVGV4dCwgaGVhZGVycywgYm9keSwgdXJsOiAocmVhbCAmJiByZWFsLnVybCkgfHwgdXJsIH07XG4gIH1cblxuICBmdW5jdGlvbiBsb2cobWV0aG9kLCB1cmwsIHJ1bGUsIG91dCwgcmVhbCkge1xuICAgIGNvbnN0IHBhcnRzID0gW107XG4gICAgcGFydHMucHVzaChcbiAgICAgIGhhc1N0YXR1cyhydWxlKSA/IGBzdGF0dXMgJHtyZWFsID8gcmVhbC5zdGF0dXMgKyAnIOKGkiAnIDogJyd9JHtvdXQuc3RhdHVzfWAgOiBgc3RhdHVzICR7b3V0LnN0YXR1c30gKG9yaWdpbmFsKWBcbiAgICApO1xuICAgIHBhcnRzLnB1c2goaGFzQm9keShydWxlKSA/ICdib2R5IG92ZXJyaWRkZW4nIDogJ2JvZHkgb3JpZ2luYWwnKTtcbiAgICBpZiAocnVsZS5kZWxheSA+IDApIHBhcnRzLnB1c2goYCske3J1bGUuZGVsYXl9bXNgKTtcbiAgICBpZiAoIXJlYWwpIHBhcnRzLnB1c2goJ21vY2tlZCAobm8gbmV0d29yayknKTtcbiAgICBjb25zb2xlLmluZm8oYCR7VEFHfSVjICR7bWV0aG9kfSAke3VybH0gIOKGkiAgJHtwYXJ0cy5qb2luKCcsICcpfWAsIFRBR19TVFlMRSwgJycpO1xuICB9XG5cbiAgY29uc3Qgb3JpZ0ZldGNoID0gd2luZG93LmZldGNoO1xuICBjb25zdCBzZW5kTWFya2VkID0gd2luZG93W1N5bWJvbC5mb3IoJ2FwaW92LnNlbmQnKV0gfHwgKChmbiwgaW5wdXQsIGluaXQpID0+IGZuLmNhbGwod2luZG93LCBpbnB1dCwgaW5pdCkpO1xuXG4gIGFzeW5jIGZ1bmN0aW9uIHBhdGNoZWRGZXRjaChpbnB1dCwgaW5pdCkge1xuICAgIGlmICghaXNSZWFkeSkgYXdhaXQgcmVhZHk7XG4gICAgY29uc3QgaXNSZXEgPSB0eXBlb2YgUmVxdWVzdCAhPT0gJ3VuZGVmaW5lZCcgJiYgaW5wdXQgaW5zdGFuY2VvZiBSZXF1ZXN0O1xuICAgIGNvbnN0IHVybCA9IGFic1VybChpc1JlcSA/IGlucHV0LnVybCA6IFN0cmluZyhpbnB1dCkpO1xuICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZygoaW5pdCAmJiBpbml0Lm1ldGhvZCkgfHwgKGlzUmVxID8gaW5wdXQubWV0aG9kIDogJ0dFVCcpKS50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IHJ1bGUgPSBmaW5kUnVsZSh1cmwsIG1ldGhvZCk7XG4gICAgaWYgKCFydWxlKSByZXR1cm4gb3JpZ0ZldGNoLmNhbGwod2luZG93LCBpbnB1dCwgaW5pdCk7XG5cbiAgICBjb25zdCBzaWduYWwgPSAoaW5pdCAmJiBpbml0LnNpZ25hbCkgfHwgKGlzUmVxID8gaW5wdXQuc2lnbmFsIDogbnVsbCk7XG4gICAgY29uc3QgbW9ja09ubHkgPSBydWxlLm1vY2tPbmx5ICYmIGhhc0JvZHkocnVsZSk7XG4gICAgbGV0IHJlYWwgPSBudWxsO1xuXG4gICAgaWYgKCFtb2NrT25seSkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZE1hcmtlZChvcmlnRmV0Y2gsIGlucHV0LCBpbml0KTtcbiAgICAgICAgcmVhbCA9IHsgc3RhdHVzOiByZXMuc3RhdHVzLCBzdGF0dXNUZXh0OiByZXMuc3RhdHVzVGV4dCwgaGVhZGVyczogcmVzLmhlYWRlcnMsIHVybDogcmVzLnVybCwgdGV4dDogbnVsbCB9O1xuICAgICAgICBpZiAoaGFzQm9keShydWxlKSkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXMuYm9keSAmJiByZXMuYm9keS5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgfSBjYXRjaCAoXykge31cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZWFsLnRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGVyciAmJiBlcnIubmFtZSA9PT0gJ0Fib3J0RXJyb3InKSB0aHJvdyBlcnI7XG4gICAgICAgIGlmICghaGFzQm9keShydWxlKSkgdGhyb3cgZXJyO1xuICAgICAgICByZWFsID0gbnVsbDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocnVsZS5kZWxheSA+IDApIGF3YWl0IHNsZWVwKHJ1bGUuZGVsYXksIHNpZ25hbCk7XG5cbiAgICBjb25zdCBvdXQgPSBidWlsZChydWxlLCByZWFsLCB1cmwpO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gbmV3IFJlc3BvbnNlKG91dC5ib2R5LCB7IHN0YXR1czogb3V0LnN0YXR1cywgc3RhdHVzVGV4dDogb3V0LnN0YXR1c1RleHQsIGhlYWRlcnM6IG91dC5oZWFkZXJzIH0pO1xuICAgIHRyeSB7XG4gICAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkocmVzcG9uc2UsICd1cmwnLCB7IHZhbHVlOiBvdXQudXJsIH0pO1xuICAgIH0gY2F0Y2ggKF8pIHt9XG4gICAgbG9nKG1ldGhvZCwgdXJsLCBydWxlLCBvdXQsIHJlYWwpO1xuICAgIHJldHVybiByZXNwb25zZTtcbiAgfVxuICB3aW5kb3cuZmV0Y2ggPSBwYXRjaGVkRmV0Y2g7XG5cbiAgY29uc3QgWEhSUHJvdG8gPSBYTUxIdHRwUmVxdWVzdC5wcm90b3R5cGU7XG4gIGNvbnN0IG9yaWdPcGVuID0gWEhSUHJvdG8ub3BlbjtcbiAgY29uc3Qgb3JpZ1NlbmQgPSBYSFJQcm90by5zZW5kO1xuICBjb25zdCBvcmlnU2V0SGVhZGVyID0gWEhSUHJvdG8uc2V0UmVxdWVzdEhlYWRlcjtcbiAgY29uc3Qgb3JpZ0Fib3J0ID0gWEhSUHJvdG8uYWJvcnQ7XG4gIGNvbnN0IHN0YXRlID0gbmV3IFdlYWtNYXAoKTtcbiAgY29uc3QgRkFLRV9QUk9QUyA9IFtcbiAgICAncmVhZHlTdGF0ZScsXG4gICAgJ3N0YXR1cycsXG4gICAgJ3N0YXR1c1RleHQnLFxuICAgICdyZXNwb25zZScsXG4gICAgJ3Jlc3BvbnNlVGV4dCcsXG4gICAgJ3Jlc3BvbnNlVVJMJyxcbiAgICAncmVzcG9uc2VYTUwnLFxuICAgICdnZXRSZXNwb25zZUhlYWRlcicsXG4gICAgJ2dldEFsbFJlc3BvbnNlSGVhZGVycydcbiAgXTtcblxuICBmdW5jdGlvbiBjbGVhckZha2UoeGhyKSB7XG4gICAgZm9yIChjb25zdCBwIG9mIEZBS0VfUFJPUFMpIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoeGhyLCBwKSkgZGVsZXRlIHhocltwXTtcbiAgfVxuICBmdW5jdGlvbiBkZWYoeGhyLCBuYW1lLCBnZXQpIHtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkoeGhyLCBuYW1lLCB7IGNvbmZpZ3VyYWJsZTogdHJ1ZSwgZ2V0IH0pO1xuICB9XG4gIGZ1bmN0aW9uIGZpcmUoeGhyLCB0eXBlLCBsb2FkZWQgPSAwLCB0b3RhbCA9IDApIHtcbiAgICBjb25zdCBldiA9XG4gICAgICB0eXBlID09PSAncmVhZHlzdGF0ZWNoYW5nZSdcbiAgICAgICAgPyBuZXcgRXZlbnQodHlwZSlcbiAgICAgICAgOiBuZXcgUHJvZ3Jlc3NFdmVudCh0eXBlLCB7IGxlbmd0aENvbXB1dGFibGU6IHRvdGFsID4gMCwgbG9hZGVkLCB0b3RhbCB9KTtcbiAgICB4aHIuZGlzcGF0Y2hFdmVudChldik7XG4gIH1cblxuICBYSFJQcm90by5vcGVuID0gZnVuY3Rpb24gKG1ldGhvZCwgdXJsLCBhc3luYykge1xuICAgIGNsZWFyRmFrZSh0aGlzKTtcbiAgICBzdGF0ZS5zZXQodGhpcywge1xuICAgICAgbWV0aG9kOiBTdHJpbmcobWV0aG9kKS50b1VwcGVyQ2FzZSgpLFxuICAgICAgdXJsOiBhYnNVcmwodXJsKSxcbiAgICAgIGFzeW5jOiBhcmd1bWVudHMubGVuZ3RoIDwgMyB8fCBhc3luYyAhPT0gZmFsc2UsXG4gICAgICBoZWFkZXJzOiB7fSxcbiAgICAgIGFjdGl2ZTogZmFsc2UsXG4gICAgICBhYm9ydGVkOiBmYWxzZSxcbiAgICAgIGRvbmU6IGZhbHNlLFxuICAgICAgcnM6IDFcbiAgICB9KTtcbiAgICByZXR1cm4gb3JpZ09wZW4uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcblxuICBYSFJQcm90by5zZXRSZXF1ZXN0SGVhZGVyID0gZnVuY3Rpb24gKG5hbWUsIHZhbHVlKSB7XG4gICAgY29uc3Qgc3QgPSBzdGF0ZS5nZXQodGhpcyk7XG4gICAgaWYgKHN0KSBzdC5oZWFkZXJzW25hbWVdID0gc3QuaGVhZGVyc1tuYW1lXSA/IHN0LmhlYWRlcnNbbmFtZV0gKyAnLCAnICsgdmFsdWUgOiBTdHJpbmcodmFsdWUpO1xuICAgIHJldHVybiBvcmlnU2V0SGVhZGVyLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gIH07XG5cbiAgWEhSUHJvdG8uc2VuZCA9IGZ1bmN0aW9uIChib2R5KSB7XG4gICAgY29uc3Qgc3QgPSBzdGF0ZS5nZXQodGhpcyk7XG4gICAgaWYgKCFzdCB8fCAhc3QuYXN5bmMpIHJldHVybiBvcmlnU2VuZC5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICAgIGNvbnN0IHhociA9IHRoaXM7XG4gICAgY29uc3QgYXJncyA9IGFyZ3VtZW50cztcbiAgICBjb25zdCBnbyA9ICgpID0+IHtcbiAgICAgIGlmIChzdC5hYm9ydGVkIHx8IHN0YXRlLmdldCh4aHIpICE9PSBzdCkgcmV0dXJuO1xuICAgICAgY29uc3QgcnVsZSA9IGZpbmRSdWxlKHN0LnVybCwgc3QubWV0aG9kKTtcbiAgICAgIGlmICghcnVsZSkgcmV0dXJuIG9yaWdTZW5kLmFwcGx5KHhociwgYXJncyk7XG4gICAgICBzdC5hY3RpdmUgPSB0cnVlO1xuICAgICAgcnVuRmFrZVhocih4aHIsIHN0LCBydWxlLCBib2R5KTtcbiAgICB9O1xuICAgIGlmIChpc1JlYWR5KSByZXR1cm4gZ28oKTtcbiAgICByZWFkeS50aGVuKGdvKTtcbiAgfTtcblxuICBYSFJQcm90by5hYm9ydCA9IGZ1bmN0aW9uICgpIHtcbiAgICBjb25zdCBzdCA9IHN0YXRlLmdldCh0aGlzKTtcbiAgICBpZiAoc3QgJiYgc3QuYWN0aXZlICYmICFzdC5kb25lKSB7XG4gICAgICBzdC5hYm9ydGVkID0gdHJ1ZTtcbiAgICAgIHN0LmRvbmUgPSB0cnVlO1xuICAgICAgY2xlYXJUaW1lb3V0KHN0LnRpbWVyKTtcbiAgICAgIGlmIChzdC5jb250cm9sbGVyKSBzdC5jb250cm9sbGVyLmFib3J0KCk7XG4gICAgICBkZWYodGhpcywgJ3N0YXR1cycsICgpID0+IDApO1xuICAgICAgZGVmKHRoaXMsICdyZWFkeVN0YXRlJywgKCkgPT4gc3QucnMpO1xuICAgICAgc3QucnMgPSA0O1xuICAgICAgZmlyZSh0aGlzLCAncmVhZHlzdGF0ZWNoYW5nZScpO1xuICAgICAgZmlyZSh0aGlzLCAnYWJvcnQnKTtcbiAgICAgIGZpcmUodGhpcywgJ2xvYWRlbmQnKTtcbiAgICAgIHN0LnJzID0gMDtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHN0ICYmICFzdC5hY3RpdmUpIHN0LmFib3J0ZWQgPSB0cnVlO1xuICAgIHJldHVybiBvcmlnQWJvcnQuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcblxuICBhc3luYyBmdW5jdGlvbiBydW5GYWtlWGhyKHhociwgc3QsIHJ1bGUsIGJvZHkpIHtcbiAgICBjb25zdCBzdGFsZSA9ICgpID0+IHN0LmFib3J0ZWQgfHwgc3QuZG9uZSB8fCBzdGF0ZS5nZXQoeGhyKSAhPT0gc3Q7XG4gICAgZGVmKHhociwgJ3JlYWR5U3RhdGUnLCAoKSA9PiBzdC5ycyk7XG4gICAgZmlyZSh4aHIsICdsb2Fkc3RhcnQnKTtcbiAgICBpZiAoeGhyLnRpbWVvdXQgPiAwKSB7XG4gICAgICBzdC50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBpZiAoc3RhbGUoKSkgcmV0dXJuO1xuICAgICAgICBzdC5hYm9ydGVkID0gdHJ1ZTtcbiAgICAgICAgc3QuZG9uZSA9IHRydWU7XG4gICAgICAgIGlmIChzdC5jb250cm9sbGVyKSBzdC5jb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgIGRlZih4aHIsICdzdGF0dXMnLCAoKSA9PiAwKTtcbiAgICAgICAgc3QucnMgPSA0O1xuICAgICAgICBmaXJlKHhociwgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICAgICAgZmlyZSh4aHIsICd0aW1lb3V0Jyk7XG4gICAgICAgIGZpcmUoeGhyLCAnbG9hZGVuZCcpO1xuICAgICAgfSwgeGhyLnRpbWVvdXQpO1xuICAgIH1cbiAgICBjb25zdCBtb2NrT25seSA9IHJ1bGUubW9ja09ubHkgJiYgaGFzQm9keShydWxlKTtcbiAgICBsZXQgcmVhbCA9IG51bGw7XG5cbiAgICBpZiAoIW1vY2tPbmx5KSB7XG4gICAgICB0cnkge1xuICAgICAgICBzdC5jb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCBpbml0ID0ge1xuICAgICAgICAgIG1ldGhvZDogc3QubWV0aG9kLFxuICAgICAgICAgIGhlYWRlcnM6IHN0LmhlYWRlcnMsXG4gICAgICAgICAgY3JlZGVudGlhbHM6IHhoci53aXRoQ3JlZGVudGlhbHMgPyAnaW5jbHVkZScgOiAnc2FtZS1vcmlnaW4nLFxuICAgICAgICAgIHNpZ25hbDogc3QuY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGJvZHkgIT0gbnVsbCAmJiBzdC5tZXRob2QgIT09ICdHRVQnICYmIHN0Lm1ldGhvZCAhPT0gJ0hFQUQnKSBpbml0LmJvZHkgPSBib2R5O1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBzZW5kTWFya2VkKG9yaWdGZXRjaCwgc3QudXJsLCBpbml0KTtcbiAgICAgICAgcmVhbCA9IHsgc3RhdHVzOiByZXMuc3RhdHVzLCBzdGF0dXNUZXh0OiByZXMuc3RhdHVzVGV4dCwgaGVhZGVyczogcmVzLmhlYWRlcnMsIHVybDogcmVzLnVybCwgdGV4dDogbnVsbCB9O1xuICAgICAgICBpZiAoaGFzQm9keShydWxlKSkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICByZXMuYm9keSAmJiByZXMuYm9keS5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgfSBjYXRjaCAoXykge31cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZWFsLnRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKHN0YWxlKCkpIHJldHVybjtcbiAgICAgICAgaWYgKCFoYXNCb2R5KHJ1bGUpKSB7XG4gICAgICAgICAgY2xlYXJUaW1lb3V0KHN0LnRpbWVyKTtcbiAgICAgICAgICBzdC5kb25lID0gdHJ1ZTtcbiAgICAgICAgICBkZWYoeGhyLCAnc3RhdHVzJywgKCkgPT4gMCk7XG4gICAgICAgICAgc3QucnMgPSA0O1xuICAgICAgICAgIGZpcmUoeGhyLCAncmVhZHlzdGF0ZWNoYW5nZScpO1xuICAgICAgICAgIGZpcmUoeGhyLCAnZXJyb3InKTtcbiAgICAgICAgICBmaXJlKHhociwgJ2xvYWRlbmQnKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmVhbCA9IG51bGw7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHJ1bGUuZGVsYXkgPiAwKSBhd2FpdCBzbGVlcChydWxlLmRlbGF5KTtcbiAgICBpZiAoc3RhbGUoKSkgcmV0dXJuO1xuICAgIGNsZWFyVGltZW91dChzdC50aW1lcik7XG5cbiAgICBjb25zdCBvdXQgPSBidWlsZChydWxlLCByZWFsLCBzdC51cmwpO1xuICAgIGNvbnN0IHRleHQgPSBvdXQuYm9keSA9PSBudWxsID8gJycgOiBvdXQuYm9keTtcbiAgICBsZXQgcmVzcG9uc2U7XG4gICAgc3dpdGNoICh4aHIucmVzcG9uc2VUeXBlKSB7XG4gICAgICBjYXNlICdqc29uJzpcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICByZXNwb25zZSA9IHRleHQgPyBKU09OLnBhcnNlKHRleHQpIDogbnVsbDtcbiAgICAgICAgfSBjYXRjaCAoXykge1xuICAgICAgICAgIHJlc3BvbnNlID0gbnVsbDtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2FycmF5YnVmZmVyJzpcbiAgICAgICAgcmVzcG9uc2UgPSBuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodGV4dCkuYnVmZmVyO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ2Jsb2InOlxuICAgICAgICByZXNwb25zZSA9IG5ldyBCbG9iKFt0ZXh0XSwgeyB0eXBlOiBvdXQuaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpIHx8ICcnIH0pO1xuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJlc3BvbnNlID0gdGV4dDtcbiAgICB9XG4gICAgY29uc3QgaGVhZGVyTGluZXMgPSBbXTtcbiAgICBvdXQuaGVhZGVycy5mb3JFYWNoKCh2LCBrKSA9PiBoZWFkZXJMaW5lcy5wdXNoKGAke2t9OiAke3Z9YCkpO1xuXG4gICAgc3QuZG9uZSA9IHRydWU7XG4gICAgZGVmKHhociwgJ3N0YXR1cycsICgpID0+IG91dC5zdGF0dXMpO1xuICAgIGRlZih4aHIsICdzdGF0dXNUZXh0JywgKCkgPT4gb3V0LnN0YXR1c1RleHQpO1xuICAgIGRlZih4aHIsICdyZXNwb25zZVVSTCcsICgpID0+IG91dC51cmwpO1xuICAgIGRlZih4aHIsICdyZXNwb25zZScsICgpID0+IHJlc3BvbnNlKTtcbiAgICBkZWYoeGhyLCAncmVzcG9uc2VUZXh0JywgKCkgPT4gdGV4dCk7XG4gICAgZGVmKHhociwgJ3Jlc3BvbnNlWE1MJywgKCkgPT4gbnVsbCk7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHhociwgJ2dldFJlc3BvbnNlSGVhZGVyJywgeyBjb25maWd1cmFibGU6IHRydWUsIHZhbHVlOiAobikgPT4gb3V0LmhlYWRlcnMuZ2V0KG4pIH0pO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh4aHIsICdnZXRBbGxSZXNwb25zZUhlYWRlcnMnLCB7XG4gICAgICBjb25maWd1cmFibGU6IHRydWUsXG4gICAgICB2YWx1ZTogKCkgPT4gaGVhZGVyTGluZXMuam9pbignXFxyXFxuJykgKyAoaGVhZGVyTGluZXMubGVuZ3RoID8gJ1xcclxcbicgOiAnJylcbiAgICB9KTtcblxuICAgIGNvbnN0IGxlbiA9IHRleHQubGVuZ3RoO1xuICAgIHN0LnJzID0gMjtcbiAgICBmaXJlKHhociwgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICBzdC5ycyA9IDM7XG4gICAgZmlyZSh4aHIsICdyZWFkeXN0YXRlY2hhbmdlJyk7XG4gICAgZmlyZSh4aHIsICdwcm9ncmVzcycsIGxlbiwgbGVuKTtcbiAgICBzdC5ycyA9IDQ7XG4gICAgZmlyZSh4aHIsICdyZWFkeXN0YXRlY2hhbmdlJyk7XG4gICAgZmlyZSh4aHIsICdsb2FkJywgbGVuLCBsZW4pO1xuICAgIGZpcmUoeGhyLCAnbG9hZGVuZCcsIGxlbiwgbGVuKTtcbiAgICBsb2coc3QubWV0aG9kLCBzdC51cmwsIHJ1bGUsIG91dCwgcmVhbCk7XG4gIH1cbn0pKCk7XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJ4X2dvb2dsZV9pZ25vcmVMaXN0IjpbMF19
