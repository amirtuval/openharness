import { readFileSync } from 'node:fs'

import { credentialUpsert, sealCredential } from '@openharness/server'
import { createPostgresCredentialStore } from '@openharness/session/postgres'
import { createVault, envKeyProvider } from '@openharness/vault'
import { Pool } from 'pg'

const url = 'postgres://openharness:openharness@localhost:5432/openharness'
const key = readFileSync('/tmp/oh-secrets-key', 'utf8').trim()
const pool = new Pool({ connectionString: url })
const { rows } = await pool.query('select id from "user" where email = $1', [
  'dev@localhost.localdomain',
])
if (rows.length === 0) {
  throw new Error('no dev user yet — sign in through the web app first')
}
const userId = rows[0].id
const vault = createVault(envKeyProvider(key))
const store = createPostgresCredentialStore({ connectionString: url })
const seeded = [
  ['azure', 'az-key-00004242', ['gpt-4o', 'my-private-deployment']],
  ['azure-eu', 'az-eu-00007777', ['gpt-4o-mini']],
]
for (const [name, apiKey, deployments] of seeded) {
  const body = {
    type: 'azure_openai',
    endpoint: 'https://my-resource.openai.azure.com',
    api_key: apiKey,
    deployments,
  }
  const sealed = await sealCredential(vault, { userId, name, body })
  await store.upsert(credentialUpsert({ userId, name, body }, sealed, new Date().toISOString()))
}
await store.close()
await pool.end()
console.log(`seeded ${seeded.length} azure credentials for ${userId}`)
