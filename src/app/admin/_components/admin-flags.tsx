"use client";

import { createContext, useContext } from "react";

/**
 * Server-decided admin switches, handed to client components as booleans by
 * the admin layout (admin/lib/feature-flags.ts). Off when nothing provides
 * them. Display only: every page and action checks the switch again itself.
 */
export type AdminFlags = { liveReview: boolean };

const OFF: AdminFlags = { liveReview: false };

const AdminFlagsContext = createContext<AdminFlags>(OFF);

export function AdminFlagsProvider({
  flags,
  children,
}: {
  flags: AdminFlags;
  children: React.ReactNode;
}) {
  return <AdminFlagsContext.Provider value={flags}>{children}</AdminFlagsContext.Provider>;
}

export function useAdminFlags(): AdminFlags {
  return useContext(AdminFlagsContext);
}
