"use client";

import { UploadWizard } from "@/components/UploadWizard";

/** Upload page: full wizard (pick/record -> preview -> details -> publish). */
export default function CreatePage() {
  return (
    <div className="py-2">
      <h1 className="px-4 pt-4 text-2xl font-black text-ink">Create</h1>
      <UploadWizard />
    </div>
  );
}
