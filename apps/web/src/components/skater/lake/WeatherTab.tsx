import { Section } from '@/components/kit/section-slug';
import { Skeleton } from '@/components/kit/skeleton';

import { TabStack } from './ReportsTab';

/**
 * **Mount point — the Weather tab (boards 1.6, 1.7).** This file is a placeholder: it draws the
 * tab's loading frame only, and agent D replaces its body with the real tab (what it's been
 * through, across the lake, what's coming, "Weather at" when the lake has two or more sample
 * points). Keep the export name and the props: `LakePage` renders `<WeatherTab … />` for
 * `?tab=weather` and passes the lake and the bay in view.
 */
export interface WeatherTabProps {
  /** The lake (the merge survivor's id). */
  waterBodyId: string;
  /** The bay in view (`?sub=`), when there is one. */
  subAreaId?: string;
}

export function WeatherTab(_props: WeatherTabProps) {
  return (
    <TabStack>
      <Section title="What it’s been through" level={2} aria-busy="true">
        <Skeleton className="h-[8.5rem] w-full" />
      </Section>
      <Section title="What’s coming" level={2} aria-busy="true">
        <Skeleton className="h-[5.5rem] w-full" />
      </Section>
    </TabStack>
  );
}
