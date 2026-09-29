import {
  createAgent,
  createSession,
  distanceFromBottom,
  expect,
  openChat,
  sendFromComposer,
  shot,
  status,
  test,
  transcript,
  uniqueName,
} from './support'

/** W3 — three turns: the history is complete, in order, and the view follows it down. */
test.describe('W3 multi-turn', () => {
  test('W3 three turns accumulate in order and the view follows', async ({
    page,
    request,
    consoleErrors,
  }) => {
    const agent = await createAgent(request, {
      name: uniqueName('QA W3'),
      model: 'anthropic/claude-sonnet-5',
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    const turns = ['turn one', 'turn two', 'turn three']
    for (const turn of turns) {
      await sendFromComposer(page, turn)
      await expect(page.locator('article[data-role="agent"]').last()).toContainText(turn)
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      expect(await distanceFromBottom(page), `view followed "${turn}"`).toBeLessThan(48)
    }

    const seen = await transcript(page)
    const roles = seen.map((entry) => entry.split(':')[0])
    expect(roles).toEqual(['user', 'agent', 'user', 'agent', 'user', 'agent'])

    const texts = seen.map((entry) => entry.slice(entry.indexOf(':') + 1))
    expect(texts[0]).toContain('turn one')
    expect(texts[1]).toContain('turn one')
    expect(texts[2]).toContain('turn two')
    expect(texts[3]).toContain('turn two')
    expect(texts[4]).toContain('turn three')
    expect(texts[5]).toContain('turn three')

    await shot(page, 'w3-01-three-turns')
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
