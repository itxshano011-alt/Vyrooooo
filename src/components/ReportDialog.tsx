"use client";

import { useForm } from "react-hook-form";
import { useAuth, loginRedirect } from "@/hooks/useAuth";
import { useToast } from "@/components/ui/Toast";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { Textarea } from "@/components/ui/Textarea";
import { FieldError } from "@/components/ui/FieldError";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useRouter } from "next/navigation";
import type { ReportTargetType } from "@/lib/db";

/**
 * Report a user, video, or comment (POST /api/reports).
 *
 * Props: targetType ("user" | "video" | "comment"), targetId (string | null),
 * open, onClose. Renders nothing actionable when targetId is null.
 * Anonymous users are redirected to /login?next=<current path>.
 */
export function ReportDialog({
  targetType,
  targetId,
  open,
  onClose,
}: {
  targetType: ReportTargetType;
  targetId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<{ reason: string }>({ defaultValues: { reason: "" } });

  const targetLabel =
    targetType === "user" ? "user" : targetType === "video" ? "video" : "comment";

  const onSubmit = async (values: { reason: string }) => {
    if (!targetId) return;
    if (!user) {
      router.push(loginRedirect(window.location.pathname));
      return;
    }
    try {
      await apiRequest("/api/reports", {
        method: "POST",
        json: { target_type: targetType, target_id: targetId, reason: values.reason.trim() },
      });
      toast("Report submitted. Thanks for keeping VYRO safe.", "success");
      reset();
      onClose();
    } catch (e) {
      toast(errorMessage(e, "Could not submit report"), "error");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Report ${targetLabel}`}>
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="flex flex-col gap-3"
      >
        <p className="text-sm text-ink-muted">
          Tell us why this {targetLabel} should be reviewed. Reports are anonymous
          to the reported {targetLabel === "user" ? "person" : "creator"}.
        </p>
        <div>
          <Textarea
            {...register("reason", {
              required: "Please describe the problem",
              minLength: { value: 1, message: "Please describe the problem" },
              maxLength: { value: 1000, message: "Reason must be at most 1000 characters" },
            })}
            rows={4}
            maxLength={1000}
            placeholder="What is wrong with this content?"
            aria-label="Report reason"
            data-autofocus
          />
          <FieldError message={errors.reason?.message} />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting} variant="danger">
            Submit report
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
