import { SendHorizontal, Square } from 'lucide-react'
import { useState, type ReactNode, type RefObject } from 'react'

import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/**
 * The message box, and the model control that sits with it.
 *
 * Enter sends, Shift+Enter starts a new line. It stays **enabled while the agent is running**:
 * a message sent mid-turn is a steering message, queued by the server and folded into the
 * next model request. That is also why Stop (which sends `user.interrupt`) sits next to Send
 * rather than replacing it.
 *
 * The model selector is a **prop, not state in here** (epic #116): which model a send carries
 * is the screen's decision — `sessions.create({ model })` on a new chat, `send(text, { model })`
 * in an open one — and the composer stays a text box that can be rendered, and tested, with or
 * without one. The cleared text is the one other rule of its own: it stays in the box until the
 * send is *stored*, because a failed send is the moment losing what you wrote hurts most.
 */
export function Composer({
  running,
  onSend,
  onStop,
  inputRef,
  disabled = false,
  modelSelector,
}: {
  /** Whether the agent is working, which is when Stop makes sense. */
  running: boolean
  /**
   * Send a message. Answer `false` when it was not stored, and the text stays in the box.
   */
  onSend: (text: string) => boolean | void | Promise<boolean | void>
  /** Stop the running turn (`user.interrupt`). */
  onStop: (() => void | Promise<void>) | undefined
  /** The input, so the screen can focus it (a new chat starts with the cursor in the box). */
  inputRef?: RefObject<HTMLTextAreaElement | null> | undefined
  /** Disable the box and the button while there is nothing a send could do yet. */
  disabled?: boolean
  /** The model control shown under the input — the compact {@link ModelPicker}. */
  modelSelector?: ReactNode
}) {
  const [text, setText] = useState('')

  const submit = async (): Promise<void> => {
    const body = text.trim()
    if (body === '' || disabled) {
      return
    }
    const accepted = await onSend(body)
    if (accepted !== false) {
      setText('')
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div>
        <Label htmlFor="composer-input" className="sr-only">
          Message
        </Label>
        <Textarea
          id="composer-input"
          ref={inputRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Send a message…  (Enter to send, Shift+Enter for a new line)"
          className="max-h-40 min-h-9 resize-none text-sm"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">{modelSelector}</div>
        <div className="flex shrink-0 items-center gap-2">
          {running && onStop !== undefined ? (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              aria-label="Stop"
              onClick={() => void onStop()}
            >
              <Square aria-hidden="true" />
            </Button>
          ) : null}

          <Button
            type="submit"
            size="icon"
            aria-label="Send message"
            disabled={disabled || text.trim() === ''}
          >
            <SendHorizontal aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  )
}
