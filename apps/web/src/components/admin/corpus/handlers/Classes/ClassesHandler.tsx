import { useInspectorContext } from '../../../inspector/inspectorContext';
import type { CorpusHandlerProps } from '../../inspector/handlerRegistry';
import { CorpusHeadMap } from '../../map/CorpusHeadMap';
import { bodyNamesPath } from '../bodyPath';
import { CLASSES_MAP_HEIGHT, ClassesInspector } from './ClassesInspector';
import type { ClassesItem } from './classesModel';
import { useClassServer, useClassWrites } from './useClassWrites';

/** Not computed yet: the map draws the body alone (one array, so the reads keep their keys). */
const NOT_COMPUTED: readonly never[] = [];

/**
 * **The Class conflicts handler** (board 4.3), registered for the `classConflicts` lane
 * (`register.tsx`): the inspector drawn from the item (`ClassesInspector`), its one write bound
 * (`useClassWrites` → `corpusWrites.decideClass`), the map band with its legend, *Open in Body →*
 * to the body's Names tab (where its class is set by hand), and ⏎ on the inspector pane.
 */
export function ClassesHandler({ item, locked, now }: CorpusHandlerProps) {
  // The registry hands this handler only `classConflicts` items (its one key).
  const classes = item as ClassesItem;
  const { pane, timeZone, linkFor } = useInspectorContext();
  const server = useClassServer();
  const { decide, pending } = useClassWrites(classes, server);
  const path = bodyNamesPath(classes.body.id);
  return (
    <ClassesInspector
      item={classes}
      locked={locked}
      now={now}
      map={
        <CorpusHeadMap
          bodyId={classes.body.id}
          neighbors={classes.neighbors ?? NOT_COMPUTED}
          height={CLASSES_MAP_HEIGHT}
          legend
          aerial
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
