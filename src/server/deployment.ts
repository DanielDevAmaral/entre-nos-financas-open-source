import { timingSafeEqual } from "node:crypto";

export function deployment() {
  const remote = !!process.env.DATABASE_URL;
  if (!remote) return { remote: false, origin: null } as const;
  const value = process.env.APP_ORIGIN;
  if (!value)
    throw new Error("Configure APP_ORIGIN antes de usar o banco remoto.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error("APP_ORIGIN deve ser uma origem HTTPS exata, sem caminho.");
  return { remote: true, origin: url.origin } as const;
}
export function validSecret(actual: unknown, expected: string | undefined) {
  if (!expected || expected.length < 32 || typeof actual !== "string")
    return false;
  const left = Buffer.from(actual),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
