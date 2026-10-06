-- Demo data for the sample PDFs in sample-data/. Safe to run more than once.
INSERT INTO users (email, name) VALUES ('demo@example.com', 'Demo') ON CONFLICT (email) DO NOTHING;
INSERT INTO courses (code, title, department, level) VALUES ('MBBS 214', 'Human Physiology II', 'Medicine', 200) ON CONFLICT (code) DO NOTHING;
INSERT INTO lecturers (name) SELECT 'Dr. A. Okafor' WHERE NOT EXISTS (SELECT 1 FROM lecturers WHERE name = 'Dr. A. Okafor');
INSERT INTO ccmas_topics (course_id, title)
  SELECT c.id, t FROM courses c, unnest(ARRAY['Cardiac cycle','Renal clearance','Action potentials','Respiratory volumes']) t
  WHERE c.code = 'MBBS 214'
    AND NOT EXISTS (SELECT 1 FROM ccmas_topics x WHERE x.course_id = c.id AND x.title = t);
-- Paste this id when the app asks for your user ID:
SELECT id AS your_user_id FROM users WHERE email = 'demo@example.com';
