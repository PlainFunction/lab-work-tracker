import { z } from 'zod'

// The whole tracker is this list of actions. The web page, the HTTP API and
// MCP all call perform(), so a person and an agent can do exactly the same
// things, except where an action says otherwise.

export interface Actor { id: string; name: string; kind: 'person' | 'agent' }
export interface Ctx { db: D1Database; actor: Actor; now: Date }
/** Every result starts with one plain line saying what happened. */
export type Result = { message: string } & Record<string, unknown>

export class ActionError extends Error {
  readonly status: 400 | 403 | 404 | 409
  constructor(status: 400 | 403 | 404 | 409, message: string) { super(message); this.status = status }
}

interface Action<S extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  /** False for actions that only read. Agents must give a why for anything else. */
  changes: boolean
  /** What happens when an agent calls it. Default: it runs. */
  agents?: 'run' | 'ask' | 'never'
  input: S
  /** For an ask: the line a person sees before they approve. */
  ask?: (args: z.infer<S>, ctx: Ctx) => Promise<string>
  run: (args: z.infer<S>, ctx: Ctx) => Promise<Result>
}

const action = <S extends z.ZodObject>(a: Action<S>) => a as unknown as Action

const OPEN = ['todo', 'doing', 'blocked'] as const
const CLOSED = ['done', 'dropped'] as const

const itemId = z.number().int().positive().describe('The item number, e.g. 12 for #12')
const why = z.string().trim().min(1).max(500).optional()
  .describe('Why you are making this change. Required from agents; it is shown in the history.')

interface ItemRow {
  id: number; title: string; notes: string; status: string; owner: string | null; owner_name: string | null
  due: string | null; created_by: string; created_at: string; updated_at: string
}

const ITEM = `SELECT i.*, a.name AS owner_name FROM items i LEFT JOIN actors a ON a.id = i.owner`

async function load(db: D1Database, id: number): Promise<ItemRow> {
  const item = await db.prepare(`${ITEM} WHERE i.id = ?`).bind(id).first<ItemRow>()
  if (!item) throw new ActionError(404, `There's no item #${id}.`)
  return item
}

async function actor(db: D1Database, id: string): Promise<Actor> {
  const a = await db.prepare('SELECT id, name, kind FROM actors WHERE id = ?').bind(id).first<Actor>()
  if (!a) throw new ActionError(404, `There's nobody with the id "${id}". list_people has everyone.`)
  return a
}

const event = (ctx: Ctx, itemId: number | null, action: string, summary: string, why?: string) =>
  ctx.db.prepare('INSERT INTO events (item_id, actor_id, action, summary, why, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(itemId, ctx.actor.id, action, summary, why ?? null, ctx.now.toISOString())

/** Changes an item and records it, in one batch, then returns the item as it is now. */
async function change(ctx: Ctx, id: number, set: Record<string, unknown>, act: string, summary: string, reason?: string): Promise<Result> {
  const cols = [...Object.keys(set).map(c => `${c} = ?`), 'updated_at = ?']
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE items SET ${cols.join(', ')} WHERE id = ?`)
      .bind(...Object.values(set), ctx.now.toISOString(), id),
    event(ctx, id, act, summary, reason),
  ])
  return { message: summary, item: await load(ctx.db, id) }
}

export const ACTIONS: Action[] = [
  action({
    name: 'list_work',
    description: 'List items. By default the open ones (todo, doing, blocked), most recently changed first.',
    changes: false,
    input: z.strictObject({
      status: z.enum(['open', 'closed', 'all', ...OPEN, ...CLOSED]).default('open'),
      owner: z.string().optional().describe('An actor id from list_people, "me", or "nobody"'),
      search: z.string().trim().min(1).max(100).optional().describe('Words in the title or notes'),
    }),
    async run({ status, owner, search }, ctx) {
      const where: string[] = []
      const binds: unknown[] = []
      const statuses = status === 'open' ? OPEN : status === 'closed' ? CLOSED : status === 'all' ? null : [status]
      if (statuses) { where.push(`i.status IN (${statuses.map(() => '?').join(', ')})`); binds.push(...statuses) }
      if (owner === 'nobody') where.push('i.owner IS NULL')
      else if (owner) { where.push('i.owner = ?'); binds.push(owner === 'me' ? ctx.actor.id : owner) }
      if (search) { where.push("(i.title LIKE ? ESCAPE '\\' OR i.notes LIKE ? ESCAPE '\\')"); const s = `%${search.replace(/[\\%_]/g, '\\$&')}%`; binds.push(s, s) }
      const sql = `${ITEM}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY i.updated_at DESC LIMIT 200`
      const { results } = await ctx.db.prepare(sql).bind(...binds).all<ItemRow>()
      return { message: `${results.length} item${results.length === 1 ? '' : 's'}`, items: results.map(({ notes: _, ...i }) => i) }
    },
  }),

  action({
    name: 'get_item',
    description: 'One item with its notes, its full history and anything waiting on a person.',
    changes: false,
    input: z.strictObject({ item: itemId }),
    async run({ item: id }, ctx) {
      const item = await load(ctx.db, id)
      const [history, asks] = await Promise.all([
        ctx.db.prepare('SELECT e.action, e.summary, e.why, e.at, a.name AS by, a.kind AS by_kind FROM events e JOIN actors a ON a.id = e.actor_id WHERE e.item_id = ? ORDER BY e.id').bind(id).all(),
        ctx.db.prepare("SELECT id, summary, why, asked_at FROM asks WHERE item_id = ? AND state = 'waiting' ORDER BY id").bind(id).all(),
      ])
      return { message: `#${id} ${item.title}`, item, history: history.results, waiting: asks.results }
    },
  }),

  action({
    name: 'add_item',
    description: 'Add a piece of work. It starts as todo.',
    changes: true,
    input: z.strictObject({
      title: z.string().trim().min(1).max(200),
      notes: z.string().trim().max(10_000).optional(),
      owner: z.string().optional().describe('An actor id from list_people, or "me"'),
      due: z.iso.date().optional().describe('YYYY-MM-DD'),
      why,
    }),
    async run({ title, notes, owner, due, why: reason }, ctx) {
      const ownerId = owner ? (owner === 'me' ? ctx.actor.id : (await actor(ctx.db, owner)).id) : null
      const now = ctx.now.toISOString()
      // One batch is one transaction, so the event can use the new item's id.
      const [inserted] = await ctx.db.batch<{ id: number }>([
        ctx.db.prepare('INSERT INTO items (title, notes, owner, due, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
          .bind(title, notes ?? '', ownerId, due ?? null, ctx.actor.id, now, now),
        ctx.db.prepare("INSERT INTO events (item_id, actor_id, action, summary, why, at) VALUES (last_insert_rowid(), ?, 'add_item', 'Added #' || last_insert_rowid() || ' ' || ?, ?, ?)")
          .bind(ctx.actor.id, title, reason ?? null, now),
      ])
      const id = inserted.results[0].id
      return { message: `Added #${id} ${title}`, item: await load(ctx.db, id) }
    },
  }),

  action({
    name: 'edit_item',
    description: "Change an item's title, notes or due date. Give only what changes.",
    changes: true,
    input: z.strictObject({
      item: itemId,
      title: z.string().trim().min(1).max(200).optional(),
      notes: z.string().trim().max(10_000).optional(),
      due: z.iso.date().nullable().optional().describe('YYYY-MM-DD, or null to clear it'),
      why,
    }),
    async run({ item: id, why: reason, ...fields }, ctx) {
      await load(ctx.db, id)
      const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
      if (!Object.keys(set).length) throw new ActionError(400, `Nothing changed on #${id}: give a title, notes or due date.`)
      return change(ctx, id, set, 'edit_item', `Changed the ${Object.keys(set).join(', ')} on #${id}`, reason)
    },
  }),

  action({
    name: 'move_item',
    description: 'Move an item to todo, doing or blocked. Moving a closed item reopens it. Blocked needs a why: what it is waiting on.',
    changes: true,
    input: z.strictObject({ item: itemId, to: z.enum(OPEN), why }),
    async run({ item: id, to, why: reason }, ctx) {
      const item = await load(ctx.db, id)
      if (item.status === to) throw new ActionError(409, `Nothing changed: #${id} is already ${to}.`)
      if (to === 'blocked' && !reason) throw new ActionError(400, `#${id} wasn't moved: say what it's waiting on in why.`)
      const verb = (CLOSED as readonly string[]).includes(item.status) ? `Reopened #${id} as ${to}` : `Moved #${id} to ${to}`
      return change(ctx, id, { status: to }, 'move_item', verb, reason)
    },
  }),

  action({
    name: 'assign_item',
    description: 'Give an item to someone (an actor id from list_people, or "me"), or to nobody.',
    changes: true,
    input: z.strictObject({ item: itemId, to: z.string().describe('An actor id, "me", or "nobody"'), why }),
    async run({ item: id, to, why: reason }, ctx) {
      await load(ctx.db, id)
      const who = to === 'nobody' ? null : to === 'me' ? ctx.actor : await actor(ctx.db, to)
      return change(ctx, id, { owner: who?.id ?? null }, 'assign_item', who ? `Gave #${id} to ${who.name}` : `Took #${id} off everyone`, reason)
    },
  }),

  action({
    name: 'comment',
    description: "Add a comment to an item's history. The comment is its own why.",
    changes: true,
    input: z.strictObject({ item: itemId, text: z.string().trim().min(1).max(5_000) }),
    async run({ item: id, text }, ctx) {
      await load(ctx.db, id)
      return change(ctx, id, {}, 'comment', `Commented on #${id}`, text)
    },
  }),

  action({
    name: 'close_item',
    description: 'Close an item as done or dropped. Only people close work: when an agent calls this, it asks a person instead, and nothing changes until they approve.',
    changes: true,
    agents: 'ask',
    input: z.strictObject({ item: itemId, as: z.enum(CLOSED), why }),
    async ask({ item: id, as }, ctx) {
      const item = await load(ctx.db, id)
      if (item.status === as) throw new ActionError(409, `Nothing was asked: #${id} is already ${as}.`)
      return `Close #${id} ${item.title} as ${as}`
    },
    async run({ item: id, as, why: reason }, ctx) {
      const item = await load(ctx.db, id)
      if (item.status === as) throw new ActionError(409, `Nothing changed: #${id} is already ${as}.`)
      return change(ctx, id, { status: as }, 'close_item', `Closed #${id} as ${as}`, reason)
    },
  }),

  action({
    name: 'list_asks',
    description: "Things agents have asked a person to do, still waiting on a decision.",
    changes: false,
    input: z.strictObject({}),
    async run(_, ctx) {
      const { results } = await ctx.db.prepare("SELECT k.id, k.item_id, k.summary, k.why, k.asked_at, a.name AS asked_by FROM asks k JOIN actors a ON a.id = k.asked_by WHERE k.state = 'waiting' ORDER BY k.id").all()
      return { message: results.length ? `${results.length} waiting on a person` : 'Nothing waiting', asks: results }
    },
  }),

  action({
    name: 'decide_ask',
    description: "Approve or decline an agent's ask. Approving runs exactly what was asked. People only.",
    changes: true,
    agents: 'never',
    input: z.strictObject({ ask: z.number().int().positive(), decision: z.enum(['approve', 'decline']), why }),
    async run({ ask: askId, decision, why: reason }, ctx) {
      // Claim it first, so two people tapping at once can't both run it.
      const ask = await ctx.db.prepare("UPDATE asks SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND state = 'waiting' RETURNING *")
        .bind(decision === 'approve' ? 'approved' : 'declined', ctx.actor.id, ctx.now.toISOString(), askId)
        .first<{ item_id: number; action: string; args: string; summary: string; why: string; asked_by: string }>()
      if (!ask) throw new ActionError(409, `Nothing changed: ask ${askId} isn't waiting any more.`)
      const agent = await actor(ctx.db, ask.asked_by)
      if (decision === 'decline') {
        const summary = `Declined ${agent.name}'s ask: ${ask.summary}`
        await event(ctx, ask.item_id, 'decide_ask', summary, reason).run()
        return { message: summary }
      }
      try {
        const done = await find(ask.action).run(JSON.parse(ask.args), ctx)
        return { ...done, message: `${done.message}, as ${agent.name} asked` }
      } catch (err) {
        await ctx.db.prepare("UPDATE asks SET state = 'waiting', decided_by = NULL, decided_at = NULL WHERE id = ?").bind(askId).run()
        throw err
      }
    },
  }),

  action({
    name: 'list_people',
    description: 'Everyone who uses the tracker, people and agents, with the ids to assign work to.',
    changes: false,
    input: z.strictObject({}),
    async run(_, ctx) {
      const { results } = await ctx.db.prepare('SELECT id, name, kind FROM actors ORDER BY kind DESC, name').all<Actor>()
      return { message: `${results.length} people and agents`, you: ctx.actor, people: results }
    },
  }),

  action({
    name: 'recent_activity',
    description: 'What changed lately, newest first, with who did it and why.',
    changes: false,
    input: z.strictObject({
      since: z.iso.datetime().optional().describe('ISO time; only changes after it'),
      limit: z.number().int().min(1).max(200).default(30),
    }),
    async run({ since, limit }, ctx) {
      const { results } = await ctx.db.prepare(`SELECT e.item_id, e.action, e.summary, e.why, e.at, a.name AS by, a.kind AS by_kind FROM events e JOIN actors a ON a.id = e.actor_id ${since ? 'WHERE e.at > ?' : ''} ORDER BY e.id DESC LIMIT ?`)
        .bind(...(since ? [since, limit] : [limit])).all()
      return { message: `${results.length} change${results.length === 1 ? '' : 's'}`, events: results }
    },
  }),
]

function find(name: string): Action {
  const a = ACTIONS.find(x => x.name === name)
  if (!a) throw new ActionError(404, `There's no action called "${name}". These exist: ${ACTIONS.map(x => x.name).join(', ')}.`)
  return a
}

/** What a client needs to call each action: the JSON Schema of its input, and the rules. */
export const describeActions = () => ACTIONS.map(a => ({
  name: a.name,
  description: a.description,
  changes: a.changes,
  agents: a.agents ?? 'run',
  input: inputSchema(a),
}))

export function inputSchema(a: Action): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(a.input, { io: 'input' }) as Record<string, unknown>
  return schema
}

/** Runs an action as an actor. The rules for agents live here, so every way in gets them. */
export async function perform(name: string, raw: unknown, ctx: Ctx): Promise<Result> {
  const a = find(name)
  const parsed = a.input.safeParse(raw ?? {})
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
    throw new ActionError(400, `Nothing changed. ${problems}`)
  }
  const args = parsed.data as Record<string, unknown>
  if (ctx.actor.kind === 'agent') {
    if (a.agents === 'never') throw new ActionError(403, `Nothing changed: ${a.name} is for people only.`)
    if (a.changes && a.name !== 'comment' && !args.why) throw new ActionError(400, 'Nothing changed: agents give a why with every change, so the history makes sense later.')
    if (a.agents === 'ask') {
      const summary = await a.ask!(args, ctx)
      // Agents retry. Asking twice for the same thing gets the same ask back.
      const same = await ctx.db.prepare("SELECT id FROM asks WHERE item_id = ? AND summary = ? AND state = 'waiting'").bind(args.item, summary).first<{ id: number }>()
      if (same) return { message: `Already waiting on a person to approve: ${summary}. Nothing changes until they do.`, waiting: true, ask: same.id }
      const [row] = await ctx.db.batch<{ id: number }>([
        ctx.db.prepare('INSERT INTO asks (item_id, action, args, summary, why, asked_by, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
          .bind(args.item, a.name, JSON.stringify(args), summary, args.why, ctx.actor.id, ctx.now.toISOString()),
        event(ctx, args.item as number, 'ask', `Asked a person to: ${summary}`, args.why as string),
      ])
      return { message: `Asked a person to approve: ${summary}. Nothing changes until they do.`, waiting: true, ask: row.results[0].id }
    }
  }
  return a.run(args, ctx)
}
