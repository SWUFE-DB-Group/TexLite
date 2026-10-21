import { useEffect, useState } from "react";

/** Refresh minute-resolution labels without polling for new data. */
export function useRelativeTimeNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function formatRelativeTime(
  value: string,
  locale: string,
  now: number,
  translate: (key: string, options: { days: number; hours: number; minutes: number }) => string
): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;

  const difference = timestamp - now;
  const absoluteDifference = Math.abs(difference);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const threeDays = 3 * day;
  if (absoluteDifference < minute) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  if (absoluteDifference > threeDays) {
    const days = Math.floor(absoluteDifference / day);
    const direction = difference < 0 ? "Past" : "Future";
    return translate(`projects.relativeDays${direction}`, { days, hours: 0, minutes: 0 });
  }
  if (absoluteDifference >= day) {
    const days = Math.floor(absoluteDifference / day);
    const hours = Math.floor((absoluteDifference % day) / hour);
    const direction = difference < 0 ? "Past" : "Future";
    const unit = hours > 0 ? "DaysHours" : "Days";
    return translate(`projects.relative${unit}${direction}`, { days, hours, minutes: 0 });
  }
  if (absoluteDifference >= hour) {
    const hours = Math.floor(absoluteDifference / hour);
    const minutes = Math.floor((absoluteDifference % hour) / minute);
    const direction = difference < 0 ? "Past" : "Future";
    const unit = minutes > 0 ? "HoursMinutes" : "Hours";
    return translate(`projects.relative${unit}${direction}`, { days: 0, hours, minutes });
  }
  const amount = Math.sign(difference) * Math.max(1, Math.floor(absoluteDifference / minute));
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(amount, "minute");
}
