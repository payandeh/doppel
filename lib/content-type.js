// Media type of an overridden response body.
// Missing or application/json stays the historical default, so old overrides keep sending JSON.
// content/inject.js copies header() because that script runs in the page and cannot load this file.
// Change the charset rules in both places.
(function (g) {
  const JSON_DEFAULT = 'application/json';

  // Options in the editor's content type menu. application/json is the default.
  const TYPES = [
    'application/atom+xml',
    'application/ecmascript',
    'application/graphql',
    'application/graphql-response+json',
    'application/gzip',
    'application/hal+json',
    'application/javascript',
    'application/json',
    'application/json-patch+json',
    'application/ld+json',
    'application/merge-patch+json',
    'application/octet-stream',
    'application/pdf',
    'application/problem+json',
    'application/protobuf',
    'application/rss+xml',
    'application/scim+json',
    'application/soap+xml',
    'application/sql',
    'application/toml',
    'application/vnd.api+json',
    'application/wasm',
    'application/x-ndjson',
    'application/x-www-form-urlencoded',
    'application/x-yaml',
    'application/xhtml+xml',
    'application/xml',
    'application/yaml',
    'application/zip',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/webp',
    'multipart/form-data',
    'multipart/mixed',
    'text/calendar',
    'text/css',
    'text/csv',
    'text/event-stream',
    'text/html',
    'text/javascript',
    'text/json',
    'text/markdown',
    'text/plain',
    'text/vcard',
    'text/xml',
    'text/yaml'
  ];

  const ALIASES = {
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
  };

  const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

  function parse(value) {
    let raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    if (!raw.includes('/')) {
      const alias = ALIASES[raw.toLowerCase()];
      if (alias) raw = alias;
    }
    const bits = raw.split(';');
    const type = bits[0].trim().toLowerCase();
    const slash = type.indexOf('/');
    if (
      slash <= 0 ||
      slash !== type.lastIndexOf('/') ||
      !TOKEN.test(type.slice(0, slash)) ||
      !TOKEN.test(type.slice(slash + 1))
    )
      return { ok: false };
    return {
      ok: true,
      type,
      params: bits
        .slice(1)
        .map((p) => p.trim())
        .filter(Boolean)
    };
  }

  // A missing type is JSON, matching overrides saved before content types existed.
  function isJson(value) {
    if (value == null || String(value).trim() === '') return true;
    const p = parse(value);
    if (!p || !p.ok) return false;
    return p.type === 'application/json' || p.type === 'text/json' || p.type.endsWith('+json');
  }

  function binary(type) {
    if (type.endsWith('+xml') || type.endsWith('+json') || type === 'image/svg+xml') return false;
    return (
      type.startsWith('image/') ||
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
      type === 'application/x-protobuf'
    );
  }

  // Value of the Content-Type response header. Textual types get charset=utf-8 unless one is set.
  function header(value) {
    const p = parse(value);
    if (!p || !p.ok) return 'application/json; charset=utf-8';
    const params = p.params.slice();
    if (!params.some((x) => /^charset\s*=/i.test(x)) && !binary(p.type)) params.unshift('charset=utf-8');
    return params.length ? p.type + '; ' + params.join('; ') : p.type;
  }

  // What to store on the rule. Empty means the JSON default, so doppel.json does not change for old rules.
  function stored(value) {
    const p = parse(value);
    if (!p || !p.ok) return '';
    const params = p.params.filter((x) => !/^charset\s*=\s*utf-8$/i.test(x));
    if (p.type === JSON_DEFAULT && !params.length) return '';
    return params.length ? p.type + '; ' + params.join('; ') : p.type;
  }

  g.APIOV_TYPE = { TYPES, JSON_DEFAULT, parse, isJson, header, stored };
})(globalThis);
