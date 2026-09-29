import {
  QA_MODEL,
  createAgent,
  createSession,
  distanceFromBottom,
  expect,
  isRealModel,
  openChat,
  sendFromComposer,
  shot,
  status,
  test,
  transcript,
  uniqueName,
  waitForAnswer,
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
      model: QA_MODEL,
      system: 'Answer briefly.',
    })
    const session = await createSession(request, agent.id)
    await openChat(page, session.id)

    // The mock echoes each prompt, which shows the turns landed in order but says nothing
    // about the session holding a conversation. Against a real provider the same three turns
    // carry a fact across them, which is the thing multi-turn is for.
    const turns = isRealModel
      ? [
          'Remember the word PLATYPUS. Reply with just: ok',
          'What word did I ask you to remember? Reply with just that word.',
          'Say that word once more, nothing else.',
        ]
      : ['turn one', 'turn two', 'turn three']
    for (const turn of turns) {
      await sendFromComposer(page, turn)
      await waitForAnswer(page, turn)
      await expect(status(page)).toHaveAttribute('aria-label', 'Status: Idle')
      expect(await distanceFromBottom(page), `view followed "${turn}"`).toBeLessThan(48)
    }

    const seen = await transcript(page)
    const roles = seen.map((entry) => entry.split(':')[0])
    expect(roles).toEqual(['user', 'agent', 'user', 'agent', 'user', 'agent'])

    const texts = seen.map((entry) => entry.slice(entry.indexOf(':') + 1))
    if (isRealModel) {
      // The first turn only plants the word; what is being checked is that the two turns
      // after it come back with it, which they can only do from the conversation so far.
      expect(texts[3]!.toLowerCase(), 'the model remembered the word a turn later').toContain(
        'platypus',
      )
      expect(texts[5]!.toLowerCase(), 'and still had it two turns later').toContain('platypus')
    } else {
      expect(texts[0]).toContain('turn one')
      expect(texts[1]).toContain('turn one')
      expect(texts[2]).toContain('turn two')
      expect(texts[3]).toContain('turn two')
      expect(texts[4]).toContain('turn three')
      expect(texts[5]).toContain('turn three')
    }

    await shot(page, 'w3-01-three-turns')
    expect(consoleErrors, consoleErrors.join('\n')).toEqual([])
  })
})
