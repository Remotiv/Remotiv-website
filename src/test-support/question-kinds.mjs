/**
 * Question fixtures for both interview kinds (migration 082).
 *
 * A job's async and AI Video Interview questions are two lists, told apart by
 * interview_questions.interview_kind. Tests written before 082 seeded one list
 * and sent both kinds of invite from it; `withLiveCopies` keeps those rows as
 * the async list and adds the same questions again as the live list, with
 * their own ids, as two lists in the real table would be.
 */
export function withLiveCopies(rows) {
  return [
    ...rows.map((r) => ({ ...r, interview_kind: "async" })),
    ...rows.map((r) => ({ ...r, id: `live-${r.id}`, interview_kind: "live" })),
  ];
}
