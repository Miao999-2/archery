const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(__dirname, 'data.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

function now() {
  return new Date().toISOString();
}

module.exports = {
  createUser(username, hash) {
    try {
      const r = db.prepare('INSERT INTO users (username, hash, created_at) VALUES (?, ?, ?)').run(username, hash, now());
      return { id: Number(r.lastInsertRowid), username };
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new Error('该用户名已被注册');
      throw e;
    }
  },
  findUser(username) {
    return db.prepare('SELECT id, username, hash FROM users WHERE username = ?').get(username);
  },
  createPost(userId, content) {
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    const ts = now();
    const r = db.prepare('INSERT INTO posts (user_id, username, content, created_at) VALUES (?, ?, ?, ?)').run(userId, user.username, content, ts);
    return { id: Number(r.lastInsertRowid), username: user.username, content, created_at: ts };
  },
  listPosts() {
    return db.prepare('SELECT id, username, content, created_at FROM posts ORDER BY id DESC LIMIT 200').all();
  },
  deletePost(id, userId) {
    const r = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(id, userId);
    return r.changes > 0;
  },
};
