export function read() {
  const config = load();
  return config.port;
}

export function fallback() {
  return config.port;
}
