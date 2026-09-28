import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { createDevFakeClient } from './lib/dev-fake-client'
import './index.css'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('apps/web: index.html is missing the #root element')
}

// With `VITE_OPENHARNESS_FAKE=1` (development only) this resolves to the in-memory fake
// client and a seeded scenario; otherwise it is `null` and the app builds the real client
// from the settings.
void createDevFakeClient().then((fake) => {
  createRoot(container).render(
    <StrictMode>
      <App {...(fake === null ? {} : { client: fake, fakeClient: true })} />
    </StrictMode>,
  )
})
