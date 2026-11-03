ALTER TABLE sessions ADD COLUMN assurance ENUM('wechat','staff') NOT NULL DEFAULT 'wechat';
