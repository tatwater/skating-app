import { Stack } from 'expo-router'

// Signed-out flow (D26). Rendered only when `!isSignedIn` (see app/_layout.tsx).
export default function AuthLayout() {
  return <Stack initialRouteName="sign-in" screenOptions={{ headerShown: false }} />
}
