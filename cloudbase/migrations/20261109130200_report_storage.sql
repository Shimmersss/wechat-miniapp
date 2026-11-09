-- 导出CSV专用私有桶；不放宽内部图片凭证桶的MIME限制。
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('xiamu-reports','经营报表导出',false,33554432,ARRAY['text/csv','application/octet-stream']);
