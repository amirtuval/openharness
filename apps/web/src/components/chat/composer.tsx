import { Pencil, SendHorizontal, Square } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

import { commandHint } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/**
 * How tall the box is allowed to grow before it starts scrolling instead (epic #201, U10).
 *
 * Ten lines of `text-sm`: enough for a paragraph or a pasted stack trace, short enough that the
 * conversation above never disappears behind the thing being typed into.
 */
const MAX_INPUT_HEIGHT = 200

/**
 * The message box's id.
 *
 * The one stable handle on the box: three screens render a {@link Composer} — a chat, New chat
 * and the first-run flow — so a keyboard shortcut that wants to put the cursor in it ("/" and
 * the first-run screen's own focus-on-mount, #212) has nothing to hold a ref to that exists on
 * all three. Exported so the shell and the screen never spell it twice.
 */
export const COMPOSER_INPUT_ID = 'composer-input'

/**
 * Put the cursor in the message box, on whatever screen is showing one (#212).
 *
 * Looked up by id rather than through a ref because there is no one place that holds the box:
 * a chat renders its own {@link Composer}, New chat renders another, and the shortcuts live in
 * the shell above both. Threading a ref down three screens would be three props and a
 * `useImperativeHandle` between them for one key. A screen with no composer — Settings — has
 * nothing to focus and the shortcut quietly does nothing, which is what it should do.
 */
export function focusComposer(): void {
  document.getElementById(COMPOSER_INPUT_ID)?.focus()
}

/**
 * Edit mode, as the composer renders it (#238).
 *
 * "Edit and resend" puts an earlier message's words back in the box, and a send then rewinds
 * the session to that message — everything after it is replaced. The screen owns that mode:
 * *which* message is being rewritten, and whether a send is allowed right now. This is the
 * part of it the box itself draws.
 */
export interface ComposerEdit {
  /**
   * Whether a send would be refused right now, because the rewound session is not idle.
   *
   * Only an idle session accepts a rewind (#238): the turn in flight owns the branch being
   * replaced. While one is running the composer says why, offers no send, and keeps the
   * draft — the screen refuses the send itself, so Enter goes nowhere either.
   */
  readonly blocked: boolean
  /**
   * Leave edit mode. The screen decides what happens to the draft; by the box's own rule —
   * clearing it cancels the edit — it clears.
   */
  readonly onCancel: () => void
}

/**
 * The message box, and the model control that sits with it.
 *
 * Enter sends, Shift+Enter starts a new line. It stays **enabled while the agent is running**:
 * a message sent mid-turn is a steering message, queued by the server and folded into the
 * next model request. That is also why Stop (which sends `user.interrupt`) sits next to Send
 * rather than replacing it — but the two are told apart by more than a colour since U10: Stop
 * carries the word, Send keeps the arrow, so "which one am I about to press" is legible without
 * hovering.
 *
 * The model selector is a **prop, not state in here** (epic #116): which model a send carries
 * is the screen's decision — `sessions.create({ model })` on a new chat, `send(text, { model })`
 * in an open one — and the composer stays a text box that can be rendered, and tested, with or
 * without one. {@link ComposerEdit} follows the same rule (#238): the screen owns the edit and
 * hands down what the box draws of it.
 *
 * Three things about how it is built are load-bearing:
 *
 * - **The box grows, up to {@link MAX_INPUT_HEIGHT}.** The height is measured and set by hand
 *   rather than left to `field-sizing-content`, which only recent Chromium implements; past the
 *   cap the textarea scrolls, so a pasted file never pushes the conversation off screen.
 * - **The text is uncontrolled unless the caller says otherwise.** Omitted, `value` is state in
 *   here; given, the screen owns the draft — which is how a suggested prompt on New chat fills
 *   the box (U10) without reaching into the DOM behind React's back.
 * - **The cleared text is the one other rule of its own**: it stays in the box until the send
 *   is *stored*, because a failed send is the moment losing what you wrote hurts most.
 */
export function Composer({
  running,
  onSend,
  onStop,
  inputRef,
  disabled = false,
  modelSelector,
  value,
  onValueChange,
  edit,
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
  /** The draft, when the screen owns it. Omitted, the composer keeps it. */
  value?: string | undefined
  /** Every keystroke, and the clear after a stored send, when {@link value} is given. */
  onValueChange?: ((text: string) => void) | undefined
  /**
   * Edit mode (#238), when the box is rewriting an earlier message. Omitted, the box is an
   * ordinary one; given, the indicator above it says what a send would do, Escape leaves the
   * mode, and a send is withheld while {@link ComposerEdit.blocked}.
   */
  edit?: ComposerEdit | undefined
}) {
  const [ownText, setOwnText] = useState('')
  const controlled = value !== undefined
  const text = controlled ? value : ownText
  const setText = (next: string): void => {
    if (controlled) {
      onValueChange?.(next)
    } else {
      setOwnText(next)
    }
  }

  // The textarea, whether or not the caller wanted a handle on it: the growth rule below needs
  // one either way, and the caller's ref is kept in step rather than handed around.
  const ownRef = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    if (inputRef !== undefined) {
      inputRef.current = ownRef.current
    }
  }, [inputRef])

  // Grow to fit, up to the cap. `height: auto` first, or `scrollHeight` would answer with the
  // height the box already has and it could never shrink again. jsdom reports 0 for everything
  // it has no layout for, and a 0-height box is worse than no measurement at all, so that case
  // leaves the CSS height alone.
  useLayoutEffect(() => {
    const element = ownRef.current
    if (element === null) {
      return
    }
    element.style.height = 'auto'
    const content = element.scrollHeight
    if (content === 0) {
      element.style.height = ''
      element.style.overflowY = ''
      return
    }
    element.style.height = `${Math.min(content, MAX_INPUT_HEIGHT)}px`
    element.style.overflowY = content > MAX_INPUT_HEIGHT ? 'auto' : 'hidden'
  }, [text])

  const submit = async (): Promise<void> => {
    const body = text.trim()
    // A blocked send is withheld here as well as offered as a disabled button: Enter is the
    // other way in, and a button that is off while the key still fires would be a bug.
    if (body === '' || disabled || edit?.blocked === true) {
      return
    }
    const accepted = await onSend(body)
    if (accepted !== false) {
      setText('')
    }
  }

  return (
    <form
      // One surface, not a box and a row of controls: the border, the focus ring and the
      // elevation belong to the whole composer, so the model control reads as part of it and
      // the ring appears when focus is anywhere inside — including on the model button.
      className={cn(
        'flex flex-col rounded-2xl border bg-background shadow-raised transition-[color,box-shadow]',
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        disabled && 'opacity-60',
      )}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {edit === undefined ? null : <EditBanner edit={edit} />}
      <CommandHint text={text} />
      <Label htmlFor={COMPOSER_INPUT_ID} className="sr-only">
        Message
      </Label>
      <Textarea
        id={COMPOSER_INPUT_ID}
        ref={ownRef}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder="Send a message…  (Enter to send, Shift+Enter for a new line)"
        // The primitives' own border and ring are switched off: the form above draws them, so
        // there is one focus indicator on screen rather than two, one of them doubled.
        className="max-h-[200px] min-h-9 resize-none border-0 bg-transparent px-3 pt-3 pb-1 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
          // Stop from the keyboard (#212). It lives here rather than in the shell's shortcut
          // handler because the box *is* half the condition — "Escape, while the composer has
          // focus, while a turn is running" — and the other half is a prop this component
          // already has. Escape anywhere else is still the overlays': the drawer, a dialog.
          //
          // Edit mode takes it when it is on (#238): Escape leaves the mode, exactly as the
          // indicator's Cancel does, because that is what the reader is being offered above
          // the box — and Stop is still one click away in the foot.
          if (event.key === 'Escape' && edit !== undefined) {
            event.preventDefault()
            edit.onCancel()
          } else if (event.key === 'Escape' && running && onStop !== undefined) {
            event.preventDefault()
            void onStop()
          }
        }}
      />

      <div className="flex items-center justify-between gap-control px-2 pt-1 pb-2">
        <div className="min-w-0">{modelSelector}</div>
        <div className="flex shrink-0 items-center gap-inline">
          {running && onStop !== undefined ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Stop"
              className="text-destructive"
              onClick={() => void onStop()}
            >
              <Square aria-hidden="true" />
              Stop
            </Button>
          ) : null}

          <Button
            type="submit"
            size="icon-sm"
            aria-label="Send message"
            disabled={disabled || text.trim() === '' || edit?.blocked === true}
          >
            <SendHorizontal aria-hidden="true" />
          </Button>
        </div>
      </div>
    </form>
  )
}

/**
 * The slash-command hint (#283): what the command being typed does, above the box.
 *
 * Shown while the draft opens with a prefix of a command ({@link commandHint}), so a reader who
 * types `/comp` is told what `/compact` is before they finish it. It is presentational and
 * never blocks a send: a line that names no command is an ordinary message, and the hint simply
 * does not appear for one. `data-slot` is the handle its tests read, like the edit row's.
 */
function CommandHint({ text }: { text: string }) {
  const command = commandHint(text)
  if (command === null) {
    return null
  }
  return (
    <div
      data-slot="composer-hint"
      className="flex items-baseline gap-control border-b px-3 py-1.5 text-xs text-muted-foreground"
    >
      <code className="shrink-0 font-mono text-foreground">{command.usage}</code>
      <span className="min-w-0 truncate">{command.description}</span>
    </div>
  )
}

/**
 * The edit-mode indicator (#238): what the box is about to do, and the way out of it.
 *
 * Sending rewinds the session to the message being rewritten, so everything the transcript
 * shows *after* it is replaced — the reader is told that before they press Send, not after.
 * While a turn is running the rewind would be refused (the server's 409), so the same row says
 * what to wait for instead. Cancel and Escape do the same thing: leave the mode.
 *
 * `data-slot` is the handle its tests read, like the action row's.
 */
function EditBanner({ edit }: { edit: ComposerEdit }) {
  return (
    <div
      data-slot="composer-edit"
      className="flex items-center gap-control border-b px-3 py-1.5 text-xs text-muted-foreground"
    >
      <Pencil aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {edit.blocked
          ? 'Editing message · wait for the reply to finish'
          : 'Editing message · sending replaces what follows it'}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="ml-auto shrink-0"
        onClick={edit.onCancel}
      >
        Cancel
      </Button>
    </div>
  )
}
