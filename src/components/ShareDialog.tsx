"use client";

import { useEffect, useState } from "react";
import type { VideoWithDetails } from "@/lib/db";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Dialog } from "@/components/ui/Dialog";

/**
 * Share a video.
 *
 * Props: video (null = closed), onClose.
 * Uses navigator.share when available; otherwise copies the link to the
 * clipboard with a fallback for clipboard API failures (manual select/copy).
 * Share URL = <origin>/video/<id> (stable public video URL).
 */
export function ShareDialog({
  video,
  onClose,
}: {
  video: VideoWithDetails | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const shareUrl = video ? `${window.location.origin}/video/${video.id}` : "";

  useEffect(() => {
    setCopied(false);
  }, [video?.id]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast("Link copied", "success");
    } catch {
      // Clipboard API unavailable/denied: user can copy manually from the input.
      toast("Copy the link manually", "info");
      const input = document.getElementById("share-link-input");
      if (input instanceof HTMLInputElement) input.select();
    }
  };

  const nativeShare = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: `VYRO video by @${video?.creator.username}`,
          url: shareUrl,
        });
      } catch (e) {
        // AbortError = user dismissed the share sheet; anything else falls
        // back to copy.
        if (e instanceof DOMException && e.name === "AbortError") return;
        await copyLink();
      }
    } else {
      await copyLink();
    }
  };

  return (
    <Dialog open={video !== null} onClose={onClose} title="Share video">
      <p className="mb-4 text-sm text-ink-muted">
        Share this video from @{video?.creator.username} with a link.
      </p>
      <div className="flex gap-2">
        <Input
          id="share-link-input"
          value={shareUrl}
          readOnly
          onFocus={(e) => e.target.select()}
          aria-label="Video share link"
        />
        <Button type="button" variant="secondary" onClick={() => void copyLink()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
        <Button type="button" fullWidth className="mt-3" onClick={() => void nativeShare()}>
          Share via...
        </Button>
      )}
    </Dialog>
  );
}
