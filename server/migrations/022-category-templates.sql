ALTER TABLE categories ADD COLUMN template_id VARCHAR(60) NULL, ADD CONSTRAINT category_template FOREIGN KEY (template_id) REFERENCES templates(id);
ALTER TABLE models ADD COLUMN specs JSON NULL
