import { Temporal } from "@js-temporal/polyfill";

export type TimeRange = {
  from: string;
  to: string;
};

function startOfDay(
  date: Temporal.PlainDate,
  timezone: string,
): Temporal.ZonedDateTime {
  return date.toZonedDateTime({
    timeZone: timezone,
    plainTime: Temporal.PlainTime.from("00:00"),
  });
}

export function parseTimeRange(input: {
  from?: string;
  to?: string;
  since?: string;
  timezone: string;
  now?: string;
}): TimeRange {
  if (input.since) {
    const match = /^(\d+)([dhw])$/.exec(input.since);
    if (!match) throw new Error("--since must look like 24h, 7d, or 2w");
    const amount = Number(match[1]);
    const unit = match[2];
    const now = input.now
      ? Temporal.Instant.from(input.now)
      : Temporal.Now.instant();
    const duration =
      unit === "h"
        ? { hours: amount }
        : unit === "d"
          ? { days: amount }
          : { weeks: amount };
    const from = now
      .toZonedDateTimeISO(input.timezone)
      .subtract(duration)
      .toInstant();
    return { from: from.toString(), to: now.toString() };
  }

  if (!input.from || !input.to)
    throw new Error("Provide --from and --to, or use --since");
  const fromDate = Temporal.PlainDate.from(input.from);
  const toDate = Temporal.PlainDate.from(input.to);
  const from = startOfDay(fromDate, input.timezone).toInstant();
  const to = startOfDay(toDate.add({ days: 1 }), input.timezone).toInstant();
  return { from: from.toString(), to: to.toString() };
}

export function formatTimeRangeLabel(
  from: string,
  to: string,
  timezone: string,
): { fromDate: string; toDate: string } {
  const fromDate = Temporal.Instant.from(from)
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
  const inclusiveEnd = Temporal.Instant.from(to).subtract({ nanoseconds: 1 });
  const toDate = inclusiveEnd
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .toString();
  return { fromDate, toDate };
}
