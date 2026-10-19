export function isExpired(session: Session) {
  return session.expiresAt <= Date.now();
}
