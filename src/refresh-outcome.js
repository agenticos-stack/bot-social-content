/**
 * What the owner should hear after `refresh()`.
 *
 * Classify from the actual source outcomes. Item counts are not a scan
 * result: a confirmed-empty account is a successful scan, a broker miss
 * (`no_answer`) is not, and a skipped run is not a refresh.
 */

const PROBLEM_OUTCOMES = new Set(["failed_safe", "unknown", "no_answer", "skipped"]);

export function classifyRefreshOutcome(result) {
  if (result?.skipped) {
    const detail = typeof result.reason === "string" ? result.reason.trim() : "";
    return { ok: false, titleKey: "refreshSkippedTitle", detail };
  }

  const perSource = Array.isArray(result?.perSource) ? result.perSource : [];
  const detail =
    perSource
      .map((row) => (typeof row?.message === "string" ? row.message.trim() : ""))
      .find((message) => message) || (typeof result?.reason === "string" ? result.reason.trim() : "");

  if (perSource.length > 0) {
    const confirmed = perSource.filter((row) => row?.outcome === "confirmed").length;
    const problems = perSource.filter((row) => PROBLEM_OUTCOMES.has(row?.outcome)).length;
    if (confirmed + problems > 0) {
      if (problems > 0 && confirmed > 0) {
        return { ok: false, titleKey: "refreshPartialTitle", detail };
      }
      if (problems > 0) {
        const onlyMiss = problems === perSource.length && perSource.every((row) => row?.outcome === "no_answer");
        return { ok: false, titleKey: onlyMiss ? "refreshNoAnswerTitle" : "refreshFailedTitle", detail };
      }
      return { ok: true, titleKey: "refreshedTitle", detail: "" };
    }
  }

  const failedSafe = Number(result?.failedSafe ?? 0);
  const unknown = Number(result?.unknown ?? 0) + Number(result?.noAnswer ?? 0);
  if (failedSafe > 0 || unknown > 0) {
    const succeeded = Number(result?.new ?? 0) + Number(result?.changed ?? 0) + Number(result?.unchanged ?? 0);
    if (succeeded > 0) {
      return { ok: false, titleKey: "refreshPartialTitle", detail };
    }
    return { ok: false, titleKey: "refreshFailedTitle", detail };
  }
  return { ok: true, titleKey: "refreshedTitle", detail: "" };
}
