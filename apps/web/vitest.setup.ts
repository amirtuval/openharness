import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/dom'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Testing Library only registers its automatic cleanup when the test runner's globals are on;
// this suite imports from `vitest` instead, so it unmounts what it rendered here.
afterEach(() => {
  cleanup()
  window.location.hash = ''
})

// The chat tests wait on a fake server that streams on real timers. A second is tight when
// the whole suite is running concurrently; two is still fast when things are fine, because
// every `findBy*`/`waitFor` resolves as soon as its condition holds.
configure({ asyncUtilTimeout: 2000 })
