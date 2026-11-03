ALTER TABLE visit_events
 ADD COLUMN share_id VARCHAR(24) NULL,
 ADD COLUMN share_owner_id CHAR(36) NULL,
 ADD FOREIGN KEY(share_id) REFERENCES share_links(id),
 ADD FOREIGN KEY(share_owner_id) REFERENCES users(id),
 ADD INDEX(share_owner_id,created_at);
