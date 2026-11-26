drop policy "Team owners can create invitations" on "public"."invitations";

drop policy "Users can view invitations for their email" on "public"."invitations";

drop policy "Team owners can manage team members" on "public"."team_members";


  create policy "Team owners can create invitations"
  on "public"."invitations"
  as permissive
  for insert
  to public
with check ((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));



  create policy "Users can view invitations for their email"
  on "public"."invitations"
  as permissive
  for select
  to public
using (((auth.email() = (email)::text) OR (EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = invitations.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[])))))));



  create policy "Team owners can manage team members"
  on "public"."team_members"
  as permissive
  for all
  to public
using ((EXISTS ( SELECT 1
   FROM public.team_members tm
  WHERE ((tm.team_id = team_members.team_id) AND (tm.user_id = auth.uid()) AND ((tm.role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying])::text[]))))));



