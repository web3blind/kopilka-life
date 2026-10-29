CREATE TABLE partner_inquiries (
  id TEXT PRIMARY KEY,
  submission_key TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  locale TEXT NOT NULL CHECK(locale IN ('ru','en')),
  consent_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  notification_chat TEXT,
  notification_message INTEGER,
  UNIQUE(notification_chat, notification_message)
);
CREATE INDEX partner_ip_time ON partner_inquiries(ip_hash, created_at);
CREATE INDEX partner_email_time ON partner_inquiries(email, created_at);
CREATE TABLE partner_outbox (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT NOT NULL REFERENCES partner_inquiries(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('telegram','email')),
  reply_update INTEGER UNIQUE,
  reply_message INTEGER,
  body TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','retry','sent','failed','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  started_at INTEGER,
  provider_id TEXT,
  error_code TEXT,
  UNIQUE(kind, inquiry_id, reply_message)
);
CREATE INDEX partner_outbox_due ON partner_outbox(state,due_at);
