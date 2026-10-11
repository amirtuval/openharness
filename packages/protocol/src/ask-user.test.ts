import { describe, expect, it } from 'vitest'

import {
  ASK_USER_HEADER_MAX_LENGTH,
  AskUserAnswersSchema,
  AskUserInputSchema,
  askUserAnswerProblems,
  askUserInputProblems,
  formatAskUserAnswers,
  parseAskUserInput,
  type AskUserAnswer,
  type AskUserInput,
} from './ask-user'

/** A choice question with two options, a text question and a confirm question. */
const input: AskUserInput = {
  questions: [
    {
      question: 'Which environment should I deploy to?',
      header: 'Environment',
      type: 'choice',
      options: [{ label: 'staging' }, { label: 'production', description: 'the live one' }],
    },
    { question: 'Anything else I should know?', header: 'Notes', type: 'text' },
    { question: 'Shall I ship it?', header: 'Ship', type: 'confirm' },
  ],
}

/** The answers to {@link input}, in order. */
const answers: AskUserAnswer[] = [
  { question: 'Which environment should I deploy to?', labels: ['staging'] },
  { question: 'Anything else I should know?', text: 'the release is on Thursday' },
  { question: 'Shall I ship it?', confirmed: true },
]

describe('the ask_user input', () => {
  it('accepts one to four questions of the three types', () => {
    expect(AskUserInputSchema.safeParse(input).success).toBe(true)
    expect(
      AskUserInputSchema.safeParse({
        questions: [{ question: 'Just one?', header: 'One', type: 'confirm' }],
      }).success,
    ).toBe(true)
    expect(
      AskUserInputSchema.safeParse({
        questions: Array.from({ length: 5 }, (_, index) => ({
          question: `question ${String(index)}`,
          header: `q${String(index)}`,
          type: 'confirm',
        })),
      }).success,
    ).toBe(false)
    expect(AskUserInputSchema.safeParse({ questions: [] }).success).toBe(false)
    expect(AskUserInputSchema.safeParse({ questions: 'none' }).success).toBe(false)
  })

  it('refuses a header longer than twelve characters', () => {
    const header = 'x'.repeat(ASK_USER_HEADER_MAX_LENGTH)
    expect(
      AskUserInputSchema.safeParse({
        questions: [{ question: 'Fits?', header, type: 'confirm' }],
      }).success,
    ).toBe(true)
    expect(
      AskUserInputSchema.safeParse({
        questions: [{ question: 'Does not?', header: `${header}x`, type: 'confirm' }],
      }).success,
    ).toBe(false)
  })

  it('refuses a choice with fewer than two or more than six options', () => {
    const choice = (labels: string[]): unknown => ({
      questions: [
        {
          question: 'Pick',
          header: 'Pick',
          type: 'choice',
          options: labels.map((label) => ({ label })),
        },
      ],
    })
    expect(AskUserInputSchema.safeParse(choice(['a', 'b'])).success).toBe(true)
    expect(AskUserInputSchema.safeParse(choice(['a', 'b', 'c', 'd', 'e', 'f'])).success).toBe(true)
    expect(AskUserInputSchema.safeParse(choice(['a'])).success).toBe(false)
    expect(AskUserInputSchema.safeParse(choice(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).success).toBe(
      false,
    )
  })

  it('refuses an option with an empty label or an empty description', () => {
    const option = (value: { label: string; description?: string }): unknown => ({
      questions: [
        { question: 'Pick', header: 'Pick', type: 'choice', options: [value, { label: 'b' }] },
      ],
    })
    expect(AskUserInputSchema.safeParse(option({ label: '', description: 'x' })).success).toBe(
      false,
    )
    expect(AskUserInputSchema.safeParse(option({ label: 'a', description: '' })).success).toBe(
      false,
    )
  })

  it('refuses two questions a reader could not tell apart', () => {
    const questions = [
      { question: 'Same?', header: 'One', type: 'confirm' },
      { question: 'Same?', header: 'Two', type: 'confirm' },
    ]
    const parsed = AskUserInputSchema.safeParse({ questions })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('distinct')
  })

  it('refuses an unknown question type', () => {
    expect(
      AskUserInputSchema.safeParse({
        questions: [{ question: 'Which?', header: 'Which', type: 'rank' }],
      }).success,
    ).toBe(false)
  })

  it('answers the questions a value asks, or null', () => {
    expect(parseAskUserInput(input)).toEqual(input)
    expect(
      parseAskUserInput({ questions: [{ question: 'Why?', header: 'Why', type: 'nope' }] }),
    ).toBe(null)
    expect(askUserInputProblems({})).toHaveLength(1)
    expect(askUserInputProblems(input)).toEqual([])
  })
})

describe('the ask_user answers', () => {
  it('accepts an answer per question, of the type that question takes', () => {
    expect(askUserAnswerProblems(input, answers)).toEqual([])
    expect(AskUserAnswersSchema.safeParse(answers).success).toBe(true)
  })

  it('requires every question to be answered exactly once', () => {
    expect(askUserAnswerProblems(input, answers.slice(0, 2))).toEqual(['Ship: no answer was given'])
    expect(askUserAnswerProblems(input, [...answers, answers[0] as AskUserAnswer])[0]).toContain(
      'answered more than once',
    )
    expect(
      askUserAnswerProblems(input, [
        ...answers.slice(1),
        { question: 'Who asked this?', confirmed: true },
      ]),
    ).toEqual([
      'Environment: no answer was given',
      '(answers): "Who asked this?" is not a question this call asked',
    ])
  })

  it('checks a choice answer against the options the question offers', () => {
    const answer = (value: Partial<AskUserAnswer>): string[] =>
      askUserAnswerProblems(input, [
        { question: 'Which environment should I deploy to?', ...value },
        ...answers.slice(1),
      ])
    expect(answer({ labels: ['production'] })).toEqual([])
    expect(answer({ labels: ['staging', 'production'] })[0]).toContain('takes one option')
    expect(answer({ labels: ['somewhere else'] })[0]).toContain('is not an option')
    expect(answer({})[0]).toContain('choose an option')
    expect(answer({ text: 'a staging slot of my own' })).toEqual([])
    expect(answer({ labels: ['staging'], text: 'unless the release slips' })).toEqual([])
    expect(answer({ confirmed: true })[0]).toContain('does not answer a choice question')
  })

  it('takes several labels for a multi-select choice, and only then', () => {
    const multi: AskUserInput = {
      questions: [
        {
          question: 'Which suites should run?',
          header: 'Suites',
          type: 'choice',
          multi_select: true,
          options: [{ label: 'unit' }, { label: 'e2e' }],
        },
      ],
    }
    expect(
      askUserAnswerProblems(multi, [
        { question: 'Which suites should run?', labels: ['unit', 'e2e'] },
      ]),
    ).toEqual([])
  })

  it('takes text for a text question and a yes/no for a confirm one, and nothing else', () => {
    const text = askUserAnswerProblems(input, [
      answers[0] as AskUserAnswer,
      { question: 'Anything else I should know?', labels: ['yes'], text: 'sure' },
      answers[2] as AskUserAnswer,
    ])
    expect(text).toEqual(['Notes: a text question has no options to choose from'])
    expect(
      askUserAnswerProblems(input, [
        answers[0] as AskUserAnswer,
        { question: 'Anything else I should know?' },
        answers[2] as AskUserAnswer,
      ]),
    ).toEqual(['Notes: a text question needs `text`'])
    expect(
      askUserAnswerProblems(input, [
        answers[0] as AskUserAnswer,
        answers[1] as AskUserAnswer,
        { question: 'Shall I ship it?', text: 'yes' },
      ]),
    ).toEqual(['Ship: a yes/no question needs `confirmed`'])
    expect(
      askUserAnswerProblems(input, [
        answers[0] as AskUserAnswer,
        answers[1] as AskUserAnswer,
        { question: 'Shall I ship it?', confirmed: false, text: 'no' },
      ]),
    ).toEqual(['Ship: a yes/no answer carries nothing but `confirmed`'])
  })

  it('spells the answers as the lines the model reads', () => {
    expect(formatAskUserAnswers(input, answers)).toBe(
      [
        'Which environment should I deploy to?: staging',
        'Anything else I should know?: the release is on Thursday',
        'Shall I ship it?: Yes',
      ].join('\n'),
    )
    expect(
      formatAskUserAnswers(input, [
        {
          question: 'Which environment should I deploy to?',
          labels: ['production'],
          text: 'at 3pm',
        },
        { question: 'Anything else I should know?', text: 'no' },
        { question: 'Shall I ship it?', confirmed: false },
      ]),
    ).toBe(
      [
        'Which environment should I deploy to?: production (write-in: at 3pm)',
        'Anything else I should know?: no',
        'Shall I ship it?: No',
      ].join('\n'),
    )
    expect(formatAskUserAnswers(input, [])).toBe(
      [
        'Which environment should I deploy to?: (no answer)',
        'Anything else I should know?: (no answer)',
        'Shall I ship it?: (no answer)',
      ].join('\n'),
    )
  })
})
