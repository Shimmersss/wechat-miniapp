CREATE TABLE share_links (
 id VARCHAR(24) PRIMARY KEY, owner_id CHAR(36) NOT NULL, owner_kind ENUM('staff','peer','customer','agent') NOT NULL,
 channel ENUM('customer','peer','agent') NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
 expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(owner_id) REFERENCES users(id), INDEX(owner_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE share_items (
 share_id VARCHAR(24) NOT NULL, unit_id CHAR(36) NOT NULL, price_version INT NOT NULL, price DECIMAL(14,2) NOT NULL,
 PRIMARY KEY(share_id,unit_id), FOREIGN KEY(share_id) REFERENCES share_links(id), FOREIGN KEY(unit_id) REFERENCES units(id)
) ENGINE=InnoDB;
