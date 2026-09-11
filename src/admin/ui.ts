// One server-rendered file, plain DOM, no build step: a self-hosted relay should
// not need a toolchain to show its own admin page.
export function adminHtml(): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>relay admin</title>
<style>
  :root { color-scheme: light dark; --line: #8883; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 940px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  nav { display: flex; gap: 8px; margin-bottom: 16px; }
  button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: none; cursor: pointer; }
  button[aria-selected="true"] { border-color: currentColor; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; }
  input, select { font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: none; color: inherit; width: 100%; box-sizing: border-box; }
  form { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; align-items: end; margin-bottom: 12px; }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
  .msg { min-height: 20px; color: #b00; }
  code { font-family: ui-monospace, monospace; }
  @media (max-width: 640px) { table { display: block; overflow-x: auto; } }
</style>
<main>
  <h1>relay admin</h1>
  <div class="row">
    <input id="key" type="password" placeholder="admin key" autocomplete="off">
    <button id="save">Use key</button>
  </div>
  <nav>
    <button data-tab="accounts" aria-selected="true">Accounts</button>
    <button data-tab="upstreams" aria-selected="false">Upstreams</button>
  </nav>
  <p class="msg" id="msg"></p>
  <section id="pane"></section>
</main>
<script>
const state = { tab: 'accounts', accounts: [], upstreams: [], loaded: false }
const key = () => sessionStorage.getItem('relay-admin-key') || ''
const msg = (t) => { document.getElementById('msg').textContent = t || '' }

async function api(path, init) {
  const res = await fetch(path, {
    ...init,
    headers: { 'x-admin-key': key(), 'content-type': 'application/json', ...(init && init.headers) },
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 20)
}

async function load() {
  try {
    const [accounts, upstreams] = await Promise.all([api('/admin/accounts'), api('/admin/upstreams')])
    state.accounts = accounts
    state.upstreams = upstreams
    msg('')
  } catch (e) {
    msg(String(e.message || e))
  }
  // An attempted fetch, success or failure, is what turns an empty list into
  // a real "there are none" - before that, an empty list just means nothing
  // has been asked for yet.
  state.loaded = true
  render()
}

function upstreamOptions(selected) {
  const rows = [{ id: 'direct', name: 'direct (no upstream)' }, ...state.upstreams]
  return rows.map((u) => \`<option value="\${esc(u.id)}"\${u.id === selected ? ' selected' : ''}>\${esc(u.name)}</option>\`).join('')
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function render() {
  const pane = document.getElementById('pane')
  pane.innerHTML = state.tab === 'accounts' ? accountsView() : upstreamsView()
  wire()
}

function accountsView() {
  const rows = state.accounts.map((a) => \`
    <tr>
      <td><code>\${esc(a.username)}</code></td>
      <td>\${esc((state.upstreams.find((u) => u.id === a.upstreamId) || { name: a.upstreamId }).name)}</td>
      <td>\${a.enabled ? 'on' : 'off'}</td>
      <td>\${esc(a.lastSeenAt || 'never')}</td>
      <td>\${esc(a.note || '')}</td>
      <td>
        <button data-copy="\${esc(a.username)}">Copy relay url</button>
        <button data-toggle="\${esc(a.id)}">\${a.enabled ? 'Disable' : 'Enable'}</button>
        <button data-del-account="\${esc(a.id)}">Delete</button>
      </td>
    </tr>\`).join('')
  return \`
    <form id="new-account">
      <label>Username<input name="username" required autocomplete="off"></label>
      <label>Password<input name="password" required autocomplete="off"></label>
      <label>Upstream<select name="upstreamId">\${upstreamOptions('direct')}</select></label>
      <label>Note<input name="note" autocomplete="off"></label>
      <button type="button" id="gen">Generate</button>
      <button type="submit">Add account</button>
    </form>
    <table>
      <thead><tr><th>Username</th><th>Upstream</th><th>Enabled</th><th>Last seen</th><th>Note</th><th></th></tr></thead>
      <tbody>\${rows || (state.loaded ? '<tr><td colspan="6">No accounts yet.</td></tr>' : '<tr><td colspan="6">Enter your admin key above to load accounts.</td></tr>')}</tbody>
    </table>
    <p>Point a client at <code>relay://&lt;username&gt;:&lt;password&gt;@\${location.host}</code>.</p>\`
}

function upstreamsView() {
  const rows = state.upstreams.map((u) => \`
    <tr>
      <td>\${esc(u.name)}</td>
      <td>\${esc(u.protocol)}</td>
      <td>\${esc(u.host || '')}\${u.port ? ':' + u.port : ''}</td>
      <td>\${esc(u.username || '')}</td>
      <td>\${esc(u.note || '')}</td>
      <td><button data-del-upstream="\${esc(u.id)}">Delete</button></td>
    </tr>\`).join('')
  return \`
    <form id="new-upstream">
      <label>Name<input name="name" required autocomplete="off"></label>
      <label>Protocol<select name="protocol"><option>http</option><option>socks5</option><option>direct</option></select></label>
      <label>Host<input name="host" autocomplete="off"></label>
      <label>Port<input name="port" type="number" autocomplete="off"></label>
      <label>Username<input name="username" autocomplete="off"></label>
      <label>Password<input name="password" autocomplete="off"></label>
      <label>Note<input name="note" autocomplete="off"></label>
      <button type="submit">Add upstream</button>
    </form>
    <table>
      <thead><tr><th>Name</th><th>Protocol</th><th>Endpoint</th><th>User</th><th>Note</th><th></th></tr></thead>
      <tbody>\${rows || (state.loaded ? '<tr><td colspan="6">No upstreams yet - accounts fall back to a direct exit.</td></tr>' : '<tr><td colspan="6">Enter your admin key above to load upstreams.</td></tr>')}</tbody>
    </table>\`
}

function formData(form) {
  const out = {}
  for (const [k, v] of new FormData(form)) if (String(v) !== '') out[k] = v
  return out
}

function wire() {
  const account = document.getElementById('new-account')
  if (account) {
    account.onsubmit = async (e) => {
      e.preventDefault()
      try { await api('/admin/accounts', { method: 'POST', body: JSON.stringify(formData(account)) }); await load() }
      catch (err) { msg(String(err.message || err)) }
    }
    document.getElementById('gen').onclick = () => { account.password.value = randomPassword() }
  }
  const upstream = document.getElementById('new-upstream')
  if (upstream) {
    upstream.onsubmit = async (e) => {
      e.preventDefault()
      try { await api('/admin/upstreams', { method: 'POST', body: JSON.stringify(formData(upstream)) }); await load() }
      catch (err) { msg(String(err.message || err)) }
    }
  }
  for (const el of document.querySelectorAll('[data-del-account]')) {
    el.onclick = async () => {
      try { await api('/admin/accounts/' + el.dataset.delAccount, { method: 'DELETE' }); await load() }
      catch (err) { msg(String(err.message || err)) }
    }
  }
  for (const el of document.querySelectorAll('[data-del-upstream]')) {
    el.onclick = async () => {
      try { await api('/admin/upstreams/' + el.dataset.delUpstream, { method: 'DELETE' }); await load() }
      catch (err) { msg(String(err.message || err)) }
    }
  }
  for (const el of document.querySelectorAll('[data-toggle]')) {
    el.onclick = async () => {
      const a = state.accounts.find((x) => x.id === el.dataset.toggle)
      try {
        await api('/admin/accounts', {
          method: 'POST',
          body: JSON.stringify({ id: a.id, username: a.username, upstreamId: a.upstreamId, note: a.note, enabled: !a.enabled }),
        })
        await load()
      } catch (err) { msg(String(err.message || err)) }
    }
  }
  for (const el of document.querySelectorAll('[data-copy]')) {
    el.onclick = () => {
      // The stored password is never sent back, so this is a template the
      // operator completes with the password they set.
      navigator.clipboard.writeText('relay://' + el.dataset.copy + ':<password>@' + location.host)
      msg('Copied - replace <password> with the one you set.')
    }
  }
}

for (const el of document.querySelectorAll('[data-tab]')) {
  el.onclick = () => {
    state.tab = el.dataset.tab
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b === el))
    render()
  }
}
document.getElementById('save').onclick = () => {
  sessionStorage.setItem('relay-admin-key', document.getElementById('key').value)
  load()
}
if (key()) { document.getElementById('key').value = key(); load() } else { render() }
</script>
</html>`
}
