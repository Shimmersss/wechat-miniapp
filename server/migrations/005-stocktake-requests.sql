ALTER TABLE stocktakes ADD COLUMN request_key VARCHAR(80) NULL, ADD COLUMN request_hash CHAR(64) NULL, ADD UNIQUE KEY stocktake_request (request_key);
