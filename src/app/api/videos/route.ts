import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import { config } from "@/lib/config";
import {
  handleRoute,
  fromPostgrestError,
  badRequest,
  forbidden,
  validationError,
} from "@/lib/api-errors";
import { videoCreateSchema } from "@/lib/validation";
import {
  uploadLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";
import { syncVideoHashtags } from "@/lib/video-hashtags";
import {
  enrichVideos,
  storagePathOwner,
  type ReadContext,
  type Video,
} from "@/lib/db";

/**
 * Confirm that a just-uploaded storage object exists before referencing it
 * from a database row. Prevents dangling rows when the client calls this
 * endpoint without completing the storage upload.
 */
async function assertObjectExists(
  bucket: string,
  path: string,
  ownerId: string
): Promise<void> {
  const fileName = path.split("/")[1];
  if (!fileName) throw badRequest("Invalid storage path");
  const { data, error } = await adminClient.storage
    .from(bucket)
    .list(ownerId, { search: fileName, limit: 1 });
  if (error) throw fromPostgrestError(error);
  if (!data || data.length === 0) {
    throw badRequest(
      `No uploaded file found at ${path}. Upload the file to storage first, then create the video.`
    );
  }
}

/**
 * Create a video row AFTER the client has uploaded the file bytes to
 * storage via a signed URL from POST /api/upload/sign.
 *
 * HONEST LIMITATION, READ BEFORE "FIXING": there is no transcoding pipeline
 * in this codebase. The row is created with processing_status='published'
 * (the migration default) immediately, so the video is viewable as soon as
 * the upload finishes. A real pipeline would insert as 'pending' through a
 * service_role worker and promote it after transcoding -- that worker does
 * not exist yet.
 */
export const POST = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  enforceRateLimit(uploadLimiter, rateLimitKey(user.id, request));

  const parsed = videoCreateSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const input = parsed.data;

  // The referenced objects must live under the caller's own prefix.
  if (storagePathOwner(input.storage_path) !== user.id) {
    throw forbidden("storage_path must be a file you uploaded");
  }
  if (
    input.thumbnail_path !== undefined &&
    input.thumbnail_path !== null &&
    storagePathOwner(input.thumbnail_path) !== user.id
  ) {
    throw forbidden("thumbnail_path must be a file you uploaded");
  }

  // Server-side enforcement of the configured duration cap (.env.example
  // documents this as enforced server-side, not just client-side UX).
  if (
    input.duration_seconds !== undefined &&
    input.duration_seconds !== null &&
    input.duration_seconds > config.videoLimits.maxVideoSeconds
  ) {
    throw badRequest(
      `Video duration exceeds the ${config.videoLimits.maxVideoSeconds}s limit`
    );
  }

  // The upload must have actually landed in storage.
  await assertObjectExists("videos", input.storage_path, user.id);
  if (input.thumbnail_path) {
    await assertObjectExists("thumbnails", input.thumbnail_path, user.id);
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("videos")
    .insert({
      creator_id: user.id,
      caption: input.caption ?? null,
      storage_path: input.storage_path,
      thumbnail_path: input.thumbnail_path ?? null,
      duration_seconds: input.duration_seconds ?? null,
      visibility: input.visibility,
    })
    .select("*")
    .single();
  if (error) throw fromPostgrestError(error, "Could not create video");

  await syncVideoHashtags(supabase, (data as Video).id, input.caption ?? null);

  const ctx: ReadContext = { userClient: supabase, adminClient, viewerId: user.id };
  const [enriched] = await enrichVideos(ctx, [data as Video]);

  return NextResponse.json({ video: enriched ?? data }, { status: 201 });
});
