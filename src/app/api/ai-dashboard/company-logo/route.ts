import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireCompanyRole } from "@/app/ai-dashboard/lib/company-guards";
import {
  COMPANY_LOGO_BUCKET,
  LOGO_MAX_BYTES,
  sniffLogoMime,
} from "@/app/ai-dashboard/(gated)/settings/constants";

export const runtime = "nodejs";

/**
 * Company logo upload.
 *
 * A ROUTE rather than a server action purely because of size: Next caps server
 * action bodies at 1MB by default and the product promises 5MB, so an action
 * would reject a valid logo before any of our own validation ran. Raising the
 * global action limit to suit one upload is the worse trade.
 *
 * Every check is server-side. The client's declared Content-Type, filename and
 * extension are all attacker-controlled and none of them is trusted.
 */
export async function POST(request: Request) {
  // Ownership and role first, before touching the body: owner/admin only, and
  // the company id comes from the session, never from the request.
  let ctx: Awaited<ReturnType<typeof requireCompanyRole>>;
  try {
    ctx = await requireCompanyRole("owner", "admin");
  } catch {
    return NextResponse.json({ error: "Not allowed." }, { status: 403 });
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const entry = form.get("logo");
    file = entry instanceof File ? entry : null;
  } catch {
    return NextResponse.json({ error: "Invalid upload." }, { status: 400 });
  }

  if (!file || file.size === 0) {
    return NextResponse.json({ error: "Choose a PNG or JPG to upload." }, { status: 400 });
  }
  if (file.size > LOGO_MAX_BYTES) {
    return NextResponse.json(
      { error: "That file is over 5MB. Try a smaller image." },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Type is decided by the FILE HEADER, not by what the browser claimed. This
  // bucket is public and served from our own origin, so an SVG or HTML payload
  // accepted here would be stored XSS rather than a mere wrong content type.
  const mime = sniffLogoMime(bytes);
  if (!mime) {
    return NextResponse.json(
      { error: "That doesn't look like a PNG or JPG." },
      { status: 400 },
    );
  }

  const service = createServiceClient();
  const previous = ctx.company.logo_path;

  // Path is derived entirely server-side — a client-supplied filename could
  // carry `../` and escape the company's folder.
  const ext = mime === "image/png" ? "png" : "jpg";
  const path = `${ctx.companyId}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadErr } = await service.storage
    .from(COMPANY_LOGO_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });

  if (uploadErr) {
    console.error("[ai-dashboard/company-logo] upload failed", uploadErr.message);
    return NextResponse.json(
      { error: "Upload failed. Please try again." },
      { status: 500 },
    );
  }

  const { error: dbErr } = await service
    .from("companies")
    .update({ logo_path: path })
    .eq("id", ctx.companyId);

  if (dbErr) {
    // Roll the object back so a failed save can't leave an unreferenced file
    // sitting in a public bucket forever.
    await service.storage.from(COMPANY_LOGO_BUCKET).remove([path]);
    console.error("[ai-dashboard/company-logo] db update failed", dbErr.message);
    return NextResponse.json(
      { error: "Upload failed. Please try again." },
      { status: 500 },
    );
  }

  // Old object removed only AFTER the new path is committed. The reverse order
  // leaves a window where the column points at a file that no longer exists,
  // which renders a broken image on every public job post.
  if (previous && previous !== path) {
    const { error: rmErr } = await service.storage
      .from(COMPANY_LOGO_BUCKET)
      .remove([previous]);
    if (rmErr) {
      // Orphaned object: invisible and cheap. Never fail the request for it.
      console.error(
        "[ai-dashboard/company-logo] old logo cleanup failed (non-fatal)",
        { path: previous, error: rmErr.message },
      );
    }
  }

  const { data } = service.storage.from(COMPANY_LOGO_BUCKET).getPublicUrl(path);
  return NextResponse.json({ path, url: data.publicUrl });
}
