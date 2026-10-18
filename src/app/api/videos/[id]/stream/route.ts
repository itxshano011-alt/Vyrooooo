import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { handleRoute, ApiError } from "@/lib/api-errors";
import { getViewableVideo } from "@/lib/video-reads";

/**
 * Signed playback URL for a video.
 *
 * The videos storage bucket is private (owner/admin only at the storage
 * layer; migration 0007), so browsers cannot fetch the bytes directly.
 * This route reuses the exact same visibility rule as GET
 * /api/videos/[id] (RLS can_view_video + API-level creator visibility via
 * getViewableVideo) and then mints a short-lived signed URL with the
 * service-role client. Anything the caller may not view surfaces as 404 --
 * the same as the detail endpoint -- so private videos are not
 * distinguishable by probing.
 */
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h

export const GET = handleRoute(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;
    const session = await getSessionUser();
    // Throws 404 when the video does not exist or is not viewable.
    const { video } = await getViewableVideo(id, session?.user.id ?? null);

    const { data, error } = await adminClient.storage
      .from("videos")
      .createSignedUrl(video.storage_path, SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      throw new ApiError(
        502,
        "internal_error",
        "Could not generate a playback URL"
      );
    }

    return NextResponse.json({
      url: data.signedUrl,
      expires_at: new Date(
        Date.now() + SIGNED_URL_TTL_SECONDS * 1000
      ).toISOString(),
    });
  }
);
