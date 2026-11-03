ALTER TABLE roles ADD COLUMN visible_fields JSON NULL, ADD COLUMN version INT NOT NULL DEFAULT 1;
ALTER TABLE staff ADD COLUMN version INT NOT NULL DEFAULT 1, ADD COLUMN created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE audit_logs ADD INDEX audit_action_time (action,created_at), ADD INDEX audit_object (object_id)
