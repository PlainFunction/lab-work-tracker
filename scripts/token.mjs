// Gives a person or an agent a token, and prints it once. Only its hash is stored.
// Running it again for the same id replaces the token, so the old one stops working.
//
//   npm run token -- --name "Sam" --kind person
//   npm run token -- --name "Triage bot" --kind agent --remote
//   npm run token -- --name "Triage bot" --kind agent --actions list_work,comment --days 30 --remote
//   npm run token -- --revoke triage-bot --remote
//
// A person's token works for a year, an agent's for 90 days, unless --days says otherwise.
// --actions limits an agent to those actions (comma separated); without it, it gets every
// action open to agents.

import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    kind: { type: 'string', default: 'person' },
    id: { type: 'string' },
    revoke: { type: 'string' },
    days: { type: 'string' },
    actions: { type: 'string' },
    remote: { type: 'boolean', default: false },
  },
})

const sql = s => `'${String(s).replaceAll("'", "''")}'`
const hash = t => createHash('sha256').update(t).digest('hex')

let statement
let token
let expires
if (values.revoke) {
  // People's history stays, so the row stays. Its token becomes a hash nobody has.
  statement = `UPDATE actors SET token_hash = ${sql(`revoked:${randomBytes(16).toString('hex')}`)} WHERE id = ${sql(values.revoke)};`
} else {
  if (!values.name) { console.error('Give a --name, e.g. --name "Sam"'); process.exit(1) }
  if (!['person', 'agent'].includes(values.kind)) { console.error('--kind is person or agent'); process.exit(1) }
  const days = values.days === undefined ? (values.kind === 'agent' ? 90 : 365) : Number(values.days)
  if (!Number.isInteger(days) || days < 1) { console.error('--days is a whole number of days, 1 or more'); process.exit(1) }
  if (values.actions && values.kind !== 'agent') { console.error('--actions is for agents; people can do everything'); process.exit(1) }
  const actions = values.actions ? JSON.stringify(values.actions.split(',').map(a => a.trim()).filter(Boolean)) : null
  expires = new Date(Date.now() + days * 86_400_000).toISOString()
  const id = values.id ?? values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  token = `wt_${randomBytes(32).toString('base64url')}`
  statement = `INSERT INTO actors (id, name, kind, token_hash, created_at) VALUES (${sql(id)}, ${sql(values.name)}, ${sql(values.kind)}, ${sql(hash(token))}, ${sql(new Date().toISOString())})
ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, token_hash = excluded.token_hash;
INSERT INTO token_limits (id, expires_at, actions) VALUES (${sql(id)}, ${sql(expires)}, ${actions === null ? 'NULL' : sql(actions)})
ON CONFLICT (id) DO UPDATE SET expires_at = excluded.expires_at, actions = excluded.actions;`
}

const dir = mkdtempSync(join(tmpdir(), 'work-tracker-'))
const file = join(dir, 'token.sql')
writeFileSync(file, statement)
// One command string: npx is a .cmd on Windows, which Node only runs through a shell,
// and passing an args array with shell: true is deprecated. Nothing here comes from the command line.
const where = values.remote ? '--remote' : '--local'
const run = spawnSync(`npx wrangler d1 execute work-tracker ${where} --config wrangler.toml --file "${file}"`, { stdio: ['ignore', 'ignore', 'inherit'], shell: true })
rmSync(dir, { recursive: true, force: true })
if (run.status !== 0) { console.error('wrangler d1 execute failed, so nothing was saved.'); process.exit(1) }

if (values.revoke) console.log(`Revoked ${values.revoke}'s token.`)
else console.log(`Token for ${values.name} (${values.kind}). It isn't stored anywhere, so copy it now:\n\n  ${token}\n\nIt works until ${expires.slice(0, 10)}. Run this again for the same name to give a new one.\n`)
