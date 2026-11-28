/** The run key and persisted observation label keep their existing JST second precision. */
export function rotatingCollectorClock(now: Date) {
  const exactIso = new Date(now.getTime() + 9 * 3600000).toISOString().replace(/Z$/u, '+09:00');
  const local = exactIso.slice(0, 19);
  const date = local.slice(0, 10);
  const hour = Number(local.slice(11, 13));
  const runStamp = date.replaceAll('-', '') + '_' + local.slice(11).replaceAll(':', '');
  return { exactIso, iso: local + '+09:00', date, hour, runStamp };
}
