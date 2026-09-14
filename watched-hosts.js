(() => {
  const { normalizeHost, normalizeHosts } = window.ApiMockRules;
  const form = document.querySelector('#watched-form');
  const input = document.querySelector('#watched-input');
  const list = document.querySelector('#watched-list');
  const error = document.querySelector('#watched-error');
  let hosts = [];
  const render = () => {
    document.querySelector('#watched-count').textContent = hosts.length;
    list.replaceChildren();
    for (const host of hosts) {
      const row = document.createElement('li');
      const name = document.createElement('code');
      name.textContent = host;
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'Remove';
      button.setAttribute('aria-label', `Remove ${host}`);
      button.addEventListener('click', () => save(hosts.filter(value => value !== host)));
      row.append(name, button); list.append(row);
    }
  };
  const save = values => chrome.storage.local.set({ watchedHosts: normalizeHosts(values) }, () => {
    if (chrome.runtime.lastError) { error.textContent = chrome.runtime.lastError.message; return; }
    hosts = normalizeHosts(values); error.textContent = ''; render();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const host = normalizeHost(input.value);
    if (!host) { error.textContent = 'Enter an HTTP(S) host or URL, without wildcards or credentials.'; return; }
    save([...hosts, host]); input.value = ''; input.focus();
  });
  chrome.storage.local.get({ watchedHosts: [] }, saved => { hosts = normalizeHosts(saved.watchedHosts); render(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.watchedHosts) { hosts = normalizeHosts(changes.watchedHosts.newValue); render(); }
  });
})();
