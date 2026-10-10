import {afterEach,describe,it,expect} from "vitest";
import {LocalDb,FUTURE,SECRET} from "../support/local-db";
let db:LocalDb;
afterEach(()=>db?.close());
const make=()=>LocalDb.create();
const channel=async()=> (await db.sql<{id:string}>("select id from public.channels where buffer_channel_id='canal-colibri'"))[0].id;
const transfer=async(actor:{userId:string},org:string|null,confirm=true)=>db.as(actor,"select public.admin_assign_channel($1,$2,$3)",[await channel(),org,confirm]);
const claim=()=>db.automation<any>("claim_posts_for_scheduling_in_mode",{p_mode:"real"});
const complete=async(id:string,token:string|undefined,ok=true)=>db.automation("complete_scheduling",{p_post_id:id,p_ok:ok,...(token?{p_token:token}:{})});
async function studio(){
 const actors=await db.seed();await db.sync([]);
 const [saved]=await db.as<{r:{id:string,revision:number}}>(actors.admin,"select public.studio_save_draft(null,null,$1::jsonb) as r",[JSON.stringify({organizationId:actors.colibri,title:"audit",dueAt:FUTURE,hashtags:[],mediaIds:[],variants:[{channelId:await channel(),text:"Confidentiel A"}]})]);
 return {...actors,draft:saved.r.id};
}

describe("Contre-audit indépendant — invariants attendus",()=>{
 it("B1 SQL: détachement puis rattachement à B exige confirmation",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"ancien"}]);await transfer(a.admin,null);
  await expect(transfer(a.admin,a.nordwind,false)).rejects.toThrow("transfer_confirmation_required");
 });
 it("B2: un transfert sans aucun post déjà importé ne doit pas exposer les imports tardifs de A à B",async()=>{
  db=await make();const a=await db.seed();await db.sync([]);await transfer(a.admin,a.nordwind);
  await db.sync([{id:"import-tardif",text:"CONFIDENTIEL ANCIEN CLIENT A"}]);
  const seen=await db.as(a.sofia,"select id from public.posts");expect(seen).toEqual([]);
 });
 it("B2: avec historique importé, les anciens contenus tardifs restent invisibles à B",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"ancien"}]);await transfer(a.admin,a.nordwind);
  await db.sync([{id:"ancien"},{id:"tardif",text:"CONFIDENTIEL A"}]);
  expect(await db.as(a.sofia,"select id from public.posts")).toEqual([]);
 });
 it("B3: un accord ne doit plus permettre une programmation après révocation du validateur",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"approuve"}]);await db.decide(a.ines,"approuve","approved");
  await db.as(a.admin,"select public.admin_set_member($1,$2,false)",[a.colibri,a.ines.userId]);
  expect((await claim()).length).toBe(0);
 });
 it("B3: le transfert suspend un accord déjà donné",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"approuve"}]);await db.decide(a.ines,"approuve","approved");await transfer(a.admin,a.nordwind);
  expect((await claim()).length).toBe(0);
 });
 it("B3: l'archivage suspend un accord déjà donné",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"approuve"}]);await db.decide(a.ines,"approuve","approved");
  await db.as(a.admin,"select public.admin_set_organization_archived($1,true)",[a.colibri]);expect((await claim()).length).toBe(0);
 });
 it("B4: une confirmation tardive ne doit pas perdre l'annulation après contenu modifié",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"p",text:"V1"}]);await db.decide(a.ines,"p","approved");const [r]=await claim();
  await db.sync([{id:"p",text:"V2"}]);await complete(r.id,r.token);
  expect(await db.post("p")).toMatchObject({approval_status:"pending",schedule_state:"unschedule_pending"});
 });
 it("B4: une confirmation ancienne sans jeton ne doit pas confirmer une NOUVELLE réservation",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"p",text:"V1"}]);await db.decide(a.ines,"p","approved");const [old]=await claim();
  await db.sync([{id:"p",text:"V2"}]);
  await db.automation("complete_unscheduling",{p_post_id:old.id,p_ok:true});
  await db.decide(a.ines,"p","approved");const [current]=await claim();expect(current).toBeTruthy();
  await db.automation("complete_scheduling",{p_post_id:old.id,p_ok:true});
  expect(await db.post("p")).not.toMatchObject({schedule_state:"scheduled"});
 });
 it("B5: une notification échouée ne révèle plus le post après révocation du membre",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"p"}]);
  const rows=await db.automation<any>("claim_notifications",{p_mode:"real"});expect(rows).toHaveLength(1);
  await db.as("anon","select public.complete_notifications($1,$2::uuid[],'failed','test')",[SECRET,rows.map((r:any)=>r.id)]);
  await db.sql("update public.notifications set claimed_at=now()-interval '20 minutes'");
  await db.as(a.admin,"select public.admin_set_member($1,$2,false)",[a.colibri,a.ines.userId]);
  expect(await db.automation("claim_notifications",{p_mode:"real"})).toEqual([]);
 });
 it("B6: un pushing abandonné ne doit pas autoriser de création forcée avant réconciliation",async()=>{
  db=await make();const a=await studio();await db.as(a.admin,"select * from public.studio_claim_push($1,false)",[a.draft]);
  await db.sql("update public.studio_variants set push_claimed_at=now()-interval '11 minutes'");
  await expect(db.as(a.admin,"select * from public.studio_claim_push($1,true)",[a.draft])).rejects.toThrow(/push_unknown|push_uncertain/);
 });
 it("Studio: une sauvegarde concurrente garde la révision suivante à envoyer",async()=>{
  db=await make();const a=await studio();const [r]=await db.as<any>(a.admin,"select * from public.studio_claim_push($1,false)",[a.draft]);
  await db.as(a.admin,"select public.studio_save_draft($1,1,$2::jsonb)",[a.draft,JSON.stringify({organizationId:a.colibri,title:"audit",dueAt:FUTURE,hashtags:["#B"],mediaIds:[],variants:[{channelId:await channel(),text:"V2"}]})]);
  expect(r.text).toBe("Confidentiel A");expect(r.hashtags).toEqual([]);
  await db.as(a.admin,"select public.studio_complete_push($1,true,'buffer-created',null,$2)",[r.variant_id,r.revision]);
  const [next]=await db.as<any>(a.admin,"select * from public.studio_claim_push($1,false)",[a.draft]);expect(next.text).toBe("V2");expect(next.revision).toBe(2);
 });
 it("Versions: un contenu différent publié ne réécrit jamais la version approuvée",async()=>{
  db=await make();const a=await db.seed();await db.sync([{id:"p",text:"V1"}]);await db.decide(a.ines,"p","approved");
  await db.sync([{id:"p",text:"V2",status:"sent"}]);
  expect(await db.sql("select version,text from public.post_versions order by version")).toEqual([{version:1,text:"V1"},{version:2,text:"V2"}]);
 });
});
