import { useCallback, useRef, useState, type ReactElement } from 'react'

/**
 * The inline prompt slot: one mechanism through which a flow takes over the input area and
 * gives it back with a result (#207).
 *
 * The input area is usually the prompt, and some things are not a prompt: the model picker
 * asks a question with a list, the `/providers` key entry (#210, X7) asks for a secret, and
 * an `ask_user` question or an approval (phase 5) asks the user to choose. All of them do the
 * same two things — render in the prompt's place, and settle with a value — and that is the
 * whole contract here. Nothing about *how many steps* a flow takes is in this file: a flow
 * that picks from a list, then asks for hidden text, then waits on the server is still one
 * {@link PromptSlotView}, settling once, at the end.
 *
 * ```tsx
 * const slot = usePromptSlot()
 * const answer = await slot.request<string | null>((settle) => (
 *   <ModelPicker models={models} onSelect={settle} onCancel={() => settle(null)} />
 * ))
 * if (answer !== null) session.setModel(answer)
 * ```
 *
 * While a flow is up the prompt is not rendered, so it is not reading keys either: the flow
 * owns Ctrl+C, Enter and the arrows, and settles when it decides to (the picker's Ctrl+C
 * settles `null`, which its caller reads as "cancel"). Nothing else can start a flow while
 * one is up, for the same reason — there is no prompt left to type `/model` into.
 */

/** What a flow renders: given the settler, the element that takes the input area's place. */
export type PromptSlotView<T> = (settle: (result: T) => void) => ReactElement

/** The slot: at most one flow, and the promise it settles. */
export interface PromptSlot {
  /**
   * Put a flow in the input area. The returned promise resolves with what the flow settles
   * with, and the prompt comes back in the same render.
   *
   * The slot holds one flow at a time. A second `request` while one is up *replaces* it, and
   * the first promise never settles — there is no honest value to settle a question nobody
   * answered. Nothing in the chat can reach that: with the prompt gone there is no `/model`
   * to type, so it is a guard for future callers rather than a path a user can take.
   */
  readonly request: <T>(view: PromptSlotView<T>) => Promise<T>
  /** The flow's element while one is up, or `null` when the prompt has the input area. */
  readonly element: ReactElement | null
}

/** The flow that is up, and the id that says so: settling a replaced flow must not clear it. */
interface PendingFlow {
  readonly id: number
  readonly element: ReactElement
}

export function usePromptSlot(): PromptSlot {
  const [pending, setPending] = useState<PendingFlow | null>(null)
  const nextId = useRef(0)

  const request = useCallback(<T,>(view: PromptSlotView<T>): Promise<T> => {
    return new Promise<T>((resolve) => {
      const id = nextId.current + 1
      nextId.current = id
      setPending({
        id,
        element: view((result) => {
          setPending((current) => (current?.id === id ? null : current))
          resolve(result)
        }),
      })
    })
  }, [])

  return { request, element: pending?.element ?? null }
}
