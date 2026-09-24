import { api } from '@skating/convex/api';
import { searchQueryArg, waterBodyDisplayName } from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect, useState } from 'react';
import { type LakeHit, LakeSearchBox } from '../LakeSearch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

/**
 * Pick the lake a Report is about (A10 §4.3): the catalog's own search, the same box the map uses.
 *
 * A bay hit resolves to its **parent** lake, as it does everywhere else — a sub-area is a name on a
 * lake, not a body a report keys on (§2.4). Which bay was meant is said on the chips, as a `where`.
 */
export function BodyPicker({
  open,
  onClose,
  onPick,
  title = 'Which lake?',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (body: { waterBodyId: string; name: string }) => void;
  title?: string;
}) {
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const id = setTimeout(() => setDebounced(text), 150);
    return () => clearTimeout(id);
  }, [text]);

  const arg = searchQueryArg(debounced);
  const results = useQuery(api.waterBodies.searchByName, open ? arg : 'skip');

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <LakeSearchBox
          items={results ?? []}
          inputValue={text}
          onInputValueChange={setText}
          emptyVisible={arg !== 'skip' && results !== undefined && results.length === 0}
          onSelect={(hit: LakeHit) => {
            setText('');
            onPick({
              waterBodyId: hit.waterBodyId,
              name: waterBodyDisplayName(
                hit.kind === 'subArea' ? (hit.parentName ?? hit.name) : hit.name,
              ),
            });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
