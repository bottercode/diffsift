export function getUser(id: string) {
  return db.query('select * from users where id = ?', [id])
}

export function isExpired(session: Session) {
  return session.expiresAt < Date.now()
}
