CREATE TABLE report_exports (
 id CHAR(36) PRIMARY KEY, actor_id CHAR(36) NOT NULL, request_key VARCHAR(80) NOT NULL, request_hash CHAR(64) NOT NULL,
 payload JSON NOT NULL, expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(actor_id) REFERENCES users(id), UNIQUE(actor_id,request_key)
) ENGINE=InnoDB;
