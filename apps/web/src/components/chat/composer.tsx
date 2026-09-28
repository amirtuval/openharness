import { SendHorizontal, Square } from 'lucide-react'
import { useState, type RefObject } from 'react'

import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/**
 * The message box.
 *
 * Enter sends, Shift+Enter starts a new line. It stays **enabled while the agent is running**:
 * a message sent mid-turn is a steering message, queued by the server and folded into the
 * next model request. That is also why Stop (which sends `user.interrupt`) sits next to Send
 * rather than replacing it.
 */
export function Composer({
  running,
  onSend,
  onStop,
  inputRef,
}: {
  /** Whether the agent is working, which is when Stop makes sense. */
  running: boolean
  onSend: (text: string) => void | Promise<void>
  onStop: () => void | Promise<void>
  /** The input, so the screen can focus it (a new chat starts with the cursor in the box). */
  inputRef?: RefObject<HTMLTextAreaElement | null> | undefined
}) {
  const [text, setText] = useState('')

  const submit = (): void => {
    const body = text.trim()
    if (body === '') {
      return
    }
    setText('')
    void onSend(body)
  }

  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor="composer-input" className="sr-only">
          Message
        </Label>
        <Textarea
          id="composer-input"
          ref={inputRef}
          rows={1}
          value={text}
          placeholder="Send a message…  (Enter to send, Shift+Enter for a new line)"
          className="max-h-40 min-h-9 resize-none text-sm"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
      </div>

      {running ? (
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

      <Button type="submit" size="icon" aria-label="Send message" disabled={text.trim() === ''}>
        <SendHorizontal aria-hidden="true" />
      </Button>
    </form>
  )
}
