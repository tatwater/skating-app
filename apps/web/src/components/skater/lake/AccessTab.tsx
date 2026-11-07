import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';

import { TabStack } from './ReportsTab';

/**
 * **Mount point — the Getting there tab (board 1.8).** This file is a placeholder: it draws the
 * tab's loading frame only, and agent D replaces its body with the real tab (public access, the
 * put-ins, parking, hike-in kept apart from drive time, "Report an access problem"). Keep the export
 * name and the props: `LakePage` renders `<AccessTab … />` for `?tab=access`. The access-problem
 * popover opens through `onReportProblem`, which sets `?act=access-problem` on the lake's URL.
 */
export interface AccessTabProps {
  /** The lake (the merge survivor's id). */
  waterBodyId: string;
  /** The bay in view (`?sub=`), when there is one. */
  subAreaId?: string;
  /** Opens the access-problem action over the sidebar (`?act=access-problem`). */
  onReportProblem: () => void;
}

export function AccessTab(_props: AccessTabProps) {
  return (
    <TabStack>
      <Section title="Put-ins" level={2} aria-busy="true">
        <Skeleton className="h-[10rem] w-full" />
        <Skeleton className="h-[6rem] w-full" />
      </Section>
    </TabStack>
  );
}
