"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { createClient } from "@/lib/supabase/client";
import { useUsernameCheck } from "@/hooks/useUsernameCheck";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/FieldError";

const signupFormSchema = z.object({
  display_name: z
    .string()
    .trim()
    .max(50, "Display name must be at most 50 characters")
    .optional(),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Username must be at least 3 characters")
    .max(24, "Username must be at most 24 characters")
    .regex(/^[a-z0-9_]+$/, "Lowercase letters, numbers, and underscores only"),
  email: z.email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

type SignupValues = z.infer<typeof signupFormSchema>;

/**
 * Sign up with display name, username (live availability), email, password.
 * The DB trigger creates the profile row automatically.
 * - Session returned -> /home.
 * - Email confirmation required -> /verify-email notice.
 */
export default function SignupPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupValues>({ resolver: zodResolver(signupFormSchema) });

  const usernameValue = watch("username") ?? "";
  const { state: usernameState } = useUsernameCheck(usernameValue);

  const onSubmit = async (values: SignupValues) => {
    setServerError(null);
    if (usernameState === "taken") {
      setError("username", { message: "This username is taken" });
      return;
    }
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: values.email.trim(),
      password: values.password,
      options: {
        data: {
          username: values.username,
          display_name: values.display_name?.trim() || values.username,
        },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/home`,
      },
    });
    if (error) {
      setServerError(error.message);
      return;
    }
    if (data.session) {
      router.push("/home");
      router.refresh();
    } else {
      router.push(`/verify-email?email=${encodeURIComponent(values.email.trim())}`);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-black text-ink">Create your account</h1>
      <p className="mt-1 text-sm text-ink-muted">Join VYRO and start creating.</p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor="signup-username" className="mb-1 block text-sm font-semibold text-ink">
            Username
          </label>
          <Input
            id="signup-username"
            autoComplete="username"
            placeholder="creator_name"
            maxLength={24}
            error={!!errors.username || usernameState === "taken" || usernameState === "invalid"}
            {...register("username")}
          />
          <FieldError message={errors.username?.message} />
          {usernameState === "checking" && (
            <p className="mt-1 text-xs text-ink-muted">Checking availability...</p>
          )}
          {usernameState === "available" && (
            <p className="mt-1 text-xs text-green-500">Username is available</p>
          )}
          {usernameState === "taken" && <FieldError message="This username is taken" />}
        </div>

        <div>
          <label htmlFor="signup-display" className="mb-1 block text-sm font-semibold text-ink">
            Display name <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <Input
            id="signup-display"
            autoComplete="name"
            placeholder="Your name"
            maxLength={50}
            error={!!errors.display_name}
            {...register("display_name")}
          />
          <FieldError message={errors.display_name?.message} />
        </div>

        <div>
          <label htmlFor="signup-email" className="mb-1 block text-sm font-semibold text-ink">
            Email
          </label>
          <Input
            id="signup-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            error={!!errors.email}
            {...register("email")}
          />
          <FieldError message={errors.email?.message} />
        </div>

        <div>
          <label htmlFor="signup-password" className="mb-1 block text-sm font-semibold text-ink">
            Password
          </label>
          <Input
            id="signup-password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            error={!!errors.password}
            {...register("password")}
          />
          <FieldError message={errors.password?.message} />
        </div>

        {serverError && <FieldError message={serverError} />}

        <Button type="submit" fullWidth loading={isSubmitting}>
          Sign up
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-ink-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-[var(--color-brand-blue)] hover:underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
