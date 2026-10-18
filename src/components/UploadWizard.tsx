"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { config } from "@/lib/config";
import { UPLOAD_EXTENSIONS } from "@/lib/validation";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { uploadWithProgress, probeVideoFile, captureVideoFrame } from "@/lib/media";
import { formatDuration } from "@/lib/format";
import { useAuth, loginRedirect } from "@/hooks/useAuth";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Textarea";
import { FieldError } from "@/components/ui/FieldError";
import { Spinner } from "@/components/ui/Spinner";
import { useRouter } from "next/navigation";

/**
 * Full video upload wizard.
 *
 * Props: onPublished(videoId) — called after POST /api/videos succeeds so
 * the page can navigate to the new video.
 *
 * Steps:
 *   1. Source: pick a file (accept video/*, capture attribute on mobile)
 *      or record in-browser via MediaRecorder (graceful denial/unsupported).
 *   2. Preview: video preview + validation results (type/size/duration from
 *      config.ts limits). Trimming is not supported; shown as a note.
 *   3. Details: caption (hashtags are parsed server-side from the caption),
 *      visibility, thumbnail frame capture via canvas.
 *   4. Publish: POST /api/upload/sign -> PUT bytes to the signed URL with
 *      real XMLHttpRequest progress -> POST /api/videos metadata.
 *      Supports cancel and retry.
 *
 * Requires sign-in: anonymous users see a prompt to log in.
 */

type Step = "source" | "preview" | "details" | "publishing" | "done";

interface SignResponse {
  bucket: string;
  path: string;
  upload_url: string;
  token: string;
  expires_in: number;
}

const ALLOWED_VIDEO_EXTS = UPLOAD_EXTENSIONS.video;

function extOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return (match?.[1] ?? "").toLowerCase();
}

export function UploadWizard({ onPublished }: { onPublished?: (videoId: string) => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const router = useRouter();

  const [step, setStep] = useState<Step>("source");
  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [probed, setProbed] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  const [stage, setStage] = useState<"signing" | "uploading" | "thumbnail" | "creating" | null>(null);
  const abortRef = useRef<{ abort: () => void } | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<{ caption: string; visibility: "public" | "private"; useThumbnail: boolean }>({
    defaultValues: { caption: "", visibility: "public", useThumbnail: true },
  });

  const maxMb = config.videoLimits.maxVideoMb;
  const maxSeconds = config.videoLimits.maxVideoSeconds;

  // Clean up object URLs.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const acceptFile = useCallback(
    async (picked: File) => {
      setValidationError(null);
      setProbed(null);

      const ext = extOf(picked.name) || extOf(picked.type.replace("video/", "."));
      if (!ALLOWED_VIDEO_EXTS.includes(ext as (typeof ALLOWED_VIDEO_EXTS)[number])) {
        setValidationError(
          `Unsupported format. Please use ${ALLOWED_VIDEO_EXTS.map((e) => `.${e}`).join(", ")}.`
        );
        return;
      }
      if (picked.size > maxMb * 1024 * 1024) {
        setValidationError(`File is too large. Maximum size is ${maxMb} MB.`);
        return;
      }
      try {
        const meta = await probeVideoFile(picked);
        if (meta.duration > maxSeconds) {
          setValidationError(
            `Video is ${formatDuration(meta.duration)} — the maximum length is ${formatDuration(maxSeconds)}.`
          );
          return;
        }
        setProbed(meta);
      } catch (e) {
        setValidationError(errorMessage(e, "Could not read this video file"));
        return;
      }

      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setObjectUrl(URL.createObjectURL(picked));
      setFile(picked);
      setStep("preview");
    },
    [maxMb, maxSeconds, objectUrl]
  );

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = e.target.files?.[0];
      e.target.value = "";
      if (picked) void acceptFile(picked);
    },
    [acceptFile]
  );

  // --- In-browser recording via MediaRecorder ---
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordVideoRef = useRef<HTMLVideoElement>(null);

  const startRecording = useCallback(async () => {
    setRecordError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecordError("Recording is not supported in this browser. Please pick a video file instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (recordVideoRef.current) {
        recordVideoRef.current.srcObject = stream;
        await recordVideoRef.current.play().catch(() => {});
      }
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: "video/webm" });
        const recorded = new File([blob], `recording-${Date.now()}.webm`, { type: "video/webm" });
        setRecording(false);
        void acceptFile(recorded);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setRecordError(
        "Camera/microphone access was denied. Allow access in your browser settings, or pick a video file instead."
      );
    }
  }, [acceptFile]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // --- Thumbnail capture ---
  const captureThumbnail = useCallback(async (): Promise<File | null> => {
    const video = previewVideoRef.current;
    if (!video) return null;
    const blob = await captureVideoFrame(video);
    if (!blob) return null;
    return new File([blob], "thumbnail.jpg", { type: "image/jpeg" });
  }, []);

  // --- Publish ---
  const publish = useCallback(
    async (values: { caption: string; visibility: "public" | "private"; useThumbnail: boolean }) => {
      if (!file || !probed) return;
      setPublishError(null);
      setProgress(0);
      setStep("publishing");

      const videoExt = extOf(file.name) || "webm";

      try {
        // 1. Signed URL for the video.
        setStage("signing");
        const sign = await apiRequest<SignResponse>("/api/upload/sign", {
          method: "POST",
          json: { kind: "video", ext: videoExt },
        });

        // 2. PUT the bytes with real progress.
        setStage("uploading");
        await new Promise<void>((resolve, reject) => {
          abortRef.current = uploadWithProgress(
            sign.upload_url,
            file,
            file.type || "video/mp4",
            (p) => setProgress(p.percent),
            () => resolve(),
            (err) => reject(err)
          );
        });
        abortRef.current = null;

        // 3. Optional thumbnail frame capture + upload.
        let thumbnailPath: string | null = null;
        if (values.useThumbnail) {
          const thumbFile = await captureThumbnail();
          if (thumbFile) {
            setStage("thumbnail");
            const thumbSign = await apiRequest<SignResponse>("/api/upload/sign", {
              method: "POST",
              json: { kind: "thumbnail", ext: "jpg" },
            });
            await new Promise<void>((resolve, reject) => {
              abortRef.current = uploadWithProgress(
                thumbSign.upload_url,
                thumbFile,
                "image/jpeg",
                () => {},
                () => resolve(),
                (err) => reject(err)
              );
            });
            abortRef.current = null;
            thumbnailPath = thumbSign.path;
          }
        }

        // 4. Create the video row.
        setStage("creating");
        const created = await apiRequest<{ video: { id: string } }>("/api/videos", {
          method: "POST",
          json: {
            caption: values.caption.trim() || null,
            storage_path: sign.path,
            thumbnail_path: thumbnailPath,
            duration_seconds: Math.round(probed.duration),
            visibility: values.visibility,
          },
        });
        setPublishedId(created.video.id);
        setStep("done");
        onPublished?.(created.video.id);
      } catch (e) {
        if (errorMessage(e) === "Upload cancelled") {
          setPublishError("Upload cancelled.");
        } else {
          setPublishError(errorMessage(e, "Publishing failed"));
        }
        setStage(null);
        setStep("details");
      }
    },
    [file, probed, captureThumbnail, onPublished]
  );

  const cancelPublish = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const resetWizard = useCallback(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setObjectUrl(null);
    setFile(null);
    setProbed(null);
    setValidationError(null);
    setPublishError(null);
    setProgress(0);
    setPublishedId(null);
    setStage(null);
    setValue("caption", "");
    setStep("source");
  }, [objectUrl, setValue]);

  // --- Render ---
  if (!user) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-16 text-center">
        <h1 className="text-2xl font-bold text-ink">Sign in to upload</h1>
        <p className="text-ink-muted">You need an account to share videos on VYRO.</p>
        <Button onClick={() => router.push(loginRedirect("/create"))}>Log in</Button>
      </div>
    );
  }

  const stepLabels = ["Source", "Preview", "Details", "Publish"];
  const stepIndex = step === "source" ? 0 : step === "preview" ? 1 : step === "details" ? 2 : 3;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      {/* Stepper */}
      <ol className="mb-6 flex items-center gap-2" aria-label="Upload progress">
        {stepLabels.map((label, i) => (
          <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                i <= stepIndex ? "bg-[var(--color-brand-blue)] text-white" : "bg-surface-elevated text-ink-muted"
              }`}
              aria-current={i === stepIndex ? "step" : undefined}
            >
              {i + 1}
            </span>
            <span className={`hidden text-sm sm:inline ${i <= stepIndex ? "text-ink font-semibold" : "text-ink-muted"}`}>
              {label}
            </span>
            {i < stepLabels.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      {step === "source" && (
        <div className="flex flex-col gap-4">
          <label
            htmlFor="video-file-input"
            className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-surface-elevated px-6 py-14 text-center hover:border-[var(--color-brand-blue)]"
          >
            <svg className="h-12 w-12 text-ink-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.55-2.28A1 1 0 0121 8.62v6.76a1 1 0 01-1.45.9L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span className="font-semibold text-ink">Choose a video file</span>
            <span className="text-sm text-ink-muted">
              {ALLOWED_VIDEO_EXTS.map((e) => `.${e}`).join(", ")} up to {maxMb} MB, {formatDuration(maxSeconds)} max
            </span>
          </label>
          <input
            id="video-file-input"
            type="file"
            accept="video/*"
            capture="environment"
            className="sr-only"
            onChange={onFileInput}
          />

          <div className="flex items-center gap-3" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-ink-muted">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {!recording ? (
            <Button variant="secondary" onClick={() => void startRecording()}>
              Record with camera
            </Button>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <video ref={recordVideoRef} muted playsInline className="aspect-[9/16] w-48 rounded-xl bg-black object-cover" aria-label="Camera preview" />
              <Button variant="danger" onClick={stopRecording}>
                Stop recording
              </Button>
            </div>
          )}
          {recordError && <FieldError message={recordError} />}
          {validationError && <FieldError message={validationError} />}
        </div>
      )}

      {step === "preview" && file && objectUrl && (
        <div className="flex flex-col items-center gap-4">
          <video
            src={objectUrl}
            controls
            playsInline
            className="aspect-[9/16] max-h-[60dvh] w-auto rounded-2xl bg-black"
            aria-label="Video preview"
          />
          <div className="w-full rounded-2xl border border-border bg-surface-elevated p-4 text-sm">
            <p className="font-semibold text-ink">{file.name}</p>
            <p className="mt-1 text-ink-muted">
              {(file.size / 1024 / 1024).toFixed(1)} MB
              {probed && ` · ${formatDuration(probed.duration)} · ${probed.width}x${probed.height}`}
            </p>
            <p className="mt-2 text-ink-muted">
              Note: uploads are published as-is; trimming is not supported yet.
            </p>
          </div>
          <div className="flex w-full gap-2">
            <Button variant="ghost" onClick={resetWizard} className="flex-1">
              Choose another
            </Button>
            <Button onClick={() => setStep("details")} className="flex-1">
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === "details" && file && objectUrl && (
        <form onSubmit={handleSubmit((v) => void publish(v))} className="flex flex-col gap-4">
          {/* Hidden preview video used for thumbnail frame capture */}
          <video
            ref={previewVideoRef}
            src={objectUrl}
            muted
            playsInline
            preload="auto"
            className="sr-only"
            aria-hidden="true"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              // Seek slightly in so the captured frame is a real frame.
              if (Number.isFinite(v.duration) && v.duration > 1) {
                v.currentTime = 1;
              }
            }}
          />

          <div>
            <label htmlFor="caption" className="mb-1 block text-sm font-semibold text-ink">
              Caption
            </label>
            <Textarea
              id="caption"
              {...register("caption", { maxLength: { value: 500, message: "Caption must be at most 500 characters" } })}
              rows={3}
              maxLength={500}
              placeholder="Say something... add #hashtags to get discovered"
            />
            <FieldError message={errors.caption?.message} />
            <p className="mt-1 text-xs text-ink-muted">Hashtags in your caption are linked automatically.</p>
          </div>

          <div>
            <span className="mb-1 block text-sm font-semibold text-ink">Visibility</span>
            <div className="flex gap-2" role="radiogroup" aria-label="Visibility">
              {(["public", "private"] as const).map((value) => (
                <label
                  key={value}
                  className={`flex-1 cursor-pointer rounded-xl border px-4 py-2.5 text-center text-sm font-semibold capitalize ${
                    watch("visibility") === value
                      ? "border-[var(--color-brand-blue)] bg-surface-elevated text-ink"
                      : "border-border text-ink-muted"
                  }`}
                >
                  <input
                    type="radio"
                    value={value}
                    {...register("visibility")}
                    className="sr-only"
                  />
                  {value}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              Private videos are only visible to you.
            </p>
          </div>

          <label className="flex cursor-pointer items-center gap-3 text-sm text-ink">
            <input
              type="checkbox"
              {...register("useThumbnail")}
              className="h-4 w-4 accent-[var(--color-brand-blue)]"
            />
            Capture a thumbnail from the video (recommended)
          </label>

          {publishError && <FieldError message={publishError} />}

          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep("preview")} className="flex-1">
              Back
            </Button>
            <Button type="submit" className="flex-1">
              Publish
            </Button>
          </div>
        </form>
      )}

      {step === "publishing" && (
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <Spinner size="lg" label="Publishing video" />
          <p className="font-semibold text-ink">
            {stage === "signing" && "Preparing upload..."}
            {stage === "uploading" && `Uploading video... ${progress}%`}
            {stage === "thumbnail" && "Uploading thumbnail..."}
            {stage === "creating" && "Publishing..."}
          </p>
          {stage === "uploading" && (
            <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-surface-elevated" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
              <div className="h-full bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] transition-[width]" style={{ width: `${progress}%` }} />
            </div>
          )}
          <Button variant="ghost" onClick={cancelPublish}>
            Cancel upload
          </Button>
        </div>
      )}

      {step === "done" && publishedId && (
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-600">
            <svg className="h-8 w-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-ink">Your video is live</h2>
          <div className="flex gap-2">
            <Button onClick={() => router.push(`/video/${publishedId}`)}>Watch it</Button>
            <Button variant="secondary" onClick={resetWizard}>
              Upload another
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
