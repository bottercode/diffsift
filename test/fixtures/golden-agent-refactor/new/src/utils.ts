export function fetchUser(id: string) {
  return db.query("select * from users where id = ?", [id]);
}
