-- The review supplement worker submits one idempotent DocumentService command.
-- It needs the command ledger, never credentials or auth-schema access.
GRANT SELECT,INSERT ON business.command_receipts TO hsbc_p1_worker;
