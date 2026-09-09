(() => {
  const nameFromUrl = (urlPattern) => {
    try {
      const url = new URL(String(urlPattern).replaceAll("*", "preview"));
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
    response: { enabled: true, status: 200, statusText: "OK", headers: '{"content-type":"application/json"}', body: '{"id":1,"title":"Mocked post","body":"This response is mocked locally.","userId":1}', delayMs: 0 }
  });

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const methodClass = (method) => `method-${String(method || "*").toLowerCase().replace("*", "star")}`;
  const pathPreview = (pattern) => {
    try { const url = new URL(String(pattern).replaceAll("*", "preview")); return `${url.pathname}${url.search}`; }
    catch { return String(pattern || "Any URL"); }
  };
  const writePath = (object, path, value) => { const parts = path.split("."); const last = parts.pop(); parts.reduce((target, key) => target[key], object)[last] = value; };
  const parsePastedJson = (value) => {
    try { return JSON.parse(value); } catch {}
    const normalizedKeys = String(value)
      .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, "$1");
    const normalizedStrings = normalizedKeys.replace(/'((?:\\.|[^'\\])*)'/g, (_, content) => {
      const decoded = content.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      return JSON.stringify(decoded);
    });
    return JSON.parse(normalizedStrings);
  };

  window.ApiMockOptionsUtils = { nameFromUrl, makeRule, esc, methodClass, pathPreview, writePath, parsePastedJson };
})();