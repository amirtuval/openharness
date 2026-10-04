import { MessageSquare, Plus } from 'lucide-react'

import { Button } from '../components/ui/button'

/** What the app shows when no chat is open. */
export function HomeScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <MessageSquare aria-hidden="true" className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <h1 className="text-base font-medium">openharness</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Pick a chat from the sidebar, or start a new one with a model your keys can use.
        </p>
      </div>
      <Button asChild>
        <a href="#/new">
          <Plus aria-hidden="true" />
          New chat
        </a>
      </Button>
    </div>
  )
}
