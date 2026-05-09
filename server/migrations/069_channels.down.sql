-- 069_channels.down.sql
-- Drop in reverse FK / dependency order.

DROP INDEX IF EXISTS idx_agent_task_queue_channel_pending;
ALTER TABLE agent_task_queue DROP COLUMN IF EXISTS channel_id;

DROP TABLE IF EXISTS channel_message_reaction;
DROP TABLE IF EXISTS channel_message;
DROP TABLE IF EXISTS channel_member;
DROP TABLE IF EXISTS channel;
