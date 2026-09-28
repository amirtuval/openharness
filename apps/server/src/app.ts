import { Hono } from 'hono'

/**
 * The openharness HTTP app. Only `GET /health` exists today — the chat API belongs to the v1
 * chat epic.
 */
export const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok' }))
