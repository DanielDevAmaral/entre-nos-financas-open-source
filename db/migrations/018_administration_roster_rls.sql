ALTER TABLE administered_families ENABLE ROW LEVEL SECURITY;
ALTER TABLE administered_families FORCE ROW LEVEL SECURITY;
GRANT SELECT ON administered_families TO family_app;
DROP POLICY IF EXISTS no_family_roster ON administered_families;
DROP POLICY IF EXISTS platform_roster ON administered_families;
CREATE POLICY no_family_roster ON administered_families FOR SELECT TO family_app USING(false);
CREATE POLICY platform_roster ON administered_families FOR ALL TO family_runtime
 USING(EXISTS(SELECT 1 FROM platform_administrators WHERE user_id=nullif(current_setting('app.user_id',true),'')::uuid))
 WITH CHECK(created_by=nullif(current_setting('app.user_id',true),'')::uuid AND EXISTS(SELECT 1 FROM platform_administrators WHERE user_id=nullif(current_setting('app.user_id',true),'')::uuid));
