import { ConvexReactClient } from 'convex/react';
import { env } from './env';

/** Single Convex client for the app (D2), authed via Clerk in the provider tree. */
export const convex = new ConvexReactClient(env.convexUrl);
