import {describe,it,expect,vi} from "vitest";
import {BufferProvider} from "@/server/publishing/buffer-provider";
import {BUFFER_READ_ONLY} from "@/server/publishing/provider";
import type {DraftContent} from "@/server/publishing/provider";
const due="2030-01-15T09:00:00.000Z";
const raw={id:"created-1",channelId:"c1",channelService:"linkedin",text:"Audit",dueAt:due,status:"draft",sentAt:null,updatedAt:null,externalLink:null,schedulingType:"automatic",error:null,tags:[{name:"À valider"}],assets:[]};
const content:DraftContent={channelId:"c1",service:"linkedin",text:"Audit",dueAt:due,assets:[]};
const json=(data:unknown,headers?:Record<string,string>,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json",...headers}});
function provider(write:()=>Response){
 const fetchImpl=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const {query}=JSON.parse(String(init?.body));
  if(query.startsWith("mutation"))return write();
  if(query.includes("query Channel"))return json({data:{channel:{organizationId:"org1"}}});
  return json({data:{tagsV2:{edges:[{node:{id:"tag1",name:"À valider"}}]}}});
 });
 return new BufferProvider("audit-fake-key","À valider",fetchImpl as typeof fetch);
}
describe("Contre-audit provider — aucune API réelle",()=>{
 it("une mutation HTTP 200 avec UNEXPECTED ne prouve pas un échec certain — refusé, lecture seule",async()=>{
  const write=vi.fn(()=>json({data:null,errors:[{message:"Internal server error",extensions:{code:"UNEXPECTED"}}]}));
  const p=provider(write);
  const error=await p.createDraft(content).catch(e=>e);expect(error).toMatchObject({message:BUFFER_READ_ONLY,outcome:"failed",refusal:"writes_disabled"});expect(write).not.toHaveBeenCalled();
 });
 it("un succès GraphQL accompagné d'un avertissement ne doit pas perdre son identifiant — refusé, lecture seule",async()=>{
  const write=vi.fn(()=>json({data:{createPost:{__typename:"PostActionSuccess",post:raw}},errors:[{message:"Warning from another field"}]}));
  const p=provider(write);
  const error=await p.createDraft(content).catch(e=>e);expect(error).toMatchObject({message:BUFFER_READ_ONLY,outcome:"failed",refusal:"writes_disabled"});expect(write).not.toHaveBeenCalled();
 });
 it("la réconciliation ne doit pas déclarer absent un post existant en erreur",async()=>{
  const fetchImpl=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   const {query}=JSON.parse(String(init?.body));
   if(query.includes("account"))return json({data:{account:{organizations:[{id:"org1"}]}}});
   return json({data:{channels:[{id:"c1",service:"linkedin",name:"audit",isDisconnected:false}],active:{edges:[{node:{...raw,status:"error"}}],pageInfo:{hasNextPage:false,endCursor:null}},sent:{edges:[],pageInfo:{hasNextPage:false,endCursor:null}}}});
  });
  const p=new BufferProvider("audit-fake-key","À valider",fetchImpl as typeof fetch);
  const r=await p.findDraftCandidates({channelId:"c1",text:"Audit",dueAt:due});expect(r.candidates.length).toBe(1);
 });
 it("un 429 conserve un Retry-After long fourni par Buffer — refusé, lecture seule",async()=>{
  const write=vi.fn(()=>json({}, {"retry-after":"172800"},429));
  const p=provider(write);
  const error=await p.updateDraft("p",content).catch(e=>e);expect(error).toMatchObject({message:BUFFER_READ_ONLY,outcome:"failed",refusal:"writes_disabled"});expect(write).not.toHaveBeenCalled();
 });
});
