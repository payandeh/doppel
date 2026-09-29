const JsonCheck = (() => {
  const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const WORD = /[A-Za-z_$][\w$]*/y;

  function lineCol(src, pos) {
    let line = 1,
      last = -1;
    for (let k = 0; k < pos && k < src.length; k++)
      if (src.charCodeAt(k) === 10) {
        line++;
        last = k;
      }
    return { line, col: pos - last };
  }

  function validate(src) {
    let i = 0;
    const n = src.length;
    const fail = (message, at = i) => {
      throw { message, pos: Math.min(at, n) };
    };
    const eof = (what) => fail('Unexpected end of JSON — ' + what);

    function ws() {
      while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) i++;
        else if (c === 47 && (src[i + 1] === '/' || src[i + 1] === '*')) fail('Comments are not allowed in JSON');
        else if (c === 0xfeff || c === 0xa0) fail('Invisible non-breaking space / BOM character here — delete it');
        else break;
      }
    }

    function value() {
      ws();
      if (i >= n) eof('expected a value');
      const c = src[i];
      if (c === '{') return object();
      if (c === '[') return array();
      if (c === '"') return string();
      if (c === "'") fail('Strings must use double quotes ("), not single quotes');
      if (c === '-' || (c >= '0' && c <= '9')) return number();
      WORD.lastIndex = i;
      const m = WORD.exec(src);
      if (m) {
        const w = m[0];
        if (w === 'true' || w === 'false' || w === 'null') {
          i += w.length;
          return;
        }
        if (w === 'True' || w === 'False' || w === 'None' || w === 'NULL' || w === 'Null')
          fail(`"${w}" is not valid JSON — use ${w === 'None' || /null/i.test(w) ? 'null' : w.toLowerCase()}`);
        if (w === 'undefined' || w === 'NaN' || w === 'Infinity') fail(`${w} is not allowed in JSON`);
        fail(`Unexpected "${w}" — text values must be in double quotes`);
      }
      if (c === '}' || c === ']') fail(`Unexpected "${c}" — expected a value`);
      if (c === ',') fail('Unexpected "," — expected a value (extra comma?)');
      fail(`Unexpected character "${c}"`);
    }

    function object() {
      i++;
      ws();
      if (src[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (i >= n) eof('expected a property name or "}"');
        if (src[i] === '}') fail('Trailing comma before "}" is not allowed', i);
        if (src[i] === "'") fail('Property names must use double quotes ("), not single quotes');
        if (src[i] !== '"') {
          WORD.lastIndex = i;
          const m = WORD.exec(src);
          fail(m ? `Property name "${m[0]}" must be in double quotes` : 'Expected a property name in double quotes');
        }
        string();
        ws();
        if (i >= n) eof('expected ":"');
        if (src[i] !== ':') fail('Expected ":" after property name');
        i++;
        value();
        ws();
        if (i >= n) eof('missing "}"');
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === '}') {
          i++;
          return;
        }
        fail(src[i] === '"' ? 'Missing "," between properties' : 'Expected "," or "}" after property value');
      }
    }

    function array() {
      i++;
      ws();
      if (src[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        ws();
        if (src[i] === ']') fail('Trailing comma before "]" is not allowed');
        value();
        ws();
        if (i >= n) eof('missing "]"');
        if (src[i] === ',') {
          i++;
          continue;
        }
        if (src[i] === ']') {
          i++;
          return;
        }
        fail('Missing "," between array items or "]"');
      }
    }

    function string() {
      const start = i;
      i++;
      while (i < n) {
        const c = src.charCodeAt(i);
        if (c === 34) {
          i++;
          return;
        }
        if (c === 92) {
          const e = src[i + 1];
          if (e !== undefined && '"\\/bfnrt'.includes(e)) {
            i += 2;
            continue;
          }
          if (e === 'u') {
            if (!/^[0-9a-fA-F]{4}$/.test(src.substr(i + 2, 4))) fail('Invalid \\u escape — needs 4 hex digits');
            i += 6;
            continue;
          }
          fail(`Invalid escape "\\${e ?? ''}" in string`);
        }
        if (c === 10 || c === 13) fail('Line break inside a string — close the string or use \\n', i);
        if (c < 0x20) fail('Control character inside a string must be escaped');
        i++;
      }
      fail('Unterminated string — missing closing "', start);
    }

    function number() {
      NUM.lastIndex = i;
      const m = NUM.exec(src);
      if (!m || m[0] === '-' || !m[0]) fail('Invalid number');
      const end = i + m[0].length;
      const next = src[end];
      if (next !== undefined && /[\d.eE+xX]/.test(next))
        fail('Invalid number (no leading zeros, hex, or trailing ".")', i);
      i = end;
    }

    try {
      ws();
      if (i >= n) return { ok: false, empty: true, message: 'Empty', pos: 0, line: 1, col: 1 };
      value();
      ws();
      if (i < n)
        fail(
          src[i] === ',' ? 'Trailing comma after the JSON value' : 'Unexpected content after the end of the JSON value'
        );
      return { ok: true };
    } catch (err) {
      if (err instanceof RangeError) {
        // Very deep nesting overflows the stack; fall back to the native parser.
        try {
          JSON.parse(src);
          return { ok: true };
        } catch (e) {
          return { ok: false, message: e.message, pos: 0, line: 1, col: 1 };
        }
      }
      if (err && typeof err.pos === 'number')
        return { ok: false, message: err.message, pos: err.pos, ...lineCol(src, err.pos) };
      throw err;
    }
  }

  function transform(text, indent) {
    const v = validate(text);
    if (!v.ok) return v;
    return { ok: true, text: JSON.stringify(JSON.parse(text), null, indent) };
  }

  return {
    validate,
    format: (text, indent = 2) => transform(text, indent),
    minify: (text) => transform(text, 0),
    describe: (r) => `Line ${r.line}, col ${r.col}: ${r.message}`
  };
})();
