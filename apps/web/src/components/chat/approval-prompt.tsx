import {
  APPROVAL_CHOICES,
  approvalConfirmation,
  approvalChoiceLabel,
  type ApprovalChoice,
  type TranscriptToolCall,
} from '@openharness/client'
import type { UserToolConfirmationEventInput } from '@openharness/protocol'
import { ShieldQuestion } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../ui/button'
import { Input } from '../ui/input'

/**
 * The approval prompt for a call the settings evaluated `ask` (epic #303, X6; issue #310).
 *
 * The call is already on screen above — its line, with the input behind the disclosure — so
 * this is the second half of it: **the choices**. The four are the policy's own vocabulary
 * plus the two ways of remembering, named exactly as the log records them:
 *
 * - **Allow once** runs this call and nothing else;
 * - **Allow for this chat** allows every later call to the same tool in this chat, read back
 *   off the log so an edit that rewinds past the answer takes it back with the branch;
 * - **Always allow** is the same for this chat **and** writes the reader's stored policy for
 *   that tool, so the next chat inherits it;
 * - **Deny** refuses the call, with an optional message the model reads as the reason.
 *
 * Deny is a two-step: the button opens the message box (a denial is often worth explaining),
 * and the box's own Deny sends it — an empty message sends a plain denial rather than a blank
 * one, because the protocol wants a non-empty `deny_message`.
 *
 * The event it builds is one `user.tool_confirmation`; the **screen** sends it, because it
 * owns the request and the error it can fail with.
 */
export function ApprovalPrompt({
  call,
  busy,
  onRespond,
}: {
  call: TranscriptToolCall
  /** A confirmation is in flight for this call: the buttons are off until the log answers. */
  busy: boolean
  /** Send the reader's decision. The screen sends the event and folds in what comes back. */
  onRespond: (input: UserToolConfirmationEventInput) => void
}) {
  const [denying, setDenying] = useState(false)
  const [message, setMessage] = useState('')

  const decide = (choice: ApprovalChoice): void => {
    if (choice === 'deny') {
      if (!denying) {
        setDenying(true)
        return
      }
      onRespond(approvalConfirmation(call.id, 'deny', message))
      return
    }
    onRespond(approvalConfirmation(call.id, choice))
  }

  return (
    <div
      data-slot="approval-prompt"
      data-tool={call.name}
      role="group"
      aria-label={`Allow ${call.name}?`}
      className="mt-1 rounded-lg border border-coral/40 bg-coral/5 px-2.5 py-2"
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldQuestion aria-hidden="true" className="size-3.5 shrink-0 text-coral-ink" />
        <span className="min-w-0">
          <span className="font-medium text-foreground">{call.name}</span> wants to run. Allow it?
        </span>
      </p>
      {denying ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Input
            data-slot="approval-deny-message"
            aria-label={`Why ${call.name} was denied`}
            value={message}
            placeholder="Why not? (optional)"
            className="h-8 min-w-0 flex-1 text-xs"
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                decide('deny')
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setDenying(false)
              }
            }}
          />
          <Button
            type="button"
            variant="destructive"
            size="xs"
            disabled={busy}
            onClick={() => decide('deny')}
          >
            Deny call
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setDenying(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {APPROVAL_CHOICES.map((choice) => (
            <Button
              key={choice.choice}
              type="button"
              variant={choice.choice === 'deny' ? 'outline' : 'secondary'}
              size="xs"
              disabled={busy}
              data-choice={choice.choice}
              className={choice.choice === 'deny' ? 'text-destructive' : undefined}
              onClick={() => decide(choice.choice)}
            >
              {approvalChoiceLabel(choice.choice)}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
