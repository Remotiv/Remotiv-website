import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { readUnsubscribeToken } from "@/lib/email/candidate/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Candidate unsubscribe. No login — see lib/email/candidate/unsubscribe.ts for
 * how the signed token authenticates the request on its own.
 *
 * GET rather than POST because it is a link in an email, which is the only
 * interface the recipient has. That makes it reachable by a mail client's link
 * prefetcher, which is FINE here and deliberately so: the action is idempotent,
 * affects only the address the token already names, and erring toward "opted
 * out" is the right direction for a consent control. Requiring a confirming
 * click would leave people who expected one click still receiving mail.
 */
function page(title: string, body: string, status: number) {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Remotiv</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4efea;color:#17131f;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px">
<div style="max-width:460px;background:#fff;border-radius:20px;padding:32px;box-shadow:0 6px 30px rgba(20,16,32,.06)">
<h1 style="font-size:20px;margin:0 0 10px">${title}</h1>
<p style="font-size:14px;line-height:1.6;color:#4a4550;margin:0">${body}</p>
</div></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const claim = readUnsubscribeToken(token);

  if (!claim) {
    return page(
      "This link isn't valid",
      "It may have been altered, or it may be from an older mailing. If you're still receiving emails you don't want, reply to one and we'll sort it out.",
      400,
    );
  }

  const service = createServiceClient();

  // The unique index on (company_id, email) makes a repeat click harmless — a
  // second insert conflicts and is ignored rather than erroring, so refreshing
  // the page or a prefetch does not produce a failure the candidate can see.
  const { error } = await service
    .from("communication_opt_outs")
    .upsert(
      {
        company_id: claim.companyId,
        email: claim.email,
        reason: "Unsubscribed via email link",
      },
      { onConflict: "company_id,email", ignoreDuplicates: true },
    );

  if (error) {
    console.error("[unsubscribe] opt-out write failed", error.message);
    return page(
      "Something went wrong",
      "We couldn't record that just now. Please reply to the email you received and we'll unsubscribe you manually.",
      500,
    );
  }

  // The company's NAME is deliberately not looked up or shown. The token
  // proves which company the address belongs to, but rendering that name on an
  // unauthenticated page would confirm to anyone holding the URL that this
  // person applied to that company.
  return page(
    "You're unsubscribed",
    "You won't receive further updates about your application from this company. This doesn't withdraw your application, and it doesn't affect any other company you've applied to through Remotiv.",
    200,
  );
}
