import {describe,it,expect} from "vitest";
import {buildPostViews} from "@/lib/view";
import type {Post,Channel,Organization} from "@/lib/types";
describe("Contre-audit modèle d'affichage après 0009",()=>{
 it("l'appartenance affichée doit utiliser le propriétaire explicite, même pour un import récent",()=>{
  const a={id:"client-a",name:"A",timezone:"America/New_York"} as Organization;
  const b={id:"client-b",name:"B",timezone:"Europe/Paris"} as Organization;
  const channel={id:"c",organizationId:b.id,visibleFrom:"2026-10-01T00:00:00Z"} as Channel;
  const post={id:"p",channelId:"c",ownerOrganizationId:a.id,ownership:"assigned",createdAt:"2026-10-10T00:00:00Z",text:"A",bufferStatus:"sent",approvalStatus:"approved",scheduleState:"idle"} as Post;
  const [view]=buildPostViews([post],[channel],[a,b]);expect(view.organization?.id).toBe(a.id);
 });
});
