import { useInspectorContext } from '../../../inspector/inspectorContext';
import type { CorpusHandlerProps } from '../../inspector/handlerRegistry';
import { CorpusHeadMap } from '../../map/CorpusHeadMap';
import { bodyNamesPath } from '../bodyPath';
import { NAMES_MAP_SIZE, NamesInspector } from './NamesInspector';
import type { NamesItem } from './namesModel';
import { useNameServer, useNameWrites } from './useNameWrites';

/** Not computed yet: the map draws the body alone (one array, so the reads keep their keys). */
const NOT_COMPUTED: readonly never[] = [];

/**
 * **The Name conflicts handler** (board 4.2), registered for the `nameConflicts` lane
 * (`register.tsx`): the inspector drawn from the item (`NamesInspector`), its one write bound
 * (`useNameWrites` → `corpusWrites.decideName`), the square head map, *Open in Body →* to the
 * body's Names tab, and ⏎ on the inspector pane.
 */
export function NamesHandler({ item, locked, now }: CorpusHandlerProps) {
  // The registry hands this handler only `nameConflicts` items (its one key).
  const names = item as NamesItem;
  const { pane, timeZone, linkFor } = useInspectorContext();
  const server = useNameServer();
  const { decide, pending } = useNameWrites(names, server);
  const path = bodyNamesPath(names.body.id);
  return (
    <NamesInspector
      item={names}
      locked={locked}
      now={now}
      map={
        <CorpusHeadMap
          bodyId={names.body.id}
          neighbors={names.neighbors ?? NOT_COMPUTED}
          height={NAMES_MAP_SIZE}
          square
        />
      }
      bodyLink={linkFor?.(path) ?? <a href={path}>{path}</a>}
      onDecide={decide}
      pending={pending}
      pane={pane}
      {...(timeZone !== undefined ? { timeZone } : {})}
    />
  );
}
