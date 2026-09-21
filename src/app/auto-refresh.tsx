"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/** Silent periodic refresh — preserves the ?key= query, re-renders the
 *  server component so the dashboard tracks the agent's live mind. */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return (
    <div className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-600 pt-2">
      <RefreshCw className="h-3 w-3" />
      <span>تحديث تلقائي كل {seconds} ثانية</span>
    </div>
  );
}
