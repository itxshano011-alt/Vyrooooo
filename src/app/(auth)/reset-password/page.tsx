"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";

const schema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: "Passwords do not match",
    path: ["confirm"],
  });

/**
 * Set a new password after following the reset-email link
 * (/auth/callback exchanges the code, then lands here with a session).
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ password: string; confirm: string }>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: { password: string; confirm: string }) => {
    setServerError(null);
    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setServerError("This reset link is invalid or has expired. Request a new one.");
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: values.password });
    if (error) {
      setServerError(error.message);
      return;
    }
    router.push("/home");
    router.refresh();
  };

  return (
    <div>
      <h1 className="text-2xl font-black text-ink">Choose a new password</h1>
      <p className="mt-1 text-sm text-ink-muted">Make it at least 8 characters.</p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor="rp-password" className="mb-1 block text-sm font-semibold text-ink">
            New password
          </label>
          <Input
            id="rp-password"
            type="password"
            autoComplete="new-password"
            error={!!errors.password}
            {...register("password")}
          />
          <FieldError message={errors.password?.message} />
        </div>
        <div>
          <label htmlFor="rp-confirm" className="mb-1 block text-sm font-semibold text-ink">
            Confirm password
          </label>
          <Input
            id="rp-confirm"
            type="password"
            autoComplete="new-password"
            error={!!errors.confirm}
            {...register("confirm")}
          />
          <FieldError message={errors.confirm?.message} />
        </div>

        {serverError && <FieldError message={serverError} />}

        <Button type="submit" fullWidth loading={isSubmitting}>
          Set new password
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        <Link href="/forgot-password" className="font-semibold text-[var(--color-brand-blue)] hover:underline">
          Request a new reset link
        </Link>
      </p>
    </div>
  );
}
