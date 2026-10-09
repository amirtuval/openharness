import { useState } from 'react'

import { useBrowserAuth } from '../components/auth-provider'
import { ErrorBanner } from '../components/chat/error-banner'
import { ProviderIcon, PROVIDER_LABELS } from '../components/provider-icon'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useClient } from '../components/client-provider'
import { useAuthConfig } from '../hooks/use-auth-config'
import type { AuthProvider } from '../lib/auth-config'
import { beginSessionCheck } from '../lib/auth-store'

/**
 * Sign in: one button per enabled provider, and the dev form when the server offers it.
 *
 * Every signed-out state ends up here — the startup `client.me()` that answered 401, a call
 * that 401ed while the app was open, or a reader who followed `#/signin` themselves — and
 * `returnHash` is where they go back to once there is a session:
 *
 * - the **dev form** signs in on the spot (`signIn.email`), then re-reads `client.me()` and
 *   lets the shell render `returnHash` again — no navigation, because the hash never moved;
 * - a **social sign-in** leaves for the provider and comes back to `returnHash`, which is
 *   passed along as Better Auth's `callbackURL`; the cookie is set on the way through.
 *
 * The cookie (epic #65, A2) is the whole session as far as this page is concerned: it never
 * sees a token, and there is nothing to store.
 */
export function SignInScreen({ returnHash }: { returnHash: string }) {
  const client = useClient()
  const auth = useBrowserAuth()
  const { config, loading, error } = useAuthConfig()

  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const callbackURL = absoluteUrl(returnHash)

  const signInWithProvider = async (provider: AuthProvider): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await auth.signInWithProvider(provider, callbackURL)
    // On success the browser is on its way to the provider and this page is gone; only a
    // failure — a provider the server will not start, an offline browser — comes back.
    if (result.error !== null) {
      setFailure(result.error)
      setBusy(false)
    }
  }

  const signInWithPassword = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    const result = await auth.signInWithEmail(email.trim(), password)
    if (result.error !== null) {
      setFailure(result.error)
      setBusy(false)
      return
    }
    // The cookie is set; ask the server who we are now, and the shell renders `returnHash`.
    setPassword('')
    setBusy(false)
    await beginSessionCheck(client)
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-sm space-y-5">
        <div className="space-y-1">
          <h1 className="text-base font-medium">Sign in to openharness</h1>
          <p className="text-sm text-muted-foreground">
            Your agents and chats are yours alone; each account brings its own model keys.
          </p>
        </div>

        {error === null ? null : (
          <ErrorBanner title="Could not load the sign-in options" message={error} />
        )}
        {failure === null ? null : (
          <ErrorBanner
            title="Sign-in failed"
            message={failure}
            onDismiss={() => setFailure(null)}
          />
        )}

        <Card>
          {/* No `pt-*` here: the card's own `py-6` is the padding inside its border, and this
              is the only card in the app with a bare `CardContent` at the top (every other one
              renders a `CardHeader` first, which is what the registry's top padding is for).
              A second 24px on top made the space above the first button 48px against the 24px
              below the last one (#187). */}
          <CardContent className="space-y-4">
            {loading ? (
              <p role="status" className="text-sm text-muted-foreground">
                Loading sign-in options…
              </p>
            ) : null}

            {config !== null && config.providers.length > 0 ? (
              <div className="flex flex-col gap-2">
                {config.providers.map((provider) => (
                  <Button
                    key={provider}
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full justify-center"
                    disabled={busy}
                    onClick={() => void signInWithProvider(provider)}
                  >
                    <ProviderIcon provider={provider} />
                    Sign in with {PROVIDER_LABELS[provider]}
                  </Button>
                ))}
              </div>
            ) : null}

            {config !== null && config.providers.length === 0 && !config.dev_login ? (
              <p className="text-sm text-muted-foreground">
                This server has no sign-in method configured. Set up a provider (Google, GitHub or
                Microsoft) on the server, or enable the development login.
              </p>
            ) : null}
          </CardContent>

          {config !== null && config.dev_login ? (
            <>
              <CardHeader className="border-t [.border-b]:pb-6">
                <CardTitle className="text-sm">Development login</CardTitle>
                <CardDescription>
                  This server runs with <code className="font-mono">OPENHARNESS_DEV_LOGIN</code>,
                  which is for localhost only.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!busy && email.trim() !== '' && password !== '') {
                      void signInWithPassword()
                    }
                  }}
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sign-in-email">Username</Label>
                    <Input
                      id="sign-in-email"
                      value={email}
                      autoComplete="username"
                      spellCheck={false}
                      placeholder="dev@localhost"
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="sign-in-password">Password</Label>
                    <Input
                      id="sign-in-password"
                      type="password"
                      value={password}
                      autoComplete="current-password"
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </div>
                  <Button
                    type="submit"
                    disabled={busy || email.trim() === '' || password === ''}
                    className="self-start"
                  >
                    {busy ? 'Signing in…' : 'Sign in'}
                  </Button>
                </form>
              </CardContent>
            </>
          ) : null}
        </Card>
      </div>
    </div>
  )
}

/**
 * A route hash as an absolute URL.
 *
 * `callbackURL` is read by the server and by the provider, so it has to be a whole URL: the
 * app may be served under a path, and `#/…` alone would not name a page. Resolved against the
 * current URL, so `#/settings` becomes `<origin><path>#/settings`.
 */
function absoluteUrl(hash: string): string {
  return new URL(hash, window.location.href).href
}
