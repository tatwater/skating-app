import { createFileRoute, redirect } from '@tanstack/react-router';
import { DEFAULT_SETTINGS_SECTION } from '../components/skater/settings/sections';

/** `/settings` → `/settings/account` (B03 §1.5): the first section is where a bare link lands. */
export const Route = createFileRoute('/_skater/settings/')({
  beforeLoad: () => {
    throw redirect({
      to: '/settings/$section',
      params: { section: DEFAULT_SETTINGS_SECTION },
      replace: true,
    });
  },
});
