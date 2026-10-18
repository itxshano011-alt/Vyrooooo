import { z } from "zod";
import { isValidStoragePath } from "./db";

/**
 * Zod schemas for every API input. Route handlers validate with these before
 * touching the database. Field limits mirror the CHECK constraints in
 * supabase/migrations so a 400 is returned before Postgres ever complains.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Matches the profiles.username CHECK: ^[a-z0-9_]{3,24}$ (migration 0002). */
export const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .max(24, "Username must be at most 24 characters")
  .regex(
    /^[a-z0-9_]+$/,
    "Username may only contain lowercase letters, numbers, and underscores"
  );

const nonEmptyTrimmed = (max: number, field: string) =>
  z
    .string()
    .trim()
    .min(1, `${field} cannot be empty`)
    .max(max, `${field} must be at most ${max} characters`);

/**
 * Storage path shape "<user_id>/<uuid>.<ext>" enforced by migration 0007.
 * The owning folder must equal the caller's id; routes check that separately.
 */
export const storagePathSchema = z
  .string()
  .refine(isValidStoragePath, "Invalid storage path format");

// ---------------------------------------------------------------------------
// Auth / account
// ---------------------------------------------------------------------------

export const signupSchema = z.object({
  email: z.email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters"),
  username: usernameSchema.optional(),
  display_name: z.string().trim().max(50).optional(),
});

export const accountDeleteSchema = z.object({
  confirm: z.literal(true, "confirm must be true to delete your account"),
});

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const profileUpdateSchema = z.object({
  display_name: z.string().trim().max(50).nullable().optional(),
  /** Empty string clears the bio; null also clears it. */
  bio: z
    .string()
    .trim()
    .max(160, "Bio must be at most 160 characters")
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v)),
  website_url: z
    .string()
    .trim()
    .max(2048)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v))
    .refine(
      (v) => v === null || v === undefined || /^https?:\/\/.+/i.test(v),
      "Website must be a valid http(s) URL"
    ),
  username: usernameSchema.optional(),
  is_private: z.boolean().optional(),
  avatar_path: storagePathSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Videos & upload signing
// ---------------------------------------------------------------------------

export const uploadKindSchema = z.enum([
  "video",
  "thumbnail",
  "avatar",
  "chat-attachment",
]);
export type UploadKind = z.infer<typeof uploadKindSchema>;

/** Extension allowlists per upload kind (lowercase, no dot). */
export const UPLOAD_EXTENSIONS: Record<UploadKind, readonly string[]> = {
  video: ["mp4", "webm", "mov"],
  thumbnail: ["jpg", "jpeg", "png", "webp"],
  avatar: ["jpg", "jpeg", "png", "webp"],
  "chat-attachment": ["jpg", "jpeg", "png", "webp", "mp4", "pdf"],
};

export const uploadSignSchema = z.object({
  kind: uploadKindSchema,
  ext: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .regex(/^[a-z0-9]+$/i, "Extension must be alphanumeric")
    .transform((v) => v.toLowerCase()),
});

export const videoCreateSchema = z.object({
  caption: z
    .string()
    .trim()
    .max(500, "Caption must be at most 500 characters")
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v)),
  storage_path: storagePathSchema,
  thumbnail_path: storagePathSchema.nullable().optional(),
  duration_seconds: z
    .number()
    .int()
    .min(0)
    .max(86400)
    .nullable()
    .optional(),
  visibility: z.enum(["public", "private"]).default("public"),
});

export const videoUpdateSchema = z
  .object({
    caption: z
      .string()
      .trim()
      .max(500, "Caption must be at most 500 characters")
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    visibility: z.enum(["public", "private"]).optional(),
  })
  .refine((v) => v.caption !== undefined || v.visibility !== undefined, {
    message: "Provide caption and/or visibility to update",
  });

// ---------------------------------------------------------------------------
// Social: follows, likes, comments, hashtags
// ---------------------------------------------------------------------------

export const followSchema = z.object({
  user_id: z.uuid("Invalid user id"),
});

export const commentCreateSchema = z.object({
  body: nonEmptyTrimmed(500, "Comment"),
});

export const commentUpdateSchema = z.object({
  body: nonEmptyTrimmed(500, "Comment"),
});

/** A single normalized hashtag: lowercase, no '#', [a-z0-9_]{1,64}. */
export const hashtagSchema = z
  .string()
  .trim()
  .min(1)
  .max(65)
  .transform((v) => v.replace(/^#+/, "").toLowerCase())
  .refine(
    (v) => /^[a-z0-9_]{1,64}$/.test(v),
    "Hashtag may only contain lowercase letters, numbers, and underscores"
  );

/** Extract normalized tags from a caption (server-side tag parsing). */
export function extractHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const found = new Set<string>();
  for (const match of caption.matchAll(/#([A-Za-z0-9_]{1,64})/g)) {
    const tag = (match[1] ?? "").toLowerCase();
    if (/^[a-z0-9_]{1,64}$/.test(tag)) found.add(tag);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

export const conversationCreateSchema = z.object({
  user_id: z.uuid("Invalid user id"),
});

export const messageCreateSchema = z.object({
  body: nonEmptyTrimmed(2000, "Message"),
  attachment_path: storagePathSchema.nullable().optional(),
});

export const conversationReadSchema = z.object({
  /** Mark every message up to and including this one as read. */
  up_to_message_id: z.uuid("Invalid message id"),
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationsMarkReadSchema = z.object({
  ids: z.array(z.uuid("Invalid notification id")).min(1).max(100),
});

// ---------------------------------------------------------------------------
// Blocks & reports
// ---------------------------------------------------------------------------

export const blockSchema = z.object({
  user_id: z.uuid("Invalid user id"),
});

export const reportSchema = z.object({
  target_type: z.enum(["user", "video", "comment"]),
  target_id: z.uuid("Invalid target id"),
  reason: nonEmptyTrimmed(1000, "Reason"),
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminReportUpdateSchema = z.object({
  status: z.enum(["reviewed", "actioned", "dismissed"]),
  note: z.string().trim().max(1000).optional(),
});

export const adminModerateSchema = z.object({
  target_type: z.enum(["video", "comment", "user"]),
  target_id: z.uuid("Invalid target id"),
  /** remove: take down video/comment. restore: clear a video flag. ban: delete the user account (cascades). */
  action: z.enum(["remove", "restore", "ban"]),
});

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

export const paginationSchema = z.object({
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
});
export type PaginationParams = z.infer<typeof paginationSchema>;

export const feedTypeSchema = z.enum(["foryou", "following", "latest"]);

export const searchSchema = z.object({
  q: z.string().trim().min(2, "Search query must be at least 2 characters").max(100),
  type: z.enum(["users", "hashtags", "videos"]).default("users"),
});
