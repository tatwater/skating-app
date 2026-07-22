import { createFileRoute } from '@tanstack/react-router';

// The bare map (`/`) — no drawer. The persistent `MapView` lives in the `_map` layout; this index
// child just fills the outlet with nothing so the map shows on its own.
export const Route = createFileRoute('/_map/')({ component: () => null });
