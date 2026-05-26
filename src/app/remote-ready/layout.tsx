import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Apply to Join Remotiv | Become Remote-Ready",
  description:
    "Join Remotiv's talent network and get hired by global companies. Build your remote-ready profile and start working with clients in the US, UK, Europe, and the Middle East.",
};

export default function RemoteReadyLayout({ children }: { children: React.ReactNode }) {
  return children;
}
