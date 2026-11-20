-- Worker repeats Checker independence checks before processing and publishing.
-- Only the contribution ownership/category columns are needed for this fence.
GRANT SELECT(case_id,person_id,kind) ON business.contributions TO hsbc_p1_worker;
