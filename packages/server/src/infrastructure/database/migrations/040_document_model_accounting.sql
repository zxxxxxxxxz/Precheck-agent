-- Additive accounting: original reservations and provider receipts stay intact.
-- Unknown dispatches always retain their full original reservation.
CREATE TABLE business.document_model_prices (
  call_id uuid PRIMARY KEY REFERENCES business.document_model_calls(id),
  pricing jsonb NOT NULL CHECK(jsonb_typeof(pricing)='object'),
  provenance text NOT NULL CHECK(provenance IN ('dispatch','verified_legacy')),
  verification_ref text NOT NULL CHECK(length(verification_ref) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE business.document_model_charges (
  call_id uuid PRIMARY KEY REFERENCES business.document_model_prices(call_id),
  charged_micros bigint NOT NULL CHECK(charged_micros>=0),
  basis text NOT NULL CHECK(basis='usage_upper_bound'),
  usage jsonb NOT NULL,
  calculation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION business.document_model_charge_valid(p jsonb,u jsonb,v jsonb,amount bigint) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE i numeric; o numeric; total numeric; cached numeric; expected numeric; rate numeric;
BEGIN
  IF jsonb_typeof(u) IS DISTINCT FROM 'object' OR jsonb_typeof(v) IS DISTINCT FROM 'object' OR
     (u - ARRAY['inputTokens','outputTokens','totalTokens'])<>'{}'::jsonb OR
     (v - ARRAY['basis','actualModel','usage','cachedInputTokens','inputCategory','contextTier','chargedMicros'])<>'{}'::jsonb OR
     v->'usage' IS DISTINCT FROM u OR v->>'basis' IS DISTINCT FROM 'usage_upper_bound' OR
     v->>'contextTier' IS DISTINCT FROM 'long_upper_bound' OR
     NOT coalesce(p->'actualModels' ? (v->>'actualModel'),false) OR
     jsonb_typeof(v->'chargedMicros') IS DISTINCT FROM 'number' OR
     (v->>'chargedMicros')::numeric IS DISTINCT FROM amount THEN RETURN false; END IF;
  IF jsonb_typeof(u->'inputTokens') IS DISTINCT FROM 'number' OR
     jsonb_typeof(u->'outputTokens') IS DISTINCT FROM 'number' OR
     jsonb_typeof(u->'totalTokens') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  i := (u->>'inputTokens')::numeric; o := (u->>'outputTokens')::numeric; total := (u->>'totalTokens')::numeric;
  IF i<0 OR o<0 OR total<>i+o OR total>9007199254740991 OR trunc(i)<>i OR trunc(o)<>o THEN RETURN false; END IF;
  IF v->'cachedInputTokens'='null'::jsonb AND v->>'inputCategory'='unreported' THEN cached:=0;
  ELSIF jsonb_typeof(v->'cachedInputTokens')='number' AND v->>'inputCategory'='cached_reported' THEN
    cached:=(v->>'cachedInputTokens')::numeric;
    IF cached<0 OR cached>i OR trunc(cached)<>cached THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF p->>'sku'='GlobalStandard' THEN rate:=1;
  ELSIF p->>'sku'='DataZoneStandard' THEN rate:=1.1;
  ELSE RETURN false; END IF;
  expected:=ceil(((i-cached)*25+cached*2+o*75)*rate);
  RETURN expected=amount AND amount<=9007199254740991;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION business.check_document_model_accounting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c business.document_model_calls; p jsonb;
BEGIN
  SELECT * INTO c FROM business.document_model_calls WHERE id=NEW.call_id;
  IF c.id IS NULL OR c.channel<>'cloud' THEN
    RAISE EXCEPTION 'document_accounting_scope_invalid';
  END IF;
  IF TG_TABLE_NAME='document_model_prices' THEN
    IF NEW.pricing->>'deployment' IS DISTINCT FROM c.model OR
       NEW.pricing->>'version' IS DISTINCT FROM 'azure-astra-2026-09-03.v1' OR
       NEW.pricing->>'provider' IS DISTINCT FROM 'azure-openai' OR
       NEW.pricing->>'basis' IS DISTINCT FROM 'usage_upper_bound' OR
       coalesce(NEW.pricing->>'sku','') NOT IN ('GlobalStandard','DataZoneStandard') OR
       (NEW.pricing - ARRAY['version','provider','deployment','actualModels','sku','basis'])<>'{}'::jsonb OR
       jsonb_typeof(NEW.pricing->'actualModels') IS DISTINCT FROM 'array' OR
       NEW.pricing->'actualModels'='[]'::jsonb OR
       NOT (NEW.pricing->'actualModels' <@ '["gpt-6-astra","gpt-6-astra-2026-09-03"]'::jsonb) OR
       (NEW.provenance='verified_legacy' AND (c.state='unknown' OR c.usage IS NULL)) THEN
      RAISE EXCEPTION 'document_accounting_price_invalid';
    END IF;
  ELSE
    SELECT pricing INTO p FROM business.document_model_prices WHERE call_id=NEW.call_id;
    IF c.usage IS NULL OR NEW.usage IS DISTINCT FROM c.usage OR
       NEW.calculation->'usage' IS DISTINCT FROM NEW.usage OR
       NEW.calculation->>'basis' IS DISTINCT FROM NEW.basis OR
       (NEW.calculation->>'chargedMicros')::bigint IS DISTINCT FROM NEW.charged_micros OR
       NOT business.document_model_charge_valid(p,NEW.usage,NEW.calculation,NEW.charged_micros) THEN
      RAISE EXCEPTION 'document_accounting_usage_invalid';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_model_price_scope BEFORE INSERT ON business.document_model_prices
  FOR EACH ROW EXECUTE FUNCTION business.check_document_model_accounting();
CREATE TRIGGER document_model_charge_scope BEFORE INSERT ON business.document_model_charges
  FOR EACH ROW EXECUTE FUNCTION business.check_document_model_accounting();
CREATE TRIGGER immutable_document_model_price BEFORE UPDATE OR DELETE ON business.document_model_prices
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
CREATE TRIGGER immutable_document_model_charge BEFORE UPDATE OR DELETE ON business.document_model_charges
  FOR EACH ROW EXECUTE FUNCTION business.reject_document_configuration_change();
REVOKE ALL ON business.document_model_prices,business.document_model_charges FROM PUBLIC,hsbc_p1_api,hsbc_p1_worker,hsbc_p1_checkpoint;
GRANT SELECT,INSERT ON business.document_model_prices,business.document_model_charges TO hsbc_p1_worker;
REVOKE ALL ON FUNCTION business.check_document_model_accounting() FROM PUBLIC;
REVOKE ALL ON FUNCTION business.document_model_charge_valid(jsonb,jsonb,jsonb,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION business.document_model_charge_valid(jsonb,jsonb,jsonb,bigint) TO hsbc_p1_worker;
