import { getUser, isExpired } from './utils'

export async function handler(req: Request) {
  const user = await getUser(req.userId)
  if (isExpired(req.session)) throw new Error('expired')
  return user
}
