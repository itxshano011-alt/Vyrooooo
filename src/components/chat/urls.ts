import { createClient } from "@/lib/supabase/client";

/**
 * Chat-specific media URL helpers. Avatars live in the public bucket, so a
 * plain public URL works; chat attachments are private and need a short-
 * lived signed URL (the read policy allows conversation participants).
 */

const supabase = createClient();

/** Public URL for an avatar storage path, or null when there is none. */
export function avatarUrl(avatarPath: string | null | undefined): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from("avatars").getPublicUrl(avatarPath);
  return data.publicUrl;
}

interface SignedEntry {
  url: string;
  expiresAt: number;
}

const signedCache = new Map<string, SignedEntry>();
const SIGNED_TTL_SECONDS = 55 * 60; // refresh before the hour expiry

/** Signed read URL for a chat-attachment storage path. Cached in memory. */
export async function attachmentUrl(path: string): Promise<string | null> {
  const cached = signedCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const { data, error } = await supabase.storage
    .from("chat-attachments")
    .createSignedUrl(path, SIGNED_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  signedCache.set(path, {
    url: data.signedUrl,
    expiresAt: Date.now() + SIGNED_TTL_SECONDS * 1000,
  });
  return data.signedUrl;
}

export type AttachmentKind = "image" | "video" | "pdf" | "other";

/** Classify an attachment by its file extension. */
export function attachmentKind(path: string): AttachmentKind {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "image";
  if (ext === "mp4") return "video";
  if (ext === "pdf") return "pdf";
  return "other";
}
