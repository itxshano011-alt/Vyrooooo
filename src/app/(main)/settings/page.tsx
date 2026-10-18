"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FieldError } from "@/components/ui/FieldError";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { useAuth } from "@/hooks/useAuth";
import type { Profile, ReportTargetType } from "@/lib/db";
import { avatarUrl } from "@/components/chat/urls";

type ThemeChoice = "dark" | "light" | "system";
const THEME_CHOICE_KEY = "vyro-theme-choice";
const THEME_KEY = "vyro-theme";

interface NotifPrefs {
  likes: boolean;
  comments: boolean;
  follows: boolean;
  messages: boolean;
}
const NOTIF_PREFS_KEY = "vyro-notif-prefs";
const DEFAULT_PREFS: NotifPrefs = {
  likes: true,
  comments: true,
  follows: true,
  messages: true,
};

interface BlockEntry {
  blocked_id: string;
  created_at: string;
  profile: {
    id: string;
    username: string;
    display_name: string | null;
    avatar_path: string | null;
  } | null;
}

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

/** Page-local switch; no shared Switch exists in the ui kit. */
function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-brand-blue" : "bg-border"
      } ${disabled ? "opacity-50" : ""}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface-elevated p-4">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {description && (
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
      )}
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm text-ink-muted">
      {children}
    </label>
  );
}

// ------------------------------------------------------------------
// Theme
// ------------------------------------------------------------------
function applyTheme(choice: ThemeChoice) {
  try {
    localStorage.setItem(THEME_CHOICE_KEY, choice);
    const resolved =
      choice === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : choice;
    localStorage.setItem(THEME_KEY, resolved);
    document.documentElement.setAttribute("data-theme", resolved);
  } catch {
    // Storage unavailable (private mode): theme still applies in-memory.
    document.documentElement.setAttribute(
      "data-theme",
      choice === "light" ? "light" : "dark"
    );
  }
}

// ------------------------------------------------------------------
// Report form
// ------------------------------------------------------------------
const reportFormSchema = z.object({
  target_type: z.enum(["user", "video", "comment"]),
  target_id: z
    .string()
    .trim()
    .uuid("Enter a valid target id"),
  reason: z
    .string()
    .trim()
    .min(1, "Tell us why you are reporting this")
    .max(1000, "Keep the reason under 1000 characters"),
});
type ReportFormValues = z.infer<typeof reportFormSchema>;

// ------------------------------------------------------------------
// Page
// ------------------------------------------------------------------
export default function SettingsPage() {
  const router = useRouter();
  const { profile, loading: authLoading, signOut } = useAuth();
  const viewerId = profile?.id ?? null;

  const [isPrivate, setIsPrivate] = useState<boolean | null>(null);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [privacyError, setPrivacyError] = useState<string | null>(null);

  const [theme, setTheme] = useState<ThemeChoice>("dark");
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_PREFS);

  const [blocks, setBlocks] = useState<BlockEntry[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(true);
  const [blocksError, setBlocksError] = useState<string | null>(null);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [reportStatus, setReportStatus] = useState<
    { ok: boolean; message: string } | null
  >(null);

  const reportForm = useForm<ReportFormValues>({
    resolver: zodResolver(reportFormSchema),
    defaultValues: { target_type: "user", target_id: "", reason: "" },
  });
  const reportErrors = reportForm.formState.errors;

  useEffect(() => {
    if (authLoading) return;
    if (!viewerId) {
      router.replace("/login");
      return;
    }
    try {
      const saved = localStorage.getItem(THEME_CHOICE_KEY);
      if (saved === "light" || saved === "dark" || saved === "system") {
        setTheme(saved);
      }
      const savedPrefs = localStorage.getItem(NOTIF_PREFS_KEY);
      if (savedPrefs) {
        const parsed = JSON.parse(savedPrefs) as Partial<NotifPrefs>;
        setPrefs({ ...DEFAULT_PREFS, ...parsed });
      }
    } catch {
      // Non-fatal.
    }
  }, [authLoading, viewerId, router]);

  // Follow the OS theme while "system" is selected.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/profiles/me", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { profile: Profile };
      setIsPrivate(data.profile.is_private);
    } catch {
      // Privacy toggle stays hidden on failure.
    }
  }, []);

  const loadBlocks = useCallback(async () => {
    setBlocksLoading(true);
    setBlocksError(null);
    try {
      const res = await fetch("/api/blocks", { credentials: "include" });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, "Could not load blocked users"));
      }
      const data = (await res.json()) as { blocks: BlockEntry[] };
      setBlocks(data.blocks);
    } catch (err) {
      setBlocksError(err instanceof Error ? err.message : "Could not load blocked users");
    } finally {
      setBlocksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!viewerId) return;
    void loadProfile();
    void loadBlocks();
  }, [viewerId, loadProfile, loadBlocks]);

  const handlePrivacyChange = useCallback(
    async (next: boolean) => {
      const prev = isPrivate;
      setIsPrivate(next);
      setPrivacySaving(true);
      setPrivacyError(null);
      try {
        const res = await fetch("/api/profiles/me", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ is_private: next }),
        });
        if (!res.ok) {
          throw new Error(await apiErrorMessage(res, "Could not update privacy"));
        }
      } catch (err) {
        setIsPrivate(prev);
        setPrivacyError(err instanceof Error ? err.message : "Could not update privacy");
      } finally {
        setPrivacySaving(false);
      }
    },
    [isPrivate]
  );

  const handleThemeChange = useCallback((next: ThemeChoice) => {
    setTheme(next);
    applyTheme(next);
  }, []);

  const handlePrefsChange = useCallback((key: keyof NotifPrefs, value: boolean) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(NOTIF_PREFS_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal.
      }
      return next;
    });
  }, []);

  const handleUnblock = useCallback(async (userId: string) => {
    setUnblocking(userId);
    try {
      const res = await fetch(
        `/api/blocks?user_id=${encodeURIComponent(userId)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, "Could not unblock user"));
      }
      setBlocks((prev) => prev.filter((b) => b.blocked_id !== userId));
    } catch {
      // Keep the row; the button becomes available again.
    } finally {
      setUnblocking(null);
    }
  }, []);

  const handleReport = reportForm.handleSubmit(async (values) => {
    setReportStatus(null);
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          target_type: values.target_type as ReportTargetType,
          target_id: values.target_id,
          reason: values.reason,
        }),
      });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, "Could not file report"));
      }
      reportForm.reset();
      setReportStatus({ ok: true, message: "Report filed. Our team will review it." });
    } catch (err) {
      setReportStatus({
        ok: false,
        message: err instanceof Error ? err.message : "Could not file report",
      });
    }
  });

  const handleDeleteAccount = useCallback(async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ confirm: true }),
      });
      if (!res.ok) {
        throw new Error(await apiErrorMessage(res, "Could not delete account"));
      }
      await signOut();
      router.replace("/");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete account");
    } finally {
      setDeleting(false);
    }
  }, [signOut, router]);

  const handleLogout = useCallback(async () => {
    await signOut();
    router.replace("/login");
  }, [signOut, router]);

  if (authLoading || !viewerId) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-4 p-4" aria-label="Loading settings">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 animate-pulse rounded-2xl bg-surface-elevated" />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4 pb-10">
      <h1 className="pt-2 text-xl font-bold text-ink">Settings</h1>

      {/* Account */}
      <Section title="Account">
        <div className="flex items-center gap-3">
          <Avatar
            src={avatarUrl(profile?.avatar_path)}
            name={profile?.username ?? "?"}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">
              {profile?.display_name?.trim() || `@${profile?.username}`}
            </p>
            <p className="truncate text-xs text-ink-muted">@{profile?.username}</p>
          </div>
          {/* Profile editor lives on the viewer's own profile page. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={!profile?.username}
            onClick={() => profile?.username && router.push(`/profile/${profile.username}`)}
          >
            Edit profile
          </Button>
        </div>
      </Section>

      {/* Privacy */}
      {isPrivate !== null && (
        <Section
          title="Privacy"
          description="Private accounts hide your videos and profile from people who don't follow you."
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-ink">Private account</span>
            <Toggle
              checked={isPrivate}
              onChange={(v) => void handlePrivacyChange(v)}
              label="Private account"
              disabled={privacySaving}
            />
          </div>
          {privacyError && (
            <p role="alert" className="text-xs text-red-400">
              {privacyError}
            </p>
          )}
        </Section>
      )}

      {/* Appearance */}
      <Section title="Appearance" description="Choose how VYRO looks on this device.">
        <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
          {(["dark", "light", "system"] as ThemeChoice[]).map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={theme === choice}
              onClick={() => handleThemeChange(choice)}
              className={`rounded-xl border px-3 py-2 text-sm capitalize transition-colors ${
                theme === choice
                  ? "border-brand-blue bg-brand-blue/10 text-ink"
                  : "border-border text-ink-muted hover:text-ink"
              }`}
            >
              {choice}
            </button>
          ))}
        </div>
      </Section>

      {/* Notifications */}
      <Section
        title="Notification preferences"
        description="These toggles are stored on this device only and control which alerts this device requests."
      >
        {(
          [
            ["likes", "Likes"],
            ["comments", "Comments"],
            ["follows", "New followers"],
            ["messages", "Messages"],
          ] as [keyof NotifPrefs, string][]
        ).map(([key, label]) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <span className="text-sm text-ink">{label}</span>
            <Toggle
              checked={prefs[key]}
              onChange={(v) => handlePrefsChange(key, v)}
              label={label}
            />
          </div>
        ))}
      </Section>

      {/* Blocked users */}
      <Section title="Blocked users" description="People you have blocked can't message you or see your profile.">
        {blocksLoading ? (
          <div className="flex items-center gap-2 text-sm text-ink-muted">
            <Spinner size="sm" /> Loading blocked users
          </div>
        ) : blocksError ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">{blocksError}</p>
            <Button variant="secondary" size="sm" onClick={() => void loadBlocks()}>
              Retry
            </Button>
          </div>
        ) : blocks.length === 0 ? (
          <p className="text-sm text-ink-muted">You haven&apos;t blocked anyone.</p>
        ) : (
          <ul className="space-y-2">
            {blocks.map((b) => (
              <li key={b.blocked_id} className="flex items-center gap-3">
                <Avatar
                  src={avatarUrl(b.profile?.avatar_path)}
                  name={b.profile?.username ?? "?"}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {b.profile?.display_name?.trim() || `@${b.profile?.username ?? "unknown"}`}
                  </p>
                  {b.profile?.username && (
                    <p className="truncate text-xs text-ink-muted">@{b.profile.username}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={unblocking === b.blocked_id}
                  onClick={() => void handleUnblock(b.blocked_id)}
                >
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Report */}
      <Section
        title="Report content"
        description="Report a user, video, or comment for review by our moderation team."
      >
        <form onSubmit={(e) => void handleReport(e)} className="space-y-3">
          <div>
            <FieldLabel htmlFor="report-target-type">What are you reporting?</FieldLabel>
            <select
              id="report-target-type"
              {...reportForm.register("target_type")}
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink"
            >
              <option value="user">User</option>
              <option value="video">Video</option>
              <option value="comment">Comment</option>
            </select>
          </div>
          <div>
            <FieldLabel htmlFor="report-target-id">Target ID</FieldLabel>
            <Input
              id="report-target-id"
              placeholder="Paste the user, video, or comment ID"
              error={!!reportErrors.target_id}
              {...reportForm.register("target_id")}
            />
            <FieldError message={reportErrors.target_id?.message} />
          </div>
          <div>
            <FieldLabel htmlFor="report-reason">Reason</FieldLabel>
            <Textarea
              id="report-reason"
              rows={3}
              placeholder="Describe the problem"
              error={!!reportErrors.reason}
              {...reportForm.register("reason")}
            />
            <FieldError message={reportErrors.reason?.message} />
          </div>
          {reportStatus && (
            <p
              role="status"
              className={`text-sm ${reportStatus.ok ? "text-green-400" : "text-red-400"}`}
            >
              {reportStatus.message}
            </p>
          )}
          <Button
            type="submit"
            variant="secondary"
            loading={reportForm.formState.isSubmitting}
          >
            File report
          </Button>
        </form>
      </Section>

      {/* Account actions */}
      <Section title="Account actions">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink">Log out of this device</span>
          <Button variant="secondary" size="sm" onClick={() => void handleLogout()}>
            Log out
          </Button>
        </div>
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-red-400">Delete account</p>
              <p className="text-xs text-ink-muted">
                Permanently deletes your profile, videos, and messages. This cannot be undone.
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
          </div>
        </div>
      </Section>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete your account?"
      >
        <p className="mb-4 text-sm text-ink-muted">
          This permanently deletes your profile, videos, comments, messages, and
          everything else. Type DELETE to confirm.
        </p>
        <div className="space-y-3">
          <div>
            <FieldLabel htmlFor="delete-confirm">Type DELETE to confirm</FieldLabel>
            <Input
              id="delete-confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
          </div>
          {deleteError && (
            <p role="alert" className="text-xs text-red-400">
              {deleteError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={deleteConfirm.trim() !== "DELETE"}
              loading={deleting}
              onClick={() => void handleDeleteAccount()}
            >
              Delete my account
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
