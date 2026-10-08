import { SHORTCUTS } from '../lib/shortcuts'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'

/**
 * Every shortcut, on one screen (#212).
 *
 * A dialog because that is what it is: something a reader asked to see, that takes the focus
 * while it is up and gives it back when it closes. Radix (`components/ui/dialog.tsx`) brings
 * the focus trap, Escape and the scroll lock, and — the part that matters here — Escape **put
 * back where the reader was**, which is what lets `?` be pressed again from inside the sheet
 * without losing the place.
 *
 * It is not a menu item anywhere, on purpose: the shortcut is the door, and the sheet is what
 * it opens. A reader who knows `?` gets the list; a reader who does not has not lost anything
 * they were looking at. (`Ctrl/⌘+/` is the second door, for hands that are already there.)
 */
export function ShortcutsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent data-slot="shortcuts-sheet" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            These work anywhere except while you are typing in a field — except the ones with
            Ctrl/⌘, which always work.
          </DialogDescription>
        </DialogHeader>
        <dl data-slot="shortcuts-list" className="flex flex-col gap-inline">
          {SHORTCUTS.map((shortcut, index) => (
            // The index is the key: the sheet is a static list, and two entries share the
            // Ctrl+/ description ("Show this list") without being the same row.
            <div key={index} className="flex items-baseline justify-between gap-control">
              <dt className="text-sm">{shortcut.description}</dt>
              <dd className="flex shrink-0 items-center gap-1">
                {shortcut.keys.map((key, keyIndex) => (
                  <kbd
                    key={keyIndex}
                    className="rounded-xs border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
                  >
                    {key}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
