import type { Where } from '@skating/core';
import { useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { LakeMap } from './LakeMap';
import { QuestionBlock, SheetHint } from './SheetSection';
import type { SheetBody } from './useSheetBody';
import { POINT_RADIUS_M, patchWhere, WherePicker } from './WherePicker';

/** One selected chip's where question. */
export interface WhereCard {
  /** `field:key`, stable across renders. */
  id: string;
  label: string;
  where: Where | undefined;
  onChange: (where: Where | undefined) => void;
}

/**
 * The where cards on the phone (A10-6, founder call 2026-09-23): one card per selected ice or
 * surface chip, as a carousel with its peers visible — a row of card tabs, a dot on any card with
 * no answer yet, *Skip* and *Done* — and the lake with its compass ring **inside the block**, since
 * a phone has no second column for the ring to live in. A tap on an arc lights the sector; a tap
 * on the water, when *a point* is armed, places one. Any order; D187 is not a wizard.
 */
export function WhereCards({
  cards,
  body,
  open,
  onClose,
  activeId,
  onActivate,
}: {
  cards: readonly WhereCard[];
  body: SheetBody | null;
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  onActivate: (id: string) => void;
}) {
  const [placing, setPlacing] = useState(false);
  const active = useMemo(
    () => cards.find((c) => c.id === activeId) ?? cards[0] ?? null,
    [cards, activeId],
  );
  const index = active ? cards.findIndex((c) => c.id === active.id) : -1;
  if (!open || !active) return null;
  const next = () => {
    const after = cards[(index + 1) % cards.length];
    if (after && cards.length > 1) onActivate(after.id);
    else onClose();
  };
  const where = active.where;

  return (
    <QuestionBlock
      title={`Where is the ${active.label.toLowerCase()}?`}
      onDone={onClose}
      extra={
        <>
          {cards.length > 1 ? (
            <Text color="$foregroundMuted" fontFamily="$mono" fontSize={10}>
              {index + 1} OF {cards.length}
            </Text>
          ) : null}
          <Text
            color="$foregroundMuted"
            fontSize={11}
            fontWeight="700"
            letterSpacing={0.8}
            textTransform="uppercase"
            onPress={next}
            accessibilityRole="button"
            paddingHorizontal={6}
          >
            Skip
          </Text>
        </>
      }
    >
      {cards.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <XStack gap={4} borderBottomWidth={1} borderBottomColor="$border">
            {cards.map((card) => {
              const on = card.id === active.id;
              return (
                <XStack
                  key={card.id}
                  paddingHorizontal={10}
                  paddingTop={4}
                  paddingBottom={6}
                  marginBottom={-1}
                  borderBottomWidth={2}
                  borderBottomColor={on ? '$primary' : 'transparent'}
                  onPress={() => onActivate(card.id)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${card.label}${card.where === undefined ? ', no answer yet' : ''}`}
                >
                  <Text
                    color={on ? '$foreground' : '$foregroundMuted'}
                    fontSize={12.5}
                    fontWeight={on ? '600' : '400'}
                  >
                    {card.label}
                    {card.where === undefined ? (
                      <Text color="$warning" accessibilityElementsHidden>
                        {' '}
                        ·
                      </Text>
                    ) : null}
                  </Text>
                </XStack>
              );
            })}
          </XStack>
        </ScrollView>
      ) : null}
      {body?.silhouette ? (
        <LakeMap
          data={body.silhouette}
          sector={where?.sector}
          point={
            where?.point
              ? { ...where.point.coord, radiusMeters: where.point.radiusMeters }
              : undefined
          }
          height={190}
          ring
          onTapSector={(sector) => active.onChange(patchWhere(where, { sector }))}
          onTap={
            placing
              ? (coord) => {
                  active.onChange(
                    patchWhere(where, { point: { coord, radiusMeters: POINT_RADIUS_M } }),
                  );
                  setPlacing(false);
                }
              : undefined
          }
        />
      ) : null}
      <YStack key={active.id}>
        <WherePicker
          where={where}
          body={body}
          onChange={active.onChange}
          instrument
          placing={placing}
          onPlacing={setPlacing}
        />
      </YStack>
      <SheetHint>
        Tap a sector on the ring, a bay, or a point on the water.
        {placing ? ' Tap the water where you mean.' : ''}
      </SheetHint>
    </QuestionBlock>
  );
}
