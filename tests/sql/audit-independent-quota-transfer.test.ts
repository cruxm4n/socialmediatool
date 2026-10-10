import { afterEach, expect, it } from "vitest";
import { LocalDb } from "../support/local-db";
let db: LocalDb;
afterEach(() => db?.close());
it("429: un Retry-After de deux jours doit conserver deux jours de pause", async () => {
  db = await LocalDb.create(); await db.seed();
  await db.automation("set_sync_backoff", {p_mode:"real",p_seconds:172800});
  const [row] = await db.sql<{seconds:number}>("select extract(epoch from backoff_until-now())::integer as seconds from public.sync_state where mode='real'");
  expect(row.seconds).toBeGreaterThan(172790);
});
it("B2: détacher puis rattacher sans historique importé ne doit pas divulguer un contenu ancien", async () => {
  db = await LocalDb.create(); const a = await db.seed(); await db.sync([]);
  const [channel] = await db.sql<{id:string}>("select id from public.channels where buffer_channel_id='canal-colibri'");
  await db.as(a.admin,"select public.admin_assign_channel($1,null,false)",[channel.id]);
  await db.as(a.admin,"select public.admin_assign_channel($1,$2,false)",[channel.id,a.nordwind]);
  await db.sync([{id:"importe-apres-transfert",text:"Contenu privé du premier client"}]);
  expect(await db.as(a.sofia,"select text from public.posts")).toEqual([]);
});
