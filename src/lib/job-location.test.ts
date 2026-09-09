/**
 * The display string and the structured data.
 *
 *   node --test src/lib/job-location.test.ts
 *
 * Two properties carry this change. Rows written BEFORE the split must go on
 * rendering exactly what they hold — nothing here may rewrite them. And a row
 * we cannot place must emit no location to Google at all, rather than the
 * confident wrong answer the previous code gave for every job on the site.
 */

// @ts-nocheck — same reason as src/lib/supabase/paging.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COUNTRIES,
  composeLocation,
  countryCode,
  DEFAULT_COUNTRY,
  jobLocationSchema,
} from "./job-location.ts";

test("the country list is the full ISO set, with Pakistan in it", () => {
  assert.ok(COUNTRIES.length > 240, `expected the ISO set, got ${COUNTRIES.length}`);
  assert.ok(COUNTRIES.some((c) => c.name === DEFAULT_COUNTRY));
  for (const code of ["PK", "DE", "AE", "GB", "US"]) {
    assert.ok(
      COUNTRIES.some((c) => c.code === code),
      `${code} missing — a client hiring there is the ordinary case`,
    );
  }
  // Aggregates are not countries and must not be offered.
  for (const code of ["EU", "UN", "ZZ", "QO"]) {
    assert.ok(!COUNTRIES.some((c) => c.code === code), `${code} is not a country`);
  }
  assert.deepEqual(
    [...COUNTRIES].sort((a, b) => a.name.localeCompare(b.name, "en")).map((c) => c.code),
    COUNTRIES.map((c) => c.code),
    "the list is sorted, because a 267-item select that is not is unusable",
  );
});

test("city and country compose the way the live rows already read", () => {
  assert.equal(composeLocation({ country: "Pakistan", city: "Karachi" }), "Karachi, Pakistan");
});

test("country alone is normal, not a fallback", () => {
  // Six of the 21 live rows are exactly this, and a remote role often has no
  // city to name.
  assert.equal(composeLocation({ country: "Pakistan" }), "Pakistan");
  assert.equal(composeLocation({ country: "Pakistan", city: "   " }), "Pakistan");
});

test("no country returns null, so the caller leaves `location` alone", () => {
  /*
   * THE protection for rows written before the split. They open for editing
   * with both inputs blank; if this returned "" the save would overwrite a live
   * job's display text with nothing.
   */
  assert.equal(composeLocation({}), null);
  assert.equal(composeLocation({ city: "Lahore" }), null);
  assert.equal(composeLocation({ country: "  ", city: "Lahore" }), null);
});

test("an on-site role gets a Place, with the ISO code Google prefers", () => {
  assert.deepEqual(
    jobLocationSchema({ workType: "On-site", country: "Pakistan", city: "Lahore" }),
    {
      jobLocation: {
        "@type": "Place",
        address: { "@type": "PostalAddress", addressLocality: "Lahore", addressCountry: "PK" },
      },
    },
  );
});

test("a hybrid role is a Place too — TELECOMMUTE is for remote only", () => {
  const schema = jobLocationSchema({ workType: "Hybrid", country: "Germany", city: "Berlin" });
  assert.ok(schema.jobLocation, "hybrid work still happens somewhere");
  assert.equal(schema.jobLocationType, undefined);
});

test("a remote role is TELECOMMUTE with an applicant requirement", () => {
  assert.deepEqual(jobLocationSchema({ workType: "Remote", country: "Pakistan" }), {
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { "@type": "Country", name: "Pakistan" },
  });
});

test("a row with neither column emits NO location key at all", () => {
  /*
   * The ~30 rows written before the split. What this replaces sent
   * `applicantLocationRequirements: { "@type": "Country", name: job.location }`
   * on every job — telling Google that "Lahore", "Remote" and
   * "Karachi, Pakistan" were country names — while never sending jobLocation,
   * which is the field it actually wants for a role that is not remote.
   *
   * A job Google cannot place is one it leaves alone. A job it places wrongly
   * is worse.
   */
  assert.deepEqual(jobLocationSchema({ workType: "On-site" }), {});
  assert.deepEqual(jobLocationSchema({}), {});

  // Remote still declares itself remote — that much is known from work_type —
  // but claims nothing about where.
  assert.deepEqual(jobLocationSchema({ workType: "Remote" }), {
    jobLocationType: "TELECOMMUTE",
  });
});

test("a city with no country is not enough for a Country claim", () => {
  const schema = jobLocationSchema({ workType: "On-site", city: "Lahore" });
  assert.deepEqual(schema.jobLocation.address, {
    "@type": "PostalAddress",
    addressLocality: "Lahore",
  });
  assert.ok(!("addressCountry" in schema.jobLocation.address), "never guess the country");
});

test("an unrecognised country name is passed through rather than dropped", () => {
  // Google accepts a name where it cannot get a code, and a stored value we do
  // not recognise is still the employer's answer.
  const schema = jobLocationSchema({ workType: "On-site", country: "Wakanda" });
  assert.equal(schema.jobLocation.address.addressCountry, "Wakanda");
  assert.equal(countryCode("Wakanda"), null);
  assert.equal(countryCode("pakistan"), "PK", "matching is case-insensitive");
  assert.equal(countryCode(null), null);
});
