"""Exercise real SQLite constraints, idempotency, quotas and retention without cloud credentials."""
import sqlite3
from pathlib import Path

db = sqlite3.connect(':memory:')
db.executescript((Path(__file__).resolve().parents[1] / 'worker/schema.sql').read_text())
insert = "INSERT INTO leads(id,name,email,interest,consent_version) VALUES('same','Test','test@example.invalid','','2026-11-04') ON CONFLICT(id) DO NOTHING"
db.execute(insert)
db.execute(insert)
assert db.execute('SELECT count(*) FROM leads').fetchone()[0] == 1
quota = "INSERT INTO rate_limits(bucket,count,expires) VALUES('test',1,9999999999) ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < 2 RETURNING count"
assert db.execute(quota).fetchone() == (1,)
assert db.execute(quota).fetchone() == (2,)
assert db.execute(quota).fetchone() is None
db.execute("UPDATE leads SET created_at='2020-01-01T00:00:00Z'")
db.execute("DELETE FROM leads WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')")
assert db.execute('SELECT count(*) FROM leads').fetchone()[0] == 0
print('SQLite schema, idempotency, atomic quota and retention: passed')
