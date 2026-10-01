import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/dom'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

import { resetAuthClientMock } from './src/test-support/better-auth-client-mock'

// Sign-in is Better Auth's own surface (epic #65, A1), and it is the one dependency in this
// app that a test cannot run for real: a social sign-in leaves the page. It is mocked at the
// module boundary for every test file — the app code is untouched, and the tests drive the
// same calls the app makes through `src/test-support/better-auth-client-mock.ts`.
vi.mock('better-auth/client', () => import('./src/test-support/better-auth-client-mock'))
vi.mock('better-auth/client/plugins', () => import('./src/test-support/better-auth-client-mock'))

// Testing Library only registers its automatic cleanup when the test runner's globals are on;
// this suite imports from `vitest` instead, so it unmounts what it rendered here.
afterEach(() => {
  cleanup()
  window.location.hash = ''
  resetAuthClientMock()
})

// The chat tests wait on a fake server that streams on real timers. A second is tight when
// the whole suite is running concurrently; two is still fast when things are fine, because
// every `findBy*`/`waitFor` resolves as soon as its condition holds.
configure({ asyncUtilTimeout: 2000 })
