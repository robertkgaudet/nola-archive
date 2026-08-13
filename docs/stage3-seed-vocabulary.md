# Stage 3 seed vocabulary — candidate DMC taxonomy

## Status: data, never schema

This document is **input to the Stage 3 clustering pass, not a schema**. Nothing
here is enforced anywhere in the database, the extraction prompt, or the shield
gate — and nothing here should ever be.

The archive is **evidence-derived**: clusters emerge from the facets the research
agent actually sourced. This vocabulary is offered to the clustering model as a
starting point so its output lands in language a DMC would recognise, and no
more than that.

Three consequences follow, and they matter:

- **It is candidate, not binding.** Stage 3 may merge these branches, split them,
  rename them, or ignore them.
- **Clusters may diverge from this seed, and that divergence is a finding.**
  When the facts disagree with the vocabulary, the facts win. A branch that
  attracts no facets is a signal about the provider universe, not a gap to be
  backfilled.
- **It stays city-agnostic.** These are categories of DMC work, not New Orleans
  categories. Nothing here should hard-code assumptions about this market.

## The four candidate branches

### 1. Operations & Logistics

The moving-people-and-things layer.

- Transportation and manifests — coaches, shuttles, transfers, airport meet-and-greet, manifest management
- Lodging — room blocks, hotel sourcing, rooming lists
- Field staffing — on-site coordinators, tour directors, registration and hospitality desk staff

### 2. Venue & Space Infrastructure

The rooms themselves and their hard attributes.

- Traditional venues — hotels, ballrooms, conference and convention space
- Adaptive reuse — warehouses, museums, historic properties, unconventional space
- Private buyouts — full-venue exclusivity
- Cross-cutting attributes — capacity, AV infrastructure, in-house vs. external catering, load-in and dock access

### 3. Local Activation & Experiences

What the group actually does — the destination content.

- Culinary — dine-arounds, tastings, cooking classes, chef experiences
- Entertainment and talent — musicians, performers, speakers, brand ambassadors
- Excursions — tours, off-site activities, partner attractions
- CSR — give-back and community-impact activities

### 4. Event Production & Design

Turning a space into the event.

- AV and staging — sound, lighting, video, rigging, staging
- Scenic and decor — florals, furniture, theming, tabletop
- Branding and signage — wayfinding, environmental graphics, printed and digital branding

## Relationship to `facet_type`

The `facets.facet_type` enum in `sql/schema.sql` is a **structural** vocabulary —
what kind of fact this is (`capacity`, `pricing_signal`, `identity`, …). The four
branches above are a **commercial** vocabulary — what kind of DMC work a provider
supplies.

They are different axes and must not be collapsed into each other. A single
`capacity` facet can inform branch 2; a single provider routinely spans several
branches. Do not add these branch names to the `facet_type` check constraint.
