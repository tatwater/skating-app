import { Image } from 'react-native';
import { Text, YStack } from 'tamagui';

/**
 * Round avatar with an initial fallback when the user has no Clerk image — extracted into its own
 * module (mirroring web's `Avatar.tsx`) so `TrustDisplay` can wrap it without an import cycle
 * (`ProfileView` → `TrustDisplay` → `Avatar`).
 */
export function Avatar({
  displayName,
  imageUrl,
  size = 64,
}: {
  displayName: string;
  imageUrl?: string;
  size?: number;
}) {
  if (imageUrl) {
    return (
      <Image
        source={{ uri: imageUrl }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel={displayName}
      />
    );
  }
  return (
    <YStack
      width={size}
      height={size}
      borderRadius={size / 2}
      backgroundColor="$surfaceMuted"
      alignItems="center"
      justifyContent="center"
    >
      <Text color="$foregroundMuted" fontSize={size / 2.5} fontWeight="600">
        {displayName.trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </YStack>
  );
}
