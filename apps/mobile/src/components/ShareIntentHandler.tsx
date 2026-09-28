import { shareLanding, shareReportFor, sheetLabel, updateReport } from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { cachedBodyPolygon } from '../lib/bodyCache';
import { getTrack } from '../lib/draftStore';
import { readSharedPhotos, type SharedPhoto, stageShare } from '../lib/sharedPhotoFiles';
import { doorHref } from '../lib/sheetDoors';
import { toDraftPhoto } from '../lib/sheetPhotos';
import { getOnScreenReport, getSheet, updateSheet } from '../lib/sheetStore';

/**
 * Photos shared to Gli from another app (A10-8 §8.7, founder call 2026-09-28) — Google Photos, the
 * gallery, the camera. A share opens a report with the photos on it; if the open sheet already has
 * something in it, one question first: add them to it, or start a new one (core's `shareLanding`).
 * Mounted inside the signed-in tabs, so a share that arrives before sign-in waits for it.
 *
 * Renders nothing. Only photos are taken; a shared link or text is let go.
 */
export function ShareIntentHandler() {
  const router = useRouter();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const handling = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || handling.current) return;
    handling.current = true;
    const files = shareIntent.files ?? [];
    void readSharedPhotos(files)
      .then((photos) => {
        // Read before letting the intent go: its files are the ones just read.
        resetShareIntent();
        if (photos.length === 0) return;
        const open = getSheet();
        if (shareLanding(open) === 'new' || open === null) {
          openNew(photos);
          return;
        }
        const n = photos.length;
        Alert.alert(
          n === 1 ? 'Add this photo' : `Add ${n} photos`,
          `To the report you have open (${sheetLabel(open)}), or to a new one?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'New report', onPress: () => openNew(photos) },
            { text: 'Add to this one', onPress: () => void addToOpen(photos) },
          ],
        );
      })
      .catch(() => resetShareIntent())
      .finally(() => {
        handling.current = false;
      });

    function openNew(photos: SharedPhoto[]) {
      const id = randomUUID();
      stageShare(id, photos);
      router.navigate(doorHref({ share: id }));
    }

    async function addToOpen(photos: SharedPhoto[]) {
      for (const photo of photos) {
        const post = getSheet();
        if (!post) break;
        const reportId = shareReportFor(post, photo, getOnScreenReport());
        const report = post.reports.find((r) => r.id === reportId);
        if (!report) continue;
        const lake = {
          outline: report.sheet.waterBodyId ? cachedBodyPolygon(report.sheet.waterBodyId) : null,
          track: (report.trackDraftId ? (getTrack(report.trackDraftId)?.points ?? []) : []).map(
            (p) => ({ lat: p.lat, lng: p.lng, timestamp: p.t }),
          ),
        };
        try {
          const draft = await toDraftPhoto(photo, lake);
          updateSheet((p) =>
            updateReport(p, report.id, (r) => ({ ...r, photos: [...r.photos, draft] })),
          );
        } catch {
          // One unreadable file does not cost the others.
        }
      }
      router.navigate('/report');
    }
  }, [hasShareIntent, shareIntent, resetShareIntent, router]);

  return null;
}
