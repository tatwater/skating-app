import { createFileRoute } from '@tanstack/react-router';
import { PlaceNameQueue } from '../components/admin/PlaceNameQueue';

/** The corpus's unplaced names (D202) — see `PlaceNameQueue`. */
export const Route = createFileRoute('/admin/water/place-names')({ component: PlaceNameQueue });
