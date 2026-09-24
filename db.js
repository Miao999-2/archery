const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// SQLite 数据库（Node 内置 node:sqlite：同步 API、零编译、零依赖，Node 24+ 直接可用）
const DB_FILE = path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const DEFAULT_CONTENT = {
  hero: {
    eyebrow: '团队官网',
    lead: '这里是射箭队的主页。内容即将上线，你可以先体验右上角的「动态墙」——多人实时发布、即时可见。',
  },
  announcement: '',
  about: '这里放射箭队的介绍：成立时间、成员、荣誉、训练安排等。内容待补充。',
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  nickname TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'approved',
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  cover_image TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT '',
  admin_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS danmaku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  video_time REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
`);

// 迁移：为旧库补充新列。ALTER 只加列、不动已有数据。
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn('post_comments', 'parent_id', 'INTEGER');
ensureColumn('users', 'nickname', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'avatar', "TEXT NOT NULL DEFAULT ''");
ensureColumn('users', 'status', "TEXT NOT NULL DEFAULT 'approved'");
ensureColumn('users', 'reason', "TEXT NOT NULL DEFAULT ''");

// 迁移：把旧数据的 UTC 时间戳一次性转成北京时间字符串（含 T 的 ISO 串 → YYYY-MM-DD HH:mm:ss）
convertLegacyTimestamps();

function toBeijing(d) {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000); // UTC+8
  const p = (n) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
}
function now() { return toBeijing(new Date()); }

// 一次性把旧库的 UTC ISO 时间戳（含 T）转成北京时间字符串，幂等（无 T 则跳过）。
// 注意：post_likes 是复合主键（post_id, user_id），没有 id 列，且其 created_at 不对外展示，故不在此转换。
function convertLegacyTimestamps() {
  const map = {
    users: ['created_at'],
    posts: ['created_at'],
    comments: ['created_at'],
    danmaku: ['created_at'],
    notices: ['created_at'],
    logs: ['created_at', 'updated_at'],
    post_comments: ['created_at'],
  };
  for (const table of Object.keys(map)) {
    for (const col of map[table]) {
      const rows = db.prepare(`SELECT id, ${col} AS v FROM ${table}`).all();
      for (const r of rows) {
        if (typeof r.v === 'string' && r.v.includes('T')) {
          const d = new Date(r.v);
          if (!isNaN(d.getTime())) {
            db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(toBeijing(d), r.id);
          }
        }
      }
    }
  }
}

// 把 WAL 日志合并进主数据库文件（备份前调用，确保 data.sqlite 是完整快照）
function checkpoint() {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* 忽略 */ }
}

// ---------- 网站内容 ----------
function getContent() {
  let stored = {};
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('content');
    if (row) stored = JSON.parse(row.value);
  } catch (e) { stored = {}; }
  return {
    hero: Object.assign({}, DEFAULT_CONTENT.hero, stored.hero || {}),
    announcement: typeof stored.announcement === 'string' ? stored.announcement : DEFAULT_CONTENT.announcement,
    about: typeof stored.about === 'string' ? stored.about : DEFAULT_CONTENT.about,
  };
}
function updateContent(patch) {
  const cur = getContent();
  const next = {
    hero: Object.assign({}, cur.hero, (patch && patch.hero) || {}),
    announcement: typeof patch.announcement === 'string' ? patch.announcement : cur.announcement,
    about: typeof patch.about === 'string' ? patch.about : cur.about,
  };
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('content', JSON.stringify(next));
  return next;
}

// ---------- 用户 ----------
function createUser(username, hash, email = '', reason = '') {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const role = count === 0 ? 'admin' : 'member'; // 第一个注册的用户自动成为管理员
  const status = count === 0 ? 'approved' : 'pending'; // 首个用户自动通过，其余待管理员审批
  const info = db.prepare('INSERT INTO users(username, email, hash, role, status, reason, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(username, email, hash, role, status, reason, now());
  return { id: Number(info.lastInsertRowid), username, role, status };
}
function findUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}
function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)) || null;
}
function getPublicProfile(username) {
  const u = db.prepare('SELECT id, username, nickname, avatar, role, status, created_at FROM users WHERE username = ?').get(username);
  if (!u) return null;
  u.display_name = u.nickname || u.username;
  return u;
}
function listUsers() {
  return db.prepare('SELECT id, username, nickname, avatar, status, email, role, created_at FROM users ORDER BY id').all();
}
function listUsersByStatus(status) {
  return db.prepare('SELECT id, username, nickname, email, reason, created_at FROM users WHERE status = ? ORDER BY id').all(status);
}
function setUserStatus(id, status) {
  if (status !== 'approved' && status !== 'pending' && status !== 'rejected') return false;
  return db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, Number(id)).changes > 0;
}
function updateProfile(userId, nickname) {
  return db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(String(nickname || '').trim(), Number(userId)).changes > 0;
}
function updateUserAvatar(userId, avatar) {
  return db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(String(avatar || ''), Number(userId)).changes > 0;
}
function deleteUser(id) {
  id = Number(id);
  const postIds = db.prepare('SELECT id FROM posts WHERE user_id = ?').all(id).map((r) => r.id);
  for (const pid of postIds) {
    db.prepare('DELETE FROM post_comments WHERE post_id = ?').run(pid);
    db.prepare('DELETE FROM post_likes WHERE post_id = ?').run(pid);
  }
  db.prepare('DELETE FROM posts WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM post_comments WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM post_likes WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM comments WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM danmaku WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM notices WHERE admin_id = ?').run(id);
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
}
function setUserRole(id, role) {
  if (role !== 'admin' && role !== 'member') return false;
  return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, Number(id)).changes > 0;
}

// ---------- 动态 ----------
function createPost(userId, content) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId));
  if (!user) throw new Error('用户不存在');
  const ts = now();
  const info = db.prepare('INSERT INTO posts(user_id, content, created_at) VALUES(?, ?, ?)')
    .run(user.id, content, ts);
  return {
    id: Number(info.lastInsertRowid),
    username: user.username,
    display_name: user.nickname || user.username,
    avatar: user.avatar,
    content,
    created_at: ts,
  };
}
function listPosts() {
  return db.prepare(`
    SELECT p.id, p.content, p.created_at, u.username, u.avatar,
           COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
    FROM posts p JOIN users u ON u.id = p.user_id
    ORDER BY p.id DESC LIMIT 200
  `).all();
}
function listPostsByUser(userId) {
  return db.prepare(`
    SELECT p.id, p.content, p.created_at, u.username, u.avatar,
           COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
    FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 100
  `).all(Number(userId));
}
function deletePost(id, userId) {
  const ok = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(Number(id), Number(userId)).changes > 0;
  if (ok) {
    db.prepare('DELETE FROM post_comments WHERE post_id = ?').run(Number(id));
    db.prepare('DELETE FROM post_likes WHERE post_id = ?').run(Number(id));
  }
  return ok;
}
function deletePostAsAdmin(id) {
  const ok = db.prepare('DELETE FROM posts WHERE id = ?').run(Number(id)).changes > 0;
  if (ok) {
    db.prepare('DELETE FROM post_comments WHERE post_id = ?').run(Number(id));
    db.prepare('DELETE FROM post_likes WHERE post_id = ?').run(Number(id));
  }
  return ok;
}

// ---------- 日志 ----------
function createLog(title, content, cover_image, video_url, adminId) {
  const ts = now();
  const info = db.prepare(`
    INSERT INTO logs(title, content, cover_image, video_url, admin_id, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(title, content, cover_image, video_url, Number(adminId), ts, ts);
  return getLog(Number(info.lastInsertRowid));
}
function listLogs() {
  return db.prepare(`
    SELECT l.id, l.title, l.cover_image, l.video_url, l.created_at, u.avatar, u.username,
           COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
    FROM logs l JOIN users u ON u.id = l.admin_id
    ORDER BY l.id DESC
  `).all();
}
function getLog(id) {
  return db.prepare(`
    SELECT l.*, u.avatar, u.username, COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
    FROM logs l JOIN users u ON u.id = l.admin_id
    WHERE l.id = ?
  `).get(Number(id)) || null;
}
function updateLog(id, patch) {
  const cur = getLog(id);
  if (!cur) return false;
  const next = {
    title: patch.title !== undefined ? patch.title : cur.title,
    content: patch.content !== undefined ? patch.content : cur.content,
    cover_image: patch.cover_image !== undefined ? patch.cover_image : cur.cover_image,
    video_url: patch.video_url !== undefined ? patch.video_url : cur.video_url,
  };
  if (!next.title) return false;
  db.prepare('UPDATE logs SET title = ?, content = ?, cover_image = ?, video_url = ?, updated_at = ? WHERE id = ?')
    .run(next.title, next.content, next.cover_image, next.video_url, now(), Number(id));
  return true;
}
function deleteLog(id) {
  db.prepare('DELETE FROM comments WHERE log_id = ?').run(Number(id));
  db.prepare('DELETE FROM danmaku WHERE log_id = ?').run(Number(id));
  return db.prepare('DELETE FROM logs WHERE id = ?').run(Number(id)).changes > 0;
}

// ---------- 评论 ----------
function addComment(logId, userId, content) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(Number(userId));
  const ts = now();
  const info = db.prepare('INSERT INTO comments(log_id, user_id, content, created_at) VALUES(?, ?, ?, ?)')
    .run(Number(logId), Number(userId), content, ts);
  return { id: Number(info.lastInsertRowid), username: user ? user.username : '?', content, created_at: ts };
}
function listComments(logId) {
  return db.prepare(`
    SELECT c.id, c.content, c.created_at, u.username, u.avatar,
           COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.log_id = ? ORDER BY c.id ASC
  `).all(Number(logId));
}

// ---------- 弹幕 ----------
function addDanmaku(logId, userId, content, videoTime) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(Number(userId));
  const t = Number(videoTime) || 0;
  const info = db.prepare('INSERT INTO danmaku(log_id, user_id, content, video_time, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(Number(logId), Number(userId), content, t, now());
  return { id: Number(info.lastInsertRowid), log_id: Number(logId), username: user ? user.username : '?', content, video_time: t };
}
function listDanmaku(logId) {
  return db.prepare(`
    SELECT d.id, d.log_id, d.content, d.video_time, u.username
    FROM danmaku d JOIN users u ON u.id = d.user_id
    WHERE d.log_id = ? ORDER BY d.video_time ASC, d.id ASC LIMIT 500
  `).all(Number(logId));
}

// ---------- 通知 ----------
function createNotice(adminId, title, content) {
  const ts = now();
  const info = db.prepare('INSERT INTO notices(admin_id, title, content, created_at) VALUES(?, ?, ?, ?)')
    .run(Number(adminId), title, content, ts);
  return { id: Number(info.lastInsertRowid), title, content, created_at: ts };
}
function listNotices() {
  return db.prepare(`
    SELECT n.id, n.title, n.content, n.created_at, u.avatar, u.username,
           COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name
    FROM notices n JOIN users u ON u.id = n.admin_id
    ORDER BY n.id DESC
  `).all();
}
function deleteNotice(id) {
  return db.prepare('DELETE FROM notices WHERE id = ?').run(Number(id)).changes > 0;
}

// ---------- 动态评论 ----------
function addPostComment(postId, userId, content, parentId = null) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(Number(userId));
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(Number(postId));
  if (!user || !post) return null;
  let pid = null;
  if (parentId) {
    const parent = db.prepare('SELECT id, post_id FROM post_comments WHERE id = ?').get(Number(parentId));
    if (!parent || parent.post_id !== Number(postId)) return null; // 父评论必须属于同一条动态
    pid = Number(parentId);
  }
  const ts = now();
  const info = db.prepare('INSERT INTO post_comments(post_id, user_id, content, parent_id, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(Number(postId), Number(userId), content, pid, ts);
  return getPostComment(Number(info.lastInsertRowid));
}
function getPostComment(id) {
  return db.prepare(`
    SELECT pc.id, pc.post_id, pc.content, pc.created_at, pc.parent_id,
           u.username, u.avatar, COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name,
           pu.username AS reply_to, COALESCE(NULLIF(pu.nickname, ''), pu.username) AS reply_to_display
    FROM post_comments pc
    JOIN users u ON u.id = pc.user_id
    LEFT JOIN post_comments pp ON pp.id = pc.parent_id
    LEFT JOIN users pu ON pu.id = pp.user_id
    WHERE pc.id = ?
  `).get(Number(id)) || null;
}
function listPostCommentsByPosts(ids) {
  const map = {};
  if (!ids || !ids.length) return map;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT pc.id, pc.post_id, pc.content, pc.created_at, pc.parent_id,
           u.username, u.avatar, COALESCE(NULLIF(u.nickname, ''), u.username) AS display_name,
           pu.username AS reply_to, COALESCE(NULLIF(pu.nickname, ''), pu.username) AS reply_to_display
    FROM post_comments pc
    JOIN users u ON u.id = pc.user_id
    LEFT JOIN post_comments pp ON pp.id = pc.parent_id
    LEFT JOIN users pu ON pu.id = pp.user_id
    WHERE pc.post_id IN (${ph}) ORDER BY pc.id ASC
  `).all(...ids.map(Number));
  for (const r of rows) (map[r.post_id] || (map[r.post_id] = [])).push(r);
  return map;
}
function deletePostComment(id, userId, isAdmin) {
  if (isAdmin) return db.prepare('DELETE FROM post_comments WHERE id = ?').run(Number(id)).changes > 0;
  return db.prepare('DELETE FROM post_comments WHERE id = ? AND user_id = ?').run(Number(id), Number(userId)).changes > 0;
}

// ---------- 动态点赞 ----------
function toggleLike(postId, userId) {
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(Number(postId));
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(userId));
  if (!post || !user) return null;
  const existing = db.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').get(Number(postId), Number(userId));
  if (existing) {
    db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(Number(postId), Number(userId));
  } else {
    db.prepare('INSERT INTO post_likes(post_id, user_id, created_at) VALUES(?, ?, ?)').run(Number(postId), Number(userId), now());
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM post_likes WHERE post_id = ?').get(Number(postId)).c;
  return { post_id: Number(postId), like_count: count, liked: !existing };
}
function getLikeInfoByPosts(ids, userId) {
  const map = {};
  if (!ids || !ids.length) return map;
  for (const id of ids) map[id] = { count: 0, liked: false };
  const ph = ids.map(() => '?').join(',');
  const counts = db.prepare(`SELECT post_id, COUNT(*) AS c FROM post_likes WHERE post_id IN (${ph}) GROUP BY post_id`).all(...ids.map(Number));
  for (const r of counts) if (map[r.post_id]) map[r.post_id].count = r.c;
  if (userId) {
    const likedRows = db.prepare(`SELECT post_id FROM post_likes WHERE user_id = ? AND post_id IN (${ph})`).all(Number(userId), ...ids.map(Number));
    for (const r of likedRows) if (map[r.post_id]) map[r.post_id].liked = true;
  }
  return map;
}

module.exports = {
  createUser, findUser, getUserById, getPublicProfile, listUsers, listUsersByStatus,
  setUserRole, setUserStatus, updateProfile, updateUserAvatar, deleteUser,
  createPost, listPosts, listPostsByUser, deletePost, deletePostAsAdmin,
  getContent, updateContent,
  createLog, listLogs, getLog, updateLog, deleteLog,
  addComment, listComments,
  addDanmaku, listDanmaku,
  createNotice, listNotices, deleteNotice,
  addPostComment, listPostCommentsByPosts, deletePostComment,
  toggleLike, getLikeInfoByPosts,
  checkpoint,
};
