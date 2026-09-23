const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const db = require('./db');

const SITE_NAME = '射箭队';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
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

// 密码哈希（Node 内置，无需第三方依赖）
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

// ---------- 页面路由 ----------
app.get('/', (req, res) => res.render('index', { content: db.getContent() }));
app.get('/about', (req, res) => res.render('about', { content: db.getContent() }));
app.get('/board', (req, res) => res.render('board', { posts: db.listPosts() }));

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
  const { username, password } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  if (u.length < 2) return res.status(400).render('register', { error: '用户名至少 2 个字符' });
  if (p.length < 6) return res.status(400).render('register', { error: '密码至少 6 位' });
  try {
    const user = db.createUser(u, hashPassword(p));
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
  res.render('admin', { content: db.getContent(), users: db.listUsers(), posts: db.listPosts(), ok: !!req.query.ok });
});

// 编辑网站内容
app.post('/admin/content', requireAdmin, (req, res) => {
  const b = req.body || {};
  db.updateContent({
    hero: { eyebrow: String(b.eyebrow || ''), lead: String(b.lead || '') },
    announcement: String(b.announcement || ''),
    about: String(b.about || ''),
  });
  res.redirect('/admin?ok=1');
});

// 指定 / 调整成员角色
app.post('/admin/users/:id/role', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const role = String((req.body && req.body.role) || '');
  if (role !== 'admin' && role !== 'member') return res.redirect('/admin');
  if (id === Number(req.session.user.id)) return res.redirect('/admin'); // 不能改自己的角色
  const admins = db.listUsers().filter((u) => u.role === 'admin');
  const target = db.listUsers().find((u) => u.id === id);
  if (target && target.role === 'admin' && role === 'member' && admins.length <= 1) {
    return res.redirect('/admin'); // 不能降级最后一个管理员
  }
  db.setUserRole(id, role);
  res.redirect('/admin');
});

// 管理员删除任意动态
app.post('/admin/posts/:id/delete', requireAdmin, (req, res) => {
  db.deletePostAsAdmin(req.params.id);
  res.redirect('/admin');
});

// ---------- Socket.io 实时交互 ----------
io.on('connection', (socket) => {
  const user = socket.request.session && socket.request.session.user;
  socket.emit('user:init', { user: user || null });

  // 发布内容 → 广播给所有在线用户（实时）
  socket.on('post:create', (payload) => {
    if (!user) return;
    const content = String((payload && payload.content) || '').trim();
    if (!content || content.length > 500) return;
    const post = db.createPost(user.id, content);
    io.emit('post:new', post);
  });

  // 删除内容 → 本人删自己的，管理员删任意
  socket.on('post:delete', (payload) => {
    if (!user) return;
    const id = payload && payload.id;
    const fresh = db.findUser(user.username);
    const isAdmin = fresh && fresh.role === 'admin';
    const ok = isAdmin ? db.deletePostAsAdmin(id) : db.deletePost(id, user.id);
    if (ok) io.emit('post:deleted', { id });
  });
});

server.listen(PORT, () => {
  console.log(`\n  射箭队网站已启动 →  http://localhost:${PORT}\n`);
});
