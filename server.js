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

app.use((req, res, next) => {
  res.locals.siteName = SITE_NAME;
  res.locals.user = req.session.user || null;
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
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// ---------- 页面路由 ----------
app.get('/', (req, res) => res.render('index'));
app.get('/about', (req, res) => res.render('about'));
app.get('/board', (req, res) => res.render('board', { posts: db.listPosts() }));

app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = username && db.findUser(String(username).trim());
  if (!user || !verifyPassword(String(password || ''), user.hash)) {
    return res.status(401).render('login', { error: '用户名或密码错误' });
  }
  req.session.user = { id: user.id, username: user.username };
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
    req.session.user = { id: user.id, username: user.username };
    res.redirect('/board');
  } catch (e) {
    res.status(400).render('register', { error: e.message || '注册失败' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
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

  // 删除自己的内容 → 广播给所有在线用户（实时）
  socket.on('post:delete', (payload) => {
    if (!user) return;
    const id = payload && payload.id;
    if (id != null && db.deletePost(id, user.id)) {
      io.emit('post:deleted', { id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  射箭队网站已启动 →  http://localhost:${PORT}\n`);
});
