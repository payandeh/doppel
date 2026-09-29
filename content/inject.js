// Runs in the page's MAIN world at document_start.
// Patches window.fetch and XMLHttpRequest so matching REST calls can get
// an overridden status code and/or JSON body.
(() => {
  if (window.__apiovInstalled) return;
  Object.defineProperty(window, '__apiovInstalled', { value: true });

  const TAG = '%c[Doppel]';
  const TAG_STYLE = 'color:#FF6B5B;font-weight:bold';
  const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
    404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
    410: 'Gone', 413: 'Payload Too Large', 415: 'Unsupported Media Type',
    422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
    503: 'Service Unavailable', 504: 'Gateway Timeout'
  };

  // ---------- rule lookup (rules live in content/bridge.js, isolated world) ----------
  let activeCount = 0;
  let isReady = false;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const markReady = () => { if (!isReady) { isReady = true; resolveReady(); } };
  // Never block the page for long if the bridge is missing (e.g. extension reloaded).
  setTimeout(markReady, 1500);

  document.addEventListener('apiov:state', (e) => {
    try { activeCount = JSON.parse(e.detail).active | 0; } catch (_) {}
    markReady();
  });
  document.dispatchEvent(new CustomEvent('apiov:request-state'));

  // Synchronous round-trip: DOM events are dispatched synchronously across worlds.
  function findRule(url, method) {
    if (!activeCount) return null;
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let rule = null;
    const onResult = (e) => {
      try { const d = JSON.parse(e.detail); if (d.id === id) rule = d.rule; } catch (_) {}
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
    try { return new URL(u, location.href).href; } catch (_) { return String(u); }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  }

  // Combine the real response (may be null) with the rule.
  function build(rule, real, url) {
    const status = hasStatus(rule) ? rule.status : real ? real.status : 200;
    const statusText = hasStatus(rule) ? (STATUS_TEXT[status] || '') : real ? real.statusText : 'OK';
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
    parts.push(hasStatus(rule) ? `status ${real ? real.status + ' → ' : ''}${out.status}` : `status ${out.status} (original)`);
    parts.push(hasBody(rule) ? 'body overridden' : 'body original');
    if (rule.delay > 0) parts.push(`+${rule.delay}ms`);
    if (!real) parts.push('mocked (no network)');
    console.info(`${TAG}%c ${method} ${url}  →  ${parts.join(', ')}`, TAG_STYLE, '');
  }

  // ---------- fetch ----------
  const origFetch = window.fetch;
  // Sends through content/DOPPEL.js so the Network tab's Initiator column marks overridden requests.
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
          try { res.body && res.body.cancel().catch(() => {}); } catch (_) {}
        } else {
          real.text = await res.text();
        }
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        if (!hasBody(rule)) throw err; // nothing to fall back to
        real = null; // server unreachable → serve the mock
      }
    }

    if (rule.delay > 0) await sleep(rule.delay, signal);

    const out = build(rule, real, url);
    const response = new Response(out.body, { status: out.status, statusText: out.statusText, headers: out.headers });
    try { Object.defineProperty(response, 'url', { value: out.url }); } catch (_) {}
    log(method, url, rule, out, real);
    return response;
  }
  window.fetch = patchedFetch;

  // ---------- XMLHttpRequest ----------
  const XHRProto = XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const origSetHeader = XHRProto.setRequestHeader;
  const origAbort = XHRProto.abort;
  const state = new WeakMap();
  const FAKE_PROPS = ['readyState', 'status', 'statusText', 'response', 'responseText',
    'responseURL', 'responseXML', 'getResponseHeader', 'getAllResponseHeaders'];

  function clearFake(xhr) {
    for (const p of FAKE_PROPS) if (Object.prototype.hasOwnProperty.call(xhr, p)) delete xhr[p];
  }
  function def(xhr, name, get) {
    Object.defineProperty(xhr, name, { configurable: true, get });
  }
  function fire(xhr, type, loaded = 0, total = 0) {
    const ev = type === 'readystatechange'
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
      st.rs = 4; fire(this, 'readystatechange');
      fire(this, 'abort'); fire(this, 'loadend');
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
        st.aborted = true; st.done = true;
        if (st.controller) st.controller.abort();
        def(xhr, 'status', () => 0);
        st.rs = 4; fire(xhr, 'readystatechange');
        fire(xhr, 'timeout'); fire(xhr, 'loadend');
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
          try { res.body && res.body.cancel().catch(() => {}); } catch (_) {}
        } else {
          real.text = await res.text();
        }
      } catch (err) {
        if (stale()) return;
        if (!hasBody(rule)) {
          clearTimeout(st.timer);
          st.done = true;
          def(xhr, 'status', () => 0);
          st.rs = 4; fire(xhr, 'readystatechange');
          fire(xhr, 'error'); fire(xhr, 'loadend');
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
        try { response = text ? JSON.parse(text) : null; } catch (_) { response = null; }
        break;
      case 'arraybuffer': response = new TextEncoder().encode(text).buffer; break;
      case 'blob': response = new Blob([text], { type: out.headers.get('content-type') || '' }); break;
      default: response = text;
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
    Object.defineProperty(xhr, 'getAllResponseHeaders', { configurable: true, value: () => headerLines.join('\r\n') + (headerLines.length ? '\r\n' : '') });

    const len = text.length;
    st.rs = 2; fire(xhr, 'readystatechange');
    st.rs = 3; fire(xhr, 'readystatechange');
    fire(xhr, 'progress', len, len);
    st.rs = 4; fire(xhr, 'readystatechange');
    fire(xhr, 'load', len, len);
    fire(xhr, 'loadend', len, len);
    log(st.method, st.url, rule, out, real);
  }
})();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjogMywgImZpbGUiOiAiaW5qZWN0LmpzIiwgInNvdXJjZXMiOiBbImRvcHBlbC1pbnRlcm5hbC9pbmplY3QuanMiXSwgInNvdXJjZXNDb250ZW50IjogWyIvLyBSdW5zIGluIHRoZSBwYWdlJ3MgTUFJTiB3b3JsZCBhdCBkb2N1bWVudF9zdGFydC5cbi8vIFBhdGNoZXMgd2luZG93LmZldGNoIGFuZCBYTUxIdHRwUmVxdWVzdCBzbyBtYXRjaGluZyBSRVNUIGNhbGxzIGNhbiBnZXRcbi8vIGFuIG92ZXJyaWRkZW4gc3RhdHVzIGNvZGUgYW5kL29yIEpTT04gYm9keS5cbigoKSA9PiB7XG4gIGlmICh3aW5kb3cuX19hcGlvdkluc3RhbGxlZCkgcmV0dXJuO1xuICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCAnX19hcGlvdkluc3RhbGxlZCcsIHsgdmFsdWU6IHRydWUgfSk7XG5cbiAgY29uc3QgVEFHID0gJyVjW0RvcHBlbF0nO1xuICBjb25zdCBUQUdfU1RZTEUgPSAnY29sb3I6I0ZGNkI1Qjtmb250LXdlaWdodDpib2xkJztcbiAgY29uc3QgTlVMTF9CT0RZX1NUQVRVUyA9IG5ldyBTZXQoWzEwMSwgMjA0LCAyMDUsIDMwNF0pO1xuICBjb25zdCBTVEFUVVNfVEVYVCA9IHtcbiAgICAyMDA6ICdPSycsIDIwMTogJ0NyZWF0ZWQnLCAyMDI6ICdBY2NlcHRlZCcsIDIwNDogJ05vIENvbnRlbnQnLFxuICAgIDMwMTogJ01vdmVkIFBlcm1hbmVudGx5JywgMzAyOiAnRm91bmQnLCAzMDQ6ICdOb3QgTW9kaWZpZWQnLFxuICAgIDQwMDogJ0JhZCBSZXF1ZXN0JywgNDAxOiAnVW5hdXRob3JpemVkJywgNDAyOiAnUGF5bWVudCBSZXF1aXJlZCcsIDQwMzogJ0ZvcmJpZGRlbicsXG4gICAgNDA0OiAnTm90IEZvdW5kJywgNDA1OiAnTWV0aG9kIE5vdCBBbGxvd2VkJywgNDA4OiAnUmVxdWVzdCBUaW1lb3V0JywgNDA5OiAnQ29uZmxpY3QnLFxuICAgIDQxMDogJ0dvbmUnLCA0MTM6ICdQYXlsb2FkIFRvbyBMYXJnZScsIDQxNTogJ1Vuc3VwcG9ydGVkIE1lZGlhIFR5cGUnLFxuICAgIDQyMjogJ1VucHJvY2Vzc2FibGUgRW50aXR5JywgNDI5OiAnVG9vIE1hbnkgUmVxdWVzdHMnLFxuICAgIDUwMDogJ0ludGVybmFsIFNlcnZlciBFcnJvcicsIDUwMTogJ05vdCBJbXBsZW1lbnRlZCcsIDUwMjogJ0JhZCBHYXRld2F5JyxcbiAgICA1MDM6ICdTZXJ2aWNlIFVuYXZhaWxhYmxlJywgNTA0OiAnR2F0ZXdheSBUaW1lb3V0J1xuICB9O1xuXG4gIC8vIC0tLS0tLS0tLS0gcnVsZSBsb29rdXAgKHJ1bGVzIGxpdmUgaW4gY29udGVudC9icmlkZ2UuanMsIGlzb2xhdGVkIHdvcmxkKSAtLS0tLS0tLS0tXG4gIGxldCBhY3RpdmVDb3VudCA9IDA7XG4gIGxldCBpc1JlYWR5ID0gZmFsc2U7XG4gIGxldCByZXNvbHZlUmVhZHk7XG4gIGNvbnN0IHJlYWR5ID0gbmV3IFByb21pc2UoKHIpID0+IChyZXNvbHZlUmVhZHkgPSByKSk7XG4gIGNvbnN0IG1hcmtSZWFkeSA9ICgpID0+IHsgaWYgKCFpc1JlYWR5KSB7IGlzUmVhZHkgPSB0cnVlOyByZXNvbHZlUmVhZHkoKTsgfSB9O1xuICAvLyBOZXZlciBibG9jayB0aGUgcGFnZSBmb3IgbG9uZyBpZiB0aGUgYnJpZGdlIGlzIG1pc3NpbmcgKGUuZy4gZXh0ZW5zaW9uIHJlbG9hZGVkKS5cbiAgc2V0VGltZW91dChtYXJrUmVhZHksIDE1MDApO1xuXG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2FwaW92OnN0YXRlJywgKGUpID0+IHtcbiAgICB0cnkgeyBhY3RpdmVDb3VudCA9IEpTT04ucGFyc2UoZS5kZXRhaWwpLmFjdGl2ZSB8IDA7IH0gY2F0Y2ggKF8pIHt9XG4gICAgbWFya1JlYWR5KCk7XG4gIH0pO1xuICBkb2N1bWVudC5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgnYXBpb3Y6cmVxdWVzdC1zdGF0ZScpKTtcblxuICAvLyBTeW5jaHJvbm91cyByb3VuZC10cmlwOiBET00gZXZlbnRzIGFyZSBkaXNwYXRjaGVkIHN5bmNocm9ub3VzbHkgYWNyb3NzIHdvcmxkcy5cbiAgZnVuY3Rpb24gZmluZFJ1bGUodXJsLCBtZXRob2QpIHtcbiAgICBpZiAoIWFjdGl2ZUNvdW50KSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBpZCA9IE1hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpICsgRGF0ZS5ub3coKS50b1N0cmluZygzNik7XG4gICAgbGV0IHJ1bGUgPSBudWxsO1xuICAgIGNvbnN0IG9uUmVzdWx0ID0gKGUpID0+IHtcbiAgICAgIHRyeSB7IGNvbnN0IGQgPSBKU09OLnBhcnNlKGUuZGV0YWlsKTsgaWYgKGQuaWQgPT09IGlkKSBydWxlID0gZC5ydWxlOyB9IGNhdGNoIChfKSB7fVxuICAgIH07XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignYXBpb3Y6bWF0Y2gtcmVzdWx0Jywgb25SZXN1bHQpO1xuICAgIHRyeSB7XG4gICAgICBkb2N1bWVudC5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudCgnYXBpb3Y6bWF0Y2gnLCB7IGRldGFpbDogSlNPTi5zdHJpbmdpZnkoeyBpZCwgdXJsLCBtZXRob2QgfSkgfSkpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKCdhcGlvdjptYXRjaC1yZXN1bHQnLCBvblJlc3VsdCk7XG4gICAgfVxuICAgIHJldHVybiBydWxlO1xuICB9XG5cbiAgY29uc3QgaGFzQm9keSA9IChyKSA9PiB0eXBlb2Ygci5ib2R5ID09PSAnc3RyaW5nJyAmJiByLmJvZHkudHJpbSgpICE9PSAnJztcbiAgY29uc3QgaGFzU3RhdHVzID0gKHIpID0+IE51bWJlci5pc0ludGVnZXIoci5zdGF0dXMpICYmIHIuc3RhdHVzID49IDIwMCAmJiByLnN0YXR1cyA8PSA1OTk7XG5cbiAgZnVuY3Rpb24gYWJzVXJsKHUpIHtcbiAgICB0cnkgeyByZXR1cm4gbmV3IFVSTCh1LCBsb2NhdGlvbi5ocmVmKS5ocmVmOyB9IGNhdGNoIChfKSB7IHJldHVybiBTdHJpbmcodSk7IH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHNsZWVwKG1zLCBzaWduYWwpIHtcbiAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdCA9IHNldFRpbWVvdXQocmVzb2x2ZSwgbXMpO1xuICAgICAgaWYgKHNpZ25hbCkgc2lnbmFsLmFkZEV2ZW50TGlzdGVuZXIoJ2Fib3J0JywgKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodCk7XG4gICAgICAgIHJlamVjdChuZXcgRE9NRXhjZXB0aW9uKCdUaGUgb3BlcmF0aW9uIHdhcyBhYm9ydGVkLicsICdBYm9ydEVycm9yJykpO1xuICAgICAgfSwgeyBvbmNlOiB0cnVlIH0pO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gQ29tYmluZSB0aGUgcmVhbCByZXNwb25zZSAobWF5IGJlIG51bGwpIHdpdGggdGhlIHJ1bGUuXG4gIGZ1bmN0aW9uIGJ1aWxkKHJ1bGUsIHJlYWwsIHVybCkge1xuICAgIGNvbnN0IHN0YXR1cyA9IGhhc1N0YXR1cyhydWxlKSA/IHJ1bGUuc3RhdHVzIDogcmVhbCA/IHJlYWwuc3RhdHVzIDogMjAwO1xuICAgIGNvbnN0IHN0YXR1c1RleHQgPSBoYXNTdGF0dXMocnVsZSkgPyAoU1RBVFVTX1RFWFRbc3RhdHVzXSB8fCAnJykgOiByZWFsID8gcmVhbC5zdGF0dXNUZXh0IDogJ09LJztcbiAgICBjb25zdCBoZWFkZXJzID0gbmV3IEhlYWRlcnMocmVhbCAmJiByZWFsLmhlYWRlcnMgPyByZWFsLmhlYWRlcnMgOiB1bmRlZmluZWQpO1xuICAgIGxldCBib2R5ID0gaGFzQm9keShydWxlKSA/IHJ1bGUuYm9keSA6IHJlYWwgPyByZWFsLnRleHQgOiAnJztcbiAgICBpZiAoaGFzQm9keShydWxlKSkge1xuICAgICAgaGVhZGVycy5zZXQoJ2NvbnRlbnQtdHlwZScsICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04Jyk7XG4gICAgICBoZWFkZXJzLmRlbGV0ZSgnY29udGVudC1sZW5ndGgnKTtcbiAgICAgIGhlYWRlcnMuZGVsZXRlKCdjb250ZW50LWVuY29kaW5nJyk7XG4gICAgfVxuICAgIGlmIChOVUxMX0JPRFlfU1RBVFVTLmhhcyhzdGF0dXMpKSBib2R5ID0gbnVsbDtcbiAgICByZXR1cm4geyBzdGF0dXMsIHN0YXR1c1RleHQsIGhlYWRlcnMsIGJvZHksIHVybDogKHJlYWwgJiYgcmVhbC51cmwpIHx8IHVybCB9O1xuICB9XG5cbiAgZnVuY3Rpb24gbG9nKG1ldGhvZCwgdXJsLCBydWxlLCBvdXQsIHJlYWwpIHtcbiAgICBjb25zdCBwYXJ0cyA9IFtdO1xuICAgIHBhcnRzLnB1c2goaGFzU3RhdHVzKHJ1bGUpID8gYHN0YXR1cyAke3JlYWwgPyByZWFsLnN0YXR1cyArICcgXHUyMTkyICcgOiAnJ30ke291dC5zdGF0dXN9YCA6IGBzdGF0dXMgJHtvdXQuc3RhdHVzfSAob3JpZ2luYWwpYCk7XG4gICAgcGFydHMucHVzaChoYXNCb2R5KHJ1bGUpID8gJ2JvZHkgb3ZlcnJpZGRlbicgOiAnYm9keSBvcmlnaW5hbCcpO1xuICAgIGlmIChydWxlLmRlbGF5ID4gMCkgcGFydHMucHVzaChgKyR7cnVsZS5kZWxheX1tc2ApO1xuICAgIGlmICghcmVhbCkgcGFydHMucHVzaCgnbW9ja2VkIChubyBuZXR3b3JrKScpO1xuICAgIGNvbnNvbGUuaW5mbyhgJHtUQUd9JWMgJHttZXRob2R9ICR7dXJsfSAgXHUyMTkyICAke3BhcnRzLmpvaW4oJywgJyl9YCwgVEFHX1NUWUxFLCAnJyk7XG4gIH1cblxuICAvLyAtLS0tLS0tLS0tIGZldGNoIC0tLS0tLS0tLS1cbiAgY29uc3Qgb3JpZ0ZldGNoID0gd2luZG93LmZldGNoO1xuICAvLyBTZW5kcyB0aHJvdWdoIGNvbnRlbnQvRE9QUEVMLmpzIHNvIHRoZSBOZXR3b3JrIHRhYidzIEluaXRpYXRvciBjb2x1bW4gbWFya3Mgb3ZlcnJpZGRlbiByZXF1ZXN0cy5cbiAgY29uc3Qgc2VuZE1hcmtlZCA9IHdpbmRvd1tTeW1ib2wuZm9yKCdhcGlvdi5zZW5kJyldIHx8ICgoZm4sIGlucHV0LCBpbml0KSA9PiBmbi5jYWxsKHdpbmRvdywgaW5wdXQsIGluaXQpKTtcblxuICBhc3luYyBmdW5jdGlvbiBwYXRjaGVkRmV0Y2goaW5wdXQsIGluaXQpIHtcbiAgICBpZiAoIWlzUmVhZHkpIGF3YWl0IHJlYWR5O1xuICAgIGNvbnN0IGlzUmVxID0gdHlwZW9mIFJlcXVlc3QgIT09ICd1bmRlZmluZWQnICYmIGlucHV0IGluc3RhbmNlb2YgUmVxdWVzdDtcbiAgICBjb25zdCB1cmwgPSBhYnNVcmwoaXNSZXEgPyBpbnB1dC51cmwgOiBTdHJpbmcoaW5wdXQpKTtcbiAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcoKGluaXQgJiYgaW5pdC5tZXRob2QpIHx8IChpc1JlcSA/IGlucHV0Lm1ldGhvZCA6ICdHRVQnKSkudG9VcHBlckNhc2UoKTtcbiAgICBjb25zdCBydWxlID0gZmluZFJ1bGUodXJsLCBtZXRob2QpO1xuICAgIGlmICghcnVsZSkgcmV0dXJuIG9yaWdGZXRjaC5jYWxsKHdpbmRvdywgaW5wdXQsIGluaXQpO1xuXG4gICAgY29uc3Qgc2lnbmFsID0gKGluaXQgJiYgaW5pdC5zaWduYWwpIHx8IChpc1JlcSA/IGlucHV0LnNpZ25hbCA6IG51bGwpO1xuICAgIGNvbnN0IG1vY2tPbmx5ID0gcnVsZS5tb2NrT25seSAmJiBoYXNCb2R5KHJ1bGUpO1xuICAgIGxldCByZWFsID0gbnVsbDtcblxuICAgIGlmICghbW9ja09ubHkpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHNlbmRNYXJrZWQob3JpZ0ZldGNoLCBpbnB1dCwgaW5pdCk7XG4gICAgICAgIHJlYWwgPSB7IHN0YXR1czogcmVzLnN0YXR1cywgc3RhdHVzVGV4dDogcmVzLnN0YXR1c1RleHQsIGhlYWRlcnM6IHJlcy5oZWFkZXJzLCB1cmw6IHJlcy51cmwsIHRleHQ6IG51bGwgfTtcbiAgICAgICAgaWYgKGhhc0JvZHkocnVsZSkpIHtcbiAgICAgICAgICB0cnkgeyByZXMuYm9keSAmJiByZXMuYm9keS5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7IH0gY2F0Y2ggKF8pIHt9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVhbC50ZXh0ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChlcnIgJiYgZXJyLm5hbWUgPT09ICdBYm9ydEVycm9yJykgdGhyb3cgZXJyO1xuICAgICAgICBpZiAoIWhhc0JvZHkocnVsZSkpIHRocm93IGVycjsgLy8gbm90aGluZyB0byBmYWxsIGJhY2sgdG9cbiAgICAgICAgcmVhbCA9IG51bGw7IC8vIHNlcnZlciB1bnJlYWNoYWJsZSBcdTIxOTIgc2VydmUgdGhlIG1vY2tcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocnVsZS5kZWxheSA+IDApIGF3YWl0IHNsZWVwKHJ1bGUuZGVsYXksIHNpZ25hbCk7XG5cbiAgICBjb25zdCBvdXQgPSBidWlsZChydWxlLCByZWFsLCB1cmwpO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gbmV3IFJlc3BvbnNlKG91dC5ib2R5LCB7IHN0YXR1czogb3V0LnN0YXR1cywgc3RhdHVzVGV4dDogb3V0LnN0YXR1c1RleHQsIGhlYWRlcnM6IG91dC5oZWFkZXJzIH0pO1xuICAgIHRyeSB7IE9iamVjdC5kZWZpbmVQcm9wZXJ0eShyZXNwb25zZSwgJ3VybCcsIHsgdmFsdWU6IG91dC51cmwgfSk7IH0gY2F0Y2ggKF8pIHt9XG4gICAgbG9nKG1ldGhvZCwgdXJsLCBydWxlLCBvdXQsIHJlYWwpO1xuICAgIHJldHVybiByZXNwb25zZTtcbiAgfVxuICB3aW5kb3cuZmV0Y2ggPSBwYXRjaGVkRmV0Y2g7XG5cbiAgLy8gLS0tLS0tLS0tLSBYTUxIdHRwUmVxdWVzdCAtLS0tLS0tLS0tXG4gIGNvbnN0IFhIUlByb3RvID0gWE1MSHR0cFJlcXVlc3QucHJvdG90eXBlO1xuICBjb25zdCBvcmlnT3BlbiA9IFhIUlByb3RvLm9wZW47XG4gIGNvbnN0IG9yaWdTZW5kID0gWEhSUHJvdG8uc2VuZDtcbiAgY29uc3Qgb3JpZ1NldEhlYWRlciA9IFhIUlByb3RvLnNldFJlcXVlc3RIZWFkZXI7XG4gIGNvbnN0IG9yaWdBYm9ydCA9IFhIUlByb3RvLmFib3J0O1xuICBjb25zdCBzdGF0ZSA9IG5ldyBXZWFrTWFwKCk7XG4gIGNvbnN0IEZBS0VfUFJPUFMgPSBbJ3JlYWR5U3RhdGUnLCAnc3RhdHVzJywgJ3N0YXR1c1RleHQnLCAncmVzcG9uc2UnLCAncmVzcG9uc2VUZXh0JyxcbiAgICAncmVzcG9uc2VVUkwnLCAncmVzcG9uc2VYTUwnLCAnZ2V0UmVzcG9uc2VIZWFkZXInLCAnZ2V0QWxsUmVzcG9uc2VIZWFkZXJzJ107XG5cbiAgZnVuY3Rpb24gY2xlYXJGYWtlKHhocikge1xuICAgIGZvciAoY29uc3QgcCBvZiBGQUtFX1BST1BTKSBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHhociwgcCkpIGRlbGV0ZSB4aHJbcF07XG4gIH1cbiAgZnVuY3Rpb24gZGVmKHhociwgbmFtZSwgZ2V0KSB7XG4gICAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHhociwgbmFtZSwgeyBjb25maWd1cmFibGU6IHRydWUsIGdldCB9KTtcbiAgfVxuICBmdW5jdGlvbiBmaXJlKHhociwgdHlwZSwgbG9hZGVkID0gMCwgdG90YWwgPSAwKSB7XG4gICAgY29uc3QgZXYgPSB0eXBlID09PSAncmVhZHlzdGF0ZWNoYW5nZSdcbiAgICAgID8gbmV3IEV2ZW50KHR5cGUpXG4gICAgICA6IG5ldyBQcm9ncmVzc0V2ZW50KHR5cGUsIHsgbGVuZ3RoQ29tcHV0YWJsZTogdG90YWwgPiAwLCBsb2FkZWQsIHRvdGFsIH0pO1xuICAgIHhoci5kaXNwYXRjaEV2ZW50KGV2KTtcbiAgfVxuXG4gIFhIUlByb3RvLm9wZW4gPSBmdW5jdGlvbiAobWV0aG9kLCB1cmwsIGFzeW5jKSB7XG4gICAgY2xlYXJGYWtlKHRoaXMpO1xuICAgIHN0YXRlLnNldCh0aGlzLCB7XG4gICAgICBtZXRob2Q6IFN0cmluZyhtZXRob2QpLnRvVXBwZXJDYXNlKCksXG4gICAgICB1cmw6IGFic1VybCh1cmwpLFxuICAgICAgYXN5bmM6IGFyZ3VtZW50cy5sZW5ndGggPCAzIHx8IGFzeW5jICE9PSBmYWxzZSxcbiAgICAgIGhlYWRlcnM6IHt9LFxuICAgICAgYWN0aXZlOiBmYWxzZSxcbiAgICAgIGFib3J0ZWQ6IGZhbHNlLFxuICAgICAgZG9uZTogZmFsc2UsXG4gICAgICByczogMVxuICAgIH0pO1xuICAgIHJldHVybiBvcmlnT3Blbi5hcHBseSh0aGlzLCBhcmd1bWVudHMpO1xuICB9O1xuXG4gIFhIUlByb3RvLnNldFJlcXVlc3RIZWFkZXIgPSBmdW5jdGlvbiAobmFtZSwgdmFsdWUpIHtcbiAgICBjb25zdCBzdCA9IHN0YXRlLmdldCh0aGlzKTtcbiAgICBpZiAoc3QpIHN0LmhlYWRlcnNbbmFtZV0gPSBzdC5oZWFkZXJzW25hbWVdID8gc3QuaGVhZGVyc1tuYW1lXSArICcsICcgKyB2YWx1ZSA6IFN0cmluZyh2YWx1ZSk7XG4gICAgcmV0dXJuIG9yaWdTZXRIZWFkZXIuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcblxuICBYSFJQcm90by5zZW5kID0gZnVuY3Rpb24gKGJvZHkpIHtcbiAgICBjb25zdCBzdCA9IHN0YXRlLmdldCh0aGlzKTtcbiAgICBpZiAoIXN0IHx8ICFzdC5hc3luYykgcmV0dXJuIG9yaWdTZW5kLmFwcGx5KHRoaXMsIGFyZ3VtZW50cyk7XG4gICAgY29uc3QgeGhyID0gdGhpcztcbiAgICBjb25zdCBhcmdzID0gYXJndW1lbnRzO1xuICAgIGNvbnN0IGdvID0gKCkgPT4ge1xuICAgICAgaWYgKHN0LmFib3J0ZWQgfHwgc3RhdGUuZ2V0KHhocikgIT09IHN0KSByZXR1cm47XG4gICAgICBjb25zdCBydWxlID0gZmluZFJ1bGUoc3QudXJsLCBzdC5tZXRob2QpO1xuICAgICAgaWYgKCFydWxlKSByZXR1cm4gb3JpZ1NlbmQuYXBwbHkoeGhyLCBhcmdzKTtcbiAgICAgIHN0LmFjdGl2ZSA9IHRydWU7XG4gICAgICBydW5GYWtlWGhyKHhociwgc3QsIHJ1bGUsIGJvZHkpO1xuICAgIH07XG4gICAgaWYgKGlzUmVhZHkpIHJldHVybiBnbygpO1xuICAgIHJlYWR5LnRoZW4oZ28pO1xuICB9O1xuXG4gIFhIUlByb3RvLmFib3J0ID0gZnVuY3Rpb24gKCkge1xuICAgIGNvbnN0IHN0ID0gc3RhdGUuZ2V0KHRoaXMpO1xuICAgIGlmIChzdCAmJiBzdC5hY3RpdmUgJiYgIXN0LmRvbmUpIHtcbiAgICAgIHN0LmFib3J0ZWQgPSB0cnVlO1xuICAgICAgc3QuZG9uZSA9IHRydWU7XG4gICAgICBjbGVhclRpbWVvdXQoc3QudGltZXIpO1xuICAgICAgaWYgKHN0LmNvbnRyb2xsZXIpIHN0LmNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgIGRlZih0aGlzLCAnc3RhdHVzJywgKCkgPT4gMCk7XG4gICAgICBkZWYodGhpcywgJ3JlYWR5U3RhdGUnLCAoKSA9PiBzdC5ycyk7XG4gICAgICBzdC5ycyA9IDQ7IGZpcmUodGhpcywgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICAgIGZpcmUodGhpcywgJ2Fib3J0Jyk7IGZpcmUodGhpcywgJ2xvYWRlbmQnKTtcbiAgICAgIHN0LnJzID0gMDtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHN0ICYmICFzdC5hY3RpdmUpIHN0LmFib3J0ZWQgPSB0cnVlO1xuICAgIHJldHVybiBvcmlnQWJvcnQuYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgfTtcblxuICBhc3luYyBmdW5jdGlvbiBydW5GYWtlWGhyKHhociwgc3QsIHJ1bGUsIGJvZHkpIHtcbiAgICBjb25zdCBzdGFsZSA9ICgpID0+IHN0LmFib3J0ZWQgfHwgc3QuZG9uZSB8fCBzdGF0ZS5nZXQoeGhyKSAhPT0gc3Q7XG4gICAgZGVmKHhociwgJ3JlYWR5U3RhdGUnLCAoKSA9PiBzdC5ycyk7XG4gICAgZmlyZSh4aHIsICdsb2Fkc3RhcnQnKTtcbiAgICBpZiAoeGhyLnRpbWVvdXQgPiAwKSB7XG4gICAgICBzdC50aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICBpZiAoc3RhbGUoKSkgcmV0dXJuO1xuICAgICAgICBzdC5hYm9ydGVkID0gdHJ1ZTsgc3QuZG9uZSA9IHRydWU7XG4gICAgICAgIGlmIChzdC5jb250cm9sbGVyKSBzdC5jb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgIGRlZih4aHIsICdzdGF0dXMnLCAoKSA9PiAwKTtcbiAgICAgICAgc3QucnMgPSA0OyBmaXJlKHhociwgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICAgICAgZmlyZSh4aHIsICd0aW1lb3V0Jyk7IGZpcmUoeGhyLCAnbG9hZGVuZCcpO1xuICAgICAgfSwgeGhyLnRpbWVvdXQpO1xuICAgIH1cbiAgICBjb25zdCBtb2NrT25seSA9IHJ1bGUubW9ja09ubHkgJiYgaGFzQm9keShydWxlKTtcbiAgICBsZXQgcmVhbCA9IG51bGw7XG5cbiAgICBpZiAoIW1vY2tPbmx5KSB7XG4gICAgICB0cnkge1xuICAgICAgICBzdC5jb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgICBjb25zdCBpbml0ID0ge1xuICAgICAgICAgIG1ldGhvZDogc3QubWV0aG9kLFxuICAgICAgICAgIGhlYWRlcnM6IHN0LmhlYWRlcnMsXG4gICAgICAgICAgY3JlZGVudGlhbHM6IHhoci53aXRoQ3JlZGVudGlhbHMgPyAnaW5jbHVkZScgOiAnc2FtZS1vcmlnaW4nLFxuICAgICAgICAgIHNpZ25hbDogc3QuY29udHJvbGxlci5zaWduYWxcbiAgICAgICAgfTtcbiAgICAgICAgaWYgKGJvZHkgIT0gbnVsbCAmJiBzdC5tZXRob2QgIT09ICdHRVQnICYmIHN0Lm1ldGhvZCAhPT0gJ0hFQUQnKSBpbml0LmJvZHkgPSBib2R5O1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBzZW5kTWFya2VkKG9yaWdGZXRjaCwgc3QudXJsLCBpbml0KTtcbiAgICAgICAgcmVhbCA9IHsgc3RhdHVzOiByZXMuc3RhdHVzLCBzdGF0dXNUZXh0OiByZXMuc3RhdHVzVGV4dCwgaGVhZGVyczogcmVzLmhlYWRlcnMsIHVybDogcmVzLnVybCwgdGV4dDogbnVsbCB9O1xuICAgICAgICBpZiAoaGFzQm9keShydWxlKSkge1xuICAgICAgICAgIHRyeSB7IHJlcy5ib2R5ICYmIHJlcy5ib2R5LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTsgfSBjYXRjaCAoXykge31cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZWFsLnRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKHN0YWxlKCkpIHJldHVybjtcbiAgICAgICAgaWYgKCFoYXNCb2R5KHJ1bGUpKSB7XG4gICAgICAgICAgY2xlYXJUaW1lb3V0KHN0LnRpbWVyKTtcbiAgICAgICAgICBzdC5kb25lID0gdHJ1ZTtcbiAgICAgICAgICBkZWYoeGhyLCAnc3RhdHVzJywgKCkgPT4gMCk7XG4gICAgICAgICAgc3QucnMgPSA0OyBmaXJlKHhociwgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICAgICAgICBmaXJlKHhociwgJ2Vycm9yJyk7IGZpcmUoeGhyLCAnbG9hZGVuZCcpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZWFsID0gbnVsbDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAocnVsZS5kZWxheSA+IDApIGF3YWl0IHNsZWVwKHJ1bGUuZGVsYXkpO1xuICAgIGlmIChzdGFsZSgpKSByZXR1cm47XG4gICAgY2xlYXJUaW1lb3V0KHN0LnRpbWVyKTtcblxuICAgIGNvbnN0IG91dCA9IGJ1aWxkKHJ1bGUsIHJlYWwsIHN0LnVybCk7XG4gICAgY29uc3QgdGV4dCA9IG91dC5ib2R5ID09IG51bGwgPyAnJyA6IG91dC5ib2R5O1xuICAgIGxldCByZXNwb25zZTtcbiAgICBzd2l0Y2ggKHhoci5yZXNwb25zZVR5cGUpIHtcbiAgICAgIGNhc2UgJ2pzb24nOlxuICAgICAgICB0cnkgeyByZXNwb25zZSA9IHRleHQgPyBKU09OLnBhcnNlKHRleHQpIDogbnVsbDsgfSBjYXRjaCAoXykgeyByZXNwb25zZSA9IG51bGw7IH1cbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdhcnJheWJ1ZmZlcic6IHJlc3BvbnNlID0gbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHRleHQpLmJ1ZmZlcjsgYnJlYWs7XG4gICAgICBjYXNlICdibG9iJzogcmVzcG9uc2UgPSBuZXcgQmxvYihbdGV4dF0sIHsgdHlwZTogb3V0LmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJyB9KTsgYnJlYWs7XG4gICAgICBkZWZhdWx0OiByZXNwb25zZSA9IHRleHQ7XG4gICAgfVxuICAgIGNvbnN0IGhlYWRlckxpbmVzID0gW107XG4gICAgb3V0LmhlYWRlcnMuZm9yRWFjaCgodiwgaykgPT4gaGVhZGVyTGluZXMucHVzaChgJHtrfTogJHt2fWApKTtcblxuICAgIHN0LmRvbmUgPSB0cnVlO1xuICAgIGRlZih4aHIsICdzdGF0dXMnLCAoKSA9PiBvdXQuc3RhdHVzKTtcbiAgICBkZWYoeGhyLCAnc3RhdHVzVGV4dCcsICgpID0+IG91dC5zdGF0dXNUZXh0KTtcbiAgICBkZWYoeGhyLCAncmVzcG9uc2VVUkwnLCAoKSA9PiBvdXQudXJsKTtcbiAgICBkZWYoeGhyLCAncmVzcG9uc2UnLCAoKSA9PiByZXNwb25zZSk7XG4gICAgZGVmKHhociwgJ3Jlc3BvbnNlVGV4dCcsICgpID0+IHRleHQpO1xuICAgIGRlZih4aHIsICdyZXNwb25zZVhNTCcsICgpID0+IG51bGwpO1xuICAgIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh4aHIsICdnZXRSZXNwb25zZUhlYWRlcicsIHsgY29uZmlndXJhYmxlOiB0cnVlLCB2YWx1ZTogKG4pID0+IG91dC5oZWFkZXJzLmdldChuKSB9KTtcbiAgICBPYmplY3QuZGVmaW5lUHJvcGVydHkoeGhyLCAnZ2V0QWxsUmVzcG9uc2VIZWFkZXJzJywgeyBjb25maWd1cmFibGU6IHRydWUsIHZhbHVlOiAoKSA9PiBoZWFkZXJMaW5lcy5qb2luKCdcXHJcXG4nKSArIChoZWFkZXJMaW5lcy5sZW5ndGggPyAnXFxyXFxuJyA6ICcnKSB9KTtcblxuICAgIGNvbnN0IGxlbiA9IHRleHQubGVuZ3RoO1xuICAgIHN0LnJzID0gMjsgZmlyZSh4aHIsICdyZWFkeXN0YXRlY2hhbmdlJyk7XG4gICAgc3QucnMgPSAzOyBmaXJlKHhociwgJ3JlYWR5c3RhdGVjaGFuZ2UnKTtcbiAgICBmaXJlKHhociwgJ3Byb2dyZXNzJywgbGVuLCBsZW4pO1xuICAgIHN0LnJzID0gNDsgZmlyZSh4aHIsICdyZWFkeXN0YXRlY2hhbmdlJyk7XG4gICAgZmlyZSh4aHIsICdsb2FkJywgbGVuLCBsZW4pO1xuICAgIGZpcmUoeGhyLCAnbG9hZGVuZCcsIGxlbiwgbGVuKTtcbiAgICBsb2coc3QubWV0aG9kLCBzdC51cmwsIHJ1bGUsIG91dCwgcmVhbCk7XG4gIH1cbn0pKCk7XG4iXSwgIm5hbWVzIjogW10sICJtYXBwaW5ncyI6ICJBQUFBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCAieF9nb29nbGVfaWdub3JlTGlzdCI6IFswXX0=
