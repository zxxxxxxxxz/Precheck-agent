import type {PoolClient} from 'pg';

/** Allocate only inside the same transaction as case creation, after its authorization checks. */
export async function allocateCaseNumber(db: PoolClient): Promise<string> {
  const result = await db.query<{case_number: string}>(`
    INSERT INTO business.case_number_counters(business_date,last_number)
    VALUES ((statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date,1)
    ON CONFLICT (business_date) DO UPDATE
      SET last_number=business.case_number_counters.last_number+1
    RETURNING 'CGT-'||to_char(business_date,'YYYYMMDD')||'-'||
      lpad(last_number::text,greatest(4,length(last_number::text)),'0') AS case_number`);
  return result.rows[0]!.case_number;
}
