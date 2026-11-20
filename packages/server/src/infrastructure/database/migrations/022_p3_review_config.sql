-- P3-01: edits create new revisions; trials/approvals/releases are immutable facts.
CREATE TABLE business.review_config_drafts (
 id uuid PRIMARY KEY, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','validated','trial_passed','approved','published')),
 author_person_id uuid NOT NULL, manifest jsonb NOT NULL, manifest_hash text NOT NULL,
 validation jsonb NOT NULL DEFAULT '{"valid":false,"issues":[]}', trial_id uuid, approval_id uuid,
 release_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.review_config_revisions (
 draft_id uuid NOT NULL REFERENCES business.review_config_drafts(id), revision integer NOT NULL,
 editor_person_id uuid NOT NULL, manifest jsonb NOT NULL, manifest_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(draft_id,revision)
);
CREATE TABLE business.review_config_trials (
 id uuid PRIMARY KEY, draft_id uuid NOT NULL, draft_revision integer NOT NULL,
 manifest_hash text NOT NULL, package_hash text NOT NULL, policy_sha256 text NOT NULL,
 passed boolean NOT NULL, receipt jsonb NOT NULL, receipt_hash text NOT NULL,
 actor_person_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(draft_id,draft_revision) REFERENCES business.review_config_revisions(draft_id,revision)
);
CREATE TABLE business.review_config_approvals (
 id uuid PRIMARY KEY, draft_id uuid NOT NULL, draft_revision integer NOT NULL,
 person_id uuid NOT NULL, manifest_hash text NOT NULL, trial_id uuid NOT NULL REFERENCES business.review_config_trials(id),
 approval_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(draft_id,draft_revision) REFERENCES business.review_config_revisions(draft_id,revision)
);
ALTER TABLE business.review_config_drafts ADD FOREIGN KEY(trial_id) REFERENCES business.review_config_trials(id);
ALTER TABLE business.review_config_drafts ADD FOREIGN KEY(approval_id) REFERENCES business.review_config_approvals(id);
CREATE TABLE business.review_config_releases (
 release_id text PRIMARY KEY CHECK(release_id ~ '^[a-z][a-z0-9_]{0,63}$'),
 draft_id uuid NOT NULL, draft_revision integer NOT NULL,
 manifest jsonb NOT NULL, manifest_hash text NOT NULL, package_hash text NOT NULL, policy_sha256 text NOT NULL,
 policy_source text NOT NULL, document_configuration_id text NOT NULL REFERENCES business.document_configurations(id),
 trial_hash text NOT NULL, approval_hash text NOT NULL, publication_receipt jsonb NOT NULL, publication_hash text NOT NULL, published_by uuid NOT NULL,
 published_at timestamptz NOT NULL DEFAULT now(), UNIQUE(draft_id,draft_revision),
 FOREIGN KEY(draft_id,draft_revision) REFERENCES business.review_config_revisions(draft_id,revision)
);
CREATE FUNCTION business.reject_review_config_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable_review_config_history'; END $$;
CREATE TRIGGER immutable_review_config_revision BEFORE UPDATE OR DELETE ON business.review_config_revisions FOR EACH ROW EXECUTE FUNCTION business.reject_review_config_history_change();
CREATE TRIGGER immutable_review_config_trial BEFORE UPDATE OR DELETE ON business.review_config_trials FOR EACH ROW EXECUTE FUNCTION business.reject_review_config_history_change();
CREATE TRIGGER immutable_review_config_approval BEFORE UPDATE OR DELETE ON business.review_config_approvals FOR EACH ROW EXECUTE FUNCTION business.reject_review_config_history_change();
CREATE TRIGGER immutable_review_config_release BEFORE UPDATE OR DELETE ON business.review_config_releases FOR EACH ROW EXECUTE FUNCTION business.reject_review_config_history_change();
REVOKE ALL ON FUNCTION business.reject_review_config_history_change() FROM PUBLIC;
