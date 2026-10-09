import { Check, Copy, Pencil } from 'lucide-react'

import { useCopy } from '../../hooks/use-copy'
import { Button } from '../ui/button'

/**
 * What can be done with a message: copy it, and — on the reader's own — write it again (#212,
 * #238).
 *
 * The row is **in the layout** rather than floating over it, and hidden with `opacity` alone:
 * a control that appears on hover and moves nothing is the point, and an overlay that shifted
 * the transcript every time the pointer crossed it would be worse than no control at all. It
 * is also why the hidden buttons are still focusable — tabbing into one shows it
 * (`group-focus-within`, from {@link MessageItem}'s `group/message`), which is the only way a
 * keyboard reader ever reaches them.
 *
 * On a device that cannot hover there is nothing to reveal the row with, so it is simply
 * always there (`no-hover:`, the `@media (hover: none)` variant from `index.css`): a touch
 * screen shows the actions the way a mouse shows them on hover — permanently.
 *
 * **Edit and resend rewinds the session** (#238). The reader's own words go back in the box,
 * and sending them restarts the conversation from that message: the original and everything
 * after it drop out of the transcript and out of the model's context, and the edited text
 * takes their place. That is why the button is offered on **any** of the reader's messages
 * and not only the last one — the branch behind it is what gets replaced, which is exactly
 * what someone who wants to say something differently means.
 *
 * It is **disabled while the agent is running**: the turn in flight owns the branch being
 * taken back, and the server refuses the rewind (409) while it runs.
 */
export function MessageActions({
  text,
  onEdit,
  editDisabled = false,
}: {
  /** The message's source — what Copy puts on the clipboard. */
  text: string
  /** Rewrite this message: put its text back in the composer, to send as a rewind (#238). */
  onEdit?: (() => void) | undefined
  /** Whether that action is unavailable right now — the agent is working, so nothing can be. */
  editDisabled?: boolean
}) {
  const { copied, copy } = useCopy(text)

  return (
    <div
      data-slot="message-actions"
      className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 no-hover:opacity-100"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-slot="message-copy"
        // The name changes with the icon: "Copied" is what the check mark means, and a
        // screen reader should not have to know the picture.
        aria-label={copied ? 'Copied' : 'Copy message'}
        className="text-muted-foreground"
        onClick={copy}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>

      {onEdit === undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-slot="message-edit"
          aria-label="Edit and resend"
          className="text-muted-foreground"
          disabled={editDisabled}
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
