-- Record the actual reservation day; a queued call may cross midnight before sending.
ALTER TABLE business.model_calls ADD COLUMN budget_day date;
-- Keep all candidates as history, but only selected candidates may be shown/applied.
ALTER TABLE business.intake_turns ADD COLUMN selected_candidate_ids uuid[];
