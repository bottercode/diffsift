export class Store {
  save(value) {
    this.write(value);
  }

  load() {
    return this.read();
  }
}
