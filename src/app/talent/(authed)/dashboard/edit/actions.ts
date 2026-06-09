"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/normalize";
import { requireProfileOwner } from "@/app/talent/lib/profile-owner";

type SourceTable = "talent_profiles" | "hire_remote_profiles";

type UpdateBasicInfoInput = {
  profileId: string;
  sourceTable: SourceTable;
  firstName: string;
  lastName: string;
  phone: string | null;
  linkedinUrl: string | null;
};

type BasicInfoData = {
  firstName: string;
  lastName: string;
  phone: string | null;
  linkedinUrl: string | null;
};

type MutationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

const NAME_MAX = 80;
const URL_MAX = 300;
const PHONE_MAX = 40;

function normaliseLinkedinUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.toLowerCase().includes("linkedin.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function updateTalentBasicInfo(
  input: UpdateBasicInfoInput,
): Promise<MutationResult<BasicInfoData>> {
  const { profileId, sourceTable } = input;
  if (
    sourceTable !== "talent_profiles" &&
    sourceTable !== "hire_remote_profiles"
  ) {
    return { success: false, error: "Invalid profile." };
  }

  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName) {
    return { success: false, error: "First name is required." };
  }
  if (firstName.length > NAME_MAX) {
    return { success: false, error: `First name must be ${NAME_MAX} characters or fewer.` };
  }
  if (!lastName) {
    return { success: false, error: "Last name is required." };
  }
  if (lastName.length > NAME_MAX) {
    return { success: false, error: `Last name must be ${NAME_MAX} characters or fewer.` };
  }

  let normalisedPhone: string | null = null;
  if (input.phone) {
    const phoneRaw = input.phone.trim();
    if (phoneRaw.length > PHONE_MAX) {
      return { success: false, error: "Phone number is too long." };
    }
    if (phoneRaw.length > 0) {
      const digits = normalizePhone(phoneRaw);
      if (digits.length < 7) {
        return { success: false, error: "Phone number must have at least 7 digits." };
      }
      normalisedPhone = digits;
    }
  }

  let normalisedLinkedin: string | null = null;
  if (input.linkedinUrl) {
    const raw = input.linkedinUrl.trim();
    if (raw.length > URL_MAX) {
      return { success: false, error: "LinkedIn URL is too long." };
    }
    if (raw.length > 0) {
      normalisedLinkedin = normaliseLinkedinUrl(raw);
      if (!normalisedLinkedin) {
        return {
          success: false,
          error: "Enter a valid LinkedIn URL (e.g. linkedin.com/in/yourname).",
        };
      }
    }
  }

  try {
    await requireProfileOwner(profileId, sourceTable);
  } catch (e) {
    if (e instanceof Error && e.message === "not_authenticated") {
      return { success: false, error: "Please sign in again." };
    }
    return { success: false, error: "You can't edit this profile." };
  }

  const service = createServiceClient();
  const patch = {
    first_name: firstName,
    last_name: lastName,
    phone: normalisedPhone,
    linkedin_url: normalisedLinkedin,
  };
  const { error } = await service
    .from(sourceTable)
    .update(patch)
    .eq("id", profileId);

  if (error) {
    console.error("[updateTalentBasicInfo] update failed:", error);
    return { success: false, error: "Could not save changes." };
  }

  revalidatePath("/talent/dashboard");
  revalidatePath("/talent/dashboard/edit");

  return {
    success: true,
    data: {
      firstName,
      lastName,
      phone: normalisedPhone,
      linkedinUrl: normalisedLinkedin,
    },
  };
}
