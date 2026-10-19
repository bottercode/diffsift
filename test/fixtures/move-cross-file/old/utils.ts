export function keep() {
  return 1;
}

export function slug(text: string) {
  return text.toLowerCase().replace(/ /g, '-');
}
