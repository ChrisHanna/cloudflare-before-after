import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
function equal(actual: string, expected: string): boolean {
  if (actual.length > 256) return false;
  return timingSafeEqual(Buffer.from(hash(actual), 'hex'), Buffer.from(hash(expected), 'hex'));
}
export function cookieValue(header: string, name: string): string {
  if (header.length > 8192) return '';
  const values = header.split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
  if (values.length !== 1) return '';
  const value = values[0]!.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
export interface PresenterSession { csrf: string; expiresAt: number }
export class PresenterAuth {
  readonly #sessions = new Map<string, PresenterSession>();
  readonly #tokens = new Map<string, number>();
  readonly #pending = new Map<string, { code: string; expiresAt: number; approved: boolean }>();
  #lastRequest = -Infinity;
  constructor(readonly now: () => number = Date.now) {}
  #prune(): void {
    for (const [id, session] of this.#sessions) if (session.expiresAt <= this.now()) this.#sessions.delete(id);
    for (const [id, expires] of this.#tokens) if (expires <= this.now()) this.#tokens.delete(id);
    for (const [id, request] of this.#pending) if (request.expiresAt <= this.now()) this.#pending.delete(id);
  }
  issueBootstrap(): string {
    this.#prune(); if (this.#tokens.size >= 8) throw new Error('Bootstrap capacity reached');
    const value = token(); this.#tokens.set(hash(value), this.now() + 60000); return value;
  }
  #session(): { cookie: string; session: PresenterSession } {
    this.#prune(); if (this.#sessions.size >= 4) throw new Error('Presenter session capacity reached');
    const cookie = token(); const session = { csrf: token(), expiresAt: this.now() + 900000 };
    this.#sessions.set(hash(cookie), session); return { cookie, session };
  }
  redeem(value: string) {
    this.#prune(); const key = hash(value); const expires = this.#tokens.get(key);
    if (!expires || value.length !== 64) throw new Error('Invalid or consumed bootstrap');
    this.#tokens.delete(key); return this.#session();
  }
  request(): { cookie: string; code: string; expiresAt: number } {
    this.#prune();
    if (this.#pending.size >= 8 || this.now() - this.#lastRequest < 1000) throw new Error('Bootstrap request throttled');
    this.#lastRequest = this.now();
    const cookie = token(); let code = randomBytes(4).toString('hex').toUpperCase();
    while ([...this.#pending.values()].some(p => p.code === code)) code = randomBytes(4).toString('hex').toUpperCase();
    const request = { code, expiresAt: this.now() + 60000, approved: false };
    this.#pending.set(hash(cookie), request); return { cookie, code, expiresAt: request.expiresAt };
  }
  approve(code: string): void {
    this.#prune(); const request = [...this.#pending.values()].find(p => equal(code, p.code));
    if (!request) throw new Error('Pending local sign-in is unavailable'); request.approved = true;
  }
  poll(cookie: string): { pending: true; code: string } | { pending: false; cookie: string; session: PresenterSession } {
    this.#prune(); const id = hash(cookie); const request = this.#pending.get(id);
    if (!request || cookie.length !== 64) throw new Error('Pending browser proof is missing or expired');
    if (!request.approved) return { pending: true, code: request.code };
    this.#pending.delete(id); return { pending: false, ...this.#session() };
  }
  session(cookie: string): PresenterSession | null {
    this.#prune(); return cookie.length === 64 ? this.#sessions.get(hash(cookie)) ?? null : null;
  }
  csrf(session: PresenterSession, value: string): boolean { return equal(value, session.csrf); }
  clear(): void { this.#sessions.clear(); this.#pending.clear(); this.#tokens.clear(); }
}
