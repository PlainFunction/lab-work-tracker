// Gives a person or an agent a token, and prints it once. Only its hash is stored.
// Running it again for the same id replaces the token, so the old one stops working.
//
//   npm run token -- --name "Sam" --kind person
//   npm run token -- --name "Triage bot" --kind agent --remote
//   npm run token -- --revoke triage-bot --remote

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
    remote: { type: 'boolean', default: false },
  },
})

const sql = s => `'${String(s).replaceAll("'", "''")}'`
const hash = t => createHash('sha256').update(t).digest('hex')

let statement
let token
if (values.revoke) {
  // People's history stays, so the row stays. Its token becomes a hash nobody has.
  statement = `UPDATE actors SET token_hash = ${sql(`revoked:${randomBytes(16).toString('hex')}`)} WHERE id = ${sql(values.revoke)};`
} else {
  if (!values.name) { console.error('Give a --name, e.g. --name "Sam"'); process.exit(1) }
  if (!['person', 'agent'].includes(values.kind)) { console.error('--kind is person or agent'); process.exit(1) }
  const id = values.id ?? values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  token = `wt_${randomBytes(32).toString('base64url')}`
  statement = `INSERT INTO actors (id, name, kind, token_hash, created_at) VALUES (${sql(id)}, ${sql(values.name)}, ${sql(values.kind)}, ${sql(hash(token))}, ${sql(new Date().toISOString())})
ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, token_hash = excluded.token_hash;`
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
else console.log(`Token for ${values.name} (${values.kind}). It isn't stored anywhere, so copy it now:\n\n  ${token}\n`)
