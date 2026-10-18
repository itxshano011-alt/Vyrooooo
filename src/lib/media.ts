"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage URL resolution for VYRO media.
 *
 * Bucket visibility (migration 0007):
 * - avatars, thumbnails: PUBLIC read -> plain public URLs.
 * - videos: PRIVATE (owner/admin only at the storage layer). Playback goes
 *   through GET /api/videos/[id]/stream, which reuses the API visibility
 *   rule (RLS can_view_video + creator visibility) and mints a short-lived
 *   signed URL with the service-role client, so public videos play for any
 *   viewer -- including logged-out users -- exactly like the detail page
 *   allows. No signed-URL minting happens client-side for videos.
 */

export class VideoUrlError extends Error {
  readonly kind: "not_found" | "forbidden" | "unknown";
  constructor(kind: VideoUrlError["kind"], message: string) {
    super(message);
    this.name = "VideoUrlError";
    this.kind = kind;
  }
}

/** Public URL for a path in a public bucket (avatars, thumbnails). */
export function publicBucketUrl(
  supabase: SupabaseClient,
  bucket: "avatars" | "thumbnails",
  path: string | null | undefined
): string | null {
  if (!path) return null;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

export function avatarUrl(supabase: SupabaseClient, path: string | null | undefined): string | null {
  return publicBucketUrl(supabase, "avatars", path);
}

export function thumbnailUrl(
  supabase: SupabaseClient,
  path: string | null | undefined
): string | null {
  return publicBucketUrl(supabase, "thumbnails", path);
}

interface StreamResponse {
  url: string;
  expires_at: string;
}

async function streamErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? "This video cannot be played right now";
  } catch {
    return "This video cannot be played right now";
  }
}

/**
 * Playable URL for a video, via the server-side stream endpoint.
 *
 * The endpoint enforces the same visibility rule as the video detail API
 * (404 for anything the viewer may not see) and returns a short-lived
 * signed URL, so this works for any viewable video -- own, public, or
 * logged-out -- without any client-side storage credentials.
 */
export async function resolveVideoUrl(videoId: string): Promise<string> {
  const res = await fetch(
    `/api/videos/${encodeURIComponent(videoId)}/stream`,
    { credentials: "include" }
  );
  if (res.status === 404) {
    throw new VideoUrlError("not_found", "This video is not available");
  }
  if (!res.ok) {
    throw new VideoUrlError("forbidden", await streamErrorMessage(res));
  }
  const data = (await res.json()) as StreamResponse;
  if (!data?.url) {
    throw new VideoUrlError("unknown", "This video cannot be played right now");
  }
  return data.url;
}

// ---------------------------------------------------------------------------
// Signed upload with real progress (browser -> storage, direct PUT).
// ---------------------------------------------------------------------------

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

/**
 * PUT a file to a signed upload URL with progress events.
 * Returns a cleanup/abort handle. The signed URL returned by
 * POST /api/upload/sign already carries the token as a query param, so a
 * plain PUT with the right Content-Type is sufficient.
 */
export function uploadWithProgress(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onProgress: (progress: UploadProgress) => void,
  onDone: () => void,
  onError: (error: Error) => void
): { abort: () => void } {
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", uploadUrl, true);
  xhr.setRequestHeader("Content-Type", contentType);
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) {
      const percent = event.total > 0 ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : 0;
      onProgress({ loaded: event.loaded, total: event.total, percent });
    }
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      onDone();
    } else {
      onError(new Error(`Upload failed (HTTP ${xhr.status})`));
    }
  };
  xhr.onerror = () => onError(new Error("Upload failed: network error"));
  xhr.onabort = () => onError(new Error("Upload cancelled"));
  xhr.send(file);
  return { abort: () => xhr.abort() };
}

/** Read video metadata (duration, dimensions) from a File without uploading. */
export function probeVideoFile(file: File): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.src = "";
    };
    video.onloadedmetadata = () => {
      const result = {
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      cleanup();
      if (!Number.isFinite(result.duration)) {
        reject(new Error("Could not read video duration"));
      } else {
        resolve(result);
      }
    };
    video.onerror = () => {
      cleanup();
      reject(new Error("This file could not be read as a video"));
    };
    video.src = url;
  });
}

/**
 * Capture the current frame of a <video> element as a JPEG blob for use as
 * the video's thumbnail. Returns null when the video is not ready.
 */
export function captureVideoFrame(video: HTMLVideoElement, maxWidth = 720): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (video.readyState < 2 || video.videoWidth === 0) {
      resolve(null);
      return;
    }
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.8);
  });
}
