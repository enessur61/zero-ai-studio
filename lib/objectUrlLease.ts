export class ObjectUrlLease {
  private readonly owned = new Set<string>();

  constructor(private readonly revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)) {}

  adopt(url: string): string {
    if (url.startsWith('blob:')) this.owned.add(url);
    return url;
  }

  /** Replace an owned URL and adopt the new one as one ownership operation. */
  replace(previousUrl: string | null | undefined, nextUrl: string): string {
    this.release(previousUrl);
    return this.adopt(nextUrl);
  }

  /** Transfer ownership to another component without revoking the URL. */
  transfer(url: string): boolean {
    return this.owned.delete(url);
  }

  release(url: string | null | undefined): boolean {
    if (!url || !this.owned.delete(url)) return false;
    this.revoke(url);
    return true;
  }

  releaseAll(): string[] {
    const released = [...this.owned];
    this.owned.clear();
    released.forEach((url) => this.revoke(url));
    return released;
  }

  has(url: string): boolean {
    return this.owned.has(url);
  }
}
