import {
  type PostSheet,
  shareLanding,
  shareReportFor,
  sheetLabel,
  updateReport,
} from '@skating/core';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { type ShareIntentFile, useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { cachedBodyPolygon } from '../lib/bodyCache';
import { getTrack } from '../lib/draftStore';
import {
  readSharedPhotos,
  type SharedPhoto,
  stageShare,
  whenShareSettles,
} from '../lib/sharedPhotoFiles';
import { doorHref } from '../lib/sheetDoors';
import { toDraftPhoto } from '../lib/sheetPhotos';
import { getOnScreenReport, getSheet, updateSheet } from '../lib/sheetStore';

/**
 * Photos shared to Gli from another app (A10-8 §8.7, founder call 2026-09-28) — Google Photos, the
 * gallery, the camera. A share opens a report with the photos on it; if the open sheet already has
 * something in it, one question first: add them to it, or start a new one (core's `shareLanding`).
 * Mounted inside the signed-in tabs, so a share that arrives before sign-in waits for it (the
 * provider keeps it through the trip to the mail app for the code).
 *
 * Each share is taken off the module the moment its files are in hand — clearing does not delete
 * them — so a second share that arrives while the first is being read is queued, never wiped.
 * Renders nothing. Only photos are taken; a shared link or text is let go.
 */
export function ShareIntentHandler() {
  const router = useRouter();
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

    /** Where one share lands — resolved once the person has answered, if there is a question. */
    function land(photos: SharedPhoto[]): Promise<void> {
      const open = getSheet();
      if (open === null || shareLanding(open) === 'new') {
        return openNew(photos);
      }
      const n = photos.length;
      const title = n === 1 ? 'Add this photo' : `Add ${n} photos`;
      // An edit of a published report cannot be parked in Drafts, so a new report would be held
      // back behind it: the only door is this one.
      const editing = open.mode.kind === 'edit' && open.dirty;
      return new Promise((resolve) => {
        Alert.alert(
          title,
          editing
            ? `To the report you're editing (${sheetLabel(open)})? Save or cancel your changes first to start a new one.`
            : `To the report you have open (${sheetLabel(open)}), or to a new one?`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
            ...(editing
              ? []
              : [
                  {
                    text: 'New report',
                    onPress: () => void openNew(photos).finally(() => resolve()),
                  },
                ]),
            {
              text: 'Add to this one',
              onPress: () => void addToOpen(photos).finally(() => resolve()),
            },
          ],
          { cancelable: true, onDismiss: () => resolve() },
        );
      });
    }

    /**
     * Stage the share and open its door — and wait for that door to say how it ended, so a share
     * queued behind this one neither cancels it by navigating away nor asks about the report before
     * it. Only a door that never runs meets the backstop, and its photos stay staged.
     */
    async function openNew(photos: SharedPhoto[]): Promise<void> {
      const id = randomUUID();
      stageShare(id, photos);
      router.navigate(doorHref({ share: id }));
      await whenShareSettles(id, 120_000);
    }

    async function addToOpen(photos: SharedPhoto[]): Promise<void> {
      for (const photo of photos) {
        const post: PostSheet | null = getSheet();
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
