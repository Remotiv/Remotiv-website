"use client";

import Link from "next/link";
import { useState } from "react";
import type { CareersRole } from "./_data";
import { ARROW, Icon } from "./_icons";

/**
 * The roles index — head, filter tabs and the grouped rows.
 *
 * A client component only because the category filter is interactive. The
 * masthead, the closer and the footer stay on the server; this is the smallest
 * boundary that covers the one piece of state on the page.
 *
 * Everything it receives is already the public projection (see CareersRole) —
 * no job row, no screening questions, no ownership columns cross into the RSC
 * payload.
 */

/** 01…09 then 10, matching the reference's pad(). */
function pad(i: number): string {
  return `${i < 9 ? "0" : ""}${i + 1}`;
}

export function RolesIndex({ roles, categories }: { roles: CareersRole[]; categories: string[] }) {
  const [filter, setFilter] = useState("All");

  const visibleCategories = categories.filter((c) => filter === "All" || filter === c);

  /*
   * The row number counts across the WHOLE index, not within a group, and it
   * keeps counting across a filter — the reference increments one `i` through
   * the rendered groups. Computed here rather than from the array position so
   * a filtered view numbers 01, 02, 03 rather than inheriting gaps.
   */
  let n = 0;

  return (
    <>
      <div className="rhead" id="roles">
        <div>
          <p className="eyebrow">
            {roles.length} live {roles.length === 1 ? "position" : "positions"}
          </p>
          <h2>Open roles</h2>
        </div>
        {/* Only when there is more than one category — a single tab that
            filters nothing is a control that does nothing. */}
        {categories.length > 1 && (
          <div className="fils">
            <button
              type="button"
              className={`fil${filter === "All" ? " on" : ""}`}
              onClick={() => setFilter("All")}
            >
              All<b>{roles.length}</b>
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className={`fil${filter === c ? " on" : ""}`}
                onClick={() => setFilter(c)}
              >
                {c}
                <b>{roles.filter((r) => r.category === c).length}</b>
              </button>
            ))}
          </div>
        )}
      </div>

      {visibleCategories.map((category) => {
        const group = roles.filter((r) => r.category === category);
        return (
          <div className="grp" key={category}>
            <div className="glab">
              <p className="eyebrow">{category}</p>
              <span className="rule" />
              <p className="meta">
                {group.length} {group.length === 1 ? "role" : "roles"}
              </p>
            </div>
            <div className="rows">
              {group.map((role) => {
                n += 1;
                return (
                  <Link className="row" href={role.href} key={role.id}>
                    <span className="rnum">{pad(n - 1)}</span>
                    <div>
                      <p className="rt">
                        {role.title}
                        {role.isNew && <span className="new">New</span>}
                      </p>
                      {role.meta.length > 0 && (
                        <ul className="rmeta">
                          {role.meta.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <span className="rright">
                      <span className="pay">
                        {role.pay}
                        {role.payUnit && <span>{role.payUnit}</span>}
                      </span>
                      <span className="rgo">
                        <Icon d={ARROW} />
                      </span>
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
