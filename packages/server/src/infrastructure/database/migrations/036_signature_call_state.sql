-- Recovery checks need durable call outcomes without exposing private responses.
GRANT SELECT(job_id,state) ON business.signature_model_calls TO hsbc_p1_api;
