// Local wall-clock ISO-8601 with a numeric UTC offset. This matches the
// standalone monitor's `datetime.now().astimezone().isoformat(...)` CSV value;
// JavaScript's toISOString() is UTC with a trailing Z and is not equivalent.
export function localIsoTimestamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(Math.abs(value)).padStart(width, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(hours)}:${pad(minutes)}`;
}
