#!/usr/bin/env bash
set -euo pipefail
set -a
source /run/secrets/db-roles.env
set +a
# Passwords supplied through environment; never embedded in command arguments.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password HSBC_DB_APP_PASSWORD
\getenv migration_password HSBC_DB_MIGRATION_PASSWORD
\getenv checkpoint_password HSBC_DB_CHECKPOINT_PASSWORD
CREATE ROLE hsbc_migration LOGIN PASSWORD :'migration_password';
CREATE ROLE hsbc_app LOGIN PASSWORD :'app_password';
CREATE ROLE hsbc_checkpoint LOGIN PASSWORD :'checkpoint_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA business AUTHORIZATION hsbc_migration;
CREATE SCHEMA checkpoint AUTHORIZATION hsbc_migration;
GRANT USAGE ON SCHEMA business TO hsbc_app;
GRANT USAGE ON SCHEMA checkpoint TO hsbc_checkpoint;
ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_migration IN SCHEMA business GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hsbc_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_migration IN SCHEMA business GRANT USAGE, SELECT ON SEQUENCES TO hsbc_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_migration IN SCHEMA checkpoint GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hsbc_checkpoint;
ALTER DEFAULT PRIVILEGES FOR ROLE hsbc_migration IN SCHEMA checkpoint GRANT USAGE, SELECT ON SEQUENCES TO hsbc_checkpoint;
ALTER ROLE hsbc_app SET search_path = business;
ALTER ROLE hsbc_checkpoint SET search_path = checkpoint;
SQL

