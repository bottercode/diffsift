export class Store {
  load() {
    return this.read();
  }

  save(value) {
    this.write(value);
  }
}
