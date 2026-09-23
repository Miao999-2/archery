const fs = require('fs');
const path = require('path');

// 纯 JSON 文件存储：不依赖 node:sqlite，任何 Node 版本都能跑，
// 方便部署到 Glitch 等免费平台（它们有持久磁盘，数据能保留）。
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_CONTENT = {
  hero: {
    eyebrow: '团队官网',
    lead: '这里是射箭队的主页。内容即将上线，你可以先体验右上角的「动态墙」——多人实时发布、即时可见。',
  },
  announcement: '',
  about: '这里放射箭队的介绍：成立时间、成员、荣誉、训练安排等。内容待补充。',
};

let db = { users: [], posts: [], content: {}, seq: { user: 1, post: 1 } };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (loaded && Array.isArray(loaded.users) && Array.isArray(loaded.posts)) {
        db = Object.assign(db, loaded);
      }
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
  // ---------- 用户 ----------
  createUser(username, hash) {
    if (db.users.some((u) => u.username === username)) throw new Error('该用户名已被注册');
    // 第一个注册的用户自动成为管理员
    const role = db.users.length === 0 ? 'admin' : 'member';
    const user = { id: db.seq.user++, username, hash, role, created_at: now() };
    db.users.push(user);
    save();
    return { id: user.id, username: user.username, role: user.role };
  },
  findUser(username) {
    return db.users.find((u) => u.username === username) || null;
  },
  listUsers() {
    return db.users.map((u) => ({ id: u.id, username: u.username, role: u.role, created_at: u.created_at }));
  },
  setUserRole(id, role) {
    if (role !== 'admin' && role !== 'member') return false;
    const u = db.users.find((x) => x.id === Number(id));
    if (!u) return false;
    u.role = role;
    save();
    return true;
  },

  // ---------- 动态 ----------
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
  deletePostAsAdmin(id) {
    const i = db.posts.findIndex((p) => p.id === Number(id));
    if (i === -1) return false;
    db.posts.splice(i, 1);
    save();
    return true;
  },

  // ---------- 网站内容 ----------
  getContent() {
    const c = db.content || {};
    return {
      hero: Object.assign({}, DEFAULT_CONTENT.hero, c.hero || {}),
      announcement: typeof c.announcement === 'string' ? c.announcement : DEFAULT_CONTENT.announcement,
      about: typeof c.about === 'string' ? c.about : DEFAULT_CONTENT.about,
    };
  },
  updateContent(patch) {
    db.content = db.content || {};
    if (patch.hero && typeof patch.hero === 'object') {
      db.content.hero = Object.assign({}, db.content.hero || {}, patch.hero);
    }
    if (typeof patch.announcement === 'string') db.content.announcement = patch.announcement;
    if (typeof patch.about === 'string') db.content.about = patch.about;
    save();
    return db.content;
  },
};
