import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth";
import {
  handleRoute,
  validationError,
  fromPostgrestError,
} from "@/lib/api-errors";
import { accountDeleteSchema } from "@/lib/validation";
import {
  authLimiter,
  enforceRateLimit,
  rateLimitKey,
} from "@/lib/rate-limit";

/**
 * Permanently delete the caller's account.
 *
 * Requires { confirm: true } in the body. Deletion goes through
 * auth.admin.deleteUser, which cascades to profiles and every dependent row
 * (videos, follows, likes, comments, messages, notifications, blocks,
 * reports) via the ON DELETE CASCADE foreign keys in the migrations.
 * This is irreversible.
 */
export const DELETE = handleRoute(async (request: NextRequest) => {
  const user = await requireUser();

  enforceRateLimit(authLimiter, rateLimitKey(user.id, request));

  const parsed = accountDeleteSchema.safeParse(await request.json());
  if (!parsed.success) throw validationError(parsed.error);

  const { error } = await adminClient.auth.admin.deleteUser(user.id);
  if (error) {
    throw fromPostgrestError(
      { code: "XX000", message: error.message, details: "", hint: "" },
      "Could not delete account"
    );
  }

  return NextResponse.json({ deleted: true });
});
