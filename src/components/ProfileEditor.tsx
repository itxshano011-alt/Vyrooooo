"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { createClient } from "@/lib/supabase/client";
import type { ProfileWithCounts } from "@/lib/db";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { avatarUrl, uploadWithProgress } from "@/lib/media";
import { useUsernameCheck } from "@/hooks/useUsernameCheck";
import { useToast } from "@/components/ui/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { FieldError } from "@/components/ui/FieldError";
import { Button } from "@/components/ui/Button";
import { Avatar } from "@/components/ui/Avatar";

interface SignResponse {
  bucket: string;
  path: string;
  upload_url: string;
  token: string;
  expires_in: number;
}

/**
 * Edit-profile dialog (owner only).
 *
 * Props:
 *   profile: current ProfileWithCounts (prefills the form).
 *   open, onClose.
 *   onSaved(updatedProfile): called with the PATCH /api/profiles/me response
 *     so the page can refresh without refetching.
 *
 * Edits display_name, username (live availability check, skips when
 * unchanged), bio, website_url, is_private toggle, and avatar (sign ->
 * PUT to the avatars bucket, then save the returned path).
 */
export function ProfileEditor({
  profile,
  open,
  onClose,
  onSaved,
}: {
  profile: ProfileWithCounts;
  open: boolean;
  onClose: () => void;
  onSaved: (profile: ProfileWithCounts) => void;
}) {
  const { toast } = useToast();
  const supabase = useMemo(() => createClient(), []);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<{
    display_name: string;
    username: string;
    bio: string;
    website_url: string;
    is_private: boolean;
  }>({
    defaultValues: {
      display_name: profile.display_name ?? "",
      username: profile.username,
      bio: profile.bio ?? "",
      website_url: profile.website_url ?? "",
      is_private: profile.is_private,
    },
  });

  const [avatarPath, setAvatarPath] = useState<string | null>(profile.avatar_path);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  const usernameValue = watch("username");
  const { state: usernameState } = useUsernameCheck(usernameValue, profile.username);

  useEffect(() => {
    if (open) {
      reset({
        display_name: profile.display_name ?? "",
        username: profile.username,
        bio: profile.bio ?? "",
        website_url: profile.website_url ?? "",
        is_private: profile.is_private,
      });
      setAvatarPath(profile.avatar_path);
      setAvatarError(null);
    }
  }, [open, profile, reset]);

  const onAvatarFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = e.target.files?.[0];
      e.target.value = "";
      if (!picked) return;
      setAvatarError(null);
      if (!picked.type.startsWith("image/")) {
        setAvatarError("Please choose an image file.");
        return;
      }
      if (picked.size > 5 * 1024 * 1024) {
        setAvatarError("Avatar must be at most 5 MB.");
        return;
      }
      const ext = ({ jpg: "jpg", jpeg: "jpg", png: "png", webp: "webp", gif: "png" } as Record<string, string>)[
        (picked.type.split("/")[1] ?? "").toLowerCase()
      ];
      if (!ext) {
        setAvatarError("Unsupported image format. Use JPG, PNG, or WebP.");
        return;
      }
      setAvatarUploading(true);
      try {
        const sign = await apiRequest<SignResponse>("/api/upload/sign", {
          method: "POST",
          json: { kind: "avatar", ext },
        });
        await new Promise<void>((resolve, reject) => {
          uploadWithProgress(
            sign.upload_url,
            picked,
            picked.type,
            () => {},
            () => resolve(),
            (err) => reject(err)
          );
        });
        setAvatarPath(sign.path);
        toast("Avatar uploaded", "success");
      } catch (err) {
        setAvatarError(errorMessage(err, "Could not upload avatar"));
      } finally {
        setAvatarUploading(false);
      }
    },
    [toast]
  );

  const onSubmit = async (values: {
    display_name: string;
    username: string;
    bio: string;
    website_url: string;
    is_private: boolean;
  }) => {
    const username = values.username.trim().toLowerCase();
    if (username !== profile.username && usernameState === "taken") {
      setError("username", { message: "This username is taken" });
      return;
    }
    try {
      const updated = await apiRequest<{ profile: ProfileWithCounts }>("/api/profiles/me", {
        method: "PATCH",
        json: {
          display_name: values.display_name.trim() || null,
          username: username !== profile.username ? username : undefined,
          bio: values.bio.trim() || null,
          website_url: values.website_url.trim() || null,
          is_private: values.is_private,
          avatar_path: avatarPath,
        },
      });
      toast("Profile updated", "success");
      onSaved(updated.profile);
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Could not update profile"), "error");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Edit profile" wide>
      <form onSubmit={handleSubmit((v) => void onSubmit(v))} className="flex flex-col gap-4">
        <div className="flex items-center gap-4">
          <Avatar src={avatarUrl(supabase, avatarPath)} name={watch("username")} size="lg" />
          <div>
            <label
              htmlFor="avatar-input"
              className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 text-sm font-semibold text-ink hover:border-[var(--color-brand-blue)]"
            >
              {avatarUploading ? "Uploading..." : "Change avatar"}
            </label>
            <input
              id="avatar-input"
              type="file"
              accept="image/*"
              className="sr-only"
              disabled={avatarUploading}
              onChange={(e) => void onAvatarFile(e)}
            />
            <p className="mt-1 text-xs text-ink-muted">JPG, PNG, or WebP up to 5 MB.</p>
          </div>
        </div>
        {avatarError && <FieldError message={avatarError} />}

        <div>
          <label htmlFor="pe-username" className="mb-1 block text-sm font-semibold text-ink">
            Username
          </label>
          <Input
            id="pe-username"
            {...register("username", {
              required: "Username is required",
              minLength: { value: 3, message: "At least 3 characters" },
              maxLength: { value: 24, message: "At most 24 characters" },
              pattern: {
                value: /^[a-z0-9_]+$/,
                message: "Lowercase letters, numbers, and underscores only",
              },
              setValueAs: (v: string) => v.trim().toLowerCase(),
            })}
            error={!!errors.username || usernameState === "taken" || usernameState === "invalid"}
            maxLength={24}
            autoComplete="username"
          />
          <FieldError message={errors.username?.message} />
          {usernameState === "checking" && <p className="mt-1 text-xs text-ink-muted">Checking availability...</p>}
          {usernameState === "available" && <p className="mt-1 text-xs text-green-500">Username is available</p>}
          {usernameState === "taken" && <FieldError message="This username is taken" />}
          {usernameState === "invalid" && <FieldError message="3-24 chars: lowercase letters, numbers, underscores" />}
        </div>

        <div>
          <label htmlFor="pe-display" className="mb-1 block text-sm font-semibold text-ink">
            Display name
          </label>
          <Input
            id="pe-display"
            {...register("display_name", { maxLength: { value: 50, message: "At most 50 characters" } })}
            maxLength={50}
            placeholder="Your name"
          />
          <FieldError message={errors.display_name?.message} />
        </div>

        <div>
          <label htmlFor="pe-bio" className="mb-1 block text-sm font-semibold text-ink">
            Bio
          </label>
          <Textarea
            id="pe-bio"
            {...register("bio", { maxLength: { value: 160, message: "Bio must be at most 160 characters" } })}
            rows={3}
            maxLength={160}
            placeholder="Tell people about yourself"
          />
          <FieldError message={errors.bio?.message} />
        </div>

        <div>
          <label htmlFor="pe-website" className="mb-1 block text-sm font-semibold text-ink">
            Website
          </label>
          <Input
            id="pe-website"
            {...register("website_url", {
              validate: (v) =>
                !v.trim() || /^https?:\/\/.+/i.test(v.trim()) || "Must be a valid http(s) URL",
            })}
            placeholder="https://example.com"
            inputMode="url"
          />
          <FieldError message={errors.website_url?.message} />
        </div>

        <label className="flex cursor-pointer items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
          <span>
            <span className="block text-sm font-semibold text-ink">Private account</span>
            <span className="block text-xs text-ink-muted">
              Only people you approve can see your profile and videos
            </span>
          </span>
          <input
            type="checkbox"
            {...register("is_private")}
            className="h-5 w-5 accent-[var(--color-brand-blue)]"
            aria-label="Private account"
          />
        </label>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting} disabled={avatarUploading}>
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
