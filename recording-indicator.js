(() => {
  if (window.top !== window || window.__LOCAL_API_MOCK_REC_INDICATOR__) return;
  window.__LOCAL_API_MOCK_REC_INDICATOR__ = true;
  const { scopeMatches, normalizeHosts } = window.ApiMockRules;
  let watchedHosts = new Set();
  const pageHost = (() => { try { return new URL(location.href || location.origin).host; } catch { return null; } })();
  let recording = null;
  let host = null;
  let name = null;
  let count = null;
  const update = () => {
    const eligible = recording?.active && watchedHosts.has(pageHost) && scopeMatches(recording.monitorScope, {
      origin: location.origin, pathname: location.pathname
    });
    if (!eligible) { host?.remove(); host = null; return; }
    if (!document.documentElement) return;
    if (!host) {
      host = document.createElement('div');
      host.id = 'local-api-mock-rec-indicator';
      host.style.cssText = 'all:initial!important;position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        :host { color-scheme: dark; }
        .card { display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 12px;max-width:250px;padding:11px 15px;border:1px solid #ffffff24;border-radius:12px;background:#111827e8;color:#f8fafc;box-shadow:0 5px 24px #0003;backdrop-filter:blur(10px);font:12px/1.4 system-ui,sans-serif; }
        .rec { grid-row:span 2;display:flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:1px;color:#fca5a5; }
        .dot { width:7px;height:7px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #ef444420; }
        .name { font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
        .count { color:#cbd5e1;font-size:11px; }
      </style><div class="card" role="status" aria-live="polite"><span class="rec"><span class="dot"></span>REC</span><span class="name"></span><span class="count"></span></div>`;
      name = shadow.querySelector('.name');
      count = shadow.querySelector('.count');
      document.documentElement.appendChild(host);
    }
    name.textContent = recording.name || 'Recording';
    count.textContent = `${recording.apiOrigin ? `API: ${new URL(recording.apiOrigin).host} · ` : ""}${recording.captured?.length || 0} captured`;
  };
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'local-api-mock' || event.data.type !== 'config') return;
    recording = event.data.config?.recording;
    watchedHosts = new Set(normalizeHosts(event.data.config?.watchedHosts));
    syncHistory();
    update();
  });
  const historyHooks = [];
  for (const method of ['pushState', 'replaceState']) {
    const native = history[method];
    const wrapper = function (...args) { const result = native.apply(this, args); update(); return result; };
    historyHooks.push({ method, native, wrapper });
  }
  const syncHistory = () => {
    const needed = recording?.active && watchedHosts.has(pageHost);
    for (const { method, native, wrapper } of historyHooks) {
      if (needed && history[method] === native) history[method] = wrapper;
      else if (!needed && history[method] === wrapper) history[method] = native;
    }
  };
  window.addEventListener('popstate', update);
  window.addEventListener('pageshow', update);
  document.addEventListener('DOMContentLoaded', update, { once: true });
  window.postMessage({ source: 'local-api-mock', type: 'get-config' }, '*');
})();
