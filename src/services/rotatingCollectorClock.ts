/** The run key and persisted observation label keep their existing JST second precision. */
export function rotatingCollectorClock(now: Date) {
  const exactIso = now.toISOString();
  const local = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 19);
  const date = local.slice(0, 10);
  const hour = Number(local.slice(11, 13));
  const runStamp = date.replaceAll('-', '') + '_' + local.slice(11).replaceAll(':', '');
  return { exactIso, iso: local + '+09:00', date, hour, runStamp };
}
