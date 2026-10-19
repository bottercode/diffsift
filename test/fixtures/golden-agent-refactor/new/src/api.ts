import { fetchUser } from "./utils";
import { isExpired } from "./auth/session";

export async function handler(req: Request) {
  const user = await fetchUser(req.userId);
  if (isExpired(req.session)) throw new Error("expired");
  return user;
}
