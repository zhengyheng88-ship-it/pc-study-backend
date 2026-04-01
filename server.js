const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise'); 
const bcrypt = require('bcryptjs');      
const jwt = require('jsonwebtoken');     
const multer = require('multer');
const xlsx = require('xlsx');
const axios = require('axios');
const path = require('path'); 

const app = express();

// ==========================================
// ⚙️ 基础中间件配置
// ==========================================
app.use(cors());
app.use(express.json());

// ==========================================
// 🔑 核心配置区 (环境变量)
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET || 'SuperSecretCloudStudyRoom2026'; 
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-b8855c79186a496d95851bd1d2b41580'; 

const upload = multer({ storage: multer.memoryStorage() });

// 🗄️ 1. 配置 MySQL 数据库连接池
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, 
  database: process.env.DB_NAME, 
  port: process.env.DB_PORT || 4000,
  ssl: {
    rejectUnauthorized: true 
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 测试数据库连接
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL 数据库连接成功！');
    conn.release();
  })
  .catch(err => {
    console.error('❌ 数据库连接失败:', err);
  });

// ==========================================
// 🛡️ 3. JWT 鉴权中间件
// ==========================================
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: '未登录' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token 无效' });
    req.user = user; 
    next(); 
  });
};

// ==========================================
// 🚀 2. 身份验证接口
// ==========================================
// ==========================================
// 🚀 2. 身份验证接口
// ==========================================
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: '不能为空' });
  
  try {
    const [existingUsers] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (existingUsers.length > 0) return res.status(409).json({ message: '已被注册' });
    
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    const [result] = await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
    res.status(201).json({ message: '注册成功', userId: result.insertId });
  } catch (err) {
    // 👇 绝杀：不管 Render 日志刷不刷新，直接把真实的数据库报错顺着网线砸回给浏览器！
    res.status(500).json({ 
      message: '服务器内部错误', 
      realError: err.message,   // 具体的报错文字（比如表不存在、语法错误）
      errorCode: err.code       // 具体的报错代码（比如 ER_NO_SUCH_TABLE）
    });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) return res.status(401).json({ message: '用户不存在' });
    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: '密码错误' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: '登录成功', token: token, username: user.username });
  } catch (err) {
    console.error("🚨 登录接口抓到报错了：", err); 
    res.status(500).json({ message: '服务器内部错误' });
  }
});

// ==========================================
// 📋 4. 任务清单接口
// ==========================================
app.get('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, content, is_completed as completed FROM tasks WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error("🚨 获取任务列表报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.post('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.query('INSERT INTO tasks (user_id, content) VALUES (?, ?)', [req.user.id, req.body.content]);
    res.json({ code: 200, id: result.insertId });
  } catch (err) {
    console.error("🚨 创建新任务报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.put('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE tasks SET is_completed = ? WHERE id = ? AND user_id = ?', [req.body.completed, req.params.id, req.user.id]);
    res.json({ code: 200 });
  } catch (err) {
    console.error("🚨 更新任务状态报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.delete('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM tasks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ code: 200 });
  } catch (err) {
    console.error("🚨 删除任务报错：", err);
    res.status(500).json({ code: 500 });
  }
});

// ==========================================
// 📊 5. 统计、AI 与 记录接口
// ==========================================
app.get('/api/study/stats', authenticateToken, async (req, res) => {
  const userId = req.user.id; 
  try {
    const [sessionResult] = await pool.query('SELECT SUM(duration) as totalTime FROM study_sessions WHERE user_id = ?', [userId]);
    const totalFocusTime = sessionResult[0].totalTime || 0; 
    const [taskResult] = await pool.query('SELECT COUNT(*) as completedTasks FROM tasks WHERE user_id = ? AND is_completed = TRUE', [userId]);
    const completedTasks = taskResult[0].completedTasks || 0;
    
    // 查询最近7天数据
    const [weeklyResult] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as date_str, SUM(duration) as daily_total
      FROM study_sessions WHERE user_id = ? AND created_at >= CURDATE() - INTERVAL 6 DAY GROUP BY date_str ORDER BY date_str ASC
    `, [userId]);

    const last7Days = []; const weeklyData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      last7Days.push(`${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      const foundDay = weeklyResult.find(row => row.date_str === dateStr);
      weeklyData.push(foundDay ? Number(foundDay.daily_total) : 0);
    }
    res.json({ code: 200, data: { totalFocusTime, completedTasks, continuousDays: 3, weeklyData, weeklyLabels: last7Days } });
  } catch (err) {
    console.error("🚨 获取统计数据报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.post('/api/ai/summarize', authenticateToken, async (req, res) => {
  try {
    const aiResponse = await axios.post('https://api.deepseek.com/chat/completions', {
      model: "deepseek-chat", 
      messages: [
        { role: "system", content: "你是一个专业的知识总结助手。" }, 
        { role: "user", content: `提炼 Markdown 格式笔记：\n${req.body.content}` }
      ], 
      temperature: 0.3 
    }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });
    res.json({ code: 200, data: aiResponse.data.choices[0].message.content });
  } catch (err) {
    console.error("🚨 AI 总结接口报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.get('/api/cards', authenticateToken, async (req, res) => {
  try {
    const [cards] = await pool.query('SELECT * FROM knowledge_cards WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ code: 200, data: cards });
  } catch (err) {
    console.error("🚨 获取知识卡片报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.post('/api/cards', authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.query('INSERT INTO knowledge_cards (user_id, title, content) VALUES (?, ?, ?)', [req.user.id, req.body.title, req.body.content]);
    res.json({ code: 200, id: result.insertId });
  } catch (err) {
    console.error("🚨 创建知识卡片报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.delete('/api/cards/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_cards WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ code: 200 });
  } catch (err) {
    console.error("🚨 删除知识卡片报错：", err);
    res.status(500).json({ code: 500 });
  }
});

app.post('/api/study/record', authenticateToken, async (req, res) => {
  try {
    await pool.query('INSERT INTO study_sessions (user_id, duration) VALUES (?, ?)', [req.user.id, req.body.duration]);
    res.json({ code: 200 });
  } catch (err) {
    console.error("🚨 保存学习记录报错：", err);
    res.status(500).json({ code: 500 });
  }
});

// ==========================================
// 🌐 6. 静态资源托管与单页应用(SPA)路由
// ==========================================
// 🌟 必须在所有 API 接口之后定义
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// 🌟 核心：捕获所有非 API 的 GET 请求，返回 index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(distPath, 'index.html'));
  }
});

// ==========================================
// 🌟 启动服务器
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { 
  console.log(`🚀 服务运行成功！`);
  console.log(`📡 监听端口: ${PORT}`);
  console.log(`📂 静态文件目录: ${distPath}`);
});