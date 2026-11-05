CREATE TABLE stocktake_sessions (
  id CHAR(36) PRIMARY KEY, operator_id CHAR(36) NOT NULL, scope JSON NOT NULL, note VARCHAR(200) NOT NULL DEFAULT '',
  status ENUM('open','closed','cancelled') NOT NULL DEFAULT 'open', stocktake_id CHAR(36) NULL,
  closed_by CHAR(36) NULL, closed_at DATETIME(3) NULL, cancel_reason VARCHAR(200) NULL,
  request_key VARCHAR(80) NULL, request_hash CHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY stocktake_session_request (request_key), KEY stocktake_session_status (status, created_at),
  FOREIGN KEY (operator_id) REFERENCES users(id), FOREIGN KEY (closed_by) REFERENCES users(id), FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id)
) ENGINE=InnoDB;
CREATE TABLE stocktake_session_units (
  session_id CHAR(36) NOT NULL, unit_id CHAR(36) NOT NULL, start_status VARCHAR(30) NOT NULL,
  scanned_by CHAR(36) NULL, scanned_at DATETIME(3) NULL, scanned_code VARCHAR(80) NULL,
  PRIMARY KEY (session_id, unit_id), KEY stocktake_session_scanned (session_id, scanned_at),
  FOREIGN KEY (session_id) REFERENCES stocktake_sessions(id), FOREIGN KEY (unit_id) REFERENCES units(id), FOREIGN KEY (scanned_by) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE stocktake_extras (
  id CHAR(36) PRIMARY KEY, session_id CHAR(36) NOT NULL, code VARCHAR(80) NOT NULL, unit_id CHAR(36) NULL,
  unit_status VARCHAR(30) NULL, reason VARCHAR(100) NOT NULL, scanned_by CHAR(36) NOT NULL,
  scanned_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY stocktake_extra_code (session_id, code), KEY stocktake_extra_unit (session_id, unit_id),
  FOREIGN KEY (session_id) REFERENCES stocktake_sessions(id), FOREIGN KEY (unit_id) REFERENCES units(id), FOREIGN KEY (scanned_by) REFERENCES users(id)
) ENGINE=InnoDB;
ALTER TABLE stocktakes ADD COLUMN session_id CHAR(36) NULL, ADD UNIQUE KEY stocktake_session (session_id);
CREATE TABLE stocktake_resolutions (
  id CHAR(36) PRIMARY KEY, stocktake_id CHAR(36) NOT NULL, target_type ENUM('unit','extra') NOT NULL, target VARCHAR(80) NOT NULL,
  resolution ENUM('pending','found','lost','handled') NOT NULL, note VARCHAR(200) NOT NULL, operator_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY stocktake_resolution_target (stocktake_id, target_type, target, created_at),
  FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id), FOREIGN KEY (operator_id) REFERENCES users(id)
) ENGINE=InnoDB
