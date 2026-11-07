import { createFileRoute } from '@tanstack/react-router';
import { GooglePhotosCallback } from '../components/skater/auth/GooglePhotosCallback';

/** Where Google's consent returns for *From Google Photos*; see `GooglePhotosCallback`. */
export const Route = createFileRoute('/google-photos/callback')({
  component: GooglePhotosCallback,
});
