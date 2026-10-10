import { useEffect, useState } from 'react'

import { useClient } from '../components/client-provider'
import type { CreateChatOptions, CreateChatResult } from '../hooks/use-sessions'
import type { ModesView } from '../hooks/use-modes'
import type { ModelsView } from '../hooks/use-models'
import { useProviderCredentials } from '../hooks/use-provider-credentials'
import { FirstRunScreen } from './first-run-screen'
import { NewChatScreen } from './new-chat-screen'

/**
 * What the root route shows a signed-in reader (epic #201, X5).
 *
 * New chat — or, for an account with no provider key at all, the first-run screen. Both `#/`
 * and `#/new` land here, which is what retires the Home screen: the root of a signed-in app is
 * the thing a reader came to do, and an old `#/` link or bookmark now goes to it. There is no
 * third state and no dead end.
 *
 * The decision is made **once**, from the credentials list's first answer, and deliberately
 * does not follow later answers: saving a key in the first-run screen makes that list non-empty,
 * and a live condition would swap the screen out from under the confirmation the reader is
 * reading. The reader leaves when they say so ({@link onLeave}), and the next mount — coming
 * back to `#/` from anywhere — decides again.
 */
export function StartScreen({
  createSession,
  catalog,
  modes,
}: {
  /** Create the session for New chat — from a model or a mode (#245, M6) — and return it. */
  createSession: (options: CreateChatOptions) => Promise<CreateChatResult>
  catalog: ModelsView
  /** The shell's modes: the presets New chat's picker offers. */
  modes: ModesView
}) {
  const client = useClient()
  const { credentials, loading, error } = useProviderCredentials(client)
  const [firstRun, setFirstRun] = useState<boolean | null>(null)

  useEffect(() => {
    if (firstRun !== null || loading) {
      return
    }
    // A list that failed to load is not "no keys": a transient failure must not walk a
    // returning reader through onboarding they finished months ago, so the catalog's own
    // empty state is left to say what happened.
    setFirstRun(error === null && credentials.length === 0)
  }, [firstRun, loading, credentials, error])

  if (firstRun === null) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p role="status" className="text-sm text-muted-foreground">
          Checking your providers…
        </p>
      </div>
    )
  }

  if (firstRun) {
    return <FirstRunScreen catalog={catalog} onLeave={() => setFirstRun(false)} />
  }

  return <NewChatScreen createSession={createSession} catalog={catalog} modes={modes} />
}
