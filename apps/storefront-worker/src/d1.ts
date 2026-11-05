import { z } from 'zod';
import { Digest, Id, Role, ScenarioId } from '../../../packages/contracts/src/schemas.js';
export interface PreparedStatement {
  bind(...values: (string | number | null)[]): PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database { prepare(sql: string): PreparedStatement; batch(statements: PreparedStatement[]): Promise<unknown> }
export const ProductSchema = z.strictObject({ product_id: z.string().regex(/^[a-z0-9-]{1,60}$/), title: z.string().min(1).max(100), detail_key: z.string().regex(/^[a-z0-9/-]{1,100}$/), image_key: z.string().regex(/^[a-z0-9-]{1,100}$/), content_digest: Digest });
export type Product = z.infer<typeof ProductSchema>;
const Registration = z.strictObject({ record_id: Id, display_name: z.string().regex(/^synthetic-[A-Za-z0-9 _-]{1,64}$/), note: z.string().max(256) });
export type Registration = z.infer<typeof Registration>;
export const CATALOG_SEED: Product = Object.freeze({ product_id: 'launch-shirt', title: 'Synthetic launch shirt', detail_key: 'catalog/launch-shirt', image_key: 'launch-shirt', content_digest: '8dc476470118143534d7a1616815da5d0e5e1fcbf61157d81e427834491f0caf' });
export class StorefrontData {
  readonly #db: Database;
  readonly #role: z.infer<typeof Role>;
  constructor(db: Database, role: z.infer<typeof Role>) { this.#db = db; this.#role = Role.parse(role); }
  async seed(products: readonly Product[] = [CATALOG_SEED]): Promise<void> {
    for (const product of products) {
      const p = ProductSchema.parse(product);
      await this.#db.prepare('INSERT INTO catalog(product_id,title,detail_key,image_key,content_digest) VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO NOTHING').bind(p.product_id, p.title, p.detail_key, p.image_key, p.content_digest).run();
      const actual = await this.product(p.product_id);
      if (JSON.stringify(actual) !== JSON.stringify(p)) throw new Error('Immutable catalog seed differs from expected content');
    }
  }
  async product(productId: string): Promise<Product | null> {
    const id = z.string().regex(/^[a-z0-9-]{1,60}$/).parse(productId);
    const row = await this.#db.prepare('SELECT product_id,title,detail_key,image_key,content_digest FROM catalog WHERE product_id=?').bind(id).first();
    return row === null ? null : ProductSchema.parse(row);
  }
  scope(scenarioId: z.infer<typeof ScenarioId>, runId: string): ScopedRegistrations {
    return new ScopedRegistrations(this.#db, this.#role, ScenarioId.parse(scenarioId), Id.parse(runId));
  }
}
export class ScopedRegistrations {
  readonly #db: Database;
  readonly #owner: readonly [z.infer<typeof Role>, z.infer<typeof ScenarioId>, string];
  constructor(db: Database, role: z.infer<typeof Role>, scenario: z.infer<typeof ScenarioId>, run: string) {
    this.#db = db; this.#owner = [Role.parse(role), ScenarioId.parse(scenario), Id.parse(run)];
  }
  async create(input: Registration): Promise<void> {
    const p = Registration.parse(input);
    await this.#db.prepare('INSERT INTO registrations(environment,scenario_id,run_id,record_id,display_name,note) VALUES(?,?,?,?,?,?) ON CONFLICT(environment,scenario_id,run_id,record_id) DO NOTHING').bind(...this.#owner, p.record_id, p.display_name, p.note).run();
    if (JSON.stringify(await this.get(p.record_id)) !== JSON.stringify(p)) throw new Error('Existing owned record differs');
  }
  async get(recordId: string): Promise<Registration | null> {
    const row = await this.#db.prepare('SELECT record_id,display_name,note FROM registrations WHERE environment=? AND scenario_id=? AND run_id=? AND record_id=?').bind(...this.#owner, Id.parse(recordId)).first();
    return row === null ? null : Registration.parse(row);
  }
  async updateNote(recordId: string, note: string): Promise<void> {
    const id = Id.parse(recordId); z.string().max(256).parse(note);
    if (!(await this.get(id))) throw new Error('Owned record not found');
    await this.#db.prepare('UPDATE registrations SET note=? WHERE environment=? AND scenario_id=? AND run_id=? AND record_id=?').bind(note, ...this.#owner, id).run();
  }
  async cleanup(): Promise<void> {
    await this.#db.prepare('DELETE FROM registrations WHERE environment=? AND scenario_id=? AND run_id=?').bind(...this.#owner).run();
  }
}
