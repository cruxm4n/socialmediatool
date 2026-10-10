import {it,expect,vi,afterEach} from "vitest";
import {LocalDb,SECRET} from "../support/local-db";
let db:LocalDb;let actors:Awaited<ReturnType<LocalDb["seed"]>>;let revokedId:string;
const sent:Array<{to:string,text:string}>=[];
vi.mock("@/server/env",()=>({env:{automationSecret:SECRET,appUrl:"https://audit.example",bufferMode:"real",notificationMode:"webhook",notificationWebhookUrl:"https://fake.invalid",notificationWebhookSecret:"synthetic-audit"}}));
vi.mock("@/server/supabase/clients",()=>({getAutomationClient:()=>({rpc:async(name:string,p:Record<string,unknown>)=>{
 if(name==="claim_notifications"){
  const rows=await db.automation<{recipient_id:string}>(name,{p_mode:p.p_mode});revokedId=rows[1].recipient_id;return {data:rows,error:null};
 }
 if(name==="complete_notifications"){
  await db.as("anon","select public.complete_notifications($1,$2::uuid[],$3,$4)",[SECRET,p.p_ids,p.p_status,p.p_error??null]);
  return {data:1,error:null};
 }
 throw new Error("unexpected RPC");
}})}));
const {dispatchNotifications}=await import("@/server/notifications");
afterEach(async()=>{vi.unstubAllGlobals();await db?.close();});
it("B5: une révocation entre deux remises ne doit pas laisser partir le contenu du second destinataire",async()=>{
 db=await LocalDb.create();actors=await db.seed();await db.sync([{id:"a",text:"Confidentiel A"},{id:"b",channelId:"canal-nordwind",text:"Confidentiel B"}]);
 vi.stubGlobal("fetch",vi.fn(async(_url:unknown,init:RequestInit)=>{
  sent.push(JSON.parse(String(init.body)));
  if(sent.length===1){
   await db.as(actors.admin,"select public.admin_set_member($1,$2,false)",[revokedId===actors.ines.userId?actors.colibri:actors.nordwind,revokedId]);
  }
  return {ok:true,status:200};
 }));
 await dispatchNotifications();
 expect(sent.length).toBe(1);
});
