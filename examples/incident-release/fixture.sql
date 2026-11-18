-- Maintainer-owned data. Runs once in the example's empty Postgres database.
BEGIN;
CREATE SCHEMA release_demo;
CREATE TABLE release_demo.releases (
    id bigint PRIMARY KEY CHECK (id >= 0),
    revision integer NOT NULL CHECK (revision > 0),
    component text NOT NULL,
    tag text NOT NULL,
    change_note text NOT NULL,
    published boolean NOT NULL
);
INSERT INTO release_demo.releases VALUES
    (741, 1, 'Relay', '3.7.1', 'Added a counter for delayed acknowledgements.', true),
    (742, 1, 'Relay', '3.7.2', 'Changed the default acknowledgement deadline from 30 seconds to 10 seconds. Explicit client overrides still take precedence.', true),
    (743, 1, 'Relay', '3.7.3', 'Draft pending review.', false);

CREATE VIEW release_demo.published_releases AS
    SELECT id, revision, component, tag, change_note FROM release_demo.releases WHERE published;
CREATE ROLE hlekk_release_reader LOGIN PASSWORD 'local-fixture-reader';
GRANT USAGE ON SCHEMA release_demo TO hlekk_release_reader;
GRANT SELECT ON release_demo.published_releases TO hlekk_release_reader;
COMMIT;
