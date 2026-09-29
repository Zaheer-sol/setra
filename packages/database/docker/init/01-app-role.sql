-- Development only. The application connects as setra_app, which is NOT a superuser,
-- so PostgreSQL row-level security policies are actually enforced.
-- Production: create this role yourself with a strong password (see docs/deployment.md).
CREATE ROLE setra_app LOGIN PASSWORD 'setra_app';
CREATE DATABASE setra_test OWNER setra;
