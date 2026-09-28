import { describe, expect, it } from 'vitest'
import { app } from './app'

describe('GET /health', () => {
  it('answers with the health payload', async () => {
    const response = await app.request('/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })
})
