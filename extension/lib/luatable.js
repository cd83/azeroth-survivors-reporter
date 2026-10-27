// A small reader for the Lua the game writes as saved variables:
//   -- comments
//   RunReporterDB = { ["runs"] = { { ["summary"] = "..." }, }, ["version"] = 1, }
// Returns { Name: value } for each top-level assignment. Tables whose keys are 1..n become
// arrays; any other table becomes an object.
(function (root) {
  'use strict';

  function parseLuaAssignments(src) {
    let i = 0;
    const n = src.length;

    const fail = (msg) => { throw new Error(`Lua parse error at ${i}: ${msg}`); };

    function skip() {
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src.startsWith('--', i)) {
          i += 2;
          const long = src.slice(i).match(/^\[(=*)\[/);
          if (long) {
            const close = `]${long[1]}]`;
            const end = src.indexOf(close, i);
            i = end < 0 ? n : end + close.length;
          } else {
            while (i < n && src[i] !== '\n') i++;
          }
          continue;
        }
        return;
      }
    }

    function string() {
      const q = src[i++];
      let out = '';
      while (i < n && src[i] !== q) {
        let c = src[i++];
        if (c !== '\\') { out += c; continue; }
        c = src[i++];
        const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
        if (c in simple) out += simple[c];
        else if (c === 'x') { out += String.fromCharCode(parseInt(src.substr(i, 2), 16)); i += 2; }
        else if (/\d/.test(c)) {
          let digits = c;
          while (digits.length < 3 && /\d/.test(src[i])) digits += src[i++];
          out += String.fromCharCode(Number(digits));
        } else out += c;
      }
      if (src[i] !== q) fail('unterminated string');
      i++;
      return out;
    }

    function longString() {
      const m = src.slice(i).match(/^\[(=*)\[\n?/);
      const close = `]${m[1]}]`;
      const start = i + m[0].length;
      const end = src.indexOf(close, start);
      if (end < 0) fail('unterminated long string');
      i = end + close.length;
      return src.slice(start, end);
    }

    function name() {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!m) fail('expected a name');
      i += m[0].length;
      return m[0];
    }

    function value() {
      skip();
      const c = src[i];
      if (c === '"' || c === "'") return string();
      if (c === '{') return table();
      if (c === '[' && /^\[=*\[/.test(src.slice(i, i + 10))) return longString();
      const num = src.slice(i).match(/^-?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf|nan)/);
      if (num) {
        i += num[0].length;
        return Number(num[0]);
      }
      const word = name();
      if (word === 'true') return true;
      if (word === 'false') return false;
      if (word === 'nil') return null;
      fail(`unexpected ${word}`);
    }

    function table() {
      i++; // {
      const entries = [];
      let next = 1;
      for (;;) {
        skip();
        if (src[i] === '}') { i++; break; }
        let key;
        if (src[i] === '[' && !/^\[=*\[/.test(src.slice(i, i + 10))) {
          i++;
          key = value();
          skip();
          if (src[i] !== ']') fail('expected ]');
          i++;
          skip();
          if (src[i] !== '=') fail('expected =');
          i++;
        } else if (/^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.test(src.slice(i, i + 200))) {
          key = name();
          skip();
          i++; // =
        } else {
          key = next++;
        }
        entries.push([key, value()]);
        skip();
        if (src[i] === ',' || src[i] === ';') i++;
      }
      const isArray = entries.every(([k], idx) => k === idx + 1);
      if (isArray) return entries.map(([, v]) => v);
      const obj = {};
      for (const [k, v] of entries) obj[k] = v;
      return obj;
    }

    const out = {};
    for (;;) {
      skip();
      if (i >= n) break;
      const key = name();
      skip();
      if (src[i] !== '=') fail('expected =');
      i++;
      out[key] = value();
      skip();
      if (src[i] === ';') i++;
    }
    return out;
  }

  root.ASR = root.ASR || {};
  root.ASR.parseLuaAssignments = parseLuaAssignments;
})(globalThis);
