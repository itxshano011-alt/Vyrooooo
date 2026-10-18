import { describe, expect, it } from "vitest";
import {
  usernameSchema,
  profileUpdateSchema,
  videoCreateSchema,
  videoUpdateSchema,
  commentCreateSchema,
  messageCreateSchema,
  reportSchema,
  followSchema,
  blockSchema,
  conversationCreateSchema,
  conversationReadSchema,
  notificationsMarkReadSchema,
  adminReportUpdateSchema,
  adminModerateSchema,
  uploadSignSchema,
  accountDeleteSchema,
  searchSchema,
  feedTypeSchema,
  extractHashtags,
} from "../validation";

describe("usernameSchema", () => {
  it("accepts valid usernames", () => {
    expect(usernameSchema.safeParse("vyro_fan99").success).toBe(true);
    expect(usernameSchema.safeParse("abc").success).toBe(true);
    expect(usernameSchema.safeParse("a".repeat(24)).success).toBe(true);
  });

  it("rejects invalid usernames", () => {
    expect(usernameSchema.safeParse("ab").success).toBe(false); // too short
    expect(usernameSchema.safeParse("a".repeat(25)).success).toBe(false); // too long
    expect(usernameSchema.safeParse("Abc").success).toBe(false); // uppercase
    expect(usernameSchema.safeParse("a b").success).toBe(false); // space
    expect(usernameSchema.safeParse("a-b").success).toBe(false); // hyphen
    expect(usernameSchema.safeParse("").success).toBe(false);
  });
});

describe("profileUpdateSchema", () => {
  it("accepts a full valid update", () => {
    const result = profileUpdateSchema.safeParse({
      display_name: "Vyro Fan",
      bio: "Short bio",
      website_url: "https://example.com",
      username: "vyro_fan",
      is_private: true,
    });
    expect(result.success).toBe(true);
  });

  it("normalizes empty bio/website to null", () => {
    const result = profileUpdateSchema.safeParse({ bio: "", website_url: "" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bio).toBeNull();
      expect(result.data.website_url).toBeNull();
    }
  });

  it("rejects overlong bio and non-http urls", () => {
    expect(
      profileUpdateSchema.safeParse({ bio: "x".repeat(161) }).success
    ).toBe(false);
    expect(
      profileUpdateSchema.safeParse({ website_url: "ftp://example.com" }).success
    ).toBe(false);
    expect(
      profileUpdateSchema.safeParse({ website_url: "not a url" }).success
    ).toBe(false);
  });

  it("accepts partial updates", () => {
    expect(profileUpdateSchema.safeParse({ is_private: false }).success).toBe(
      true
    );
    expect(profileUpdateSchema.safeParse({}).success).toBe(true);
  });
});

describe("videoCreateSchema", () => {
  const base = {
    storage_path:
      "123e4567-e89b-12d3-a456-426614174000/123e4567-e89b-12d3-a456-426614174000.mp4",
  };

  it("accepts minimal metadata", () => {
    const result = videoCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visibility).toBe("public");
    }
  });

  it("accepts full metadata", () => {
    const result = videoCreateSchema.safeParse({
      ...base,
      caption: "Hello #world",
      thumbnail_path:
        "123e4567-e89b-12d3-a456-426614174000/123e4567-e89b-12d3-a456-426614174000.jpg",
      duration_seconds: 42,
      visibility: "private",
    });
    expect(result.success).toBe(true);
  });

  it("rejects bad storage paths and overlong captions", () => {
    expect(
      videoCreateSchema.safeParse({ ...base, storage_path: "evil/../x.mp4" })
        .success
    ).toBe(false);
    expect(
      videoCreateSchema.safeParse({ ...base, caption: "x".repeat(501) }).success
    ).toBe(false);
    expect(
      videoCreateSchema.safeParse({ ...base, duration_seconds: -1 }).success
    ).toBe(false);
    expect(
      videoCreateSchema.safeParse({ ...base, visibility: "friends" }).success
    ).toBe(false);
  });
});

describe("videoUpdateSchema", () => {
  it("accepts caption and/or visibility", () => {
    expect(videoUpdateSchema.safeParse({ caption: "new" }).success).toBe(true);
    expect(videoUpdateSchema.safeParse({ visibility: "private" }).success).toBe(
      true
    );
  });

  it("rejects empty updates", () => {
    expect(videoUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("commentCreateSchema / messageCreateSchema", () => {
  it("enforces length limits", () => {
    expect(commentCreateSchema.safeParse({ body: "nice!" }).success).toBe(true);
    expect(commentCreateSchema.safeParse({ body: "" }).success).toBe(false);
    expect(commentCreateSchema.safeParse({ body: "   " }).success).toBe(false);
    expect(commentCreateSchema.safeParse({ body: "x".repeat(501) }).success).toBe(
      false
    );
    expect(messageCreateSchema.safeParse({ body: "x".repeat(2001) }).success).toBe(
      false
    );
    expect(
      messageCreateSchema.safeParse({
        body: "hi",
        attachment_path:
          "123e4567-e89b-12d3-a456-426614174000/123e4567-e89b-12d3-a456-426614174000.png",
      }).success
    ).toBe(true);
  });
});

describe("reportSchema", () => {
  it("accepts valid reports", () => {
    expect(
      reportSchema.safeParse({
        target_type: "video",
        target_id: "123e4567-e89b-12d3-a456-426614174000",
        reason: "Spam content",
      }).success
    ).toBe(true);
  });

  it("rejects bad target types, ids, and reasons", () => {
    const bad = {
      target_type: "video",
      target_id: "123e4567-e89b-12d3-a456-426614174000",
      reason: "x",
    };
    expect(reportSchema.safeParse({ ...bad, target_type: "post" }).success).toBe(
      false
    );
    expect(reportSchema.safeParse({ ...bad, target_id: "nope" }).success).toBe(
      false
    );
    expect(reportSchema.safeParse({ ...bad, reason: "" }).success).toBe(false);
    expect(
      reportSchema.safeParse({ ...bad, reason: "x".repeat(1001) }).success
    ).toBe(false);
  });
});

describe("follow/block/conversation id schemas", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  it("require uuids", () => {
    expect(followSchema.safeParse({ user_id: id }).success).toBe(true);
    expect(followSchema.safeParse({ user_id: "nope" }).success).toBe(false);
    expect(blockSchema.safeParse({ user_id: id }).success).toBe(true);
    expect(conversationCreateSchema.safeParse({ user_id: id }).success).toBe(true);
    expect(
      conversationReadSchema.safeParse({ up_to_message_id: id }).success
    ).toBe(true);
  });
});

describe("notificationsMarkReadSchema", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  it("accepts 1-100 ids", () => {
    expect(notificationsMarkReadSchema.safeParse({ ids: [id] }).success).toBe(
      true
    );
    expect(notificationsMarkReadSchema.safeParse({ ids: [] }).success).toBe(
      false
    );
    expect(
      notificationsMarkReadSchema.safeParse({ ids: Array(101).fill(id) }).success
    ).toBe(false);
  });
});

describe("admin schemas", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  it("adminReportUpdateSchema allows only terminal states", () => {
    expect(adminReportUpdateSchema.safeParse({ status: "actioned" }).success).toBe(
      true
    );
    expect(adminReportUpdateSchema.safeParse({ status: "open" }).success).toBe(
      false
    );
  });

  it("adminModerateSchema validates target/action pairs structurally", () => {
    expect(
      adminModerateSchema.safeParse({
        target_type: "video",
        target_id: id,
        action: "remove",
      }).success
    ).toBe(true);
    expect(
      adminModerateSchema.safeParse({
        target_type: "user",
        target_id: id,
        action: "restore",
      }).success
    ).toBe(true); // route rejects semantically invalid combos
    expect(
      adminModerateSchema.safeParse({
        target_type: "video",
        target_id: id,
        action: "explode",
      }).success
    ).toBe(false);
  });
});

describe("uploadSignSchema", () => {
  it("lowercases extensions", () => {
    const result = uploadSignSchema.safeParse({ kind: "video", ext: "MP4" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ext).toBe("mp4");
  });

  it("rejects bad kinds and extensions", () => {
    expect(uploadSignSchema.safeParse({ kind: "song", ext: "mp3" }).success).toBe(
      false
    );
    expect(uploadSignSchema.safeParse({ kind: "video", ext: "exe" }).success).toBe(
      true
    ); // ext allowlist enforced in the route
    expect(uploadSignSchema.safeParse({ kind: "video", ext: "../mp4" }).success).toBe(
      false
    );
  });
});

describe("accountDeleteSchema", () => {
  it("requires explicit confirmation", () => {
    expect(accountDeleteSchema.safeParse({ confirm: true }).success).toBe(true);
    expect(accountDeleteSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(accountDeleteSchema.safeParse({}).success).toBe(false);
  });
});

describe("searchSchema / feedTypeSchema", () => {
  it("requires a 2+ character query", () => {
    expect(searchSchema.safeParse({ q: "ab" }).success).toBe(true);
    expect(searchSchema.safeParse({ q: "a" }).success).toBe(false);
    expect(searchSchema.safeParse({ q: "  " }).success).toBe(false);
    expect(
      searchSchema.safeParse({ q: "cats", type: "videos" }).success
    ).toBe(true);
    expect(searchSchema.safeParse({ q: "cats", type: "posts" }).success).toBe(
      false
    );
  });

  it("accepts the three feed types", () => {
    for (const type of ["foryou", "following", "latest"] as const) {
      expect(feedTypeSchema.safeParse(type).success).toBe(true);
    }
    expect(feedTypeSchema.safeParse("trending").success).toBe(false);
  });
});

describe("extractHashtags", () => {
  it("extracts normalized tags from captions", () => {
    expect(extractHashtags("Hello #World and #vyro_rocks!")).toEqual([
      "world",
      "vyro_rocks",
    ]);
    expect(extractHashtags("no tags here")).toEqual([]);
    expect(extractHashtags(null)).toEqual([]);
    expect(extractHashtags("#dup #dup #DUP")).toEqual(["dup"]);
  });
});
