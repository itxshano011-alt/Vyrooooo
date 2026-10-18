"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import ChatWindow from "@/components/chat/ChatWindow";
import { useAuth } from "@/hooks/useAuth";

export default function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { profile, loading } = useAuth();

  useEffect(() => {
    if (!loading && !profile) router.replace("/login");
  }, [loading, profile, router]);

  if (loading || !profile) {
    return (
      <div className="flex h-dvh items-center justify-center" aria-label="Loading chat">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-blue border-t-transparent" />
      </div>
    );
  }

  return <ChatWindow conversationId={id} />;
}
