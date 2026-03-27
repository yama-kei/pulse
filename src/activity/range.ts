const RANGE_RE = /^(\d+)([dhm])$/;

const MULTIPLIERS: Record<string, number> = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
};

export function parseRange(range: string, now: Date = new Date()): Date {
  const match = range.match(RANGE_RE);
  if (!match) throw new Error(`Invalid range: "${range}". Use e.g. 7d, 24h, 30m`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (value <= 0) throw new Error(`Invalid range: value must be > 0`);
  return new Date(now.getTime() - value * MULTIPLIERS[unit]);
}
