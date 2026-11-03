CREATE TABLE visit_events (
 visitor_hash CHAR(64) NOT NULL, event_id VARCHAR(100) NOT NULL, type ENUM('pv','event') NOT NULL, name VARCHAR(40) NOT NULL DEFAULT '',
 route VARCHAR(150) NOT NULL DEFAULT '', unit_id VARCHAR(60) NULL, source VARCHAR(20) NOT NULL, share_hash CHAR(64) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(visitor_hash,event_id), INDEX(created_at,type)
) ENGINE=InnoDB;
