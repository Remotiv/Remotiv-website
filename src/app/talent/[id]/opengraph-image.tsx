import { ImageResponse } from "next/og";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "edge";
export const alt = "Remotiv Talent Profile";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type Props = { params: Promise<{ id: string }> };

type MinimalRow = {
  first_name: string;
  last_name: string | null;
  job_title?: string | null;
  job_titles?: string | null;
  photo_path: string | null;
};

function fallbackImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #7E47FF 0%, #9886FE 100%)",
        color: "white",
        fontSize: "72px",
        fontWeight: 800,
        fontFamily: "system-ui, sans-serif",
        letterSpacing: "-0.04em",
      }}
    >
      Remotiv.
    </div>,
    { ...size },
  );
}

export default async function Image({ params }: Props) {
  const { id } = await params;

  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return fallbackImage();
  }

  const supabase = createServiceClient();
  let row: MinimalRow | null = null;

  const { data: pak } = await supabase
    .from("talent_profiles")
    .select("first_name, last_name, job_title, photo_path")
    .eq("id", id)
    .not("approved_at", "is", null)
    .maybeSingle();
  if (pak) {
    row = pak as MinimalRow;
  } else {
    const { data: remote } = await supabase
      .from("hire_remote_profiles")
      .select("first_name, last_name, job_titles, photo_path")
      .eq("id", id)
      .not("approved_at", "is", null)
      .maybeSingle();
    if (remote) row = remote as MinimalRow;
  }

  if (!row) return fallbackImage();

  const fullName = `${row.first_name} ${row.last_name ?? ""}`.trim();
  const role = (row.job_title ?? row.job_titles ?? "Remotiv Talent")
    .split(",")[0]
    .trim();
  const photoUrl = (() => {
    if (!row.photo_path) return null;
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
    return base
      ? `${base}/storage/v1/object/public/talent_photos/${row.photo_path}`
      : null;
  })();

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #7E47FF 0%, #9886FE 100%)",
        fontFamily: "system-ui, sans-serif",
        padding: "80px",
        color: "white",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "60px",
          width: "100%",
        }}
      >
        {photoUrl && (
          // biome-ignore lint/performance/noImgElement: ImageResponse only supports plain <img>
          <img
            src={photoUrl}
            alt=""
            width={300}
            height={300}
            style={{
              borderRadius: "32px",
              objectFit: "cover",
              border: "4px solid rgba(255,255,255,0.4)",
            }}
          />
        )}
        <div
          style={{ display: "flex", flexDirection: "column", flex: 1 }}
        >
          <div
            style={{
              fontSize: "28px",
              opacity: 0.85,
              letterSpacing: "0.5em",
              textTransform: "uppercase",
              marginBottom: "16px",
              display: "flex",
            }}
          >
            Remotiv
          </div>
          <div
            style={{
              fontSize: "64px",
              fontWeight: 800,
              lineHeight: 1.1,
              marginBottom: "16px",
              letterSpacing: "-0.03em",
              display: "flex",
            }}
          >
            {fullName}
          </div>
          <div
            style={{
              fontSize: "36px",
              opacity: 0.85,
              display: "flex",
            }}
          >
            {role}
          </div>
        </div>
      </div>
    </div>,
    { ...size },
  );
}
