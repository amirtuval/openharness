import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { AppearanceCard } from '../components/settings/appearance'
import { ContextCard } from '../components/settings/context'
import { DefaultModelCard } from '../components/settings/default-model'
import { ModesCard } from '../components/settings/modes'
import { ProvidersCard } from '../components/settings/providers'
import { ToolsCard } from '../components/settings/tools'
import { UsageCard } from '../components/settings/usage'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../components/ui/collapsible'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import type { ModesView } from '../hooks/use-modes'
import type { ModelsView } from '../hooks/use-models'
import { useSettings } from '../hooks/use-settings'
import { SETTINGS_STORAGE_KEY, saveSettings } from '../lib/settings'

/**
 * Settings, in the order a reader needs it (epic #201, X5).
 *
 * **Providers** — the keys every chat runs on — first, then **Default model**, **Modes** (#245),
 * **Context** (the compaction controls, #282) and **Tools** (which tools a chat may use, #303
 * X4/#307), then **Appearance**, then **Usage** (what the month has cost so far, #247), and last **Advanced**,
 * which holds the one developer-facing setting and is collapsed. Before this, the screen opened on a Connection card that only a self-hoster has
 * any use for, with the thing everyone needs — a provider key — below the fold; the order is
 * the fix, and it is why the server URL moved rather than disappeared.
 *
 * The theme keeps a `localStorage` cache under `openharness:theme` that is only there to paint
 * the first frame (#203); the server URL lives under {@link SETTINGS_STORAGE_KEY} and is the
 * only thing left in this browser's settings.
 *
 * The provider keys live on the server (A5), encrypted, write-only; {@link ProvidersCard} is
 * where they are managed. The default model ({@link DefaultModelCard}) and the theme
 * ({@link AppearanceCard}) are server state too, and the model picker reads the shell's one
 * catalog rather than fetching its own.
 */
export function SettingsScreen({ catalog, modes }: { catalog: ModelsView; modes: ModesView }) {
  const settings = useSettings()
  const [serverUrl, setServerUrl] = useState(settings.serverUrl)
  const [saved, setSaved] = useState(false)

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-xl space-y-6 px-6 py-6">
        <h1 className="text-base font-medium">Settings</h1>

        <ProvidersCard />

        <DefaultModelCard catalog={catalog} />

        <ModesCard modes={modes} catalog={catalog} />

        <ContextCard catalog={catalog} />

        <ToolsCard />

        <AppearanceCard />

        <UsageCard />

        <Collapsible>
          <Card>
            <CardHeader>
              <CollapsibleTrigger className="flex items-center gap-1 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 transition-transform [[data-state=open]_&]:rotate-90"
                />
                <CardTitle className="text-sm">Advanced</CardTitle>
              </CollapsibleTrigger>
              <CardDescription>
                Connection details, stored in this browser under{' '}
                <code className="font-mono">{SETTINGS_STORAGE_KEY}</code>.
              </CardDescription>
            </CardHeader>
            <CollapsibleContent>
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
                      An empty URL means this origin: the app calls <code>/v1</code> on the page's
                      own host, which is what the dev server proxies and what a static build
                      expects. Signing in, signing out and the device-approval page all happen on
                      this server too.
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
            </CollapsibleContent>
          </Card>
        </Collapsible>
      </div>
    </div>
  )
}
