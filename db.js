const fs = require('fs');
const path = require('path');

// 纯 JSON 文件存储：不依赖 node:sqlite，任何 Node 版本都能跑，
// 方便部署到 Glitch 等免费平台（它们有持久磁盘，数据能保留）。
const DATA_FILE = path.join(__dirname, 'data.json');

let db = { users: [], posts: [], seq: { user: 1, post: 1 } };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (loaded && Array.isArray(loaded.users) && Array.isArray(loaded.posts)) db = loaded;
    }
  } catch (e) {
    console.error('读取 data.json 失败，使用空数据：', e.message);
  }
}
function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('写入 data.json 失败：', e.message);
  }
}
function now() {
  return new Date().toISOString();
}
load();

module.exports = {
  createUser(username, hash) {
    if (db.users.some((u) => u.username === username)) throw new Error('该用户名已被注册');
    const user = { id: db.seq.user++, username, hash, created_at: now() };
    db.users.push(user);
    save();
    return { id: user.id, username: user.username };
  },
  findUser(username) {
    return db.users.find((u) => u.username === username) || null;
  },
  createPost(userId, content) {
    const user = db.users.find((u) => u.id === Number(userId));
    if (!user) throw new Error('用户不存在');
    const post = { id: db.seq.post++, user_id: user.id, username: user.username, content, created_at: now() };
    db.posts.push(post);
    save();
    return { id: post.id, username: post.username, content: post.content, created_at: post.created_at };
  },
  listPosts() {
    return db.posts
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, 200)
      .map((p) => ({ id: p.id, username: p.username, content: p.content, created_at: p.created_at }));
  },
  deletePost(id, userId) {
    const i = db.posts.findIndex((p) => p.id === Number(id) && p.user_id === Number(userId));
    if (i === -1) return false;
    db.posts.splice(i, 1);
    save();
    return true;
  },
};
