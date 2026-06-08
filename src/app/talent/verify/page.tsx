import { Suspense } from "react";
import { TalentVerifyClient } from "./verify-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verifying — Remotiv" };

export default function TalentVerifyPage() {
  return (
    <Suspense fallback={null}>
      <TalentVerifyClient />
    </Suspense>
  );
}
