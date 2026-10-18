// The page is a client of the same actions an agent uses: everything it does
// is a POST to /api/actions/<name>. No framework; text goes in with textContent.

const $ = (sel, root = document) => root.querySelector(sel)

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

class SignedOut extends Error {}

async function act(name, args = {}) {
  const res = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (res.status === 401) throw new SignedOut()
  const body = await res.json()
  if (!body.ok) throw new Error(body.error)
  return body
}

const when = iso => {
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

const agentTag = kind => kind === 'agent' ? h('span', { class: 'tag' }, 'agent') : null

let people = []
let open = null // the item number in the dialog

function say(text) { $('#status').textContent = text }

// One line per change, the why underneath. The same shape in Lately and in an item's history.
const change = e => h('li', {},
  h('span', {}, e.by, agentTag(e.by_kind), ': ', e.summary),
  e.why ? h('span', { class: 'why' }, e.why) : null,
  h('span', { class: 'when' }, when(e.at)))

async function refresh() {
  const [work, asks, lately] = await Promise.all([act('list_work'), act('list_asks'), act('recent_activity', { limit: 15 })])

  for (const section of document.querySelectorAll('.board section')) {
    const items = work.items.filter(i => i.status === section.dataset.status)
    $('.n', section).textContent = items.length ? String(items.length) : ''
    $('ul', section).replaceChildren(...items.map(i => h('li', {},
      h('button', { type: 'button', class: 'card', onclick: () => show(i.id) },
        h('span', { class: 'm' }, `#${i.id}`),
        h('span', { class: 't' }, i.title),
        h('span', { class: 'm' }, [i.owner_name ?? 'Nobody', i.due ? `due ${i.due}` : ''].filter(Boolean).join(' · '))))))
  }

  // Quiet when there's nothing to decide: the section only shows when something is waiting.
  $('#asks').hidden = !asks.asks.length
  $('#asks ul').replaceChildren(...asks.asks.map(a => h('li', {},
    h('p', {}, h('strong', {}, a.summary), h('br'), `${a.asked_by}: ${a.why}`),
    h('button', { type: 'button', class: 'primary', onclick: () => decide(a.id, 'approve') }, 'Approve'),
    h('button', { type: 'button', onclick: () => decide(a.id, 'decline') }, 'Decline'))))

  $('#lately').replaceChildren(...lately.events.map(change))
}

async function decide(ask, decision) {
  try { say((await act('decide_ask', { ask, decision })).message) } catch (err) { fail(err) }
  await refresh().catch(fail)
}

async function show(id) {
  open = id
  const dialog = $('#item')
  $('.error', dialog).textContent = ''
  $('#why').value = ''
  const { item, history } = await act('get_item', { item: id })
  $('.key', dialog).textContent = `#${item.id} · added ${when(item.created_at)}`
  $('.title', dialog).value = item.title
  $('.notes', dialog).value = item.notes
  $('.f-status', dialog).textContent = item.status
  $('.f-due', dialog).textContent = item.due ?? 'None'
  $('.f-owner', dialog).replaceChildren(
    h('option', { value: 'nobody' }, 'Nobody'),
    ...people.map(p => h('option', { value: p.id, selected: p.id === item.owner }, p.kind === 'agent' ? `${p.name} (agent)` : p.name)))
  for (const b of dialog.querySelectorAll('[data-move],[data-close]')) {
    b.setAttribute('aria-pressed', String((b.dataset.move ?? b.dataset.close) === item.status))
  }
  $('.history', dialog).replaceChildren(...history.map(change))
  if (!dialog.open) dialog.showModal()
}

async function run(name, args) {
  const dialog = $('#item')
  try {
    const why = $('#why').value.trim()
    const r = await act(name, { item: open, ...args, ...(why && name !== 'comment' ? { why } : {}) })
    say(r.message)
    await Promise.all([show(open), refresh()])
    return true
  } catch (err) {
    if (err instanceof SignedOut) return signedOut()
    $('.error', dialog).textContent = err.message
    return false
  }
}

function fail(err) {
  if (err instanceof SignedOut) return signedOut()
  say(err.message)
}

function signedOut() {
  $('#app').hidden = true
  $('#me').hidden = true
  $('#sign-in').hidden = false
  $('#item').close()
}

async function start() {
  const res = await fetch('/api/me')
  if (!res.ok) return signedOut()
  const { you } = await res.json()
  $('#me-name').textContent = you.name
  $('#me').hidden = false
  $('#sign-in').hidden = true
  $('#app').hidden = false
  people = (await act('list_people')).people
  await refresh()
}

$('#sign-in').addEventListener('submit', async e => {
  e.preventDefault()
  const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: $('#token').value }) })
  const body = await res.json()
  if (!body.ok) { $('#sign-in .error').textContent = body.error; return }
  $('#token').value = ''
  await start().catch(fail)
})

$('#sign-out').addEventListener('click', async () => {
  await fetch('/api/session', { method: 'DELETE' })
  signedOut()
})

$('#add').addEventListener('submit', async e => {
  e.preventDefault()
  const input = $('#add-title')
  try {
    say((await act('add_item', { title: input.value })).message)
    input.value = ''
    await refresh()
  } catch (err) { fail(err) }
})

for (const b of document.querySelectorAll('[data-move]')) b.addEventListener('click', () => run('move_item', { to: b.dataset.move }))
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => run('close_item', { as: b.dataset.close }))
$('#item .f-owner').addEventListener('change', e => run('assign_item', { to: e.target.value }))
$('#item .title').addEventListener('change', e => run('edit_item', { title: e.target.value }))
$('#item .notes').addEventListener('change', e => run('edit_item', { notes: e.target.value }))
$('#item .comment').addEventListener('submit', async e => {
  e.preventDefault()
  if (await run('comment', { text: $('#comment').value })) $('#comment').value = ''
})

// Ambient, not pushy: catch up when someone comes back to the tab, and once a minute while it's open.
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app').hidden) refresh().catch(fail) })
setInterval(() => { if (!document.hidden && !$('#app').hidden) refresh().catch(fail) }, 60_000)

start().catch(fail)
