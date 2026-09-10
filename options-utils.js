(() => {
  const nameFromUrl = (urlPattern) => {
    try {
      const trimmed = String(urlPattern ?? "").trim();
      const url = new URL(trimmed.replaceAll("*", "preview"));
      const resource = url.pathname.split("/").filter(Boolean)[0];
      const label = resource?.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
      return label ? `${label} API` : "New API mock";
    } catch {
      return "New API mock";
    }
  };

  const makeRule = () => ({
    id: crypto.randomUUID(),
    enabled: true,
    name: nameFromUrl("https://jsonplaceholder.typicode.com/posts/1?test=*"),
    match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/1?test=*", method: "GET" },
    request: { url: "", method: "", headers: "{}", body: "" },
    responses: [{ enabled: true, status: 200, statusText: "OK", headers: '{"content-type":"application/json"}', body: '{"id":1,"title":"Mocked post","body":"This response is mocked locally.","userId":1}', delayMs: 0 }]
  });

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const methodClass = (method) => `method-${String(method || "*").toLowerCase().replace("*", "star")}`;
  const pathPreview = (pattern) => {
    try { const url = new URL(String(pattern ?? "").trim().replaceAll("*", "preview")); return `${url.pathname}${url.search}`; }
    catch { return String(pattern || "Any URL").trim() || "Any URL"; }
  };
  const writePath = (object, path, value) => { const parts = path.split("."); const last = parts.pop(); parts.reduce((target, key) => target[key], object)[last] = value; };

  const parsePastedJson = (rawInput) => {
    if (rawInput === null || rawInput === undefined) return null;
    if (typeof rawInput === "object") return rawInput;
    if (typeof rawInput === "number" || typeof rawInput === "boolean") return rawInput;
    const str = String(rawInput).trim();
    if (!str) return {};
    try { return JSON.parse(str); } catch {}

    let cleaned = str;
    let index = 0;
    const len = cleaned.length;

    function skipWhitespaceAndComments() {
      while (index < len) {
        const ch = cleaned[index];
        const next = cleaned[index + 1];
        if (/\s/.test(ch)) { index++; continue; }
        if (ch === "/" && next === "/") {
          index += 2;
          while (index < len && cleaned[index] !== "\n" && cleaned[index] !== "\r") index++;
          continue;
        }
        if (ch === "/" && next === "*") {
          index += 2;
          while (index < len && !(cleaned[index] === "*" && cleaned[index + 1] === "/")) index++;
          index += 2;
          continue;
        }
        if (ch === "#") {
          index++;
          while (index < len && cleaned[index] !== "\n" && cleaned[index] !== "\r") index++;
          continue;
        }
        const remaining = cleaned.slice(index);
        const matchWrapper = remaining.match(/^(?:(?:const|let|var)\s+[\w$]+\s*=\s*|export\s+default\s+|module\.exports\s*=\s*|return\s+)/);
        if (matchWrapper) {
          index += matchWrapper[0].length;
          continue;
        }
        break;
      }
    }

    function parseString(quoteChar) {
      index++;
      let result = "";
      while (index < len) {
        const ch = cleaned[index];
        if (ch === "\\") {
          index++;
          if (index >= len) break;
          const escChar = cleaned[index];
          if (escChar === "n") result += "\n";
          else if (escChar === "r") result += "\r";
          else if (escChar === "t") result += "\t";
          else if (escChar === "b") result += "\b";
          else if (escChar === "f") result += "\f";
          else if (escChar === "v") result += "\v";
          else if (escChar === "0") result += "\0";
          else if (escChar === "'" || escChar === '"' || escChar === "`" || escChar === "\\" || escChar === "/") result += escChar;
          else if (escChar === "u") {
            const hex = cleaned.slice(index + 1, index + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              result += String.fromCharCode(parseInt(hex, 16));
              index += 4;
            } else result += "u";
          } else if (escChar === "x") {
            const hex = cleaned.slice(index + 1, index + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              result += String.fromCharCode(parseInt(hex, 16));
              index += 2;
            } else result += "x";
          } else result += escChar;
          index++;
        } else if (ch === quoteChar) {
          index++;
          return result;
        } else {
          result += ch;
          index++;
        }
      }
      return result;
    }

    function skipBalanced(openChar, closeChar) {
      let depth = 0;
      while (index < len) {
        const ch = cleaned[index];
        if (ch === '"' || ch === "'" || ch === "`") {
          parseString(ch);
          continue;
        }
        if (ch === openChar) depth++;
        else if (ch === closeChar) {
          depth--;
          if (depth <= 0) { index++; break; }
        }
        index++;
      }
    }

    function parseNumberOrWord() {
      let word = "";
      while (index < len) {
        const ch = cleaned[index];
        if (/\s/.test(ch) || ch === "," || ch === "}" || ch === "]" || ch === ")" || ch === ";" || ch === ":" || ch === "/" || ch === "#") break;
        word += ch;
        index++;
      }
      if (word === "true") return true;
      if (word === "false") return false;
      if (word === "null" || word === "undefined" || word === "NaN" || word === "Infinity" || word === "+Infinity" || word === "-Infinity") return null;
      if (word === "function") {
        skipWhitespaceAndComments();
        if (cleaned[index] === "(") skipBalanced("(", ")");
        skipWhitespaceAndComments();
        if (cleaned[index] === "{") skipBalanced("{", "}");
        return null;
      }
      if (word === "new") {
        skipWhitespaceAndComments();
        while (index < len && !/\s|\(|;|,|\}|\]|\)/.test(cleaned[index])) index++;
        skipWhitespaceAndComments();
        if (cleaned[index] === "(") skipBalanced("(", ")");
        return null;
      }
      const curIndex = index;
      skipWhitespaceAndComments();
      if (cleaned.slice(index, index + 2) === "=>") {
        index += 2;
        skipWhitespaceAndComments();
        if (cleaned[index] === "{") skipBalanced("{", "}");
        else {
          while (index < len && cleaned[index] !== "," && cleaned[index] !== "}" && cleaned[index] !== "]" && cleaned[index] !== ")" && cleaned[index] !== ";") index++;
        }
        return null;
      }
      index = curIndex;

      if (/^[-+]?0x[0-9a-fA-F]+$/i.test(word)) return parseInt(word, 16);
      if (/^[-+]?0b[01]+$/i.test(word)) return parseInt(word.replace(/^[-+]?0b/i, ""), 2) * (word.startsWith("-") ? -1 : 1);
      if (/^[-+]?0o[0-7]+$/i.test(word)) return parseInt(word.replace(/^[-+]?0o/i, ""), 8) * (word.startsWith("-") ? -1 : 1);
      if (/^[-+]?\d+n$/i.test(word)) {
        const num = Number(word.slice(0, -1));
        return Number.isSafeInteger(num) ? num : word.slice(0, -1);
      }
      if (/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(word)) return Number(word);
      return word;
    }

    function parseKey() {
      skipWhitespaceAndComments();
      const ch = cleaned[index];
      if (ch === '"' || ch === "'" || ch === "`") return parseString(ch);
      let key = "";
      while (index < len) {
        const c = cleaned[index];
        if (c === ":" || c === "(" || /\s/.test(c) || c === "}" || c === ",") break;
        key += c;
        index++;
      }
      return key;
    }

    function parseObject() {
      index++;
      const obj = {};
      while (index < len) {
        skipWhitespaceAndComments();
        if (index >= len) break;
        if (cleaned[index] === "}") { index++; return obj; }
        const key = parseKey();
        skipWhitespaceAndComments();
        if (cleaned[index] === "(") {
          skipBalanced("(", ")");
          skipWhitespaceAndComments();
          if (cleaned[index] === "{") skipBalanced("{", "}");
          skipWhitespaceAndComments();
          if (cleaned[index] === ",") index++;
          continue;
        }
        if (cleaned[index] === ":") index++;
        skipWhitespaceAndComments();
        const val = parseValue();
        if (key !== "") obj[key] = val;
        skipWhitespaceAndComments();
        if (cleaned[index] === ",") {
          index++;
          skipWhitespaceAndComments();
          if (cleaned[index] === "}") { index++; return obj; }
        } else if (cleaned[index] === "}") {
          index++;
          return obj;
        }
      }
      return obj;
    }

    function parseArray() {
      index++;
      const arr = [];
      while (index < len) {
        skipWhitespaceAndComments();
        if (index >= len) break;
        if (cleaned[index] === "]") { index++; return arr; }
        const val = parseValue();
        arr.push(val);
        skipWhitespaceAndComments();
        if (cleaned[index] === ",") {
          index++;
          skipWhitespaceAndComments();
          if (cleaned[index] === "]") { index++; return arr; }
        } else if (cleaned[index] === "]") {
          index++;
          return arr;
        }
      }
      return arr;
    }

    function parseValue() {
      skipWhitespaceAndComments();
      if (index >= len) return null;
      const ch = cleaned[index];
      if (ch === "{") return parseObject();
      if (ch === "[") return parseArray();
      if (ch === '"' || ch === "'" || ch === "`") return parseString(ch);
      if (ch === "(") {
        skipBalanced("(", ")");
        skipWhitespaceAndComments();
        if (cleaned.slice(index, index + 2) === "=>") {
          index += 2;
          skipWhitespaceAndComments();
          if (cleaned[index] === "{") skipBalanced("{", "}");
          else {
            while (index < len && cleaned[index] !== "," && cleaned[index] !== "}" && cleaned[index] !== "]" && cleaned[index] !== ")" && cleaned[index] !== ";") index++;
          }
          return null;
        }
      }
      if (ch === "/" && cleaned[index + 1] !== "/" && cleaned[index + 1] !== "*") {
        index++;
        while (index < len && cleaned[index] !== "/") {
          if (cleaned[index] === "\\") index++;
          index++;
        }
        if (cleaned[index] === "/") index++;
        while (index < len && /[a-z]/i.test(cleaned[index])) index++;
        return null;
      }
      return parseNumberOrWord();
    }

    skipWhitespaceAndComments();
    if (cleaned[index] === "(") {
      index++;
    }
    const result = parseValue();
    if (result === undefined) throw new Error("Invalid JSON or JavaScript object");
    return result;
  };

  const formatJson = (value, indent = 2) => {
    const str = String(value ?? "").trim();
    if (!str) return "";
    const parsed = parsePastedJson(str);
    return JSON.stringify(parsed, null, indent);
  };

  const normalizeRule = (rule) => {
    const normalized = JSON.parse(JSON.stringify(rule));
    if (normalized.match) {
      if (typeof normalized.match.urlPattern === "string") normalized.match.urlPattern = normalized.match.urlPattern.trim();
      if (typeof normalized.match.method === "string") normalized.match.method = normalized.match.method.trim();
    }
    if (normalized.request) {
      if (typeof normalized.request.url === "string") normalized.request.url = normalized.request.url.trim();
      if (typeof normalized.request.method === "string") normalized.request.method = normalized.request.method.trim();
    }
    if (!Array.isArray(normalized.responses)) normalized.responses = normalized.response ? [{ ...normalized.response }] : makeRule().responses;
    if (!normalized.responses.length) normalized.responses = makeRule().responses;
    delete normalized.response;
    normalized.responses = normalized.responses.map((response) => {
      const normalizedResponse = { ...response };
      delete normalizedResponse.name;
      return normalizedResponse;
    });
    normalized.defaultResponseIndex = Math.min(Math.max(Number(normalized.defaultResponseIndex) || 0, 0), normalized.responses.length - 1);
    normalized.response = normalized.responses[0];
    return normalized;
  };

  window.ApiMockOptionsUtils = { nameFromUrl, makeRule, esc, methodClass, pathPreview, writePath, parsePastedJson, formatJson, normalizeRule };
})();