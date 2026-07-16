-- Chuyển đổi points cũ (30/20/10) sang mới (5/3/1)
UPDATE match_history SET points = 5 WHERE points = 30;
UPDATE match_history SET points = 3 WHERE points = 20;
UPDATE match_history SET points = 1 WHERE points = 10;
