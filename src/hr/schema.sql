-- 人事掃描建檔資料庫結構（Cloudflare D1）
CREATE TABLE IF NOT EXISTS departments (
  id   TEXT PRIMARY KEY,          -- NUEIP 部門 id
  name TEXT NOT NULL,
  code TEXT,
  path TEXT                       -- 上層路徑，方便搜尋
);

CREATE TABLE IF NOT EXISTS employees (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  id_no              TEXT,         -- 身分證／居留證號
  gender             TEXT,
  birth_date         TEXT,         -- YYYY-MM-DD（西元）
  mobile             TEXT,
  phone              TEXT,
  email              TEXT,
  address_reg        TEXT,         -- 戶籍地址
  address_mail       TEXT,         -- 通訊地址
  emergency_name     TEXT,
  emergency_relation TEXT,
  emergency_phone    TEXT,
  dept_id            TEXT,
  dept_name          TEXT,
  title              TEXT,
  hire_date          TEXT,
  note               TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending 待核對 / confirmed 已確認 / imported 已匯入 NUEIP
  created_by         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by         TEXT,
  updated_at         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_id_no
  ON employees(id_no) WHERE id_no IS NOT NULL AND id_no <> '';
CREATE INDEX IF NOT EXISTS ix_employees_name ON employees(name);
CREATE INDEX IF NOT EXISTS ix_employees_dept ON employees(dept_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  who    TEXT,
  role   TEXT,
  action TEXT NOT NULL,
  target TEXT
);

-- 防暴力破解：記錄各來源連續輸錯次數
CREATE TABLE IF NOT EXISTS login_fail (
  ip           TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL DEFAULT 0
);

-- 個人檔案（照片、PDF）：內容以 base64 分段存在 file_chunks（每段 < 2MB，符合 D1 單列上限）
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  kind        TEXT,               -- 身分證正面／身分證背面／到職資料表／其他…
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,   -- bytes
  r2_key      TEXT NOT NULL UNIQUE,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_files_emp ON files(employee_id);
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (file_id, seq)
);

-- 薪資相關欄位（檢視權限看不到月薪與投保級距）
ALTER TABLE employees ADD COLUMN salary INTEGER;            -- 月薪（元）
ALTER TABLE employees ADD COLUMN insurance_salary INTEGER;  -- 投保級距（元）
ALTER TABLE employees ADD COLUMN dispatch_type TEXT;        -- 派應
