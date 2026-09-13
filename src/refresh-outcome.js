/**
 * What the owner should hear after `refresh()`.
 *
 * `refresh()` returns a structured result. Treating "the RPC returned" as
 * success announced 「來源已重新整理」 over `failedSafe: 1` (#1960).
 */

export function classifyRefreshOutcome(result) {
  const failedSafe = Number(result?.failedSafe ?? 0);
  const unknown = Number(result?.unknown ?? 0);
  const perSource = Array.isArray(result?.perSource) ? result.perSource : [];
  const detail =
    perSource
      .map((row) => (typeof row?.message === "string" ? row.message.trim() : ""))
      .find((message) => message) || "";

  if (failedSafe > 0 || unknown > 0) {
    const succeeded = Number(result?.new ?? 0) + Number(result?.changed ?? 0) + Number(result?.unchanged ?? 0);
    if (succeeded > 0) {
      return { ok: false, titleKey: "refreshPartialTitle", detail };
    }
    return { ok: false, titleKey: "refreshFailedTitle", detail };
  }
  return { ok: true, titleKey: "refreshedTitle", detail: "" };
}
