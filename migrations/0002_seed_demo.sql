INSERT INTO tenants (slug, name)
VALUES ('local', 'Local workspace')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (tenant_id, email, display_name, timezone)
SELECT id, 'demo@local.test', 'Demo User', 'Asia/Shanghai'
FROM tenants WHERE slug = 'local'
ON CONFLICT (tenant_id, email) DO NOTHING;

INSERT INTO memberships (tenant_id, user_id, role)
SELECT u.tenant_id, u.id, 'owner'
FROM users u
JOIN tenants t ON t.id = u.tenant_id
WHERE t.slug = 'local' AND u.email = 'demo@local.test'
ON CONFLICT DO NOTHING;
