import { Stack } from 'expo-router';

export const unstable_settings = { anchor: 'sign-in' };

// Signed-out flow (D26). Rendered only when `!isSignedIn` (see app/_layout.tsx).
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
