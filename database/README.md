# Database Directory

This directory contains database schema and migration files for the BlinkPOS hybrid storage system.

## Files

### `init.sql`
Initial database schema that runs automatically when the PostgreSQL container starts for the first time.

**Contains:**
- Table definitions (payment_splits, payment_events, tip_recipients_stats, system_metrics)
- Indexes for query optimization
- Views for common queries
- Triggers and functions for automation
- Initial seed data

**Usage:**
- Automatically executed by Docker: `docker-compose up`
- Manual execution: `psql -U blinkuser -d blinkpos -f init.sql`

## Database Schema Overview

```
payment_splits           Main table for all payment split records
  ├── id                 Primary key
  ├── payment_hash       Unique invoice identifier
  ├── user_wallet_id     User's wallet
  ├── base_amount        Amount going to merchant
  ├── tip_amount         Amount going to tip recipient
  └── status             pending|processing|completed|failed|expired

payment_events           Audit trail for all state changes
  ├── id                 Primary key
  ├── payment_hash       Links to payment_splits
  ├── event_type         created|paid|forwarding_started|completed|failed
  └── event_data         JSON metadata

tip_recipients_stats     Aggregate statistics per recipient
  ├── recipient_username Username of tip recipient
  ├── total_tips_received Cumulative tips in sats
  ├── total_tips_count   Number of tips received
  └── average_tip_amount Auto-calculated average

system_metrics           Performance and health metrics
  ├── metric_name        Name of metric
  ├── metric_value       Numeric value
  └── timestamp          When recorded
```

## Views

### `recent_payments`
Shows payments from the last 7 days with processing times.

```sql
SELECT * FROM recent_payments LIMIT 10;
```

### `tip_leaderboard`
Rankings of tip recipients by total tips received.

```sql
SELECT * FROM tip_leaderboard;
```

### `daily_payment_stats`
Daily aggregated statistics (volume, tips, success rate, etc.)

```sql
SELECT * FROM daily_payment_stats
WHERE date > CURRENT_DATE - INTERVAL '30 days';
```

## Useful Queries

### Check pending payments
```sql
SELECT payment_hash, tip_amount, created_at, 
       EXTRACT(EPOCH FROM (NOW() - created_at))/60 as age_minutes
FROM payment_splits 
WHERE status = 'pending'
ORDER BY created_at DESC;
```

### View payment history for a user
```sql
SELECT payment_hash, total_amount, base_amount, tip_amount, 
       status, created_at, processed_at
FROM payment_splits
WHERE user_wallet_id = 'your_wallet_id'
ORDER BY created_at DESC
LIMIT 20;
```

### Audit trail for a payment
```sql
SELECT event_type, event_data, timestamp
FROM payment_events
WHERE payment_hash = 'your_payment_hash'
ORDER BY timestamp ASC;
```

### Today's statistics
```sql
SELECT 
  COUNT(*) as total_payments,
  COUNT(*) FILTER (WHERE status = 'completed') as successful,
  SUM(total_amount) as total_volume,
  SUM(tip_amount) as total_tips,
  AVG(tip_percent) FILTER (WHERE tip_amount > 0) as avg_tip_percent
FROM payment_splits
WHERE created_at >= CURRENT_DATE;
```

## Maintenance

### Cleanup old metrics
```sql
SELECT cleanup_old_metrics(30); -- Keep last 30 days
```

### Mark expired payments
```sql
SELECT cleanup_expired_payments(); -- Mark >24h old pending payments as expired
```

### Vacuum and analyze
```sql
VACUUM ANALYZE payment_splits;
VACUUM ANALYZE payment_events;
```

### Check table sizes
```sql
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;
```

## Adding Migrations

For schema changes after initial deployment, create migration files:

```
database/
  ├── init.sql                    # Initial schema
  ├── migrations/
  │   ├── 001_initial.sql        # (points to init.sql)
  │   ├── 002_add_indexes.sql    # Future migration
  │   └── 003_new_feature.sql    # Future migration
```

Each migration should be:
1. **Idempotent** - Can be run multiple times safely
2. **Reversible** - Include rollback instructions in comments
3. **Tested** - Test on dev environment first

Example migration:
```sql
-- Migration: 002_add_user_preferences.sql
-- Description: Add user preferences table
-- Date: 2025-01-15

BEGIN;

CREATE TABLE IF NOT EXISTS user_preferences (
  user_wallet_id VARCHAR(100) PRIMARY KEY,
  default_tip_percent DECIMAL(5,2),
  sound_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Rollback: DROP TABLE user_preferences;

COMMIT;
```

## Backup and Restore

### Backup
```bash
# Full database backup
docker exec blinkpos-postgres pg_dump -U blinkuser blinkpos > backup.sql

# Table-specific backup
docker exec blinkpos-postgres pg_dump -U blinkuser -t payment_splits blinkpos > payments_backup.sql
```

### Restore
```bash
# Restore full database
docker exec -i blinkpos-postgres psql -U blinkuser blinkpos < backup.sql

# Restore specific table
docker exec -i blinkpos-postgres psql -U blinkuser blinkpos < payments_backup.sql
```

## Connection Info

**Development (Docker):**
- Host: `localhost`
- Port: `5432`
- Database: `blinkpos`
- User: `blinkuser`
- Password: `blinkpass`

**Connection string:**
```
postgresql://blinkuser:blinkpass@localhost:5432/blinkpos
```

## Troubleshooting

### Schema not initialized
```bash
# Check if init.sql ran
docker-compose logs postgres | grep "BlinkPOS database schema"

# Manually run if needed
docker exec -i blinkpos-postgres psql -U blinkuser blinkpos < database/init.sql
```

### Permission errors
```bash
# Grant all permissions to blinkuser
docker exec -it blinkpos-postgres psql -U postgres -c "
  GRANT ALL PRIVILEGES ON DATABASE blinkpos TO blinkuser;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO blinkuser;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO blinkuser;
"
```

### Reset database (⚠️ DESTRUCTIVE)
```bash
# Stop containers
docker-compose down

# Remove volumes (deletes all data)
docker volume rm bbtv2_postgres_data

# Start fresh
docker-compose up -d
```


## Migrations in production

Production applies `init.sql` (on an empty database) and then every
`migrations/*.sql` whose number is above the current `schema_version`, in
sorted order, from the `run-migrations` init container of the
`blinkbitcoin/charts` `blink-terminal` chart (`psql -v ON_ERROR_STOP=1`),
before the app container starts. `deploy-prod.sh` is deprecated and does not
reflect that path.

## Testing against real Postgres

Store logic that depends on transactions, advisory locks, `lock_timeout` or
index choice is tested in `tests/unit/pg/*.pg.spec.ts` against a real server
(blink-wip#1616). Each suite creates a fresh database, applies `init.sql` and
every migration in the production order (so the chain itself is tested), and
drops it afterwards.

The suites are opt-in via `PG_TEST_URL` — an admin connection string for a
role that may `CREATE DATABASE` / `CREATE EXTENSION` — and skipped without it.
CI runs them against a `postgres:15-alpine` service container.

```bash
docker run -d --name bt-pg -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:15-alpine
PG_TEST_URL=postgres://postgres:postgres@localhost:55432/postgres npx jest tests/unit/pg
```

Single-statement SQL contracts that need no concurrency can stay as PGlite
probes (`scripts/pglite-sql-probe.mjs`), which run without a server.
