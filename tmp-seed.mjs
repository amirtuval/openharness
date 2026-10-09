import { credentialUpsert, sealCredential } from '@openharness/server'
import { createPostgresCredentialStore } from '@openharness/session/postgres'
import { createVault, envKeyProvider } from '@openharness/vault'
import pg from 'pg'

const url = process.env.DATABASE_URL
const vault = createVault(envKeyProvider(process.env.OPENHARNESS_SECRETS_KEY))
const pool = new pg.Pool({ connectionString: url })
const { rows } = await pool.query('select id from "user" limit 1')
const userId = rows[0].id
const store = createPostgresCredentialStore({ connectionString: url })

const bodies = [
  { name: 'azure', body: { type: 'azure_openai', endpoint: 'https://my-resource.openai.azure.com', api_key: 'az-secret-4242', deployments: ['gpt-4o', 'gpt-4o-mini'] } },
  { name: 'custom', body: { type: 'openai_compatible', base_url: 'http://127.0.0.1:11434/v1', api_key: 'custom-secret-7777' } },
  { name: 'bedrock-us', body: { type: 'bedrock', access_key_id: 'AKIAIOSFODNN7EXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-2' } },
]

for (const { name, body } of bodies) {
  const sealed = await sealCredential(vault, { userId, name, body })
  const stored = await store.upsert(
    credentialUpsert({ userId, name, body }, sealed, new Date().toISOString()),
  )
  console.log('seeded', stored.name, stored.type, JSON.stringify(stored.details ?? null), 'last4', stored.last4)
}
await pool.end()
