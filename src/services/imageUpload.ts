import { supabase, isSupabaseConfigured } from './supabase';

/**
 * Photo uploads now go through the `upload-image` Edge Function.
 *
 * The ImgBB API key lives in Supabase Edge Function secrets, so it is never part
 * of the JavaScript bundle and cannot be read in the browser. The function also
 * enforces the size, file-type and per-network limits server-side.
 */

export interface UploadedImage {
  url: string;
  display_url: string;
  thumb_url: string;
  /** Seconds until ImgBB removes the hosted copy (matches the 48h card life). */
  expires_in: number;
}

/** The card's own lifespan: auto-expire the hosted image at the same time. */
export const CARD_IMAGE_EXPIRATION_SECONDS = 172800;

const readFunctionError = async (error: unknown, fallback: string): Promise<string> => {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error.trim()) return body.error;
    } catch {
      /* fall through to the generic message */
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
};

/** Uploads one photo and returns the hosted details. Throws on any failure. */
export const uploadCardImage = async (
  file: File,
  expirationSeconds: number = CARD_IMAGE_EXPIRATION_SECONDS,
): Promise<UploadedImage> => {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Photo uploads are unavailable because this site is not connected to Supabase.',
    );
  }

  const formData = new FormData();
  formData.append('image', file);
  formData.append('expiration', String(expirationSeconds));

  // supabase-js forwards FormData untouched (it lets the browser set the
  // multipart boundary), so no Content-Type header is set here.
  const { data, error } = await supabase.functions.invoke('upload-image', {
    body: formData,
  });

  if (error) {
    throw new Error(await readFunctionError(error, 'We could not upload that photo. Please try again.'));
  }

  if (!data?.success || !data.url) {
    throw new Error(
      typeof data?.error === 'string' && data.error
        ? data.error
        : 'We could not upload that photo. Please try again.',
    );
  }

  return {
    url: String(data.url),
    display_url: String(data.display_url ?? data.url),
    thumb_url: String(data.thumb_url ?? ''),
    expires_in: Number(data.expires_in ?? expirationSeconds),
  };
};

/** Convenience wrapper for callers that only need the hosted URL. */
export const uploadCardImageUrl = async (
  file: File,
  expirationSeconds: number = CARD_IMAGE_EXPIRATION_SECONDS,
): Promise<string> => (await uploadCardImage(file, expirationSeconds)).url;
