import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const container = document.getElementById('root')

if (container === null) {
  throw new Error('apps/web: index.html is missing the #root element')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
