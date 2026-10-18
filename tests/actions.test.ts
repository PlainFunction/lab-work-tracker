import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { ACTIONS } from '../src/actions'
import { call, reset } from './helpers'

const SAM = 'sam-token'
const BOT = 'bot-token'

beforeEach(reset)

describe('actions over the HTTP API', () => {
  it('adds, moves, assigns and comments, and every change lands in the history', async () => {
    const added = await call(SAM, 'add_item', { title: 'Fix the gate latch', due: '2026-10-24' })
    expect(added.status).toBe(200)
    expect(added.body.message).toBe('Added #1 Fix the gate latch')
    expect(added.body.item).toMatchObject({ id: 1, status: 'todo', due: '2026-10-24', created_by: 'sam' })

    await call(SAM, 'move_item', { item: 1, to: 'doing' })
    await call(SAM, 'assign_item', { item: 1, to: 'me' })
    await call(BOT, 'comment', { item: 1, text: 'The supplier has the part in stock.' })

    const { body } = await call(SAM, 'get_item', { item: 1 })
    expect(body.item).toMatchObject({ status: 'doing', owner: 'sam', owner_name: 'Sam' })
    expect(body.history.map((e: { summary: string; by: string }) => `${e.by}: ${e.summary}`)).toEqual([
      'Sam: Added #1 Fix the gate latch',
      'Sam: Moved #1 to doing',
      'Sam: Gave #1 to Sam',
      'Triage bot: Commented on #1',
    ])
    expect(body.history[3]).toMatchObject({ by_kind: 'agent', why: 'The supplier has the part in stock.' })
  })

  it('lists open work by default, and filters by owner and words', async () => {
    await call(SAM, 'add_item', { title: 'Quote for the Smiths', owner: 'triage-bot', why: 'x' })
    await call(SAM, 'add_item', { title: 'Order 50mm pipe' })
    await call(SAM, 'add_item', { title: 'Old job' })
    await call(SAM, 'close_item', { item: 3, as: 'dropped' })

    expect((await call(SAM, 'list_work')).body.items.map((i: { id: number }) => i.id).sort()).toEqual([1, 2])
    expect((await call(SAM, 'list_work', { status: 'closed' })).body.items).toHaveLength(1)
    expect((await call(BOT, 'list_work', { owner: 'me' })).body.items.map((i: { title: string }) => i.title)).toEqual(['Quote for the Smiths'])
    expect((await call(SAM, 'list_work', { owner: 'nobody' })).body.items.map((i: { id: number }) => i.id)).toEqual([2])
    expect((await call(SAM, 'list_work', { search: 'pipe' })).body.items).toHaveLength(1)
    // LIKE wildcards in a search are just characters.
    expect((await call(SAM, 'list_work', { search: '%' })).body.items).toHaveLength(0)
  })

  it('says what was wrong, and that nothing changed', async () => {
    expect((await call(SAM, 'add_item', {})).body.error).toMatch(/^Nothing changed\. title:/)
    expect((await call(SAM, 'add_item', { titel: 'typo' })).body.error).toMatch(/titel/)
    expect((await call(SAM, 'move_item', { item: 9, to: 'doing' }))).toMatchObject({ status: 404, body: { error: "There's no item #9." } })
    expect((await call(SAM, 'nope')).status).toBe(404)
    expect((await call(SAM, 'nope')).body.error).toContain('list_work')
    await call(SAM, 'add_item', { title: 'A' })
    expect((await call(SAM, 'move_item', { item: 1, to: 'todo' })).status).toBe(409)
    expect((await call(SAM, 'move_item', { item: 1, to: 'blocked' })).body.error).toMatch(/waiting on/)
    expect((await call(SAM, 'edit_item', { item: 1 })).status).toBe(400)
    expect((await call(SAM, 'assign_item', { item: 1, to: 'ghost' })).status).toBe(404)
  })

  it('reopens a closed item when it is moved', async () => {
    await call(SAM, 'add_item', { title: 'A' })
    await call(SAM, 'close_item', { item: 1, as: 'done' })
    expect((await call(SAM, 'move_item', { item: 1, to: 'todo', why: 'The tap still drips' })).body.message).toBe('Reopened #1 as todo')
  })

  it('edits only the fields given', async () => {
    await call(SAM, 'add_item', { title: 'A', notes: 'keep', due: '2026-11-01' })
    const { body } = await call(SAM, 'edit_item', { item: 1, title: 'B', due: null })
    expect(body.message).toBe('Changed the title, due on #1')
    expect(body.item).toMatchObject({ title: 'B', notes: 'keep', due: null })
  })
})

describe('the rules for agents', () => {
  it('needs a why for every change from an agent, and none for reads', async () => {
    const r = await call(BOT, 'add_item', { title: 'Chase the Nguyen invoice' })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/^Nothing changed: agents give a why/)
    expect((await call(BOT, 'list_work')).status).toBe(200)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM items').first('n')).toBe(0)
    expect((await call(BOT, 'add_item', { title: 'Chase the Nguyen invoice', why: 'Unpaid 30 days' })).status).toBe(200)
  })

  it("turns an agent's close into an ask, and a person's approval runs exactly that", async () => {
    await call(SAM, 'add_item', { title: 'Send the Smiths their quote' })
    const asked = await call(BOT, 'close_item', { item: 1, as: 'done', why: 'The quote went out at 9:02, see the sent folder' })
    expect(asked.body).toMatchObject({ waiting: true, ask: 1, message: 'Asked a person to approve: Close #1 Send the Smiths their quote as done. Nothing changes until they do.' })
    expect((await call(SAM, 'get_item', { item: 1 })).body.item.status).toBe('todo')

    // Asking again gets the same ask, not a second one.
    expect((await call(BOT, 'close_item', { item: 1, as: 'done', why: 'retry' })).body).toMatchObject({ ask: 1, message: expect.stringMatching(/^Already waiting/) })

    const asks = (await call(SAM, 'list_asks')).body.asks
    expect(asks).toEqual([expect.objectContaining({ id: 1, item_id: 1, asked_by: 'Triage bot', summary: 'Close #1 Send the Smiths their quote as done' })])

    const approved = await call(SAM, 'decide_ask', { ask: 1, decision: 'approve' })
    expect(approved.body.message).toBe('Closed #1 as done, as Triage bot asked')
    expect(approved.body.item.status).toBe('done')
    const history = (await call(SAM, 'get_item', { item: 1 })).body.history
    expect(history.slice(-2)).toEqual([
      expect.objectContaining({ by: 'Triage bot', summary: 'Asked a person to: Close #1 Send the Smiths their quote as done' }),
      expect.objectContaining({ by: 'Sam', summary: 'Closed #1 as done', why: 'The quote went out at 9:02, see the sent folder' }),
    ])
    expect((await call(SAM, 'decide_ask', { ask: 1, decision: 'approve' })).status).toBe(409)
  })

  it('lets a person decline, and nothing changes', async () => {
    await call(SAM, 'add_item', { title: 'A' })
    await call(BOT, 'close_item', { item: 1, as: 'dropped', why: 'Looks stale' })
    expect((await call(SAM, 'decide_ask', { ask: 1, decision: 'decline', why: 'Still needed' })).body.message).toBe("Declined Triage bot's ask: Close #1 A as dropped")
    expect((await call(SAM, 'get_item', { item: 1 })).body.item.status).toBe('todo')
    expect((await call(SAM, 'list_asks')).body.asks).toEqual([])
  })

  it('puts an ask back if approving it fails, so it can still be declined', async () => {
    await call(SAM, 'add_item', { title: 'A' })
    await call(BOT, 'close_item', { item: 1, as: 'done', why: 'Finished' })
    await call(SAM, 'close_item', { item: 1, as: 'done' })
    expect((await call(SAM, 'decide_ask', { ask: 1, decision: 'approve' })).body.error).toBe('Nothing changed: #1 is already done.')
    expect((await call(SAM, 'list_asks')).body.asks).toHaveLength(1)
  })

  it("doesn't let an agent decide asks", async () => {
    await call(SAM, 'add_item', { title: 'A' })
    await call(BOT, 'close_item', { item: 1, as: 'done', why: 'Finished' })
    const r = await call(BOT, 'decide_ask', { ask: 1, decision: 'approve', why: 'I am sure' })
    expect(r).toMatchObject({ status: 403, body: { error: 'Nothing changed: decide_ask is for people only.' } })
  })

  it('lets people close work straight away', async () => {
    await call(SAM, 'add_item', { title: 'A' })
    expect((await call(SAM, 'close_item', { item: 1, as: 'done' })).body.item.status).toBe('done')
  })
})

it('has an input schema an agent can read for every action', () => {
  for (const a of ACTIONS) expect(a.description.length, a.name).toBeGreaterThan(20)
  expect(ACTIONS.map(a => a.name)).toEqual([
    'list_work', 'get_item', 'add_item', 'edit_item', 'move_item', 'assign_item', 'comment',
    'close_item', 'list_asks', 'decide_ask', 'list_people', 'recent_activity',
  ])
})
