/**
 * Central branding and product configuration for VYRO.
 *
 * Change everything in this one file to re-skin the app: name, tagline,
 * theme colors, and upload limits. Components must import from here rather
 * than hard-coding brand values.
 */

export interface BrandColors {
  blue: string;
  violet: string;
}

export interface VideoLimits {
  /** Maximum upload size in megabytes. */
  maxVideoMb: number;
  /** Maximum video duration in seconds. */
  maxVideoSeconds: number;
}

export interface VyroConfig {
  siteName: string;
  tagline: string;
  colors: BrandColors;
  videoLimits: VideoLimits;
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config: VyroConfig = {
  siteName: "VYRO",
  tagline: "Create. Watch. Connect.",
  colors: {
    blue: "#2563eb",
    violet: "#8b5cf6",
  },
  videoLimits: {
    maxVideoMb: parsePositiveInt(process.env.NEXT_PUBLIC_MAX_VIDEO_MB, 100),
    maxVideoSeconds: parsePositiveInt(process.env.NEXT_PUBLIC_MAX_VIDEO_SECONDS, 180),
  },
};
