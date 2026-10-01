import { useState } from 'react'

import { ModelProvidersCard } from '../components/settings/model-providers'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useSettings } from '../hooks/use-settings'
import { SETTINGS_STORAGE_KEY, saveSettings } from '../lib/settings'

/**
 * Where the server is, and the model-provider keys this account runs on.
 *
 * There used to be a second field here — the static `x-api-key` — and it is gone (epic #65,
 * A8): signing in is Better Auth's job now (the sign-in page, the device-approval page), and
 * what authentication the browser does is a cookie it cannot read, let alone store. What is
 * left in `localStorage` is the server URL, under `openharness:settings`, and an empty URL
 * means **same origin** — which is what the Vite dev proxy and a static build served next to
 * the API both want.
 *
 * The provider keys live on the server (A5), encrypted, write-only; {@link ModelProvidersCard}
 * is where they are managed.
 */
export function SettingsScreen() {
  const settings = useSettings()
  const [serverUrl, setServerUrl] = useState(settings.serverUrl)
  const [saved, setSaved] = useState(false)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-xl space-y-6 px-6 py-6">
        <div className="space-y-1">
          <h1 className="text-base font-medium">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Connection details are stored in this browser, under{' '}
            <code className="font-mono">{SETTINGS_STORAGE_KEY}</code>.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Connection</CardTitle>
            <CardDescription>
              An empty server URL means this origin: the app calls <code>/v1</code> on the page's
              own host, which is what the dev server proxies and what a static build expects.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                saveSettings({ serverUrl: serverUrl.trim() })
                setSaved(true)
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="settings-server-url">Server URL</Label>
                <Input
                  id="settings-server-url"
                  value={serverUrl}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={`(same origin: ${window.location.origin})`}
                  onChange={(event) => {
                    setServerUrl(event.target.value)
                    setSaved(false)
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Signing in, signing out and the device-approval page all happen on this server
                  too.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit">Save</Button>
                {saved ? (
                  <span role="status" className="text-xs text-muted-foreground">
                    Saved — the next request uses it.
                  </span>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>

        <ModelProvidersCard />
      </div>
    </div>
  )
}
