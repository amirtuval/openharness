import { PACKAGE_NAME as CLIENT_PACKAGE_NAME } from '@openharness/client'
import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'

/**
 * Placeholder page. It renders the project name and the packages this app is wired to
 * (which is what proves the web → protocol / client edges resolve through built output).
 * The chat UI lands in the v1 epic.
 */
export function App() {
  return (
    <main>
      <h1>openharness</h1>
      <p>Placeholder web app — the chat UI lands in the v1 epic.</p>
      <p>
        <small>
          wired: {PROTOCOL_PACKAGE_NAME}, {CLIENT_PACKAGE_NAME}
        </small>
      </p>
    </main>
  )
}
