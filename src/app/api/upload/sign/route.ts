import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireProfile } from "@/lib/auth";
import {
  handleRoute,
  fromPostgrestError,
  badRequest,
  validationError,
} from "@/lib/api-errors";
import {
  uploadSignSchema,
  UPLOAD_EXTENSIONS,
  type UploadKind,
} from "@/lib/validation";
import {
  uploadLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";

const BUCKET_FOR_KIND: Record<UploadKind, string> = {
  video: "videos",
  thumbnail: "thumbnails",
  avatar: "avatars",
  "chat-attachment": "chat-attachments",
};

/**
 * Signed upload URL TTL. This version of @supabase/storage-js mints upload
 * URLs valid for 2 hours with no per-call TTL option, so the value below
 * documents the SDK behavior rather than configuring it.
 */
const SIGNED_URL_TTL_SECONDS = 7200;

/**
 * Issue a signed upload URL for a direct browser-to-storage upload.
 *
 * The storage path is computed server-side as <uid>/<uuid>.<ext>, which is
 * exactly the shape the storage RLS policies in migration 0007 require, so
 * a caller cannot write outside their own prefix. The extension is checked
 * against a per-kind allowlist (video: mp4/webm/mov).
 *
 * Flow: client calls this -> uploads the file bytes to upload_url with a
 * PUT -> then calls POST /api/videos (or PATCH /api/profiles/me,
 * POST /api/conversations/[id]/messages) referencing the returned path.
 */
export const POST = handleRoute(async (request: NextRequest) => {
  const { user } = await requireProfile();

  enforceRateLimit(uploadLimiter, rateLimitKey(user.id, request));

  const parsed = uploadSignSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);
  const { kind, ext } = parsed.data;

  const allowed = UPLOAD_EXTENSIONS[kind];
  if (!allowed.includes(ext)) {
    throw badRequest(
      `Extension .${ext} is not allowed for ${kind} uploads (allowed: ${allowed.join(", ")})`
    );
  }

  const bucket = BUCKET_FOR_KIND[kind];
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  // The admin client mints the URL because it must be valid regardless of
  // the caller's storage RLS state; the path itself is unforgeable since we
  // generated it, and the upload still lands under the caller's prefix.
  const { data, error } = await adminClient.storage
    .from(bucket)
    .createSignedUploadUrl(path);
  if (error) throw fromPostgrestError(error, "Could not create upload URL");
  if (!data) throw badRequest("Could not create upload URL");

  return NextResponse.json({
    bucket,
    path,
    upload_url: data.signedUrl,
    token: data.token,
    expires_in: SIGNED_URL_TTL_SECONDS,
  });
});
