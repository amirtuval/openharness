import type { Client } from '@openharness/client'
import { useEffect, useState } from 'react'

import { useBrowserAuth } from '../components/auth-provider'
import { useClient } from '../components/client-provider'
import { ErrorBanner } from '../components/chat/error-banner'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import type { AuthCallOutcome } from '../lib/auth-client'
import { markSignedOut } from '../lib/auth-store'

/** What the page is showing right now. */
type DeviceState =
  | { readonly kind: 'verifying' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'approved' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * The device-authorization approval page (epic #65, A6).
 *
 * `oh login` prints a URL with the user code in it and waits. This is the page that URL
 * opens: it shows the code, asks the reader to check it against their terminal, and approves
 * or denies the pending login — a phishing terminal's code will not be the one on screen.
 *
 * The route is `#/device?user_code=<code>` (see `lib/router.ts`), which is what the server's
 * `verification_uri_complete` should point at.
 *
 * Signed out, the shell shows the sign-in page first and comes back here: verifying a code
 * **binds it to this browser's session**, so there has to be one, and the code is only
 * approvable by the session that claimed it.
 */
export function DeviceScreen({ userCode }: { userCode: string | null }) {
  const client = useClient()
  const auth = useBrowserAuth()
  const [state, setState] = useState<DeviceState>({ kind: 'verifying' })
  const [deciding, setDeciding] = useState(false)

  useEffect(() => {
    if (userCode === null) {
      setState({
        kind: 'failed',
        message:
          'This page needs the code from your terminal. Run `oh login` again and open the link it prints.',
      })
      return
    }

    let cancelled = false
    setState({ kind: 'verifying' })
    void auth.verifyDeviceCode(userCode).then((result) => {
      if (cancelled) {
        return
      }
      noteDeadSession(client, result)
      setState(
        result.error !== null
          ? { kind: 'failed', message: result.error }
          : // A code that was already decided — the reader approved it and reloaded — says so
            // rather than offering buttons that would only fail.
            result.codeStatus === 'approved'
            ? { kind: 'approved' }
            : result.codeStatus === 'denied'
              ? { kind: 'denied' }
              : { kind: 'ready' },
      )
    })
    return () => {
      cancelled = true
    }
  }, [auth, client, userCode])

  const decide = async (approve: boolean): Promise<void> => {
    if (userCode === null || deciding) {
      return
    }
    setDeciding(true)
    const result = approve
      ? await auth.approveDeviceCode(userCode)
      : await auth.denyDeviceCode(userCode)
    setDeciding(false)
    noteDeadSession(client, result)
    if (result.error !== null) {
      setState({ kind: 'failed', message: result.error })
      return
    }
    setState(approve ? { kind: 'approved' } : { kind: 'denied' })
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-md space-y-5">
        <div className="space-y-1">
          <h1 className="text-base font-medium">Approve a CLI login</h1>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono">oh login</code> is asking to sign in as you.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              {state.kind === 'approved'
                ? 'Approved'
                : state.kind === 'denied'
                  ? 'Denied'
                  : 'Does this code match your terminal?'}
            </CardTitle>
            <CardDescription>
              {state.kind === 'approved'
                ? 'Return to your terminal — it is signing in on its own now.'
                : state.kind === 'denied'
                  ? 'Nothing was signed in. The terminal was told the request was refused.'
                  : state.kind === 'failed'
                    ? 'The code could not be used.'
                    : 'Approve only if the terminal shows exactly this code.'}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {userCode === null ? null : (
              <p
                data-slot="device-user-code"
                className="rounded-md border bg-muted/40 px-4 py-3 text-center font-mono text-2xl tracking-widest"
              >
                {userCode}
              </p>
            )}

            {state.kind === 'failed' ? (
              <ErrorBanner title="Device login failed" message={state.message} />
            ) : null}

            {state.kind === 'verifying' ? (
              <p role="status" className="text-sm text-muted-foreground">
                Checking the code…
              </p>
            ) : null}

            {state.kind === 'ready' ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={deciding}
                  onClick={() => void decide(true)}
                  className="flex-1"
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={deciding}
                  onClick={() => void decide(false)}
                  className="flex-1"
                >
                  Deny
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/**
 * A call that came back 401 is a session that ended while this page was open.
 *
 * Better Auth's own errors are not the API client's `AuthenticationError`, so this page reads
 * the status itself: signing out puts the sign-in page up *with this route as the place to
 * come back to*, which is the same first step as arriving here signed out.
 */
function noteDeadSession(client: Client, result: AuthCallOutcome): void {
  if (result.httpStatus === 401) {
    markSignedOut(client)
  }
}
