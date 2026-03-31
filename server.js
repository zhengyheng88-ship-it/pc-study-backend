const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise'); 
const bcrypt = require('bcryptjs');      
const jwt = require('jsonwebtoken');     
const multer = require('multer');
const xlsx = require('xlsx');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 🔑 核心配置区 (🌟 已修改：支持云端环境变量读取)
// ==========================================
const JWT_SECRET = process.env.JWT_SECRET || 'SuperSecretCloudStudyRoom2026'; 
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-b8855c79186a496d95851bd1d2b41580'; 

const upload = multer({ storage: multer.memoryStorage() });

// 🗄️ 1. 配置 MySQL 数据库连接池 (🌟 已修改：对接 TiDB 云数据库)
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '123456', 
  database: process.env.DB_NAME || 'study_room_db', 
  port: process.env.DB_PORT || 4000, // TiDB Cloud 默认端口通常为 4000
  ssl: {
    rejectUnauthorized: true // ⚠️ 连接 TiDB 等云数据库通常必须开启 SSL，否则会拒绝连接
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL 数据库连接成功！');
    conn.release();
  })
  .catch(err => {
    console.error('❌ 数据库连接失败:', err);
  });

// ==========================================
// 🚀 2. 核心接口区域 (免门禁)
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
    res.status(500).json({ message: '服务器内部错误' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: '不能为空' });

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (users.length === 0) return res.status(401).json({ message: '用户不存在' });
    
    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: '密码错误' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ message: '登录成功', token: token, username: user.username });
  } catch (err) {
    res.status(500).json({ message: '服务器内部错误' });
  }
});

// ==========================================
// 🛡️ 3. JWT 鉴权中间件 (门禁系统)
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
// 📊 4. 大盘与AI接口
// ==========================================
app.get('/api/study/stats', authenticateToken, async (req, res) => {
  const userId = req.user.id; 
  try {
    const [sessionResult] = await pool.query('SELECT SUM(duration) as totalTime FROM study_sessions WHERE user_id = ?', [userId]);
    const totalFocusTime = sessionResult[0].totalTime || 0; 

    const [taskResult] = await pool.query('SELECT COUNT(*) as completedTasks FROM tasks WHERE user_id = ? AND is_completed = TRUE', [userId]);
    const completedTasks = taskResult[0].completedTasks || 0;

    const [weeklyResult] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as date_str, SUM(duration) as daily_total
      FROM study_sessions WHERE user_id = ? AND created_at >= CURDATE() - INTERVAL 6 DAY GROUP BY date_str ORDER BY date_str ASC
    `, [userId]);

    const last7Days = [];
    const weeklyData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const year = d.getFullYear(); const month = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      last7Days.push(`${month}-${day}`);
      const foundDay = weeklyResult.find(row => row.date_str === dateStr);
      weeklyData.push(foundDay ? Number(foundDay.daily_total) : 0);
    }

    res.json({
      code: 200,
      data: { totalFocusTime, completedTasks, continuousDays: 3, weeklyData, weeklyLabels: last7Days }
    });
  } catch (error) {
    res.status(500).json({ code: 500, message: '获取大盘失败' });
  }
});

app.post('/api/schedule/import', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '请上传 Excel 文件' });
  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const csvData = xlsx.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
    const prompt = `你是一个智能课表解析助手。规则：day:1-7, slot:1-5, colorClass随机选['bg-pastel-blue','bg-pastel-green','bg-pastel-orange','bg-pastel-purple','bg-pastel-pink']。请严格返回 JSON 数组格式，课表数据：\n${csvData}`;
    
    const aiResponse = await axios.post('https://api.deepseek.com/chat/completions', {
      model: "deepseek-chat", messages: [{ role: "system", content: "你是一个只输出纯 JSON 的数据提取器。" }, { role: "user", content: prompt }], temperature: 0.1 
    }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' } });

    let resultText = aiResponse.data.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
    res.json({ message: '解析成功', courses: JSON.parse(resultText) });
  } catch (error) {
    res.status(500).json({ message: 'AI 解析遇到错误' });
  }
});

app.post('/api/ai/summarize', authenticateToken, async (req, res) => {
  if (!req.body.content) return res.status(400).json({ code: 400, message: '内容不能为空' });
  try {
    const aiResponse = await axios.post('https://api.deepseek.com/chat/completions', {
      model: "deepseek-chat", messages: [{ role: "system", content: "你是一个专业的知识总结助手。" }, { role: "user", content: `请将以下长文本提炼成结构清晰的 Markdown 格式笔记：\n${req.body.content}` }], temperature: 0.3 
    }, { headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` } });
    res.json({ code: 200, data: aiResponse.data.choices[0].message.content, message: '提炼成功' });
  } catch (error) {
    res.status(500).json({ code: 500, message: 'AI 提炼失败' });
  }
});

// ==========================================
// 📚 5. 知识卡片接口
// ==========================================
app.get('/api/cards', authenticateToken, async (req, res) => {
  try {
    const [cards] = await pool.query('SELECT * FROM knowledge_cards WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
    res.json({ code: 200, data: cards });
  } catch (err) { res.status(500).json({ code: 500 }); }
});

app.post('/api/cards', authenticateToken, async (req, res) => {
  try {
    const [result] = await pool.query('INSERT INTO knowledge_cards (user_id, title, content) VALUES (?, ?, ?)', [req.user.id, req.body.title, req.body.content]);
    res.json({ code: 200, id: result.insertId });
  } catch (err) { res.status(500).json({ code: 500 }); }
});

app.delete('/api/cards/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_cards WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    res.json({ code: 200 });
  } catch (err) { res.status(500).json({ code: 500 }); }
});

// ==========================================
// 📅 6. 课表专属接口 
// ==========================================
app.get('/api/schedule', authenticateToken, async (req, res) => {
  try {
    const [courses] = await pool.query('SELECT * FROM courses WHERE user_id = ?', [req.user.id]); 
    res.json({ code: 200, data: courses });
  } catch (err) { res.status(500).json({ code: 500 }); }
});

app.post('/api/schedule/save', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    await pool.query('DELETE FROM courses WHERE user_id = ?', [userId]);
    if (req.body.courses && req.body.courses.length > 0) {
      const values = req.body.courses.map(c => [userId, c.day, c.slot, c.name, c.loc, c.colorClass]);
      await pool.query('INSERT INTO courses (user_id, day, slot, name, loc, colorClass) VALUES ?', [values]);
    }
    res.json({ code: 200, message: '同步成功' });
  } catch (err) { res.status(500).json({ code: 500 }); }
});

// ==========================================
// ⏱️ 7. 自习室专注时长接口 
// ==========================================
app.post('/api/study/record', authenticateToken, async (req, res) => {
  try {
    await pool.query('INSERT INTO study_sessions (user_id, duration) VALUES (?, ?)', [req.user.id, req.body.duration]);
    res.json({ code: 200 });
  } catch (error) { res.status(500).json({ code: 500 }); }
});

// ==========================================
// 📌 8. 重要事件轴专属接口
// ==========================================
app.get('/api/events', authenticateToken, async (req, res) => {
  try {
    const [events] = await pool.query(
      'SELECT * FROM events WHERE user_id = ? ORDER BY event_date ASC', 
      [req.user.id]
    );
    res.json({ code: 200, data: events });
  } catch (err) {
    console.error('获取事件失败:', err);
    res.status(500).json({ code: 500, message: '获取事件失败' });
  }
});

app.post('/api/events', authenticateToken, async (req, res) => {
  const { title, event_date } = req.body;
  if (!title || !event_date) return res.status(400).json({ code: 400, message: '信息不全' });

  try {
    const [result] = await pool.query(
      'INSERT INTO events (user_id, title, event_date) VALUES (?, ?, ?)',
      [req.user.id, title, event_date]
    );
    res.json({ code: 200, message: '保存成功', id: result.insertId });
  } catch (err) {
    console.error('保存事件失败:', err);
    res.status(500).json({ code: 500, message: '保存事件失败' });
  }
});

// ==========================================
// 🌟 已修改：动态端口监听
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 后端服务器已启动，监听端口: ${PORT}`); });