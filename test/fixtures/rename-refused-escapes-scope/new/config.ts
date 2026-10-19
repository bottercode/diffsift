export function read() {
  const settings = load();
  return settings.port;
}

export function fallback() {
  return settings.port;
}
