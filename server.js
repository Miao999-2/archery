const path = require('path');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { Server } = require('socket.io');
const db = require('./db');
const backup = require('./backup');

const SITE_NAME = '射箭队';
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
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'archery-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true },
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

// 把当前用户（含角色）注入所有模板，并保持角色最新
app.use((req, res, next) => {
  res.locals.siteName = SITE_NAME;
  let user = null;
  if (req.session.user) {
    const fresh = db.findUser(req.session.user.username);
    if (fresh) {
      user = { id: fresh.id, username: fresh.username, role: fresh.role };
      req.session.user = user;
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

// ---------- 页面路由 ----------
app.get('/', (req, res) => res.render('index', { content: db.getContent() }));
app.get('/about', (req, res) => res.render('about', { content: db.getContent() }));
app.get('/board', (req, res) => {
  const posts = db.listPosts();
  const userId = req.session.user ? req.session.user.id : null;
  res.render('board', {
    posts,
    commentsByPost: db.listPostCommentsByPosts(posts.map((p) => p.id)),
    likesByPost: db.getLikeInfoByPosts(posts.map((p) => p.id), userId),
  });
});

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && db.findUser(String(username).trim());
  if (!user || !verifyPassword(String(password || ''), user.hash)) {
    return res.status(401).render('login', { error: '用户名或密码错误' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/board');
});

app.get('/register', (req, res) => res.render('register', { error: null }));
app.post('/register', (req, res) => {
  const { username, password, email } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  const em = String(email || '').trim();
  if (u.length < 2) return res.status(400).render('register', { error: '用户名至少 2 个字符' });
  if (p.length < 6) return res.status(400).render('register', { error: '密码至少 6 位' });
  if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return res.status(400).render('register', { error: '邮箱格式不正确' });
  try {
    const user = db.createUser(u, hashPassword(p), em);
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect('/board');
  } catch (e) {
    res.status(400).render('register', { error: e.message || '注册失败' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- 管理员工作台 ----------
app.get('/admin', requireAdmin, (req, res) => {
  res.render('admin', {
    content: db.getContent(),
    users: db.listUsers(),
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

// ---------- 文件上传（管理员） ----------
app.post('/api/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '上传失败：仅支持 PNG / JPG / JPEG / MP4' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ---------- 日志 ----------
app.get('/logs', (req, res) => res.render('logs', { logs: db.listLogs() }));
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
app.get('/logs/:id', (req, res) => {
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
app.post('/notices/:id/delete', requireAdmin, (req, res) => {
  db.deleteNotice(req.params.id);
  res.redirect('/notices');
});

// ---------- Socket.io 实时交互 ----------
io.on('connection', (socket) => {
  const user = socket.request.session && socket.request.session.user;
  socket.emit('user:init', { user: user || null });

  // 发布动态 → 广播给所有在线用户（实时）
  socket.on('post:create', (payload) => {
    if (!user) return;
    const content = String((payload && payload.content) || '').trim();
    if (!content || content.length > 500) return;
    const post = db.createPost(user.id, content);
    io.emit('post:new', post);
  });

  // 删除动态 → 本人删自己的，管理员删任意
  socket.on('post:delete', (payload) => {
    if (!user) return;
    const id = payload && payload.id;
    const fresh = db.findUser(user.username);
    const isAdmin = fresh && fresh.role === 'admin';
    const ok = isAdmin ? db.deletePostAsAdmin(id) : db.deletePost(id, user.id);
    if (ok) io.emit('post:deleted', { id });
  });

  // 评论动态 → 存库 + 实时广播给所有在线用户
  socket.on('post:comment:send', (payload) => {
    if (!user) return;
    const postId = Number(payload && payload.postId);
    const content = String((payload && payload.content) || '').trim();
    if (!postId || !content || content.length > 200) return;
    const c = db.addPostComment(postId, user.id, content);
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
  console.log(`\n  射箭队网站已启动 →  http://localhost:${PORT}\n`);
});

// ---------- 数据持久化：定期 + 退出时备份到 GitHub 私密仓库 ----------
async function doBackup() {
  try {
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
