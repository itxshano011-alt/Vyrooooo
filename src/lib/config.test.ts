import { describe, expect, it } from "vitest";
import { config } from "./config";

describe("vyro config", () => {
  it("exposes the expected brand identity", () => {
    expect(config.siteName).toBe("VYRO");
    expect(config.colors.blue).toBe("#2563eb");
    expect(config.colors.violet).toBe("#8b5cf6");
  });

  it("falls back to safe video limits without env vars", () => {
    expect(config.videoLimits.maxVideoMb).toBeGreaterThan(0);
    expect(config.videoLimits.maxVideoSeconds).toBeGreaterThan(0);
  });
});
