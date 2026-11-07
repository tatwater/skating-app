import { createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { SettingsPage } from '../components/skater/settings/SettingsPage';
import {
  homeSearchSchema,
  isSettingsSection,
  type SettingsSection,
} from '../components/skater/settings/sections';

/**
 * `/settings/$section` (B03 §1.5, D242): the section is the path, validated here — a section that
 * doesn't exist is the 404, not a crash. `/settings/home` takes `?edit=true` (change home, 7.18) and
 * `?travel=true` (traveling, 7.19); a bad value degrades to the home summary.
 */
export const Route = createFileRoute('/_skater/settings/$section')({
  params: {
    parse: ({ section }): { section: SettingsSection } => {
      if (!isSettingsSection(section)) throw notFound();
      return { section };
    },
    stringify: ({ section }) => ({ section }),
  },
  validateSearch: homeSearchSchema,
  component: SettingsRoute,
});

function SettingsRoute() {
  const { section } = Route.useParams();
  const { edit, travel } = Route.useSearch();
  const router = useRouter();
  return (
    <SettingsPage
      section={section}
      homeView={section !== 'home' ? 'summary' : edit ? 'edit' : travel ? 'travel' : 'summary'}
      onNavigate={(href, options) =>
        options?.replace ? router.history.replace(href) : router.history.push(href)
      }
    />
  );
}
