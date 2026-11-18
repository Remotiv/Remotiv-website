/**
 * The length of the email code Supabase Auth sends (Auth > Email > OTP length),
 * set to 6 on staging and production (#51). The invitation page's copy and its
 * code field use this; the server accepts 6 to 10 digits, Supabase's whole
 * range, so a changed setting never locks anyone out, only reads oddly.
 * scripts/staging/proofs-051.mjs fails if staging's codes are another length.
 */
export const INVITE_CODE_LENGTH = 6;
