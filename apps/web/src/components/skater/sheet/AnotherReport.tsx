import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClock, faMagnifyingGlass } from '@fortawesome/sharp-light-svg-icons';
import { faPlus } from '@fortawesome/sharp-regular-svg-icons';
import { type Mint, openReport, type PostSheet } from '@skating/core';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/kit/dropdown-menu';
import { updateSheet, useSheet } from '@/lib/sheetStore';
import type { AnotherReportSlotProps } from './sheetSlots';

/**
 * *Another report* (5.16/5.17): the same lake at another time, inserted after the Report it is about
 * (the tabs sort by time once it has one), or a different lake — a fresh Report on the same full
 * *Which lake?* the top bar opens. Pure over the Post, so the two adds are unit-tested.
 */
export function addAnotherVisit(
  post: PostSheet,
  afterId: string,
  now: number,
  mint: Mint,
): { post: PostSheet; reportId: string } | null {
  const at = post.reports.findIndex((r) => r.id === afterId);
  const source = post.reports[at];
  if (source === undefined || source.sheet.waterBodyId === undefined) return null;
  const showPutIn = source.sheet.scalars.showPutIn;
  const report = openReport(
    {
      waterBodyId: source.sheet.waterBodyId,
      ...(source.bodyName !== undefined ? { bodyName: source.bodyName } : {}),
      ...(showPutIn !== undefined ? { showPutIn } : {}),
    },
    now,
    mint,
  );
  const reports = [...post.reports.slice(0, at + 1), report, ...post.reports.slice(at + 1)];
  return { post: { ...post, reports, dirty: true }, reportId: report.id };
}

export function addDifferentLake(
  post: PostSheet,
  now: number,
  mint: Mint,
): { post: PostSheet; reportId: string } {
  const showPutIn = post.reports[post.reports.length - 1]?.sheet.scalars.showPutIn;
  const report = openReport({ ...(showPutIn !== undefined ? { showPutIn } : {}) }, now, mint);
  return {
    post: { ...post, reports: [...post.reports, report], dirty: true },
    reportId: report.id,
  };
}

const mint: Mint = () => crypto.randomUUID();

/** The `anotherReport` slot: the menu at the end of the tabs. */
export function AnotherReport({ activeReportId, onAdded }: AnotherReportSlotProps) {
  const post = useSheet();
  const active = post?.reports.find((r) => r.id === activeReportId);
  const lake = active?.sheet.waterBodyId !== undefined ? (active.bodyName ?? 'This lake') : null;
  const add = (make: (p: PostSheet) => { post: PostSheet; reportId: string } | null) => {
    let added: string | null = null;
    updateSheet((p) => {
      const made = make(p);
      if (made === null) return p;
      added = made.reportId;
      return made.post;
    });
    if (added !== null) onAdded(added);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-attr="sheet-another-report"
        className="flex h-full cursor-pointer items-center gap-(--space-2) border-0 border-r border-solid border-line bg-transparent px-(--space-4_5) text-kick leading-none font-semibold tracking-head text-fg2 uppercase outline-none hover:text-fg focus-visible:shadow-focus data-popup-open:bg-panel data-popup-open:text-fg"
      >
        <FontAwesomeIcon icon={faPlus} aria-hidden="true" />
        Another report
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-82.5">
        <DropdownMenuItem
          data-attr="another-report-same-lake"
          disabled={lake === null}
          icon={<FontAwesomeIcon icon={faClock} />}
          label={lake !== null ? `${lake}, another time` : 'This lake, another time'}
          className="h-auto py-(--space-2_5)"
          onClick={() => add((p) => addAnotherVisit(p, activeReportId, Date.now(), mint))}
        >
          <MenuLines
            title={lake !== null ? `${lake}, another time` : 'This lake, another time'}
            sub="A second visit to the lake this report is about"
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          data-attr="another-report-different-lake"
          icon={<FontAwesomeIcon icon={faMagnifyingGlass} />}
          label="A different lake"
          className="h-auto py-(--space-2_5)"
          onClick={() => add((p) => addDifferentLake(p, Date.now(), mint))}
        >
          <MenuLines title="A different lake" sub="From a GPX file, your photos, or a search" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuLines({ title, sub }: { title: string; sub: string }) {
  return (
    <span className="flex flex-col gap-(--space-1) whitespace-normal">
      <span className="text-row leading-snug text-fg">{title}</span>
      <span className="text-assist leading-snug font-regular text-fg2">{sub}</span>
    </span>
  );
}
