import {
  watchTaskActivity,
  type ModelPriceLookup,
  type TaskActivityState,
} from '@openharness/client'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { useClient } from '../components/client-provider'

/**
 * What one child session is doing right now, for the card its parent draws (epic #340, S9;
 * issue #346).
 *
 * A task does not report progress, so the card's activity line is read from the **child's own
 * stream** — the client's `watchTaskActivity` loads the child's history and then follows it —
 * and this hook is only the React binding: one watcher per card, closed when the card is
 * unmounted, and the state read through `useSyncExternalStore` (the watcher's `getState` is
 * stable between changes, which is the pair React takes).
 *
 * **Nothing is followed while the card has nothing to show.** `enabled` is false for a task that
 * has finished — a `done`, `failed` or `stopped` card draws its result rather than an activity
 * line — so a chat with six finished subagents holds no streams, which is what the watcher's own
 * reference count exists for. The watcher is still built, so a task that moves back to `running`
 * (the reader sent it a message) starts following without a new one.
 *
 * @param childSessionId the child's session, or `null` for a task that has none
 * @param options `enabled` — whether anything is watching — and the catalog's prices, for the
 *   money the card shows beside the tokens
 */
export function useTaskActivity(
  childSessionId: string | null,
  options: { readonly enabled: boolean; readonly prices?: ModelPriceLookup | undefined },
): TaskActivityState {
  const client = useClient()
  const { enabled } = options
  const prices = options.prices
  const watcher = useMemo(
    () =>
      childSessionId === null
        ? null
        : watchTaskActivity(client.sessions.events, childSessionId, {
            ...(prices === undefined ? {} : { prices }),
          }),
    [client, childSessionId, prices],
  )

  // A card that unmounts — a scroll out of the conversation, a chat left — takes its follower
  // with it. `close()` rather than the last unsubscribe, because the watcher outlives this
  // component's subscriptions and a rebuild of it must not leave the old one connecting.
  useEffect(
    () => () => {
      watcher?.close()
    },
    [watcher],
  )

  const subscribe = useCallback(
    (listener: () => void) =>
      watcher === null || !enabled ? () => {} : watcher.subscribe(listener),
    [watcher, enabled],
  )
  const getSnapshot = useCallback(
    () => (watcher === null || !enabled ? IDLE : watcher.getState()),
    [watcher, enabled],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * What a child nothing is watching reads as: nothing running, nothing spent.
 *
 * A module constant rather than a fresh object, because `useSyncExternalStore` compares snapshots
 * by reference and an object built per read would re-render forever.
 */
const IDLE: TaskActivityState = {
  activity: { kind: 'idle' },
  waiting: false,
  status: 'idle',
  model: null,
  usage: null,
  cost: null,
}
