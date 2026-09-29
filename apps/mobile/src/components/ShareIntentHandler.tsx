import { api } from '@skating/convex/api';
import {
  resolveShowPutInDefault,
  shareLanding,
  shareReportFor,
  sheetLabel,
  updateReport,
} from '@skating/core';
import { useQuery } from 'convex/react';
import { useRouter } from 'expo-router';
import { type ShareIntentFile, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { cachedBodyPolygon } from '../lib/bodyCache';
import { parkForNewDoor } from '../lib/doorParking';
import { readSharedPhotos, type SharedPhoto } from '../lib/sharedPhotoFiles';
import { shareSheet } from '../lib/shareSheet';
import { saveSheetAsDraft } from '../lib/sheetActions';
import { doorHref } from '../lib/sheetDoors';
import { toDraftPhoto, trackPointsFor } from '../lib/sheetPhotos';
import { getOnScreenReport, getSheet, setSheet, updateSheet } from '../lib/sheetStore';

type Choice = 'add' | 'new' | 'cancel';

/** Saves of an open sheet that keeps changing before a share gives up replacing it. */
const PARK_TRIES = 3;

/**
 * Photos shared to Gli from another app (A10-8 §8.7, founder call 2026-09-28) — Google Photos, the
 * gallery, the camera. A share opens a report with the photos on it; if the open sheet already has
 * something in it, one question first: add them to it, or start a new one (core's `shareLanding`).
 * Mounted inside the signed-in tabs, so a share that arrives before sign-in waits for it (the
 * provider keeps it through the trip to the mail app for the code).
 *
 * **Each share is finished here before the next is looked at.** The handler builds the new report
 * itself, sets aside what was open exactly as a door would (`parkForNewDoor`: to Drafts, or held
 * with a reason), puts the report on screen, and only then navigates — the Report tab adopts it
 * (`?share=`). No share waits on another screen to say how it went, so none can be stranded
 * between the two: a share lands, or the person is told why it could not and chooses. (The first
 * build routed shares through the tab's door and waited on it; three review rounds found three ways
 * that handshake lost photos.)
 *
 * Each share is taken off the module the moment its files are in hand — clearing does not delete
 * them — so a second share that arrives meanwhile is queued, never wiped. Renders nothing. Only
 * photos are taken; a shared link or text is let go.
 */
export function ShareIntentHandler() {
  const router = useRouter();
  const profile = useQuery(api.profiles.current, {});
  const showPutInDefault = useRef<boolean | undefined>(undefined);
  showPutInDefault.current = profile?.showPutInDefault;
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const queue = useRef<ShareIntentFile[][]>([]);
  const running = useRef(false);

  useEffect(() => {
    if (!hasShareIntent) return;
    queue.current.push(shareIntent.files ?? []);
    resetShareIntent();
    if (running.current) return;
    running.current = true;
    void (async () => {
      try {
        for (let files = queue.current.shift(); files; files = queue.current.shift()) {
          const photos = await readSharedPhotos(files).catch(() => []);
          if (photos.length > 0) await land(photos);
        }
      } finally {
        running.current = false;
      }
    })();

    async function land(photos: SharedPhoto[]): Promise<void> {
      const open = getSheet();
      const choice: Choice =
        open === null || shareLanding(open) === 'new'
          ? 'new'
          : await ask(
              photos.length,
              `To the report you have open (${sheetLabel(open)}), or to a new one?`,
              true,
            );
      if (choice === 'add') await addToOpen(photos);
      else if (choice === 'new') await startNew(photos);
    }

    /**
     * A new report with the photos on it. Built first (reading photos can take seconds), then what is
     * open set aside as any door does, then shown — so nothing typed on the open sheet meanwhile is
     * lost to the swap.
     */
    async function startNew(photos: SharedPhoto[]): Promise<void> {
      const sheet = await shareSheet(
        photos,
        resolveShowPutInDefault(showPutInDefault.current),
        Date.now(),
      );
      const built = sheet.reports.flatMap((r) => r.photos);
      if (built.length === 0) {
        Alert.alert(
          "Couldn't read those photos",
          'Try sharing them again, or add them from the report.',
        );
        return;
      }
      // Set aside what is open — and again if it changed while it was being saved (the save copies
      // photos, which takes a moment the person can type through): only a sheet whose every edit is
      // in Drafts is replaced. One that will not hold still is left on screen, and says so.
      for (let tries = 0; ; tries += 1) {
        const before = getSheet();
        const parking = await parkForNewDoor(before, Date.now(), saveSheetAsDraft);
        if (parking.kind === 'held') {
          // What is open can't be set aside (an edit with unsaved changes, a draft that won't
          // save): the built report goes, and the one door left is offered.
          if ((await ask(photos.length, parking.message, false)) === 'add') await addToOpen(photos);
          return;
        }
        if (getSheet() === before) break;
        if (tries >= PARK_TRIES) {
          Alert.alert(
            'Your report is still changing',
            'Share the photos again once you have finished, and they will open in a new report.',
          );
          return;
        }
      }
      setSheet(sheet);
      router.navigate(doorHref({ share: sheet.draftId }));
    }

    async function addToOpen(photos: SharedPhoto[]): Promise<void> {
      let added = 0;
      for (const photo of photos) {
        const post = getSheet();
        if (!post) break;
        const reportId = shareReportFor(post, photo, getOnScreenReport());
        const report = post.reports.find((r) => r.id === reportId);
        if (!report) continue;
        const lake = {
          outline: report.sheet.waterBodyId ? cachedBodyPolygon(report.sheet.waterBodyId) : null,
          track: trackPointsFor(report.trackDraftId),
        };
        try {
          const draft = await toDraftPhoto(photo, lake);
          // The sheet changed under the read: this photo has nowhere to go.
          if (getSheet()?.draftId !== post.draftId) continue;
          updateSheet((p) =>
            updateReport(p, report.id, (r) => ({ ...r, photos: [...r.photos, draft] })),
          );
          added += 1;
        } catch {
          // One unreadable file does not cost the others.
        }
      }
      if (added < photos.length) {
        Alert.alert(
          added === 0 ? "Couldn't add those photos" : `Added ${added} of ${photos.length}`,
          'The rest could not be read. Add them from the report if you have them.',
        );
      }
      router.navigate('/report');
    }

    /** One question, answered by a tap — never by a timeout. */
    function ask(n: number, message: string, offerNew: boolean): Promise<Choice> {
      return new Promise((resolve) => {
        Alert.alert(
          n === 1 ? 'Add this photo' : `Add ${n} photos`,
          message,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
            ...(offerNew ? [{ text: 'New report', onPress: () => resolve('new') }] : []),
            { text: 'Add to this one', onPress: () => resolve('add') },
          ],
          { cancelable: true, onDismiss: () => resolve('cancel') },
        );
      });
    }
  }, [hasShareIntent, shareIntent, resetShareIntent, router]);

  return null;
}
