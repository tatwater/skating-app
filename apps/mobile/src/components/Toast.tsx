import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AccessibilityInfo, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Paragraph, YStack } from 'tamagui';
import {
  dismissToast,
  EMPTY_TOASTS,
  pushToast,
  TOAST_MS,
  type ToastQueue,
} from '../lib/toastQueue';

/**
 * The phone's toast (D268): every server refusal is shown here, never inline — a client-side field
 * problem stays the amber line under its field. One at a time over the bottom of the screen, gone
 * after a few seconds or on a tap, and read out by a screen reader as it appears.
 *
 * Mounted once, at the root navigator, over every screen. Drawn from the app's existing tokens (the
 * inverted pair, so it reads as something on top of the page in either theme) until the re-skin.
 */

type Show = (message: string) => void;

const ToastContext = createContext<Show | null>(null);

/** Show a toast. Outside the provider it does nothing, so a screen never crashes for want of one. */
export function useToast(): Show {
  return useContext(ToastContext) ?? noop;
}

function noop() {}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ToastQueue>(EMPTY_TOASTS);
  const nextId = useRef(1);
  const insets = useSafeAreaInsets();

  const show = useCallback<Show>((message) => {
    const id = nextId.current++;
    setQueue((q) => pushToast(q, { id, message }));
  }, []);

  const current = queue.current;
  useEffect(() => {
    if (current === null) return;
    AccessibilityInfo.announceForAccessibility(current.message);
    const timer = setTimeout(() => setQueue((q) => dismissToast(q, current.id)), TOAST_MS);
    return () => clearTimeout(timer);
  }, [current]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {current !== null ? (
        <YStack
          position="absolute"
          left={0}
          right={0}
          bottom={insets.bottom + 96}
          paddingHorizontal="4"
          pointerEvents="box-none"
        >
          <Pressable
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            accessibilityHint="Double tap to dismiss"
            onPress={() => setQueue((q) => dismissToast(q, current.id))}
          >
            <YStack
              backgroundColor="foreground"
              borderRadius="3"
              paddingHorizontal="4"
              paddingVertical="3"
            >
              <Paragraph color="background" fontSize={14}>
                {current.message}
              </Paragraph>
            </YStack>
          </Pressable>
        </YStack>
      ) : null}
    </ToastContext.Provider>
  );
}
