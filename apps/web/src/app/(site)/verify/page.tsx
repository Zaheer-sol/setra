import type { Metadata } from "next";
import { Suspense } from "react";
import { VerifyBooks } from "./verify-books";

export const metadata: Metadata = {
  title: "Verify books on Monad",
  description: "Check a business's books against the fingerprint it published on Monad, straight from the chain."
};

export default function VerifyPage() {
  return (
    <Suspense>
      <VerifyBooks />
    </Suspense>
  );
}
