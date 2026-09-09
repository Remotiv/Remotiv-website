/**
 * Where a job is, as two fields and one display string.
 *
 * ── Why this module exists ───────────────────────────────────
 *
 * `jobs.location` was one free-text box, and the 21 live rows show what that
 * produced: six say "Lahore", six say "Pakistan", one says "Karachi, Pakistan",
 * and two say "Remote" — which is not a place at all, it is the work type,
 * already stored in its own column.
 *
 * So the input splits into `country` and `city`, and this module owns both the
 * string they compose into and the structured data they feed. One helper, used
 * by the admin form, the AI dashboard wizard and both job detail pages, because
 * a display string composed two different ways is a display string that drifts.
 *
 * ── `location` stays, and stays authoritative for display ────
 *
 * Every consumer — the board card, the board's substring filter, both detail
 * pages, the OG image, the sitemap, admin lists, search subtitles — reads
 * `location`. None of them is changed by this. Rows written before the split
 * keep the exact string they hold and go on rendering it.
 *
 * A PLAIN MODULE — no imports — so both client forms can use it.
 */

/** ISO 3166-1, from Node's own region data. Names are what we store. */
export type Country = { code: string; name: string };

/**
 * Every country, not a shortlist.
 *
 * Remotiv places Pakistani talent with global employers, so a client hiring in
 * Germany or the UAE is the ordinary case. A curated list plus "Other" would be
 * a wall that costs a code change every time a customer is won somewhere new.
 */
export const COUNTRIES: readonly Country[] = [
  { code: "AF", name: "Afghanistan" },
  { code: "AX", name: "Åland Islands" },
  { code: "AL", name: "Albania" },
  { code: "DZ", name: "Algeria" },
  { code: "AS", name: "American Samoa" },
  { code: "AD", name: "Andorra" },
  { code: "AO", name: "Angola" },
  { code: "AI", name: "Anguilla" },
  { code: "AQ", name: "Antarctica" },
  { code: "AG", name: "Antigua & Barbuda" },
  { code: "AR", name: "Argentina" },
  { code: "AM", name: "Armenia" },
  { code: "AW", name: "Aruba" },
  { code: "AU", name: "Australia" },
  { code: "AT", name: "Austria" },
  { code: "AZ", name: "Azerbaijan" },
  { code: "BS", name: "Bahamas" },
  { code: "BH", name: "Bahrain" },
  { code: "BD", name: "Bangladesh" },
  { code: "BB", name: "Barbados" },
  { code: "BY", name: "Belarus" },
  { code: "BE", name: "Belgium" },
  { code: "BZ", name: "Belize" },
  { code: "BJ", name: "Benin" },
  { code: "DY", name: "Benin" },
  { code: "BM", name: "Bermuda" },
  { code: "BT", name: "Bhutan" },
  { code: "BO", name: "Bolivia" },
  { code: "BA", name: "Bosnia & Herzegovina" },
  { code: "BW", name: "Botswana" },
  { code: "BV", name: "Bouvet Island" },
  { code: "BR", name: "Brazil" },
  { code: "IO", name: "British Indian Ocean Territory" },
  { code: "VG", name: "British Virgin Islands" },
  { code: "BN", name: "Brunei" },
  { code: "BG", name: "Bulgaria" },
  { code: "BF", name: "Burkina Faso" },
  { code: "HV", name: "Burkina Faso" },
  { code: "BI", name: "Burundi" },
  { code: "KH", name: "Cambodia" },
  { code: "CM", name: "Cameroon" },
  { code: "CA", name: "Canada" },
  { code: "CV", name: "Cape Verde" },
  { code: "BQ", name: "Caribbean Netherlands" },
  { code: "KY", name: "Cayman Islands" },
  { code: "CF", name: "Central African Republic" },
  { code: "TD", name: "Chad" },
  { code: "CL", name: "Chile" },
  { code: "CN", name: "China" },
  { code: "CX", name: "Christmas Island" },
  { code: "CC", name: "Cocos (Keeling) Islands" },
  { code: "CO", name: "Colombia" },
  { code: "KM", name: "Comoros" },
  { code: "CG", name: "Congo - Brazzaville" },
  { code: "CD", name: "Congo - Kinshasa" },
  { code: "ZR", name: "Congo - Kinshasa" },
  { code: "CK", name: "Cook Islands" },
  { code: "CR", name: "Costa Rica" },
  { code: "CI", name: "Côte d’Ivoire" },
  { code: "HR", name: "Croatia" },
  { code: "CU", name: "Cuba" },
  { code: "AN", name: "Curaçao" },
  { code: "CW", name: "Curaçao" },
  { code: "CY", name: "Cyprus" },
  { code: "CZ", name: "Czechia" },
  { code: "DK", name: "Denmark" },
  { code: "DJ", name: "Djibouti" },
  { code: "DM", name: "Dominica" },
  { code: "DO", name: "Dominican Republic" },
  { code: "EC", name: "Ecuador" },
  { code: "EG", name: "Egypt" },
  { code: "SV", name: "El Salvador" },
  { code: "GQ", name: "Equatorial Guinea" },
  { code: "ER", name: "Eritrea" },
  { code: "EE", name: "Estonia" },
  { code: "SZ", name: "Eswatini" },
  { code: "ET", name: "Ethiopia" },
  { code: "FK", name: "Falkland Islands" },
  { code: "FO", name: "Faroe Islands" },
  { code: "FJ", name: "Fiji" },
  { code: "FI", name: "Finland" },
  { code: "FR", name: "France" },
  { code: "FX", name: "France" },
  { code: "GF", name: "French Guiana" },
  { code: "PF", name: "French Polynesia" },
  { code: "TF", name: "French Southern Territories" },
  { code: "GA", name: "Gabon" },
  { code: "GM", name: "Gambia" },
  { code: "GE", name: "Georgia" },
  { code: "DD", name: "Germany" },
  { code: "DE", name: "Germany" },
  { code: "GH", name: "Ghana" },
  { code: "GI", name: "Gibraltar" },
  { code: "GR", name: "Greece" },
  { code: "GL", name: "Greenland" },
  { code: "GD", name: "Grenada" },
  { code: "GP", name: "Guadeloupe" },
  { code: "GU", name: "Guam" },
  { code: "GT", name: "Guatemala" },
  { code: "GG", name: "Guernsey" },
  { code: "GN", name: "Guinea" },
  { code: "GW", name: "Guinea-Bissau" },
  { code: "GY", name: "Guyana" },
  { code: "HT", name: "Haiti" },
  { code: "HM", name: "Heard & McDonald Islands" },
  { code: "HN", name: "Honduras" },
  { code: "HK", name: "Hong Kong SAR China" },
  { code: "HU", name: "Hungary" },
  { code: "IS", name: "Iceland" },
  { code: "IN", name: "India" },
  { code: "ID", name: "Indonesia" },
  { code: "IR", name: "Iran" },
  { code: "IQ", name: "Iraq" },
  { code: "IE", name: "Ireland" },
  { code: "IM", name: "Isle of Man" },
  { code: "IL", name: "Israel" },
  { code: "IT", name: "Italy" },
  { code: "JM", name: "Jamaica" },
  { code: "JP", name: "Japan" },
  { code: "JE", name: "Jersey" },
  { code: "JO", name: "Jordan" },
  { code: "KZ", name: "Kazakhstan" },
  { code: "KE", name: "Kenya" },
  { code: "KI", name: "Kiribati" },
  { code: "XK", name: "Kosovo" },
  { code: "KW", name: "Kuwait" },
  { code: "KG", name: "Kyrgyzstan" },
  { code: "LA", name: "Laos" },
  { code: "LV", name: "Latvia" },
  { code: "LB", name: "Lebanon" },
  { code: "LS", name: "Lesotho" },
  { code: "LR", name: "Liberia" },
  { code: "LY", name: "Libya" },
  { code: "LI", name: "Liechtenstein" },
  { code: "LT", name: "Lithuania" },
  { code: "LU", name: "Luxembourg" },
  { code: "MO", name: "Macao SAR China" },
  { code: "MG", name: "Madagascar" },
  { code: "MW", name: "Malawi" },
  { code: "MY", name: "Malaysia" },
  { code: "MV", name: "Maldives" },
  { code: "ML", name: "Mali" },
  { code: "MT", name: "Malta" },
  { code: "MH", name: "Marshall Islands" },
  { code: "MQ", name: "Martinique" },
  { code: "MR", name: "Mauritania" },
  { code: "MU", name: "Mauritius" },
  { code: "YT", name: "Mayotte" },
  { code: "MX", name: "Mexico" },
  { code: "FM", name: "Micronesia" },
  { code: "MD", name: "Moldova" },
  { code: "MC", name: "Monaco" },
  { code: "MN", name: "Mongolia" },
  { code: "ME", name: "Montenegro" },
  { code: "MS", name: "Montserrat" },
  { code: "MA", name: "Morocco" },
  { code: "MZ", name: "Mozambique" },
  { code: "BU", name: "Myanmar (Burma)" },
  { code: "MM", name: "Myanmar (Burma)" },
  { code: "NA", name: "Namibia" },
  { code: "NR", name: "Nauru" },
  { code: "NP", name: "Nepal" },
  { code: "NL", name: "Netherlands" },
  { code: "NC", name: "New Caledonia" },
  { code: "NZ", name: "New Zealand" },
  { code: "NI", name: "Nicaragua" },
  { code: "NE", name: "Niger" },
  { code: "NG", name: "Nigeria" },
  { code: "NU", name: "Niue" },
  { code: "NF", name: "Norfolk Island" },
  { code: "KP", name: "North Korea" },
  { code: "MK", name: "North Macedonia" },
  { code: "MP", name: "Northern Mariana Islands" },
  { code: "NO", name: "Norway" },
  { code: "OM", name: "Oman" },
  { code: "PK", name: "Pakistan" },
  { code: "PW", name: "Palau" },
  { code: "PS", name: "Palestinian Territories" },
  { code: "PA", name: "Panama" },
  { code: "PG", name: "Papua New Guinea" },
  { code: "PY", name: "Paraguay" },
  { code: "PE", name: "Peru" },
  { code: "PH", name: "Philippines" },
  { code: "PN", name: "Pitcairn Islands" },
  { code: "PL", name: "Poland" },
  { code: "PT", name: "Portugal" },
  { code: "PR", name: "Puerto Rico" },
  { code: "QA", name: "Qatar" },
  { code: "RE", name: "Réunion" },
  { code: "RO", name: "Romania" },
  { code: "RU", name: "Russia" },
  { code: "SU", name: "Russia" },
  { code: "RW", name: "Rwanda" },
  { code: "WS", name: "Samoa" },
  { code: "SM", name: "San Marino" },
  { code: "ST", name: "São Tomé & Príncipe" },
  { code: "CQ", name: "Sark" },
  { code: "SA", name: "Saudi Arabia" },
  { code: "SN", name: "Senegal" },
  { code: "CS", name: "Serbia" },
  { code: "RS", name: "Serbia" },
  { code: "YU", name: "Serbia" },
  { code: "SC", name: "Seychelles" },
  { code: "SL", name: "Sierra Leone" },
  { code: "SG", name: "Singapore" },
  { code: "SX", name: "Sint Maarten" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
  { code: "SB", name: "Solomon Islands" },
  { code: "SO", name: "Somalia" },
  { code: "ZA", name: "South Africa" },
  { code: "GS", name: "South Georgia & South Sandwich Islands" },
  { code: "KR", name: "South Korea" },
  { code: "SS", name: "South Sudan" },
  { code: "ES", name: "Spain" },
  { code: "LK", name: "Sri Lanka" },
  { code: "BL", name: "St. Barthélemy" },
  { code: "SH", name: "St. Helena" },
  { code: "KN", name: "St. Kitts & Nevis" },
  { code: "LC", name: "St. Lucia" },
  { code: "MF", name: "St. Martin" },
  { code: "PM", name: "St. Pierre & Miquelon" },
  { code: "VC", name: "St. Vincent & Grenadines" },
  { code: "SD", name: "Sudan" },
  { code: "SR", name: "Suriname" },
  { code: "SJ", name: "Svalbard & Jan Mayen" },
  { code: "SE", name: "Sweden" },
  { code: "CH", name: "Switzerland" },
  { code: "SY", name: "Syria" },
  { code: "TW", name: "Taiwan" },
  { code: "TJ", name: "Tajikistan" },
  { code: "TZ", name: "Tanzania" },
  { code: "TH", name: "Thailand" },
  { code: "TL", name: "Timor-Leste" },
  { code: "TP", name: "Timor-Leste" },
  { code: "TG", name: "Togo" },
  { code: "TK", name: "Tokelau" },
  { code: "TO", name: "Tonga" },
  { code: "TT", name: "Trinidad & Tobago" },
  { code: "TN", name: "Tunisia" },
  { code: "TR", name: "Türkiye" },
  { code: "TM", name: "Turkmenistan" },
  { code: "TC", name: "Turks & Caicos Islands" },
  { code: "TV", name: "Tuvalu" },
  { code: "UM", name: "U.S. Outlying Islands" },
  { code: "VI", name: "U.S. Virgin Islands" },
  { code: "UG", name: "Uganda" },
  { code: "UA", name: "Ukraine" },
  { code: "AE", name: "United Arab Emirates" },
  { code: "GB", name: "United Kingdom" },
  { code: "UK", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "UY", name: "Uruguay" },
  { code: "UZ", name: "Uzbekistan" },
  { code: "NH", name: "Vanuatu" },
  { code: "VU", name: "Vanuatu" },
  { code: "VA", name: "Vatican City" },
  { code: "VE", name: "Venezuela" },
  { code: "VD", name: "Vietnam" },
  { code: "VN", name: "Vietnam" },
  { code: "WF", name: "Wallis & Futuna" },
  { code: "EH", name: "Western Sahara" },
  { code: "YD", name: "Yemen" },
  { code: "YE", name: "Yemen" },
  { code: "ZM", name: "Zambia" },
  { code: "RH", name: "Zimbabwe" },
  { code: "ZW", name: "Zimbabwe" },
];

/** Most roles sit here, so the select opens on it. */
export const DEFAULT_COUNTRY = "Pakistan";

/**
 * The one display string, composed the one way.
 *
 * City first, then country — matching the two live rows that already use that
 * shape ("Karachi, Pakistan"). Country alone is NORMAL, not a fallback: six of
 * the 21 live rows are exactly that, and a genuinely remote role often has no
 * city to name.
 *
 * Returns null when there is no country, and the caller must then LEAVE
 * `location` ALONE rather than write an empty string. That is the whole
 * protection for rows written before the split: opening one for editing shows
 * two blank inputs, and saving without filling them must not overwrite a live
 * job's display text with "".
 */
export function composeLocation(input: {
  country?: string | null;
  city?: string | null;
}): string | null {
  const country = (input.country ?? "").trim();
  if (!country) return null;
  const city = (input.city ?? "").trim();
  return city ? `${city}, ${country}` : country;
}

/** ISO code for a stored country name, or null if we do not recognise it. */
export function countryCode(name: string | null | undefined): string | null {
  const wanted = (name ?? "").trim().toLowerCase();
  if (!wanted) return null;
  return COUNTRIES.find((c) => c.name.toLowerCase() === wanted)?.code ?? null;
}

/**
 * The JobPosting location fields, or nothing at all.
 *
 * ── What this replaces, and why it was wrong twice ───────────
 *
 * Both detail pages emitted, on EVERY job:
 *
 *   applicantLocationRequirements: { "@type": "Country", name: job.location }
 *
 * `applicantLocationRequirements` states where an APPLICANT may live, and
 * Google reads it only alongside `jobLocationType: "TELECOMMUTE"`. It was being
 * sent for on-site roles too. And its value was the display string, so Google
 * was told that "Lahore", "Remote" and "Karachi, Pakistan" are country names.
 *
 * Meanwhile `jobLocation` — which Google requires for a role that is not
 * remote — was absent entirely, so every on-site job had no location in its
 * structured data at all. That defect is older than this split and would be
 * worth fixing on its own.
 *
 * ── Omission beats assertion ─────────────────────────────────
 *
 * A row with neither column gets NEITHER key. Not an empty PostalAddress, not
 * the display string in a Country. A job Google cannot place is a job it leaves
 * alone; a job it places wrongly is worse, and "wrongly" is what the previous
 * code guaranteed for all ~30 rows.
 */
export function jobLocationSchema(input: {
  workType?: string | null;
  country?: string | null;
  city?: string | null;
}): Record<string, unknown> {
  const country = (input.country ?? "").trim();
  const city = (input.city ?? "").trim();
  const remote = (input.workType ?? "").trim().toLowerCase() === "remote";

  if (remote) {
    return {
      jobLocationType: "TELECOMMUTE",
      // Where an applicant may be based. Only meaningful with a real country.
      ...(country ? { applicantLocationRequirements: { "@type": "Country", name: country } } : {}),
    };
  }

  if (!country && !city) return {};

  return {
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        ...(city ? { addressLocality: city } : {}),
        // ISO alpha-2 where we can resolve it, which is what Google prefers;
        // the stored name otherwise, which it still accepts.
        ...(country ? { addressCountry: countryCode(country) ?? country } : {}),
      },
    },
  };
}
