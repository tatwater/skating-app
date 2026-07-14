import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// We run Vitest without global injection (tests import describe/it/expect explicitly), so
// Testing Library's automatic afterEach cleanup doesn't self-register — do it here, or rendered
// trees leak across tests and duplicate-match queries.
afterEach(cleanup)
