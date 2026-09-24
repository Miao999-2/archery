const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { Jimp } = require('jimp');
const { Server } = require('socket.io');
const db = require('./db');
const backup = require('./backup');

const SITE_NAME = 'RUC射箭队';
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 会话（socket.io 与 http 共享，实现登录状态打通）
// 登录态持久化到 SQLite（随数据一起备份）：服务器重启 / 更新后仍保持登录；cookie 有效期一周
class SQLiteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const raw = db.getSession(sid);
      cb(null, raw ? JSON.parse(raw) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : null;
      db.setSession(sid, JSON.stringify(sess), maxAge);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try { db.destroySession(sid); cb(null); } catch (e) { cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : null;
      db.touchSession(sid, maxAge);
      cb(null);
    } catch (e) { cb(e); }
  }
}
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'archery-dev-secret-change-me',
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// 把当前用户（含昵称/头像/状态）注入所有模板，并保持角色最新
app.use((req, res, next) => {
  res.locals.siteName = SITE_NAME;
  let user = null;
  if (req.session.user) {
    const fresh = db.findUser(req.session.user.username);
    if (fresh && fresh.status === 'approved') {
      user = {
        id: fresh.id,
        username: fresh.username,
        role: fresh.role,
        nickname: fresh.nickname,
        avatar: fresh.avatar,
        status: fresh.status,
        display_name: fresh.nickname || fresh.username,
      };
      req.session.user = user;
    } else {
      req.session.user = null; // 待审批 / 被拒 的账号视为未登录
    }
  }
  res.locals.user = user;
  res.locals.isAdmin = !!(user && user.role === 'admin');
  next();
});

// 密码哈希（Node 内置 scrypt，无需第三方依赖）
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const check = crypto.scryptSync(pw, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const fresh = db.findUser(req.session.user.username);
  if (!fresh || fresh.role !== 'admin') return res.status(403).send('无权限访问（需要管理员权限）。<a href="/">返回首页</a>');
  next();
}
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// 文件上传（图片 PNG/JPG/JPEG、视频 MP4）
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase();
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    },
  }),
  limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(png|jpe?g|mp4)$/i.test(file.originalname || '')),
});

// 头像上传（存入内存，自动压缩后转 base64 存库，随备份一起持久化，不落磁盘）
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 放大阈值：过大的文件交给下方压缩，而不是直接拒绝
  fileFilter: (req, file, cb) => cb(null, /\.(png|jpe?g|gif)$/i.test(file.originalname || '')),
});

// 动态墙配图上传（同头像：内存存储 + 压缩后 base64 存库）
const postImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(png|jpe?g|gif)$/i.test(file.originalname || '')),
});

// 判断图片是否真的包含透明像素（jimp 解出的位图通常都带 alpha 通道，不能用 hasAlpha() 判断）
function hasTransparency(img) {
  const data = img.bitmap.data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

// 压缩图片：最长边超过 maxDim 则等比缩小（保持宽高比、不拉伸不补边）；有透明则保留 PNG，否则转 JPEG 减小体积
const AVATAR_MAX_DIM = 512;
const POST_IMAGE_MAX_DIM = 1280;
async function compressImage(buffer, maxDim) {
  const img = await Jimp.read(buffer);
  if (img.width > maxDim || img.height > maxDim) {
    const scale = Math.min(maxDim / img.width, maxDim / img.height);
    img.resize({ w: Math.max(1, Math.round(img.width * scale)), h: Math.max(1, Math.round(img.height * scale)) });
  }
  const mime = hasTransparency(img) ? 'image/png' : 'image/jpeg';
  const out = await img.getBuffer(mime, { quality: 82 });
  return { mime, buffer: out };
}
const compressAvatar = (buffer) => compressImage(buffer, AVATAR_MAX_DIM);
const compressPostImage = (buffer) => compressImage(buffer, POST_IMAGE_MAX_DIM);

// ---------- 页面路由 ----------
app.get('/', (req, res) => res.render('index', { content: db.getContent() }));
app.get('/about', (req, res) => res.render('about', { content: db.getContent() }));
app.get('/board', requireLogin, (req, res) => {
  const posts = db.listPosts();
  const userId = req.session.user ? req.session.user.id : null;
  res.render('board', {
    posts,
    commentsByPost: db.listPostCommentsByPosts(posts.map((p) => p.id)),
    likesByPost: db.getLikeInfoByPosts(posts.map((p) => p.id), userId),
  });
});

app.get('/login', (req, res) => {
  const msg = req.query.msg === 'pending' ? '注册申请已提交，请等待管理员审批通过后再登录。' : '';
  res.render('login', { error: null, msg });
});
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && db.findUser(String(username).trim());
  if (!user || !verifyPassword(String(password || ''), user.hash)) {
    return res.status(401).render('login', { error: '用户名或密码错误', msg: '' });
  }
  if (user.status === 'pending') {
    return res.status(403).render('login', { error: '账号正在等待管理员审批，暂时无法登录。', msg: '' });
  }
  if (user.status === 'rejected') {
    return res.status(403).render('login', { error: '该账号的注册申请未通过，无法登录。', msg: '' });
  }
  req.session.user = {
    id: user.id, username: user.username, role: user.role,
    nickname: user.nickname, avatar: user.avatar, status: user.status,
    display_name: user.nickname || user.username,
  };
  res.redirect('/board');
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', (req, res) => {
  const { username, password, email, reason } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  const em = String(email || '').trim();
  const rsn = String(reason || '').trim();
  if (u.length < 2) return res.status(400).render('register', { error: '用户名至少 2 个字符' });
  if (p.length < 6) return res.status(400).render('register', { error: '密码至少 6 位' });
  if (!rsn) return res.status(400).render('register', { error: '请填写申请理由' });
  if (rsn.length > 200) return res.status(400).render('register', { error: '申请理由不超过 200 字' });
  if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).render('register', { error: '邮箱格式不正确' });
  try {
    const user = db.createUser(u, hashPassword(p), em, rsn);
    if (user.status === 'approved') {
      req.session.user = {
        id: user.id, username: user.username, role: user.role,
        nickname: '', avatar: '', status: 'approved', display_name: user.username,
      };
      return res.redirect('/board');
    }
    res.redirect('/login?msg=pending');
  } catch (e) {
    res.status(400).render('register', { error: e.message || '注册失败' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- 个人主页 / 设置 ----------
app.get('/u/:username', (req, res) => {
  const profile = db.getPublicProfile(req.params.username);
  if (!profile) return res.status(404).send('用户不存在。<a href="/">返回首页</a>');
  const posts = db.listPostsByUser(profile.id);
  res.render('profile', { profile, posts });
});

app.get('/settings', requireLogin, (req, res) => {
  const fresh = db.getUserById(req.session.user.id);
  res.render('settings', {
    u: fresh,
    ok: req.query.ok,
    err: req.query.err === 'avatar' ? '头像上传失败：请上传 PNG / JPG / JPEG / GIF 图片（系统会自动压缩过大图片）' : (req.query.err === 'nickname' ? '昵称不超过 30 个字符' : (req.query.err === 'bio' ? '个人简介不超过 200 个字符' : null)),
  });
});
app.post('/settings', requireLogin, (req, res) => {
  const nickname = String((req.body && req.body.nickname) || '').trim();
  const bio = String((req.body && req.body.bio) || '').trim();
  if (nickname.length > 30) return res.redirect('/settings?err=nickname');
  if (bio.length > 200) return res.redirect('/settings?err=bio');
  db.updateProfile(req.session.user.id, nickname, bio);
  res.redirect('/settings?ok=1');
});
app.post('/settings/avatar', requireLogin, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err || !req.file) return res.redirect('/settings?err=avatar'); // 含文件过大 / 非图片格式
    try {
      const { mime, buffer } = await compressAvatar(req.file.buffer);
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      db.updateUserAvatar(req.session.user.id, dataUrl);
      res.redirect('/settings?ok=1');
    } catch (e) {
      res.redirect('/settings?err=avatar'); // 图片损坏或无法解码
    }
  });
});

// ---------- 发布动态（支持可选图片，图片压缩后存库；成功后 socket 广播给所有在线用户） ----------
app.post('/api/post', requireLogin, (req, res) => {
  postImageUpload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: '图片上传失败：仅支持 PNG / JPG / JPEG / GIF，且不超过 20MB' });
    try {
      const content = String((req.body && req.body.content) || '').trim();
      let image = '';
      if (req.file) {
        const { mime, buffer } = await compressPostImage(req.file.buffer);
        image = `data:${mime};base64,${buffer.toString('base64')}`;
      }
      if (!content && !image) return res.status(400).json({ error: '内容或图片不能都为空' });
      if (content.length > 500) return res.status(400).json({ error: '内容过长' });
      const post = db.createPost(req.session.user.id, content, image);
      io.emit('post:new', post);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: '发布失败' });
    }
  });
});

// ---------- 动态墙补拉（断线/休眠后，客户端用它同步错过的广播） ----------
app.get('/api/posts', requireLogin, (req, res) => {
  const since = Number(req.query.since) || 0;
  const posts = db.listPosts().filter((p) => Number(p.id) > since);
  res.json(posts);
});

// ---------- 管理员工作台 ----------
app.get('/admin', requireAdmin, (req, res) => {
  res.render('admin', {
    content: db.getContent(),
    users: db.listUsers(),
    pendingUsers: db.listUsersByStatus('pending'),
    rejectedUsers: db.listUsersByStatus('rejected'),
    posts: db.listPosts(),
    logs: db.listLogs(),
    ok: !!req.query.ok,
  });
});
app.post('/admin/content', requireAdmin, (req, res) => {
  const b = req.body || {};
  db.updateContent({
    hero: { eyebrow: String(b.eyebrow || ''), lead: String(b.lead || '') },
    announcement: String(b.announcement || ''),
    about: String(b.about || ''),
  });
  res.redirect('/admin?ok=1');
});
app.post('/admin/users/:id/role', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const role = String((req.body && req.body.role) || '');
  if (role !== 'admin' && role !== 'member') return res.redirect('/admin');
  if (id === Number(req.session.user.id)) return res.redirect('/admin'); // 不能改自己的角色
  const admins = db.listUsers().filter((u) => u.role === 'admin');
  const target = db.listUsers().find((u) => u.id === id);
  if (target && target.role === 'admin' && role === 'member' && admins.length <= 1) return res.redirect('/admin'); // 不能降级最后一个管理员
  db.setUserRole(id, role);
  res.redirect('/admin');
});
app.post('/admin/posts/:id/delete', requireAdmin, (req, res) => {
  db.deletePostAsAdmin(req.params.id);
  res.redirect('/admin');
});
app.post('/admin/users/:id/approve', requireAdmin, (req, res) => {
  db.setUserStatus(Number(req.params.id), 'approved');
  res.redirect('/admin');
});
app.post('/admin/users/:id/reject', requireAdmin, (req, res) => {
  db.setUserStatus(Number(req.params.id), 'rejected');
  res.redirect('/admin');
});
app.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.session.user.id)) return res.redirect('/admin'); // 不能删自己
  const target = db.getUserById(id);
  if (!target) return res.redirect('/admin');
  if (target.role === 'admin') {
    const admins = db.listUsers().filter((u) => u.role === 'admin');
    if (admins.length <= 1) return res.redirect('/admin'); // 不能删除最后一个管理员
  }
  db.deleteUser(id);
  res.redirect('/admin');
});

// ---------- 文件上传（管理员） ----------
app.post('/api/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '上传失败：仅支持 PNG / JPG / JPEG / MP4' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ---------- 日志 ----------
app.get('/logs', requireLogin, (req, res) => res.render('logs', { logs: db.listLogs() }));
app.get('/logs/new', requireAdmin, (req, res) => res.render('log-edit', { log: null, error: null }));
app.post('/logs', requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) {
    return res.status(400).render('log-edit', {
      log: { title, content: b.content || '', cover_image: b.cover_image || '', video_url: b.video_url || '' },
      error: '标题不能为空',
    });
  }
  const log = db.createLog(title, String(b.content || ''), String(b.cover_image || ''), String(b.video_url || ''), req.session.user.id);
  res.redirect('/logs/' + log.id);
});
app.get('/logs/:id', requireLogin, (req, res) => {
  const log = db.getLog(req.params.id);
  if (!log) return res.status(404).send('日志不存在。<a href="/logs">返回日志列表</a>');
  res.render('log-detail', { log, comments: db.listComments(log.id), danmaku: db.listDanmaku(log.id) });
});
app.get('/logs/:id/edit', requireAdmin, (req, res) => {
  const log = db.getLog(req.params.id);
  if (!log) return res.status(404).send('日志不存在。');
  res.render('log-edit', { log, error: null });
});
app.post('/logs/:id', requireAdmin, (req, res) => {
  const b = req.body || {};
  db.updateLog(req.params.id, {
    title: String(b.title || '').trim(),
    content: String(b.content || ''),
    cover_image: String(b.cover_image || ''),
    video_url: String(b.video_url || ''),
  });
  res.redirect('/logs/' + req.params.id);
});
app.post('/logs/:id/delete', requireAdmin, (req, res) => {
  db.deleteLog(req.params.id);
  res.redirect('/logs');
});
app.post('/logs/:id/comments', requireLogin, (req, res) => {
  const content = String((req.body && req.body.content) || '').trim();
  if (content) db.addComment(req.params.id, req.session.user.id, content);
  res.redirect('/logs/' + req.params.id + '#comments');
});

// ---------- 通知（仅管理员发布） ----------
app.get('/notices', (req, res) => res.render('notices', { notices: db.listNotices() }));
app.post('/notices', requireAdmin, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const content = String(b.content || '').trim();
  if (!title) return res.redirect('/notices');
  db.createNotice(req.session.user.id, title, content);
  res.redirect('/notices');
});
app.post('/notices/:id/pin', requireAdmin, (req, res) => {
  const n = db.getNotice(req.params.id);
  if (n) db.setNoticePinned(req.params.id, n.pinned ? 0 : 1);
  res.redirect('/notices');
});
app.get('/notices/:id/edit', requireAdmin, (req, res) => {
  const n = db.getNotice(req.params.id);
  if (!n) return res.status(404).send('通知不存在。<a href="/notices">返回通知</a>');
  res.render('notice-edit', { n, error: null });
});
app.post('/notices/:id/edit', requireAdmin, (req, res) => {
  const n = db.getNotice(req.params.id);
  if (!n) return res.status(404).send('通知不存在。<a href="/notices">返回通知</a>');
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const content = String(b.content || '').trim();
  if (!title) return res.render('notice-edit', { n, error: '标题不能为空' });
  db.updateNotice(req.params.id, title, content);
  res.redirect('/notices');
});
app.post('/notices/:id/delete', requireAdmin, (req, res) => {
  db.deleteNotice(req.params.id);
  res.redirect('/notices');
});

// ---------- Socket.io 实时交互 ----------
io.on('connection', (socket) => {
  const user = socket.request.session && socket.request.session.user;
  socket.emit('user:init', { user: user || null });

  // 删除动态 → 本人删自己的，管理员删任意
  socket.on('post:delete', (payload) => {
    if (!user) return;
    const id = payload && payload.id;
    const fresh = db.findUser(user.username);
    const isAdmin = fresh && fresh.role === 'admin';
    const ok = isAdmin ? db.deletePostAsAdmin(id) : db.deletePost(id, user.id);
    if (ok) io.emit('post:deleted', { id });
  });

  // 评论动态（含回复某条评论）→ 存库 + 实时广播给所有在线用户
  socket.on('post:comment:send', (payload) => {
    if (!user) return;
    const postId = Number(payload && payload.postId);
    const content = String((payload && payload.content) || '').trim();
    if (!postId || !content || content.length > 200) return;
    const parentId = payload && payload.parentId ? Number(payload.parentId) : null;
    const c = db.addPostComment(postId, user.id, content, parentId);
    if (c) io.emit('post:comment:new', c);
  });

  // 删除评论 → 本人删自己的，管理员删任意
  socket.on('post:comment:delete', (payload) => {
    if (!user) return;
    const id = Number(payload && payload.id);
    const fresh = db.findUser(user.username);
    const isAdmin = fresh && fresh.role === 'admin';
    const ok = db.deletePostComment(id, user.id, isAdmin);
    if (ok) io.emit('post:comment:deleted', { id });
  });

  // 点赞/取消点赞 → 实时广播最新点赞数与本人状态
  socket.on('post:like', (payload) => {
    if (!user) return;
    const postId = Number(payload && payload.postId);
    if (!postId) return;
    const r = db.toggleLike(postId, user.id);
    if (r) io.emit('post:like:changed', r);
  });

  // 加入某个日志的弹幕房间
  socket.on('log:join', (logId) => {
    if (logId) socket.join('log-' + logId);
  });

  // 发送弹幕 → 存库 + 实时广播给同房间在线用户
  socket.on('danmaku:send', (payload) => {
    if (!user) return;
    const logId = Number(payload && payload.logId);
    const content = String((payload && payload.content) || '').trim();
    const videoTime = Number(payload && payload.video_time) || 0;
    if (!logId || !content || content.length > 100) return;
    const d = db.addDanmaku(logId, user.id, content, videoTime);
    io.to('log-' + logId).emit('danmaku:new', d);
  });
});

// 错误处理（如上传文件过大）
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件过大（视频最大 150MB）' });
  console.error(err);
  res.status(500).send('服务器出错了。');
});

server.listen(PORT, () => {
  console.log(`\n  RUC射箭队网站已启动 →  http://localhost:${PORT}\n`);
});

// ---------- 数据持久化：定期 + 退出时备份到 GitHub 私密仓库 ----------
async function doBackup() {
  try {
    db.cleanupSessions(); // 顺手清理过期会话，避免表无限增长
    db.checkpoint();
    await backup.uploadBackup();
  } catch (e) { /* 备份失败不影响主流程 */ }
}

// 每 5 分钟备份一次（兜底：防崩溃/强杀导致的小段数据丢失）
setInterval(doBackup, 5 * 60 * 1000);

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在备份数据后退出……`);
  doBackup().finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref(); // 兜底：5 秒内未退出则强退
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
