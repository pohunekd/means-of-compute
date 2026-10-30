export function parseMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function insideWindow(now: Date, start: string, end: string): boolean {
  const nowM = now.getHours() * 60 + now.getMinutes();
  const startM = parseMinutes(start);
  const endM = parseMinutes(end);
  if (startM === endM) return true;
  if (startM <= endM) {
    return nowM >= startM && nowM < endM;
  }
  return nowM >= startM || nowM < endM;
}

export function deriveIdle(
  secondsSinceInput: number,
  acPower: boolean,
  batteryPercent: number | null,
  insideWindow: boolean,
  idleMinutes: number,
  batteryThreshold: number,
  userActivityUnknown = false,
  userActivityCause = "",
  powerUnknown = false,
  powerCause = "",
  loggedOut = false,
  unattendedWindow: string | null = null,
): { idle: boolean; reason: string } {
  if (userActivityUnknown) {
    return { idle: false, reason: `user activity unknown: ${userActivityCause || "unavailable"}` };
  }
  if (powerUnknown) {
    return { idle: false, reason: `power unknown: ${powerCause || "unavailable"}` };
  }
  const idleMinutesSec = idleMinutes * 60;
  const batteryOk = batteryPercent === null || batteryPercent > batteryThreshold;

  if (!insideWindow) {
    return { idle: false, reason: "outside the policy window" };
  }
  if (!acPower) {
    return { idle: false, reason: "not on AC power" };
  }
  if (!batteryOk) {
    return {
      idle: false,
      reason: `battery at ${String(batteryPercent)} percent, at or below the ${String(batteryThreshold)} percent floor`,
    };
  }
  if (loggedOut) {
    return { idle: true, reason: "no user logged in, on AC power" };
  }
  if (secondsSinceInput < idleMinutesSec) {
    return { idle: false, reason: `user input ${String(secondsSinceInput)} seconds ago` };
  }
  const mins = Math.round(secondsSinceInput / 60);
  if (unattendedWindow !== null) {
    return {
      idle: true,
      reason: `unattended window ${unattendedWindow}: no input on the local session for ${String(mins)} minutes, on AC power`,
    };
  }
  return { idle: true, reason: `no user input for ${String(mins)} minutes, on AC power` };
}
