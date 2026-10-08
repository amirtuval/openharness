import { Check, Copy, Pencil } from 'lucide-react'

import { useCopy } from '../../hooks/use-copy'
import { Button } from '../ui/button'

/**
 * What can be done with a message: copy it, and — on the reader's own last one — write it
 * again (#212).
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
 * **Edit and resend pre-fills the composer and stops.** It is not a rewind: the log is
 * append-only (#201), nothing here deletes the message it copies, and what the reader gets is
 * their own words back in the box to change and send — a new message, at the end, like any
 * other. That is why the button exists only on the **last** user message: anywhere else it
 * would be a way to say the same thing twice into the middle of a conversation.
 */
export function MessageActions({
  text,
  onEdit,
}: {
  /** The message's source — what Copy puts on the clipboard. */
  text: string
  /** Pre-fill the composer with this text. Given for the last user message, and no other. */
  onEdit?: (() => void) | undefined
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
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
