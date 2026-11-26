-- Migration 099: restore the dos_config vocabulary comment, and state pillar
-- cardinality (#715; the loss is a side effect of migration 097).
--
-- TWO THINGS, and the first is the reason the second could not simply be
-- appended.
--
-- 1. RESTORE WHAT 097 DROPPED.
--    Migration 090 left `user_preferences.dos_hl_config` carrying the full dos
--    vocabulary: what a pillar is and that it is not task priority, the
--    NEVER RENAME AN OPTION rule, the topic-versus-pillar disjointness rule,
--    and the config-is-a-subset-of-Notion rule. Migration 097 renamed the
--    column to `dos_config` and wrote a short pointer comment in its place.
--    Its header says the JSONB value's own shape "is untouched -- migrations
--    086-090 already settled that, and this migration does not touch their
--    content", which was the intent; but COMMENT ON COLUMN REPLACES, it does
--    not append, so every rule above stopped being on the column the moment
--    that migration ran.
--
--    Nothing broke, which is exactly the problem: the rules still exist in the
--    text of migrations 089 and 090, which nobody reads at ritual time, while
--    the place the repo points people at went quiet. #715 asked to add one
--    sentence "alongside the vocabulary line" and there was no longer a
--    vocabulary line to be alongside.
--
-- 2. ANSWER THE CARDINALITY QUESTION (#715).
--    `work` ships four pillars, `angus` ships five, and nothing said whether
--    four was ever a rule. The `Pillar 1`-`Pillar 4` keys and the historical
--    `P1`-`P4` Notion options read as though it were. It is not: the count is
--    per-domain and open, and `Pillar N` is an ordering convention rather than
--    a cap. That is recorded below, in the place the rest of this vocabulary
--    lives.
--
-- SCOPE: this migration writes a COMMENT and nothing else. No column, no
-- constraint, no data. It is idempotent by construction -- COMMENT ON COLUMN
-- replaces whatever is there -- and safe to re-run or to apply out of order
-- against any migration that does not itself rewrite this comment.
--
-- NOT TOUCHED: ADR-054. Its section 2 carries the pillar vocabulary and is
-- Accepted, so whether it needs this sentence too is a human call between
-- erratum and new ADR (ADR-039 section 1). See the scoping note on #715.
--
-- Dollar-quoted rather than single-quoted: migrations 089 and 090 stripped the
-- apostrophes out of their prose to survive SQL quoting ("an objectives
-- immutable identity"), which made the text harder to read every time it was
-- carried forward. Dollar quoting removes the reason to.

COMMENT ON COLUMN user_preferences.dos_config IS $comment$dos ritual config, split per ADR-054 section 5 into per-domain behaviour and global behaviour. Fetched at runtime via the get_dos_config MCP tool, which takes an optional domain argument defaulting to work. Shape: { by_domain: { work: <domain config>, angus: <domain config> }, types, tone }.

A DOMAIN CONFIG is { topics, pillars, domain_signals, artefact_registers, state_doc_rules, daily_log_schema }: topics is the subject-area taxonomy used to classify an item (renamed from the old top-level domains key, since domain now means only the ADR-051 section 1 routing axis work|angus); domain_signals is the classifier deciding which domain an item routes to (repurposed from workspace.work_entities / workspace.personal_signals). types and tone are global -- identical whichever domain a night routes to.

A PILLAR is a strategic objective ({key, label, description, notion_option}) and is NOT task priority -- priority means the Tasks DB P0-P4 urgency scale only (#618).

PILLAR COUNT IS PER-DOMAIN AND NOT FIXED (#715). work ships four and angus ships five; neither number is a rule. The Pillar N keys are an ordering convention, not a cap, and the historical P1-P4 Notion option names are likewise just the names those four objectives happened to be given. Adding a domain, or a fifth work objective, needs no schema change and no permission from this comment -- only a new option in Notion first, per the subset rule below.

notion_option is the value the pillar writes into the Daily Log Pillars multi_select, stored verbatim so internal keys can be renamed without touching Notion. It is an OPTION VALUE, not a property name.

NEVER RENAME AN OPTION, ONLY ADD. An option name is an objective's immutable identity, so renaming it silently rewrites what every historical entry meant -- the defect #692 removed by replacing the per-objective checkbox properties. A changed objective is a NEW option; the retired one simply stops being selected and stays in Notion so history still reads correctly. Never invent a value either: Notion CREATES an unknown multi_select option on write, so a guessed string adds a pillar identity instead of failing. Pre-089 blobs carry the same string under notion_property and readers accept it as an option value.

A TOPIC is a subject area NO pillar covers, so a value must never appear in both lists (#656 removed Product, Round and EHS from work topics for that reason, and because two of them had no Notion option at all).

EVERY CONFIGURED VALUE MUST EXIST IN NOTION, BUT NOT THE REVERSE: config is a subset of the live option set, checked at ritual time by check_dos_config_drift, because a configured value Notion lacks either fails the write or is SILENTLY CREATED by Notion (#695), while a Notion option that config omits is how retired vocabulary ages. Options are never deleted -- deleting one would strip it from every historical page.

daily_log_schema.properties is likewise the verbatim declaration of that domain's Notion Daily Log properties, including the Pillars multi_select the pillars project into (#692), and the Synthesis Status select (Confirmed / Unconfirmed) that the #561 unattended sweep requires and that every entry carries exactly one value of (#678). The angus block ratifies the personal Daily Log as it already exists in Notion, five owner-authored pillars included (#679); its topic list is unverified against Notion and migration 090 deliberately left it alone.

Readers accept the pre-088 flat shape as a fallback so the deployed server works either side of migrations 086-090. Column history: dos_eod_config -> dos_hl_config (migration 054) -> dos_config (migration 097, ADR-054 section 7). See migration 050 for the original schema and 086-090 for its evolution; this comment carries forward the one migration 090 wrote, which migration 097 replaced by accident.$comment$;
