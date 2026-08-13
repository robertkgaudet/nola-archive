-- ============================================================
-- 001-facet-types.sql
-- Adds two facet_type values, from pilot findings on Preservation Hall:
--   'identity'          — address, founding year, official name variants.
--                         These were being dumped into 'unique_attribute'.
--   'related_property'  — facts about a sister/affiliated property the
--                         provider operates. A Toulouse Theatre capacity was
--                         filed as if it described Preservation Hall itself.
--
-- The original constraint is unnamed in schema.sql, so Postgres auto-named it
-- facets_facet_type_check. We drop that and re-add under the same name, which
-- makes this file safe to re-run.
-- ============================================================

alter table facets drop constraint if exists facets_facet_type_check;

alter table facets add constraint facets_facet_type_check check (facet_type in (
  'service','capacity','group_size','venue_format','neighborhood',
  'seasonal','pricing_signal','unique_attribute','booking_constraint',
  'amenity','accessibility','duration',
  'identity','related_property',
  'other'
));
